import { affectedNames, Task, toTasks } from "../core/tasks";
import type { Op, TagRef, TagType } from "../core/types";
import { preflight } from "./guard";
import {
  deleteJournal,
  Journal,
  nextJournalID,
  pruneJournals,
  readJournal,
  writeJournal,
} from "./journal";
import {
  captureStates,
  getColorOf,
  itemsWithTag,
  tagIDsOf,
  TagState,
  typesOf,
} from "./tagStore";

const ITEM_CHUNK = 200;
/**
 * Tag edits must not touch the user-visible "Date Modified".
 *
 * skipEditCheck: Zotero refuses to save some items of an editable library,
 * e.g. annotations other members created in a group library. Its own bulk
 * tag operations (Zotero.Tags.rename and removeFromLibrary, used on the fast
 * paths here) change their tags anyway, so the per-item paths do the same
 * instead of failing half-way. editItems checks the library itself.
 */
const SAVE_OPTIONS = { skipDateModifiedUpdate: true, skipEditCheck: true };

export interface ApplyOptions {
  libraryID: number;
  ops: readonly Op[];
  /** Every tag of the library; used to validate that name-level tasks are complete. */
  allTags: readonly TagRef[];
  onProgress?: (done: number, total: number, task: Task) => void;
  /** Polled between tasks only; a task is never interrupted half-way. */
  isCancelled?: () => boolean;
}

export interface ApplyResult {
  /** "" if no journal was kept: there were no tasks, or nothing changed. */
  journalId: string;
  status: "done" | "failed" | "cancelled";
  completedTasks: number;
  totalTasks: number;
  /** Completed tasks that changed nothing: their tag was no longer in use. */
  skippedTasks: number;
  error?: string;
}

function log(...args: unknown[]) {
  Zotero.debug(
    `[TagWiz] ${args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`,
  );
}

async function setColor(
  libraryID: number,
  name: string,
  color: string | false,
  position?: number,
) {
  await Zotero.DB.executeTransaction(async () => {
    // Zotero clears the color for any falsy value; its typings only allow string.
    await Zotero.Tags.setColor(
      libraryID,
      name,
      color as string,
      position as number,
    );
  });
}

type TagData = { tag: string; type: number };

/**
 * Load `ids`, let `mutate` change their tags, and save them in transactions
 * of ITEM_CHUNK. Items of other libraries are left alone. Saves skip Zotero's
 * per-item edit check (see SAVE_OPTIONS), so the library's own permission is
 * checked here, before every chunk: it can change during a long run.
 */
async function editItems(
  libraryID: number,
  ids: readonly number[],
  mutate: (item: Zotero.Item) => void,
): Promise<void> {
  for (let i = 0; i < ids.length; i += ITEM_CHUNK) {
    const library = Zotero.Libraries.get(libraryID);
    if (!library || !library.editable) {
      throw new Error("The library is not editable");
    }
    const items = (
      (await Zotero.Items.getAsync(
        ids.slice(i, i + ITEM_CHUNK) as number[],
      )) as Zotero.Item[]
    ).filter((item) => item && item.libraryID === libraryID);
    await (Zotero.Items as any).loadDataTypes(items, ["tags"]);
    await Zotero.DB.executeTransaction(async () => {
      for (const item of items) {
        mutate(item);
        if (item.hasChanged()) await item.save(SAVE_OPTIONS);
      }
    });
  }
}

/** Delete the stored forms of `name` that no item uses any more. */
async function purgeTag(name: string) {
  const ids = await tagIDsOf([name]);
  if (ids.length) {
    await Zotero.DB.executeTransaction(async () => {
      await Zotero.Tags.purge(ids);
    });
  }
}

/**
 * Per-item rename. Unlike Zotero.Tags.rename it keeps each item's tag type.
 * If an item already has the target, the result is manual when either side is
 * manual (a manual assertion is never downgraded to automatic).
 */
async function renamePerItem(libraryID: number, from: string, to: string) {
  const ids = (await itemsWithTag(libraryID, from)).map((r) => r.id);
  await editItems(libraryID, ids, (item) => {
    const tags = item.getTags() as TagData[];
    const source = tags.find((t) => t.tag === from);
    if (!source) return;
    const sourceType = source.type ? 1 : 0;
    const rest = tags.filter((t) => t.tag !== from);
    const existing = rest.find((t) => t.tag === to);
    if (existing) existing.type = Math.min(existing.type ? 1 : 0, sourceType);
    else rest.push({ tag: to, type: sourceType });
    item.setTags(rest);
  });
  // A save removes a tag by the one ID Zotero.Tags.getID knows, so rows of
  // the name's other stored forms (see tagIDsOf) are left: remove them by ID.
  // Their items already got `to` above, as Zotero lists every form by name.
  const fromIDs = await tagIDsOf([from]);
  if (fromIDs.length > 1 && (await typesOf(libraryID, from)).length) {
    await Zotero.Tags.removeFromLibrary(
      libraryID,
      fromIDs,
      () => {},
      // undefined = every type; typings require an array.
      undefined as unknown as number[],
    );
  }
  await purgeTag(from);
}

/** Each run* returns false if there was nothing to do (tag no longer used). */
async function runRename(
  libraryID: number,
  from: string,
  to: string,
): Promise<boolean> {
  const fromTypes = await typesOf(libraryID, from);
  if (!fromTypes.length) {
    log("skip rename, source no longer used", from);
    return false;
  }
  const toTypes = await typesOf(libraryID, to);

  const sourceColor = getColorOf(libraryID, from);
  const targetColor = getColorOf(libraryID, to);
  // Keep the target's own color: Zotero.Tags.rename would overwrite it with the source's.
  if (sourceColor && targetColor) await setColor(libraryID, from, false);

  // Zotero.Tags.rename forces type=0, so it is only safe if no automatic tag
  // is involved. It also renames only the one stored form Zotero.Tags.getID
  // knows, so a name stored in several forms (see tagIDsOf) goes per item.
  const fast =
    [...fromTypes, ...toTypes].every((t) => t === 0) &&
    (await tagIDsOf([from])).length === 1;
  log("rename", from, "->", to, fast ? "(fast path)" : "(per-item path)");
  if (fast) {
    await Zotero.Tags.rename(libraryID, from, to);
  } else {
    await renamePerItem(libraryID, from, to);
    if (sourceColor && !targetColor) {
      await setColor(libraryID, from, false);
      await setColor(libraryID, to, sourceColor.color, sourceColor.position);
    }
  }
  return true;
}

async function runRetype(
  libraryID: number,
  name: string,
  toType: TagType,
): Promise<boolean> {
  const tagged = await itemsWithTag(libraryID, name);
  if (!tagged.length) {
    log("skip retype, tag no longer used", name);
    return false;
  }
  const ids = tagged.filter((r) => r.type !== toType).map((r) => r.id);
  log("retype", name, "->", toType, `(${ids.length} items)`);
  await editItems(libraryID, ids, (item) => {
    const tags = (item.getTags() as TagData[]).map((t) =>
      t.tag === name ? { ...t, type: toType } : t,
    );
    item.setTags(tags);
  });
  return true;
}

async function runRemove(
  libraryID: number,
  name: string,
  types: TagType[] | "all",
): Promise<boolean> {
  if (!(await typesOf(libraryID, name)).length) {
    log("skip remove, tag no longer used", name);
    return false;
  }
  log("remove", name, types);
  await Zotero.Tags.removeFromLibrary(
    libraryID,
    await tagIDsOf([name]),
    () => {},
    // undefined = remove the whole tag (and its color); typings require an array.
    (types === "all" ? undefined : types) as number[],
  );
  return true;
}

async function runTask(libraryID: number, task: Task): Promise<boolean> {
  switch (task.kind) {
    case "rename":
      return runRename(libraryID, task.from, task.to);
    case "retype":
      return runRetype(libraryID, task.name, task.toType);
    case "remove":
      return runRemove(libraryID, task.name, task.types);
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Apply a plan's operations. Throws before changing anything if the preflight
 * checks or the task folding fail. Once started, nothing throws: a failing
 * task or journal write stops the run, a failing callback is only logged, and
 * the result reports what happened so the caller can offer undo.
 */
export async function applyOps(opts: ApplyOptions): Promise<ApplyResult> {
  const { libraryID } = opts;
  const guard = preflight(libraryID);
  if (!guard.ok) throw new Error(`Cannot edit tags: ${guard.reason}`);

  const tasks = toTasks(opts.ops, opts.allTags);
  if (!tasks.length) {
    return {
      journalId: "",
      status: "done",
      completedTasks: 0,
      totalTasks: 0,
      skippedTasks: 0,
    };
  }

  const names = affectedNames(tasks);
  const journal: Journal = {
    version: 1,
    id: await nextJournalID(),
    createdAt: new Date().toISOString(),
    libraryID,
    status: "running",
    tasks,
    completedTasks: 0,
    before: await captureStates(libraryID, names),
  };
  await writeJournal(journal);

  // The journal is written once now and once at the end. `before` is all a
  // forced undo needs after a crash; rewriting the whole file after every
  // task would cost O(tasks × journal size) for a progress count only.
  let status: ApplyResult["status"] = "done";
  let error: string | undefined;
  let skippedTasks = 0;
  for (const [i, task] of tasks.entries()) {
    if (opts.isCancelled?.()) {
      status = "cancelled";
      break;
    }
    // The fast paths (Zotero.Tags.rename/removeFromLibrary) don't check
    // permissions, and a sync can make the library read-only mid-run.
    const check = preflight(libraryID);
    if (!check.ok) {
      status = "failed";
      error = `Cannot edit tags: ${check.reason}`;
      break;
    }
    try {
      if (!(await runTask(libraryID, task))) skippedTasks++;
      journal.completedTasks = i + 1;
    } catch (e) {
      status = "failed";
      error = message(e);
      log("task failed", task, error);
      break;
    }
    try {
      opts.onProgress?.(i + 1, tasks.length, task);
    } catch (e) {
      // e.g. the dialog was closed; the run itself must go on.
      log("progress callback failed", message(e));
    }
  }

  journal.status = status;
  journal.error = error;
  let kept = true;
  try {
    journal.after = await captureStates(libraryID, names);
    await writeJournal(journal);
  } catch (e) {
    // Without `after`, undo still works from `before` (see undoJournal).
    log("could not finish the journal", message(e));
    status = "failed";
    error ??= message(e);
  }
  if (journal.after && unchanged(journal.before, journal.after)) {
    // Nothing to undo (every task skipped, cancelled or failed before any
    // change): the journal would only hide the previous run from Undo.
    try {
      await deleteJournal(journal.id);
      kept = false;
    } catch (e) {
      log("could not delete an empty journal", message(e));
    }
  }
  try {
    await pruneJournals();
  } catch (e) {
    log("could not prune old journals", message(e));
  }

  return {
    journalId: kept ? journal.id : "",
    status,
    completedTasks: journal.completedTasks,
    totalTasks: tasks.length,
    skippedTasks,
    error,
  };
}

// ---------------------------------------------------------------- undo

function sameState(a: TagState | undefined, b: TagState | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.color?.color !== b.color?.color) return false;
  if (a.items.length !== b.items.length) return false;
  const key = (s: TagState) =>
    s.items
      .map((x) => `${x.id}:${x.type}`)
      .sort()
      .join(",");
  return key(a) === key(b);
}

/**
 * Same items, types, colors and color positions for every name of `before`.
 * (sameState ignores positions: they are list indexes, which shift when an
 * unrelated tag's color changes, so they must not count as drift.)
 */
function unchanged(before: TagState[], after: TagState[]): boolean {
  const afterByName = new Map(after.map((s) => [s.name, s]));
  return before.every((s) => {
    const a = afterByName.get(s.name);
    return sameState(s, a) && s.color?.position === a?.color?.position;
  });
}

export type UndoResult =
  | { ok: true; restoredTags: number }
  | { ok: false; reason: "drifted"; driftedTags: string[] }
  | { ok: false; reason: "interrupted" }
  | { ok: false; reason: "already-undone" };

/**
 * Restore the affected tags to their state before the run (membership, types,
 * colors). Refuses if those tags changed after the run, unless `force`.
 * A run that was interrupted (crash, quit) has no `after` snapshot, so changes
 * made since cannot be detected; it is only undone with `force`.
 */
export async function undoJournal(
  journalID: string,
  opts: { force?: boolean } = {},
): Promise<UndoResult> {
  const journal = await readJournal(journalID);
  if (journal.status === "undone")
    return { ok: false, reason: "already-undone" };
  if (!journal.after && !opts.force)
    return { ok: false, reason: "interrupted" };

  const guard = preflight(journal.libraryID);
  if (!guard.ok) throw new Error(`Cannot edit tags: ${guard.reason}`);

  const { libraryID } = journal;
  const names = journal.before.map((s) => s.name);
  const current = await captureStates(libraryID, names);
  if (journal.after && !opts.force) {
    const afterByName = new Map(journal.after.map((s) => [s.name, s]));
    const drifted = current
      .filter((s) => !sameState(s, afterByName.get(s.name)))
      .map((s) => s.name);
    if (drifted.length) {
      return { ok: false, reason: "drifted", driftedTags: drifted };
    }
  }

  // itemID -> (tag name -> type it must have afterwards, or null for "must not have")
  const wanted = new Map<number, Map<string, TagType | null>>();
  /** Names whose items or color actually change back. */
  const restored = new Set<string>();
  const want = (id: number, name: string, type: TagType | null) => {
    const perItem = wanted.get(id) ?? new Map<string, TagType | null>();
    perItem.set(name, type);
    wanted.set(id, perItem);
    restored.add(name);
  };
  const currentByName = new Map(current.map((s) => [s.name, s]));
  for (const before of journal.before) {
    const color = currentByName.get(before.name)?.color;
    if (
      color?.color !== before.color?.color ||
      color?.position !== before.color?.position
    ) {
      restored.add(before.name);
    }
    const now = new Map(
      (currentByName.get(before.name)?.items ?? []).map((x) => [x.id, x.type]),
    );
    const was = new Map(before.items.map((x) => [x.id, x.type]));
    for (const [id, type] of was)
      if (now.get(id) !== type) want(id, before.name, type);
    for (const id of now.keys()) if (!was.has(id)) want(id, before.name, null);
  }

  log("undo", journalID, `${wanted.size} items`);
  await editItems(libraryID, [...wanted.keys()], (item) => {
    const changes = wanted.get(item.id)!;
    const tags = (item.getTags() as TagData[]).filter(
      (t) => !changes.has(t.tag),
    );
    for (const [name, type] of changes) {
      if (type !== null) tags.push({ tag: name, type });
    }
    item.setTags(tags);
  });
  for (const name of names) await purgeTag(name);

  // Colors: clear every affected name, then re-insert in original order so
  // list positions line up again.
  for (const s of journal.before) await setColor(libraryID, s.name, false);
  const colored = journal.before
    .filter((s) => s.color)
    .sort((a, b) => a.color!.position - b.color!.position);
  for (const s of colored) {
    await setColor(libraryID, s.name, s.color!.color, s.color!.position);
  }

  journal.status = "undone";
  await writeJournal(journal);
  return { ok: true, restoredTags: restored.size };
}

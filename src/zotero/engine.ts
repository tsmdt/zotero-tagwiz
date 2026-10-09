import { affectedNames, Task, toTasks } from "../core/tasks";
import type { Op, TagRef, TagType } from "../core/types";
import { preflight } from "./guard";
import {
  Journal,
  newJournalID,
  pruneJournals,
  readJournal,
  writeJournal,
} from "./journal";
import {
  captureStates,
  getColorOf,
  itemsWithTag,
  TagState,
  typesOf,
} from "./tagStore";

const ITEM_CHUNK = 200;
/** Tag edits must not touch the user-visible "Date Modified". */
const SAVE_OPTIONS = { skipDateModifiedUpdate: true };

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
  journalId: string;
  status: "done" | "failed" | "cancelled";
  completedTasks: number;
  totalTasks: number;
  error?: string;
}

function log(...args: unknown[]) {
  Zotero.debug(
    `[TagCleaner] ${args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`,
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

/** Load `ids`, let `mutate` change their tags, and save them in transactions of ITEM_CHUNK. */
async function editItems(
  ids: readonly number[],
  mutate: (item: Zotero.Item) => void,
): Promise<void> {
  for (let i = 0; i < ids.length; i += ITEM_CHUNK) {
    const items = (await Zotero.Items.getAsync(
      ids.slice(i, i + ITEM_CHUNK) as number[],
    )) as Zotero.Item[];
    await (Zotero.Items as any).loadDataTypes(items, ["tags"]);
    await Zotero.DB.executeTransaction(async () => {
      for (const item of items) {
        mutate(item);
        if (item.hasChanged()) await item.save(SAVE_OPTIONS);
      }
    });
  }
}

async function purgeTag(name: string) {
  const id = Zotero.Tags.getID(name);
  if (id) {
    await Zotero.DB.executeTransaction(async () => {
      await Zotero.Tags.purge([id]);
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
  await editItems(ids, (item) => {
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
  await purgeTag(from);
}

async function runRename(libraryID: number, from: string, to: string) {
  const fromTypes = await typesOf(libraryID, from);
  if (!fromTypes.length) {
    log("skip rename, source no longer used", from);
    return;
  }
  const toTypes = await typesOf(libraryID, to);

  const sourceColor = getColorOf(libraryID, from);
  const targetColor = getColorOf(libraryID, to);
  // Keep the target's own color: Zotero.Tags.rename would overwrite it with the source's.
  if (sourceColor && targetColor) await setColor(libraryID, from, false);

  // Zotero.Tags.rename forces type=0, so it is only safe if no automatic tag is involved.
  const fast = [...fromTypes, ...toTypes].every((t) => t === 0);
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
}

async function runRetype(libraryID: number, name: string, toType: TagType) {
  const ids = (await itemsWithTag(libraryID, name))
    .filter((r) => r.type !== toType)
    .map((r) => r.id);
  log("retype", name, "->", toType, `(${ids.length} items)`);
  await editItems(ids, (item) => {
    const tags = (item.getTags() as TagData[]).map((t) =>
      t.tag === name ? { ...t, type: toType } : t,
    );
    item.setTags(tags);
  });
}

async function runRemove(
  libraryID: number,
  name: string,
  types: TagType[] | "all",
) {
  const id = Zotero.Tags.getID(name);
  if (!id) {
    log("skip remove, tag no longer exists", name);
    return;
  }
  log("remove", name, types);
  await Zotero.Tags.removeFromLibrary(
    libraryID,
    [id],
    () => {},
    // undefined = remove the whole tag (and its color); typings require an array.
    (types === "all" ? undefined : types) as number[],
  );
}

async function runTask(libraryID: number, task: Task) {
  switch (task.kind) {
    case "rename":
      return runRename(libraryID, task.from, task.to);
    case "retype":
      return runRetype(libraryID, task.name, task.toType);
    case "remove":
      return runRemove(libraryID, task.name, task.types);
  }
}

/**
 * Apply a plan's operations. Throws before changing anything if the preflight
 * checks or the task folding fail. Once started, task failures do not throw:
 * they stop the run and are reported in the result so the caller can offer undo.
 */
export async function applyOps(opts: ApplyOptions): Promise<ApplyResult> {
  const { libraryID } = opts;
  const guard = preflight(libraryID);
  if (!guard.ok) throw new Error(`Cannot edit tags: ${guard.reason}`);

  const tasks = toTasks(opts.ops, opts.allTags);
  if (!tasks.length) {
    return { journalId: "", status: "done", completedTasks: 0, totalTasks: 0 };
  }

  const names = affectedNames(tasks);
  const journal: Journal = {
    version: 1,
    id: newJournalID(),
    createdAt: new Date().toISOString(),
    libraryID,
    status: "running",
    tasks,
    completedTasks: 0,
    before: await captureStates(libraryID, names),
  };
  await writeJournal(journal);

  let status: ApplyResult["status"] = "done";
  let error: string | undefined;
  for (const [i, task] of tasks.entries()) {
    if (opts.isCancelled?.()) {
      status = "cancelled";
      break;
    }
    try {
      await runTask(libraryID, task);
    } catch (e) {
      status = "failed";
      error = e instanceof Error ? e.message : String(e);
      log("task failed", task, error);
      break;
    }
    journal.completedTasks = i + 1;
    await writeJournal(journal);
    opts.onProgress?.(i + 1, tasks.length, task);
  }

  journal.status = status;
  journal.error = error;
  journal.after = await captureStates(libraryID, names);
  await writeJournal(journal);
  await pruneJournals();

  return {
    journalId: journal.id,
    status,
    completedTasks: journal.completedTasks,
    totalTasks: tasks.length,
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

export type UndoResult =
  | { ok: true; restoredTags: number }
  | { ok: false; reason: "drifted"; driftedTags: string[] }
  | { ok: false; reason: "already-undone" | "no-snapshot" };

/**
 * Restore the affected tags to their state before the run (membership, types,
 * colors). Refuses if those tags changed after the run, unless `force`.
 */
export async function undoJournal(
  journalID: string,
  opts: { force?: boolean } = {},
): Promise<UndoResult> {
  const journal = await readJournal(journalID);
  if (journal.status === "undone")
    return { ok: false, reason: "already-undone" };
  if (!journal.after) return { ok: false, reason: "no-snapshot" };

  const guard = preflight(journal.libraryID);
  if (!guard.ok) throw new Error(`Cannot edit tags: ${guard.reason}`);

  const { libraryID } = journal;
  const names = journal.before.map((s) => s.name);
  const current = await captureStates(libraryID, names);
  const afterByName = new Map(journal.after.map((s) => [s.name, s]));
  const drifted = current
    .filter((s) => !sameState(s, afterByName.get(s.name)))
    .map((s) => s.name);
  if (drifted.length && !opts.force) {
    return { ok: false, reason: "drifted", driftedTags: drifted };
  }

  // itemID -> (tag name -> type it must have afterwards, or null for "must not have")
  const wanted = new Map<number, Map<string, TagType | null>>();
  const want = (id: number, name: string, type: TagType | null) => {
    const perItem = wanted.get(id) ?? new Map<string, TagType | null>();
    perItem.set(name, type);
    wanted.set(id, perItem);
  };
  const currentByName = new Map(current.map((s) => [s.name, s]));
  for (const before of journal.before) {
    const now = new Map(
      (currentByName.get(before.name)?.items ?? []).map((x) => [x.id, x.type]),
    );
    const was = new Map(before.items.map((x) => [x.id, x.type]));
    for (const [id, type] of was)
      if (now.get(id) !== type) want(id, before.name, type);
    for (const id of now.keys()) if (!was.has(id)) want(id, before.name, null);
  }

  log("undo", journalID, `${wanted.size} items`);
  await editItems([...wanted.keys()], (item) => {
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
  return { ok: true, restoredTags: names.length };
}

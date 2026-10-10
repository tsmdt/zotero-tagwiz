import type { Task } from "../core/tasks";
import type { TagState } from "./tagStore";

export type JournalStatus =
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "undone";

/**
 * Record of one apply run: what was asked, what the affected tags looked like
 * before and after. Written to disk before the first change and updated after
 * every task, so a crash still leaves a record that can be undone from
 * `before` (`after` is then missing, see undoJournal).
 */
export interface Journal {
  version: 1;
  id: string;
  createdAt: string;
  libraryID: number;
  status: JournalStatus;
  tasks: Task[];
  completedTasks: number;
  error?: string;
  before: TagState[];
  after?: TagState[];
}

/** Journals kept per library, and in all (unreadable ones count here only). */
const KEEP = 10;
const KEEP_FILES = 50;

/** Suffix of the file a journal is written to before it replaces the real one. */
const TMP_SUFFIX = ".tmp";

const DIR_NAME = "tagwiz";
/** Folder used before the plugin was renamed to TagWiz. */
const LEGACY_DIR_NAME = "tagcleaner";

function dirPath(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, DIR_NAME);
}

/**
 * Move snapshots from the pre-rename folder into the current one, so undo
 * keeps working across the rename. Existing files are never overwritten.
 */
async function migrateLegacyJournals(): Promise<void> {
  const legacy = PathUtils.join(Zotero.DataDirectory.dir, LEGACY_DIR_NAME);
  if (!(await IOUtils.exists(legacy))) return;
  await IOUtils.makeDirectory(dirPath(), { ignoreExisting: true });
  for (const path of (await IOUtils.getChildren(legacy)) as string[]) {
    const target = PathUtils.join(dirPath(), PathUtils.filename(path));
    if (!(await IOUtils.exists(target))) await IOUtils.move(path, target);
  }
  try {
    await IOUtils.remove(legacy); // only succeeds if the folder is now empty
  } catch {
    // something is left behind; leave the folder alone
  }
}

function filePath(id: string): string {
  return PathUtils.join(dirPath(), `${id}.json`);
}

export function newJournalID(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * A new journal ID that sorts after every existing one (listJournalIDs and
 * so "latest" go by ID), even if the system clock was set back meanwhile.
 */
export async function nextJournalID(): Promise<string> {
  const id = newJournalID();
  const newest = (await listJournalIDs())[0];
  // "x-1" sorts right after "x".
  return newest !== undefined && id <= newest ? `${newest}-1` : id;
}

/**
 * Write via a temporary file that is then renamed over the journal, so a
 * crash mid-write leaves the previous version instead of truncated JSON.
 */
export async function writeJournal(journal: Journal): Promise<void> {
  await IOUtils.makeDirectory(dirPath(), { ignoreExisting: true });
  const path = filePath(journal.id);
  await IOUtils.writeJSON(path, journal, { tmpPath: path + TMP_SUFFIX });
}

function isTagState(value: any): boolean {
  return (
    typeof value?.name === "string" &&
    Array.isArray(value.items) &&
    value.items.every(
      (x: any) => Number.isInteger(x?.id) && (x.type === 0 || x.type === 1),
    ) &&
    (value.color === undefined ||
      (typeof value.color?.color === "string" &&
        Number.isInteger(value.color.position)))
  );
}

/**
 * Throws unless `value` has the shape undo relies on, so a damaged or
 * hand-edited file counts as unreadable instead of failing half-way.
 */
function checkJournal(value: any): Journal {
  const valid =
    value?.version === 1 &&
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    Number.isInteger(value.libraryID) &&
    typeof value.status === "string" &&
    Array.isArray(value.tasks) &&
    Number.isInteger(value.completedTasks) &&
    Array.isArray(value.before) &&
    value.before.every(isTagState) &&
    (value.after === undefined ||
      (Array.isArray(value.after) && value.after.every(isTagState)));
  if (!valid) throw new Error("not a valid TagWiz journal");
  return value as Journal;
}

async function readFile(id: string): Promise<Journal> {
  return checkJournal(await IOUtils.readJSON(filePath(id)));
}

export async function readJournal(id: string): Promise<Journal> {
  await migrateLegacyJournals();
  return readFile(id);
}

/** Library of each journal read so far: it never changes, and files are big. */
const libraryOf = new Map<string, number>();

async function journalLibrary(id: string): Promise<number | undefined> {
  if (!libraryOf.has(id)) {
    try {
      libraryOf.set(id, (await readFile(id)).libraryID);
    } catch {
      return undefined;
    }
  }
  return libraryOf.get(id);
}

/** Newest first. */
export async function listJournalIDs(): Promise<string[]> {
  await migrateLegacyJournals();
  if (!(await IOUtils.exists(dirPath()))) return [];
  const children: string[] = await IOUtils.getChildren(dirPath());
  return children
    .map((p) => PathUtils.filename(p))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort()
    .reverse();
}

/**
 * Keep the newest KEEP journals of each library (so edits in one library do
 * not drop another library's undo), at most KEEP_FILES files in all. Also
 * delete temporary files left behind by an interrupted write (only one run
 * writes at a time, and it is over).
 */
export async function pruneJournals(): Promise<void> {
  const ids = await listJournalIDs();
  const keptPerLibrary = new Map<number, number>();
  for (const [index, id] of ids.entries()) {
    const libraryID = await journalLibrary(id);
    const kept =
      libraryID === undefined ? 0 : (keptPerLibrary.get(libraryID) ?? 0);
    if (index < KEEP_FILES && kept < KEEP) {
      if (libraryID !== undefined) keptPerLibrary.set(libraryID, kept + 1);
      continue;
    }
    await IOUtils.remove(filePath(id), { ignoreAbsent: true });
    libraryOf.delete(id);
  }
  if (!(await IOUtils.exists(dirPath()))) return;
  for (const path of (await IOUtils.getChildren(dirPath())) as string[]) {
    if (path.endsWith(TMP_SUFFIX)) {
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  }
}

export interface UndoCandidate {
  /** Latest journal of the library, unless that one was already undone. */
  journal?: Journal;
  /**
   * IDs of unreadable journals newer than `journal`. Their library is
   * unknown, so any of them may be this library's latest run: undoing
   * `journal` would then revert an older run than the user expects.
   */
  unreadable: string[];
}

/** The library's latest journal, and the unreadable ones found before it. */
export async function findUndoable(libraryID: number): Promise<UndoCandidate> {
  const unreadable: string[] = [];
  for (const id of await listJournalIDs()) {
    let journal: Journal;
    try {
      journal = await readFile(id);
    } catch (e) {
      Zotero.debug(`[TagWiz] unreadable journal ${id}: ${e}`);
      unreadable.push(id);
      continue;
    }
    if (journal?.libraryID !== libraryID) continue;
    return {
      journal: journal.status === "undone" ? undefined : journal,
      unreadable,
    };
  }
  return { unreadable };
}

/**
 * Latest journal that can still be undone, if any. Unreadable files are
 * passed over; use findUndoable to learn about them.
 */
export async function latestUndoable(
  libraryID: number,
): Promise<Journal | undefined> {
  return (await findUndoable(libraryID)).journal;
}

import { affectedItemCount, type EditKind } from "../core/history";
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
 * before and after. Written to disk before the first change and again when
 * the run ends, so a crash still leaves a record that can be undone from
 * `before` (`after` is then missing, see undoJournal; it cannot be redone).
 */
export interface Journal {
  version: 1;
  id: string;
  createdAt: string;
  libraryID: number;
  status: JournalStatus;
  /** The status an undo replaced, put back by a redo. Set while undone. */
  undoneStatus?: JournalStatus;
  kind: EditKind;
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

function dirPath(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, DIR_NAME);
}

function filePath(id: string): string {
  return PathUtils.join(dirPath(), `${id}.json`);
}

/**
 * Journal IDs start with newJournalID's timestamp; nextJournalID and tests
 * add "-suffixes". Anything else in the folder is not ours: a name like
 * "notes" would sort after every timestamp and pass for the newest journal.
 */
const JOURNAL_ID =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-[A-Za-z0-9]+)*$/;

/** The journal ID of a file name, or undefined if it is not a journal file. */
function idOfFile(filename: string): string | undefined {
  if (!filename.endsWith(".json")) return undefined;
  const id = filename.slice(0, -".json".length);
  return JOURNAL_ID.test(id) ? id : undefined;
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
  // Not only the file's modification time: some file systems (FAT, network
  // drives) keep it to the second, so an undo and a redo within one second
  // would leave the summary of the first.
  summaries.delete(journal.id);
}

/** Remove a journal, e.g. one of a run that changed nothing. */
export async function deleteJournal(id: string): Promise<void> {
  await IOUtils.remove(filePath(id), { ignoreAbsent: true });
  forget(id);
}

/** Drop a removed journal from the caches. */
function forget(id: string) {
  libraryOf.delete(id);
  summaries.delete(id);
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
    typeof value.kind === "string" &&
    (value.status === "undone"
      ? typeof value.undoneStatus === "string"
      : value.undoneStatus === undefined) &&
    Array.isArray(value.tasks) &&
    Number.isInteger(value.completedTasks) &&
    Array.isArray(value.before) &&
    value.before.every(isTagState) &&
    (value.after === undefined ||
      (Array.isArray(value.after) && value.after.every(isTagState)));
  if (!valid) throw new Error("not a valid TagWiz journal");
  return value as Journal;
}

export async function readJournal(id: string): Promise<Journal> {
  return checkJournal(await IOUtils.readJSON(filePath(id)));
}

/** Library of each journal read so far: it never changes, and files are big. */
const libraryOf = new Map<string, number>();

async function journalLibrary(id: string): Promise<number | undefined> {
  if (!libraryOf.has(id)) {
    try {
      libraryOf.set(id, (await readJournal(id)).libraryID);
    } catch {
      return undefined;
    }
  }
  return libraryOf.get(id);
}

/** Newest first. */
export async function listJournalIDs(): Promise<string[]> {
  if (!(await IOUtils.exists(dirPath()))) return [];
  const children: string[] = await IOUtils.getChildren(dirPath());
  return children
    .map((p) => idOfFile(PathUtils.filename(p)))
    .filter((id): id is string => id !== undefined)
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
    forget(id);
  }
  if (!(await IOUtils.exists(dirPath()))) return;
  for (const path of (await IOUtils.getChildren(dirPath())) as string[]) {
    if (path.endsWith(TMP_SUFFIX)) {
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  }
}

/** One run as the History tab lists it. */
export interface HistoryEntry {
  id: string;
  createdAt: string;
  kind: EditKind;
  /** Items whose tags the run changed (see affectedItemCount). */
  items: number;
  status: JournalStatus;
  /** No `after` snapshot: the run was cut short by a crash or quit. */
  interrupted: boolean;
}

export interface History {
  /** This library's runs, newest first. */
  entries: HistoryEntry[];
  /** Journals that could not be read; any of them may be this library's. */
  unreadable: string[];
}

/**
 * Summaries by journal ID, with their file's modification time: History is
 * listed on every reload, and journals can be megabytes.
 */
const summaries = new Map<string, { modified: number; entry: HistoryEntry }>();

function summarize(journal: Journal): HistoryEntry {
  return {
    id: journal.id,
    createdAt: journal.createdAt,
    kind: journal.kind,
    items: affectedItemCount(journal.before, journal.after),
    status: journal.status,
    interrupted: !journal.after,
  };
}

/** Every kept run of the library, newest first. */
export async function listHistory(libraryID: number): Promise<History> {
  const entries: HistoryEntry[] = [];
  const unreadable: string[] = [];
  for (const id of await listJournalIDs()) {
    const library = libraryOf.get(id);
    if (library !== undefined && library !== libraryID) continue;
    try {
      const modified = (await IOUtils.stat(filePath(id))).lastModified;
      const hit = summaries.get(id);
      if (hit && modified !== undefined && hit.modified === modified) {
        entries.push(hit.entry);
        continue;
      }
      const journal = await readJournal(id);
      libraryOf.set(id, journal.libraryID);
      if (journal.libraryID !== libraryID) continue;
      const entry = summarize(journal);
      if (modified !== undefined) summaries.set(id, { modified, entry });
      entries.push(entry);
    } catch (e) {
      Zotero.debug(`[TagWiz] unreadable journal ${id}: ${e}`);
      unreadable.push(id);
    }
  }
  return { entries, unreadable };
}

/**
 * Delete the library's undone runs: a new edit was made on top of their
 * state, so they can no longer be redone (see redoChain).
 */
export async function discardUndone(libraryID: number): Promise<void> {
  for (const entry of (await listHistory(libraryID)).entries) {
    if (entry.status === "undone") await deleteJournal(entry.id);
  }
}

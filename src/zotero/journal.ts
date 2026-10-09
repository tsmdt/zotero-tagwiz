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
 * every task, so a crash still leaves an undoable record.
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

const KEEP = 10;

function dirPath(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, "tagcleaner");
}

function filePath(id: string): string {
  return PathUtils.join(dirPath(), `${id}.json`);
}

export function newJournalID(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function writeJournal(journal: Journal): Promise<void> {
  await IOUtils.makeDirectory(dirPath(), { ignoreExisting: true });
  await IOUtils.writeJSON(filePath(journal.id), journal);
}

export async function readJournal(id: string): Promise<Journal> {
  return (await IOUtils.readJSON(filePath(id))) as Journal;
}

/** Newest first. */
export async function listJournalIDs(): Promise<string[]> {
  if (!(await IOUtils.exists(dirPath()))) return [];
  const children: string[] = await IOUtils.getChildren(dirPath());
  return children
    .map((p) => PathUtils.filename(p))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort()
    .reverse();
}

/** Delete all but the newest KEEP journals. */
export async function pruneJournals(): Promise<void> {
  const ids = await listJournalIDs();
  for (const id of ids.slice(KEEP)) {
    await IOUtils.remove(filePath(id), { ignoreAbsent: true });
  }
}

/** Latest journal that can still be undone, if any. */
export async function latestUndoable(
  libraryID: number,
): Promise<Journal | undefined> {
  for (const id of await listJournalIDs()) {
    const journal = await readJournal(id);
    if (journal.libraryID !== libraryID) continue;
    return journal.status === "undone" ? undefined : journal;
  }
  return undefined;
}

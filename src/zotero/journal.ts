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

const KEEP = 10;

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

export async function writeJournal(journal: Journal): Promise<void> {
  await IOUtils.makeDirectory(dirPath(), { ignoreExisting: true });
  await IOUtils.writeJSON(filePath(journal.id), journal);
}

export async function readJournal(id: string): Promise<Journal> {
  await migrateLegacyJournals();
  return (await IOUtils.readJSON(filePath(id))) as Journal;
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

/** Delete all but the newest KEEP journals. */
export async function pruneJournals(): Promise<void> {
  const ids = await listJournalIDs();
  for (const id of ids.slice(KEEP)) {
    await IOUtils.remove(filePath(id), { ignoreAbsent: true });
  }
}

/**
 * Latest journal that can still be undone, if any. Unreadable files (e.g.
 * truncated or edited by hand) are skipped.
 */
export async function latestUndoable(
  libraryID: number,
): Promise<Journal | undefined> {
  for (const id of await listJournalIDs()) {
    let journal: Journal;
    try {
      journal = await readJournal(id);
    } catch (e) {
      Zotero.debug(`[TagWiz] skipping unreadable journal ${id}: ${e}`);
      continue;
    }
    if (journal?.libraryID !== libraryID) continue;
    return journal.status === "undone" ? undefined : journal;
  }
  return undefined;
}

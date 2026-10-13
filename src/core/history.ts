import { getOrCreate } from "./collections";
import type { TagType } from "./types";

/** Which tab a run came from; shown in the History tab. */
export type EditKind = "case" | "rename" | "merge" | "duplicates" | "remove";

/** The parts of a journal's tag snapshot (TagState) a summary needs. */
interface ItemsOfTag {
  name: string;
  items: ReadonlyArray<{ id: number; type: TagType }>;
}

/**
 * What turns the tags of `from` into those of `to`, for each name of `to`:
 * itemID -> (tag name -> the type the item must have, or null for "must not
 * have the tag"). Names missing from `from` count as unused there.
 */
export function diffItems(
  from: readonly ItemsOfTag[],
  to: readonly ItemsOfTag[],
): Map<number, Map<string, TagType | null>> {
  const fromByName = new Map(from.map((s) => [s.name, s]));
  const changes = new Map<number, Map<string, TagType | null>>();
  const set = (id: number, name: string, type: TagType | null) =>
    getOrCreate(changes, id, () => new Map()).set(name, type);
  for (const goal of to) {
    const now = new Map(
      (fromByName.get(goal.name)?.items ?? []).map((x) => [x.id, x.type]),
    );
    const then = new Map(goal.items.map((x) => [x.id, x.type]));
    for (const [id, type] of then)
      if (now.get(id) !== type) set(id, goal.name, type);
    for (const id of now.keys()) if (!then.has(id)) set(id, goal.name, null);
  }
  return changes;
}

/**
 * Items whose tags the run changed: those that gained, lost or retyped one of
 * its tags. Items that only carry a merge target keep it unchanged, so they
 * do not count. A run without `after` (interrupted) counts every item that
 * had one of its tags before.
 */
export function affectedItemCount(
  before: readonly ItemsOfTag[],
  after?: readonly ItemsOfTag[],
): number {
  if (!after) {
    return new Set(before.flatMap((s) => s.items.map((x) => x.id))).size;
  }
  return diffItems(after, before).size;
}

/** The parts of a History entry the undo and redo chains need. */
interface Step {
  id: string;
  status: string;
  /** No `after` snapshot: the run cannot be redone. */
  interrupted: boolean;
}

/**
 * Runs Undo reverts to return to before `id`, newest first: every newer run
 * that is still applied, then `id` itself. Empty if `id` is unknown or undone.
 */
export function undoChain<T extends Step>(
  entries: readonly T[],
  id: string,
): T[] {
  const index = entries.findIndex((e) => e.id === id);
  if (index < 0 || entries[index].status === "undone") return [];
  return entries.slice(0, index + 1).filter((e) => e.status !== "undone");
}

/**
 * Runs Redo re-applies to return to after `id`, oldest first. Only the
 * undone runs newer than every applied one can be redone (an undone run
 * below an applied one was overtaken by a later edit), and not past a run
 * without `after`. Empty if `id` cannot be redone.
 */
export function redoChain<T extends Step>(
  entries: readonly T[],
  id: string,
): T[] {
  const top = entries.findIndex((e) => e.status !== "undone");
  const undone = entries.slice(0, top < 0 ? entries.length : top).reverse();
  const chain: T[] = [];
  for (const entry of undone) {
    if (entry.interrupted) return [];
    chain.push(entry);
    if (entry.id === id) return chain;
  }
  return [];
}

/** What the History tab can do with run `id`, if anything. */
export function historyAction(
  entries: readonly Step[],
  id: string | undefined,
): "undo" | "redo" | undefined {
  if (id === undefined) return undefined;
  if (undoChain(entries, id).length) return "undo";
  if (redoChain(entries, id).length) return "redo";
  return undefined;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** YYYY-MM-DD in local time; "?" for a missing or damaged date. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "?";
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** HH:MM:SS in local time, 24-hour clock; "?" for a missing date. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "?";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

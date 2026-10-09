import { cleanName } from "./normalize";
import type { Op, TagRef, TagType } from "./types";

/**
 * Name-level work items the engine executes. Zotero's tag APIs are keyed by
 * name (a name can exist as manual and automatic), so ops on TagRefs are
 * folded into these.
 */
export type Task =
  | { kind: "rename"; from: string; to: string }
  | { kind: "retype"; name: string; toType: TagType }
  | { kind: "remove"; name: string; types: TagType[] | "all" };

export function taskNames(task: Task): string[] {
  return task.kind === "rename" ? [task.from, task.to] : [task.name];
}

export function affectedNames(tasks: readonly Task[]): string[] {
  return [...new Set(tasks.flatMap(taskNames))];
}

/**
 * Fold plan ops into tasks. Throws on plans that cannot be executed as
 * requested instead of silently doing something different:
 * - a rename that covers only some types of a name (rename is name-level)
 * - one name renamed to two different targets
 */
export function toTasks(
  ops: readonly Op[],
  allTags: readonly TagRef[],
): Task[] {
  const typesByName = new Map<string, Set<TagType>>();
  for (const tag of allTags) {
    const set = typesByName.get(tag.name) ?? new Set<TagType>();
    set.add(tag.type);
    typesByName.set(tag.name, set);
  }

  const renames = new Map<string, { to: string; types: Set<TagType> }>();
  const removes = new Map<string, Set<TagType>>();
  const retypes: Task[] = [];

  for (const op of ops) {
    if (op.kind === "rename") {
      const to = cleanName(op.to);
      const entry = renames.get(op.from.name);
      if (entry && entry.to !== to) {
        throw new Error(
          `Tag "${op.from.name}" is renamed to both "${entry.to}" and "${to}"`,
        );
      }
      const types = entry?.types ?? new Set<TagType>();
      types.add(op.from.type);
      renames.set(op.from.name, { to, types });
    } else if (op.kind === "retype") {
      retypes.push({ kind: "retype", name: op.tag.name, toType: op.toType });
    } else {
      const set = removes.get(op.tag.name) ?? new Set<TagType>();
      set.add(op.tag.type);
      removes.set(op.tag.name, set);
    }
  }

  const tasks: Task[] = [];
  for (const [from, { to, types }] of renames) {
    const all = typesByName.get(from) ?? types;
    if ([...all].some((t) => !types.has(t))) {
      throw new Error(
        `Renaming "${from}" must include all of its types (manual and automatic)`,
      );
    }
    tasks.push({ kind: "rename", from, to });
  }
  tasks.push(...retypes);
  for (const [name, types] of removes) {
    const all = typesByName.get(name) ?? types;
    const full = [...all].every((t) => types.has(t));
    tasks.push({
      kind: "remove",
      name,
      types: full ? "all" : [...types].sort(),
    });
  }
  return tasks;
}

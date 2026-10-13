import { convertCase } from "./caseStyles";
import { getOrCreate } from "./collections";
import { type DuplicateGroup, preferManual } from "./duplicates";
import { cleanName } from "./normalize";
import {
  CaseOptions,
  ChangePlan,
  MAX_TAG_LENGTH,
  Op,
  PlanRow,
  TagRef,
} from "./types";

/** Returns a problem description, or null if `name` is a valid Zotero tag name. */
export function validateTagName(name: string): string | null {
  const clean = cleanName(name);
  if (clean === "") return "empty";
  if (clean.length > MAX_TAG_LENGTH) return "too-long";
  return null;
}

function row(op: Op): PlanRow {
  return { op, included: true, merges: false, warnings: [] };
}

function targetOf(op: Op): string | null {
  return op.kind === "rename" ? op.to : null;
}

/** The tag an op acts on: a rename's source, or the retyped/removed tag. */
export function opSource(op: Op): TagRef {
  return op.kind === "rename" ? op.from : op.tag;
}

/**
 * Add validation, merge and chain flags. `allTags` is every tag of the library
 * (not only the selected ones) so merges into untouched tags are detected.
 */
function finalize(rows: PlanRow[], allTags: readonly TagRef[]): ChangePlan {
  const existing = new Set(allTags.map((t) => t.name));
  const movedAway = new Set(
    rows
      .filter((r) => r.op.kind === "rename" || r.op.kind === "remove")
      .map((r) => opSource(r.op).name),
  );
  // Distinct source names per target: the manual and automatic rows of one
  // name renamed together are a single source, not a merge.
  const sourcesByTarget = new Map<string, Set<string>>();
  for (const r of rows) {
    const to = targetOf(r.op);
    if (to === null) continue;
    getOrCreate(sourcesByTarget, to, () => new Set()).add(opSource(r.op).name);
  }

  for (const r of rows) {
    const to = targetOf(r.op);
    if (to === null) continue;
    const problem = validateTagName(to);
    if (problem) {
      r.error = problem;
    } else if (movedAway.has(to) && opSource(r.op).name !== to) {
      // A -> B while B itself is renamed/removed: result would depend on order.
      r.error = "target-is-also-changed";
    } else if (existing.has(to) || (sourcesByTarget.get(to)?.size ?? 0) > 1) {
      r.merges = true;
    }
    if (r.error) r.included = false;
  }
  return { rows };
}

/** Ops that will actually run: included and error-free. */
export function includedOps(plan: ChangePlan): Op[] {
  return plan.rows.filter((r) => r.included && !r.error).map((r) => r.op);
}

export function buildCasePlan(
  selected: readonly TagRef[],
  options: CaseOptions,
  allTags: readonly TagRef[],
): ChangePlan {
  const rows: PlanRow[] = [];
  for (const tag of selected) {
    const to = convertCase(tag.name, options);
    if (to === tag.name) continue; // already in the requested style
    rows.push(row({ kind: "rename", from: tag, to }));
  }
  return finalize(rows, allTags);
}

export function buildUnifyPlan(
  sources: readonly TagRef[],
  target: string,
  allTags: readonly TagRef[],
): ChangePlan {
  const to = cleanName(target);
  // finalize flags merges: into an existing tag, or several sources into a
  // new one. Renaming one tag to a new name merges nothing.
  const rows = sources
    .filter((tag) => tag.name !== to)
    .map((tag) => row({ kind: "rename", from: tag, to }));
  return finalize(rows, allTags);
}

export function buildRemovePlan(
  selected: readonly TagRef[],
  allTags: readonly TagRef[],
): ChangePlan {
  const rows = selected.map((tag) => {
    const r = row({ kind: "remove", tag });
    if (tag.color) r.warnings.push("loses-color");
    return r;
  });
  return finalize(rows, allTags);
}

/**
 * Merge every non-canonical member into the canonical one. Members with the
 * canonical's name but the other type are re-typed instead (items keep the tag).
 * `chosen` maps a group to the survivor the user picked (default: suggested).
 * The survivor is a name: if it exists as a manual tag, that one survives,
 * so merging never turns manual tags automatic (as in pickCanonical).
 */
export function buildDuplicatePlan(
  groups: readonly DuplicateGroup[],
  allTags: readonly TagRef[],
  chosen: ReadonlyMap<DuplicateGroup, TagRef> = new Map(),
): ChangePlan {
  const rows: PlanRow[] = [];
  for (const group of groups) {
    const picked = chosen.get(group) ?? group.canonical;
    const canonical = preferManual(group.members, picked.name) ?? picked;
    for (const member of group.members) {
      if (member === canonical) continue;
      if (member.name === canonical.name) {
        if (member.type !== canonical.type) {
          rows.push(
            row({ kind: "retype", tag: member, toType: canonical.type }),
          );
        }
        continue;
      }
      rows.push(row({ kind: "rename", from: member, to: canonical.name }));
    }
  }
  const plan = finalize(rows, allTags);
  for (const r of plan.rows)
    if (r.op.kind === "rename" && !r.error) r.merges = true;
  return plan;
}

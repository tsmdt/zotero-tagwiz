import { DuplicateTier, duplicateKey, tierRank } from "./normalize";
import type { TagRef } from "./types";

export interface DuplicateGroup {
  /** Lowest tier at which all members already match. */
  matchedBy: DuplicateTier;
  members: TagRef[];
  /** Suggested survivor; the user may pick another one. */
  canonical: TagRef;
}

export interface FuzzyPair {
  a: TagRef;
  b: TagRef;
  reason: "typo" | "plural";
}

/**
 * Most-used first, then colored, then manual, then a stable name order
 * (prefers names containing uppercase, i.e. the "nicer" spelling, then lexical).
 */
export function pickCanonical(members: readonly TagRef[]): TagRef {
  const hasUpper = (t: TagRef) => t.name !== t.name.toLowerCase();
  return [...members].sort(
    (x, y) =>
      y.itemCount - x.itemCount ||
      Number(!!y.color) - Number(!!x.color) ||
      x.type - y.type ||
      Number(hasUpper(y)) - Number(hasUpper(x)) ||
      (x.name < y.name ? -1 : x.name > y.name ? 1 : 0),
  )[0];
}

/**
 * Group tags that are duplicates up to `maxTier` (tiers are cumulative).
 * Groups come back biggest-impact first. Never returns single-member groups.
 */
export function findDuplicateGroups(
  tags: readonly TagRef[],
  maxTier: DuplicateTier,
): DuplicateGroup[] {
  const buckets = new Map<string, TagRef[]>();
  for (const tag of tags) {
    const key = duplicateKey(tag.name, maxTier);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(tag);
    else buckets.set(key, [tag]);
  }

  const groups: DuplicateGroup[] = [];
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    const matchedBy =
      (["exact", "case", "normalized"] as const)
        .slice(0, tierRank(maxTier) + 1)
        .find((tier) => {
          const first = duplicateKey(members[0].name, tier);
          return members.every((m) => duplicateKey(m.name, tier) === first);
        }) ?? maxTier;
    groups.push({ matchedBy, members, canonical: pickCanonical(members) });
  }
  return groups.sort(
    (a, b) =>
      sum(b.members) - sum(a.members) ||
      (a.canonical.name < b.canonical.name ? -1 : 1),
  );
}

function sum(members: readonly TagRef[]): number {
  return members.reduce((n, m) => n + m.itemCount, 0);
}

/** Levenshtein distance <= 1 (cheap early-out; no full matrix). */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1);
  return la > lb
    ? a.slice(i + 1) === b.slice(i)
    : b.slice(i + 1) === a.slice(i);
}

/**
 * Suggest-only candidates: single typos and simple plurals among tags that are
 * NOT already exact/case/normalized duplicates. Names must be >= 5 chars and
 * share a first character to keep false positives and runtime down.
 */
export function findFuzzyPairs(tags: readonly TagRef[]): FuzzyPair[] {
  const items = tags
    .map((tag) => ({ tag, key: duplicateKey(tag.name, "normalized") }))
    .filter((x) => x.key.length >= 5);
  const byFirst = new Map<string, typeof items>();
  for (const item of items) {
    const bucket = byFirst.get(item.key[0]);
    if (bucket) bucket.push(item);
    else byFirst.set(item.key[0], [item]);
  }

  const pairs: FuzzyPair[] = [];
  for (const bucket of byFirst.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const x = bucket[i];
        const y = bucket[j];
        if (x.key === y.key || !withinOneEdit(x.key, y.key)) continue;
        const [short, long] =
          x.key.length <= y.key.length ? [x.key, y.key] : [y.key, x.key];
        const plural = long === short + "s";
        pairs.push({ a: x.tag, b: y.tag, reason: plural ? "plural" : "typo" });
      }
    }
  }
  return pairs;
}

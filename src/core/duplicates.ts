import { compareCodeUnits, getOrCreate } from "./collections";
import { DUPLICATE_TIERS, DuplicateTier, duplicateKey } from "./normalize";
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
 * The manual tag named `name` among `members`, else the automatic one: a
 * manual assertion wins over an automatic one of the same name.
 */
export function preferManual(
  members: readonly TagRef[],
  name: string,
): TagRef | undefined {
  return (
    members.find((m) => m.name === name && m.type === 0) ??
    members.find((m) => m.name === name)
  );
}

/**
 * Most-used name first (manual and automatic uses counted together), then
 * colored, then manual, then a stable name order (prefers names containing
 * uppercase, i.e. the "nicer" spelling, then lexical).
 * If the winning name also exists as a manual tag, the manual one is returned,
 * so merging never turns manual tags into automatic ones by default.
 */
export function pickCanonical(members: readonly TagRef[]): TagRef {
  const hasUpper = (t: TagRef) => t.name !== t.name.toLowerCase();
  const uses = new Map<string, number>();
  for (const m of members)
    uses.set(m.name, (uses.get(m.name) ?? 0) + m.itemCount);
  const best = [...members].sort(
    (x, y) =>
      uses.get(y.name)! - uses.get(x.name)! ||
      Number(!!y.color) - Number(!!x.color) ||
      x.type - y.type ||
      Number(hasUpper(y)) - Number(hasUpper(x)) ||
      compareCodeUnits(x.name, y.name),
  )[0];
  return preferManual(members, best.name) ?? best;
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
    getOrCreate(buckets, duplicateKey(tag.name, maxTier), () => []).push(tag);
  }

  const groups: DuplicateGroup[] = [];
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    // All members share the key of maxTier, so the search ends there at the
    // latest.
    const matchedBy =
      DUPLICATE_TIERS.find((tier) => {
        const first = duplicateKey(members[0].name, tier);
        return members.every((m) => duplicateKey(m.name, tier) === first);
      }) ?? maxTier;
    groups.push({ matchedBy, members, canonical: pickCanonical(members) });
  }
  return groups.sort(
    (a, b) =>
      sum(b.members) - sum(a.members) ||
      compareCodeUnits(a.canonical.name, b.canonical.name),
  );
}

function sum(members: readonly TagRef[]): number {
  return members.reduce((n, m) => n + m.itemCount, 0);
}

/**
 * Suggest-only candidates: single typos and simple plurals among tags that are
 * NOT already exact/case/normalized duplicates. Names must be >= 5 chars and
 * share a first character to keep false positives down. A name used as manual
 * and automatic tag counts once, and so do names that are duplicates of each
 * other ("Neuron", "neuron"): the most-used one stands for them, as the
 * duplicate groups above the suggestions merge them anyway. Most-used pairs
 * come first.
 *
 * Runs in O(n · length²) instead of comparing all pairs: keys one edit apart
 * either share a "deleted at i" variant (substitution at i), or one key is
 * a deletion variant of the other (insertion/deletion).
 */
export function findFuzzyPairs(tags: readonly TagRef[]): FuzzyPair[] {
  const byName = new Map<string, TagRef>();
  for (const tag of tags) {
    const seen = byName.get(tag.name);
    if (!seen || tag.itemCount > seen.itemCount) byName.set(tag.name, tag);
  }
  const byNormalized = new Map<string, TagRef>();
  for (const tag of byName.values()) {
    const key = duplicateKey(tag.name, "normalized");
    const seen = byNormalized.get(key);
    if (
      !seen ||
      tag.itemCount > seen.itemCount ||
      (tag.itemCount === seen.itemCount && tag.name < seen.name)
    ) {
      byNormalized.set(key, tag);
    }
  }
  const items = [...byNormalized]
    .map(([key, tag]) => ({ tag, key, chars: Array.from(key) }))
    .filter((x) => x.key.length >= 5);
  type Item = (typeof items)[number];

  const byKey = new Map<string, Item[]>();
  const bySubstitution = new Map<string, Item[]>();
  const push = (map: Map<string, Item[]>, key: string, item: Item) =>
    getOrCreate(map, key, () => []).push(item);
  const without = (chars: string[], i: number) =>
    chars.slice(0, i).join("") + chars.slice(i + 1).join("");
  for (const item of items) {
    push(byKey, item.key, item);
    // i = 0 would change the first character.
    for (let i = 1; i < item.chars.length; i++) {
      push(bySubstitution, `${i}\u0000${without(item.chars, i)}`, item);
    }
  }

  const pairs: FuzzyPair[] = [];
  const seen = new Set<string>();
  const add = (x: Item, y: Item) => {
    if (x.key === y.key || x.chars[0] !== y.chars[0]) return;
    const id = [x.tag.name, y.tag.name].sort().join("\u0000");
    if (seen.has(id)) return;
    seen.add(id);
    const [short, long] =
      x.key.length <= y.key.length ? [x.key, y.key] : [y.key, x.key];
    const plural = long === short + "s";
    pairs.push({ a: x.tag, b: y.tag, reason: plural ? "plural" : "typo" });
  };
  for (const bucket of bySubstitution.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) add(bucket[i], bucket[j]);
    }
  }
  for (const item of items) {
    for (let i = 0; i < item.chars.length; i++) {
      for (const shorter of byKey.get(without(item.chars, i)) ?? []) {
        add(shorter, item);
      }
    }
  }
  return pairs.sort(
    (p, q) =>
      q.a.itemCount + q.b.itemCount - (p.a.itemCount + p.b.itemCount) ||
      compareCodeUnits(
        `${p.a.name}\u0000${p.b.name}`,
        `${q.a.name}\u0000${q.b.name}`,
      ),
  );
}

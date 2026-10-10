export type DuplicateTier = "exact" | "case" | "normalized";

const TIER_ORDER: DuplicateTier[] = ["exact", "case", "normalized"];

export function tierRank(tier: DuplicateTier): number {
  return TIER_ORDER.indexOf(tier);
}

/** A Latin or Greek letter followed by the combining marks (accents) to drop. */
const ACCENTED = /([\p{Script=Latin}\p{Script=Greek}])\p{M}+/gu;

/** NFC + trim, what Zotero itself stores (see Zotero.Tags.cleanData). */
export function cleanName(name: string): string {
  return name.normalize("NFC").trim();
}

/**
 * Key under which two tag names count as duplicates at the given tier.
 *
 * - exact:      same name after NFC + trim
 * - case:       ... ignoring case and runs of whitespace
 * - normalized: ... treating whitespace, "_" and "-" as the same separator,
 *               splitting camelCase, folding accents on Latin and Greek
 *               letters and compatibility forms.
 *
 * Other punctuation is deliberately kept, so "C++", "C#" and "C" never collide.
 * Combining marks of other scripts are kept too: there they tell letters
 * apart (Japanese が/か, Devanagari vowel signs, Cyrillic й/и).
 */
export function duplicateKey(name: string, tier: DuplicateTier): string {
  const clean = cleanName(name);
  if (tier === "exact") return clean;

  const spaced = clean.replace(/\s+/gu, " ");
  const lowered = spaced.toLowerCase();
  if (tier === "case") return lowered;

  const folded = spaced
    .normalize("NFKD")
    .replace(ACCENTED, "$1")
    .normalize("NFC")
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .replace(/[\s_-]+/gu, " ")
    .trim();
  // Separator-only names ("-", "_") would all collapse to ""; keep them apart.
  return folded === "" ? lowered : folded;
}

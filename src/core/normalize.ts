import { CAMEL_BOUNDARY, lower, SEPARATORS } from "./caseStyles";

/** Duplicate tiers, each matching more than the one before. */
export const DUPLICATE_TIERS = ["exact", "case", "normalized"] as const;

export type DuplicateTier = (typeof DUPLICATE_TIERS)[number];

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
  const lowered = lower(spaced);
  if (tier === "case") return lowered;

  const folded = spaced
    .normalize("NFKD")
    .replace(ACCENTED, "$1")
    .normalize("NFC")
    .replace(CAMEL_BOUNDARY, "$1 $2")
    .toLowerCase()
    .split(SEPARATORS)
    .join(" ")
    .trim();
  // Separator-only names ("-", "_") would all collapse to ""; keep them apart.
  return folded === "" ? lowered : folded;
}

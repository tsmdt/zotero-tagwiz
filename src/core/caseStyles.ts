import type { CaseOptions } from "./types";

export const DEFAULT_SMALL_WORDS: readonly string[] = [
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "in",
  "nor",
  "of",
  "on",
  "or",
  "per",
  "the",
  "to",
  "vs",
  "via",
];

const WORD_RE = /[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’]*/gu;

/** Word separators of snake/kebab/camel/Pascal case, as in duplicateKey. */
const SEPARATORS = /[\s_-]+/u;

/**
 * Split an identifier-like string into words: on whitespace, "_" and "-",
 * and on lower→Upper and ACRONYMWord boundaries. Other punctuation stays in
 * its word, so "C++ programming" and "C programming" never collide.
 */
export function splitWords(input: string): string[] {
  return input
    .split(SEPARATORS)
    .flatMap((part) =>
      part
        .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1\u0000$2")
        .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1\u0000$2")
        .split("\u0000"),
    )
    .filter((w) => w.length > 0);
}

/**
 * Locale-independent lower case. "İ" (U+0130) would otherwise become "i" plus
 * a combining dot above, which renders as a stray dot.
 */
export function lower(text: string): string {
  return text.replace(/\u0130/gu, "I").toLowerCase();
}

/** Leading characters that are neither letters nor digits ("#", "+", "'"). */
const LEADING_SYMBOLS = /^[^\p{L}\p{N}]*/u;

/** Upper-case the first letter or digit, lower-case the rest: "#todo" -> "#Todo". */
function capitalize(word: string): string {
  const symbols = LEADING_SYMBOLS.exec(word)![0];
  const [first = "", ...rest] = Array.from(word.slice(symbols.length));
  return symbols + first.toUpperCase() + lower(rest.join(""));
}

function isAcronym(word: string): boolean {
  const letters = word.replace(/[^\p{L}]/gu, "");
  return (
    letters.length >= 2 &&
    letters === letters.toUpperCase() &&
    letters !== letters.toLowerCase()
  );
}

/**
 * Mixed case with a capital after the first letter: "iPhone", "McDonald's",
 * "LaTeX". Leading symbols don't count as the first letter: "#ToRead" is a
 * capitalized word with a symbol, not mixed case.
 */
function isMixedCase(word: string): boolean {
  const body = word.replace(LEADING_SYMBOLS, "");
  const rest = Array.from(body).slice(1).join("");
  return /\p{Lu}/u.test(rest) && /\p{Ll}/u.test(body);
}

/** A word with a letter or digit, unlike "#" or "+" on their own. */
const hasWordChar = (word: string) => /[\p{L}\p{N}]/u.test(word);

function convertBody(body: string, opts: CaseOptions): string {
  const keepAcronyms = opts.keepAcronyms ?? true;
  const keep = (word: string) =>
    keepAcronyms && (isAcronym(word) || isMixedCase(word));
  switch (opts.style) {
    case "lower":
      return body.replace(WORD_RE, (word) => (keep(word) ? word : lower(word)));
    case "upper":
      return body.toUpperCase();
    case "title": {
      const small = new Set(
        (opts.smallWords ?? DEFAULT_SMALL_WORDS).map((w) => lower(w)),
      );
      let index = 0;
      return body.replace(WORD_RE, (word) => {
        const first = index++ === 0;
        if (keep(word)) return word;
        const lowered = lower(word);
        return !first && small.has(lowered) ? lowered : capitalize(word);
      });
    }
    case "sentence": {
      let index = 0;
      return body.replace(WORD_RE, (word) => {
        const first = index++ === 0;
        if (keep(word)) return word;
        return first ? capitalize(word) : lower(word);
      });
    }
    case "camel":
    case "pascal":
    case "snake":
    case "kebab": {
      // Leading/trailing "_" or "-" mark a tag ("_todo" sorts first in
      // Zotero's tag selector): keep them instead of reading them as
      // separators. A tag of separators only has no words: "".
      const [, lead, core, trail] = /^([_-]*)(.*?)([_-]*)$/su.exec(body)!;
      if (!/[^\s_-]/u.test(core)) return "";
      return lead + convertIdentifier(core, opts, keep) + trail;
    }
  }
}

function convertIdentifier(
  body: string,
  opts: CaseOptions,
  keep: (word: string) => boolean,
): string {
  const keepAcronyms = opts.keepAcronyms ?? true;
  switch (opts.style) {
    case "camel":
    case "pascal": {
      // Already a single camel/Pascal identifier: leave it alone. Re-splitting
      // is ambiguous (e.g. "aBCD") and would make the conversion non-idempotent.
      // A camel identifier may start with a kept acronym ("LLMframework").
      // Leading symbols don't decide the case: "#toRead" is camel.
      // This holds without keepAcronyms too: PascalCase "ABCD" (from
      // "a b c d") cannot be told apart from an acronym, so "HELLO" stays.
      const start = body.replace(LEADING_SYMBOLS, "");
      const isIdentifier = !SEPARATORS.test(body);
      const startsRight =
        opts.style === "camel"
          ? /^\p{Ll}/u.test(start) ||
            (keepAcronyms && /^\p{Lu}{2}/u.test(start))
          : /^\p{Lu}/u.test(start);
      if (isIdentifier && startsRight) return body;
      // Kept acronyms don't count as the leading camelCase word:
      // "LLM Framework Studies" -> "LLMframeworkStudies". Neither do words of
      // symbols only: "# to read" -> "#toRead".
      let lowerNext = opts.style === "camel";
      return splitWords(body)
        .map((w) => {
          if (keep(w) || !hasWordChar(w)) return w;
          const out = lowerNext ? lower(w) : capitalize(w);
          lowerNext = false;
          return out;
        })
        .join("");
    }
    case "snake":
      return splitWords(body)
        .map((w) => (keep(w) ? w : lower(w)))
        .join("_");
    default:
      return splitWords(body)
        .map((w) => (keep(w) ? w : lower(w)))
        .join("-");
  }
}

/**
 * Convert a tag name to the requested case style. Locale-independent
 * (String#toLowerCase/toUpperCase, never the toLocale* variants).
 * Returns the NFC-normalized, trimmed result; may be "" for degenerate input.
 */
export function convertCase(name: string, opts: CaseOptions): string {
  const input = name.normalize("NFC");
  const wanted = (opts.prefix ?? "").normalize("NFC");
  const prefix = wanted && input.startsWith(wanted) ? wanted : "";
  const body = input.slice(prefix.length);
  const lead = /^\s*/u.exec(body)?.[0] ?? "";
  const result = convertBody(body.slice(lead.length), opts);
  return (prefix + (prefix ? lead : "") + result).normalize("NFC").trim();
}

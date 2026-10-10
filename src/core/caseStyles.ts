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

/**
 * Split an identifier-like string into words: on anything that is not a
 * letter/number/mark, and on lower→Upper and ACRONYMWord boundaries.
 */
export function splitWords(input: string): string[] {
  return input
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .flatMap((part) =>
      part
        .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1\u0000$2")
        .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1\u0000$2")
        .split("\u0000"),
    )
    .filter((w) => w.length > 0);
}

function capitalize(word: string): string {
  const [first = "", ...rest] = Array.from(word);
  return first.toUpperCase() + rest.join("").toLowerCase();
}

function isAcronym(word: string): boolean {
  const letters = word.replace(/[^\p{L}]/gu, "");
  return (
    letters.length >= 2 &&
    letters === letters.toUpperCase() &&
    letters !== letters.toLowerCase()
  );
}

function convertBody(body: string, opts: CaseOptions): string {
  const keepAcronyms = opts.keepAcronyms ?? true;
  const keep = (word: string) => keepAcronyms && isAcronym(word);
  switch (opts.style) {
    case "lower":
      return body.replace(WORD_RE, (word) =>
        keep(word) ? word : word.toLowerCase(),
      );
    case "upper":
      return body.toUpperCase();
    case "title": {
      const small = new Set(
        (opts.smallWords ?? DEFAULT_SMALL_WORDS).map((w) => w.toLowerCase()),
      );
      let index = 0;
      return body.replace(WORD_RE, (word) => {
        const first = index++ === 0;
        if (keep(word)) return word;
        const lower = word.toLowerCase();
        return !first && small.has(lower) ? lower : capitalize(word);
      });
    }
    case "sentence": {
      let index = 0;
      return body.replace(WORD_RE, (word) => {
        const first = index++ === 0;
        if (keep(word)) return word;
        return first ? capitalize(word) : word.toLowerCase();
      });
    }
    case "camel":
    case "pascal": {
      // Already a single camel/Pascal identifier: leave it alone. Re-splitting
      // is ambiguous (e.g. "aBCD") and would make the conversion non-idempotent.
      // A camel identifier may start with a kept acronym ("LLMframework").
      const isIdentifier = !/[^\p{L}\p{M}\p{N}]/u.test(body);
      const startsRight =
        opts.style === "camel"
          ? /^\p{Ll}/u.test(body) || (keepAcronyms && /^\p{Lu}{2}/u.test(body))
          : /^\p{Lu}/u.test(body);
      if (isIdentifier && startsRight) return body;
      // Kept acronyms don't count as the leading camelCase word:
      // "LLM Framework Studies" -> "LLMframeworkStudies".
      let lowerNext = opts.style === "camel";
      return splitWords(body)
        .map((w) => {
          if (keep(w)) return w;
          const out = lowerNext ? w.toLowerCase() : capitalize(w);
          lowerNext = false;
          return out;
        })
        .join("");
    }
    case "snake":
      return splitWords(body)
        .map((w) => (keep(w) ? w : w.toLowerCase()))
        .join("_");
    case "kebab":
      return splitWords(body)
        .map((w) => (keep(w) ? w : w.toLowerCase()))
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
  let prefix = "";
  let body = input;
  if (opts.preservePrefix) {
    const idx = Math.max(input.lastIndexOf(":"), input.lastIndexOf("/"));
    if (idx >= 0) {
      prefix = input.slice(0, idx + 1);
      body = input.slice(idx + 1);
    }
  }
  const lead = /^\s*/u.exec(body)?.[0] ?? "";
  const result = convertBody(body.slice(lead.length), opts);
  return (prefix + (prefix ? lead : "") + result).normalize("NFC").trim();
}

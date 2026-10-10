/** 0 = manual, 1 = automatic (mirrors Zotero's tag types). */
export type TagType = 0 | 1;

export interface TagRef {
  name: string;
  type: TagType;
  /** Number of items in the library carrying this tag (trashed items included). */
  itemCount: number;
  /** Items inside the selected collection scope (trashed excluded); unset without a scope. */
  scopeCount?: number;
  color?: string;
  /** Position within the library's colored-tag list. */
  position?: number;
}

export type CaseStyle =
  | "lower"
  | "upper"
  | "title"
  | "sentence"
  | "camel"
  | "pascal"
  | "snake"
  | "kebab";

export interface CaseOptions {
  style: CaseStyle;
  /**
   * Keep all-caps words of 2+ letters ("NLP") and mixed-case words ("iPhone")
   * unchanged in every style but upper case. Default true.
   */
  keepAcronyms?: boolean;
  /** Tags starting with this exact prefix (e.g. "TECH: ") keep it unchanged. Default "" (off). */
  prefix?: string;
  /** Title case: words kept lowercase unless first. */
  smallWords?: readonly string[];
}

/**
 * Operations are name-based, like Zotero.Tags.rename: a name that exists with
 * both types shows up as two TagRefs, and the engine groups them by name.
 */
export type Op =
  | { kind: "rename"; from: TagRef; to: string }
  | { kind: "retype"; tag: TagRef; toType: TagType }
  | { kind: "remove"; tag: TagRef };

export interface PlanRow {
  op: Op;
  /** User may untick a row in the preview. Rows with an error are never included. */
  included: boolean;
  /** Target name is shared with another tag/row, so items will be merged. */
  merges: boolean;
  warnings: string[];
  /** Blocking problem; the row cannot be applied. */
  error?: string;
}

export interface ChangePlan {
  rows: PlanRow[];
}

export const MAX_TAG_LENGTH = 255;

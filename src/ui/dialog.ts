import { DEFAULT_SMALL_WORDS } from "../core/caseStyles";
import {
  DuplicateGroup,
  findDuplicateGroups,
  findFuzzyPairs,
  type FuzzyPair,
} from "../core/duplicates";
import {
  EditKind,
  formatDate,
  formatTime,
  historyAction,
  redoChain,
  undoChain,
} from "../core/history";
import type { DuplicateTier } from "../core/normalize";
import {
  buildCasePlan,
  buildDuplicatePlan,
  buildRemovePlan,
  buildUnifyPlan,
  includedOps,
} from "../core/plan";
import { TaskError, toTasks } from "../core/tasks";
import type {
  CaseOptions,
  CaseStyle,
  ChangePlan,
  Op,
  PlanRow,
  TagRef,
} from "../core/types";
import { applyOps, redoTo, undoTo } from "../zotero/engine";
import { preflight } from "../zotero/guard";
import { type HistoryEntry, listHistory } from "../zotero/journal";
import { loadTags, measureImpact, type Scope } from "../zotero/tagStore";
import { FluentMessageId } from "../../typings/i10n";
import { getString } from "../utils/locale";
import { isWindowAlive } from "../utils/window";
import { append, clear, clearable, h } from "./dom";

export interface DialogParams {
  libraryID: number;
  collection?: { id: number; name: string };
}

type TabID = "case" | "unify" | "duplicates" | "remove" | "history";
const TABS: TabID[] = ["case", "unify", "duplicates", "remove", "history"];

/** One listed tag name; `refs` are all of its types in the whole library. */
interface NameRow {
  name: string;
  refs: TagRef[];
  items: number;
  scopeItems?: number;
  type: TagKind;
  color?: string;
}

/** A name can exist as a manual tag, an automatic one, or both. */
type TagKind = "manual" | "automatic" | "both";
const TAG_KINDS: Record<TagKind, { rank: number; label: FluentMessageId }> = {
  manual: { rank: 0, label: "type-manual" },
  both: { rank: 1, label: "type-both" },
  automatic: { rank: 2, label: "type-automatic" },
};

function tagKind(refs: TagRef[]): TagKind {
  const manual = refs.some((r) => r.type !== 1);
  const auto = refs.some((r) => r.type === 1);
  return manual && auto ? "both" : auto ? "automatic" : "manual";
}

/** Preview rows that belong together (same name, e.g. manual + automatic). */
interface DisplayRow {
  key: string;
  rows: PlanRow[];
  op: Op;
  items: number;
  included: boolean;
  blocked: boolean;
}

/** Sortable columns of the tag list. */
type SortKey = "name" | "type" | "items" | "scopeItems";
interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}
/** `rows` are kept in this order, so it needs no sorting. */
const DEFAULT_SORT: Sort = { key: "name", dir: "asc" };

/** Direction of a column's first click: counts start with the most used. */
const FIRST_DIR: Record<SortKey, Sort["dir"]> = {
  name: "asc",
  type: "asc",
  items: "desc",
  scopeItems: "desc",
};

/**
 * Header clicks toggle the name column; the other columns cycle through their
 * first direction, the other one, then back to name order.
 */
function nextSort(current: Sort, key: SortKey): Sort {
  const first = FIRST_DIR[key];
  const flip = (dir: Sort["dir"]) => (dir === "asc" ? "desc" : "asc");
  if (current.key !== key) return { key, dir: first };
  if (key === "name") return { key, dir: flip(current.dir) };
  return current.dir === first ? { key, dir: flip(first) } : DEFAULT_SORT;
}

function compareRows(key: SortKey): (a: NameRow, b: NameRow) => number {
  switch (key) {
    case "name":
      return (a, b) => byName(a.name, b.name);
    case "type":
      return (a, b) => TAG_KINDS[a.type].rank - TAG_KINDS[b.type].rank;
    default:
      return (a, b) => (a[key] ?? 0) - (b[key] ?? 0);
  }
}

/** Narrowest a table column can be dragged, in px. */
const MIN_COLUMN_WIDTH = 32;

/** Tables whose columns the user can resize. */
type ResizableTable = "tags" | "preview" | "history";

const MAX_FUZZY = 100;
/** Rows rendered at most in the tag list and the preview (all still apply). */
const MAX_ROWS = 1000;
const FILTER_DELAY = 150;
/** Wait for changes made elsewhere in Zotero to settle before reloading. */
const RELOAD_DELAY = 500;
/** Tag names listed by name in the Remove confirmation, at most. */
const MAX_CONFIRM_NAMES = 10;
const IMPACT_DELAY = 250;
const CASE_STYLES: Array<[CaseStyle, FluentMessageId]> = [
  ["lower", "case-lower"],
  ["upper", "case-upper"],
  ["title", "case-title"],
  ["sentence", "case-sentence"],
  ["camel", "case-camel"],
  ["pascal", "case-pascal"],
  ["snake", "case-snake"],
  ["kebab", "case-kebab"],
];
const DUP_TIERS: Array<[DuplicateTier, FluentMessageId]> = [
  ["exact", "dup-exact"],
  ["case", "dup-case"],
  ["normalized", "dup-normalized"],
];

const refKey = (t: TagRef) => `${t.name}\u0000${t.type}`;
const groupKey = (g: DuplicateGroup) =>
  g.members.map(refKey).sort().join("\u0001");
const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" }) || (a < b ? -1 : 1);

function opName(op: Op): string {
  return op.kind === "rename" ? op.from.name : op.tag.name;
}

/**
 * Names whose items an edit changes. A rename's target is not one of them:
 * items that already carry only the target keep it unchanged.
 */
function editedNames(ops: readonly Op[]): string[] {
  return [...new Set(ops.map(opName))];
}

function opKey(op: Op): string {
  const type = op.kind === "rename" ? op.from.type : op.tag.type;
  return `${op.kind}\u0000${opName(op)}\u0000${op.kind === "rename" ? op.to : ""}\u0000${op.kind === "retype" ? type : ""}`;
}

export class TagWizDialog {
  private readonly doc: Document;
  private readonly root: HTMLElement;
  private libraryID: number;
  private collection?: { id: number; name: string };

  private tab: TabID = "case";
  private includeSub = true;
  private filter = "";
  private sort: Sort = DEFAULT_SORT;
  /** Column widths in px, in column order, of each table the user resized. */
  private columnWidths: Partial<Record<ResizableTable, number[]>> = {};
  private allTags: TagRef[] = [];
  private rows: NameRow[] = [];
  /** Tags were read at least once; until then there is nothing to count. */
  private loaded = false;
  private selected = new Set<string>();
  /** The tag clicked last: where a Shift + Click range starts. */
  private rangeAnchor?: string;
  /** Names currently rendered in the tag list (filter and MAX_ROWS applied). */
  private shownNames = new Set<string>();
  private excluded = new Set<string>();

  private caseOpts: CaseOptions = {
    style: "title",
    keepAcronyms: true,
    prefix: "",
    smallWords: DEFAULT_SMALL_WORDS,
  };
  private unifyTarget = "";
  private targetTouched = false;

  private dupTier: DuplicateTier = "case";
  private groups: DuplicateGroup[] = [];
  /** Groups the user unticked; the others are merged. Kept across reloads. */
  private groupOff = new Set<string>();
  /** Survivor the user picked per group. Kept across reloads. */
  private chosen = new Map<string, TagRef>();
  /** Fuzzy pairs of the listed tags; computed on demand, reset by reload. */
  private fuzzy?: FuzzyPair[];

  private plan: ChangePlan = { rows: [] };
  private busy = false;
  private cancelRequested = false;
  /** The user tried to close the window during a run. */
  private closeWhenDone = false;
  private status: { text: string; kind: "info" | "error" } = {
    text: "",
    kind: "info",
  };
  private impactText = "";
  /**
   * Which message the footer shows next to the tag count: the one set last.
   * Without an impact (nothing to apply) it shows the status.
   */
  private latest: "status" | "impact" = "status";
  private impactSeq = 0;
  private impactTimer?: number;
  private filterTimer?: number;
  private reloadTimer?: number;
  /** Bumped by every loadData; an older, slower one must not overwrite it. */
  private loadSeq = 0;
  /** This library's runs, newest first; loaded on the History tab only. */
  private history: HistoryEntry[] = [];
  /** Journals that could not be read; any of them may be this library's. */
  private historyUnreadable: string[] = [];
  /** The run whose "before" state Restore returns to. */
  private historySelected?: string;

  private headerEl!: HTMLElement;
  private menuEl!: HTMLElement;
  private mainEl!: HTMLElement;
  private leftEl!: HTMLElement;
  private controlsEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private footerEl!: HTMLElement;

  constructor(
    private readonly win: Window,
    params: DialogParams,
  ) {
    this.doc = win.document;
    this.root = this.doc.getElementById("tagwiz-root") as HTMLElement;
    this.libraryID = params.libraryID;
    this.collection = params.collection;
  }

  /** False once the window is closed; its DOM must not be touched then. */
  private get alive(): boolean {
    return !!isWindowAlive(this.win);
  }

  private libraryName(): string {
    const library = Zotero.Libraries.get(this.libraryID);
    return library ? library.name : "";
  }

  // ------------------------------------------------------------- data

  private get scope(): Scope | undefined {
    return this.collection
      ? {
          collectionID: this.collection.id,
          includeSubcollections: this.includeSub,
        }
      : undefined;
  }

  async init() {
    this.doc.title = getString("dialog-title");
    this.checkLibrary();
    this.observeChanges();
    // Closing mid-run would abandon the run with no UI: stop at the next task
    // boundary instead, then close.
    this.win.addEventListener("close", (e: Event) => {
      if (!this.busy) return;
      e.preventDefault();
      this.closeWhenDone = true;
      this.cancelRequested = true;
      this.setStatus(getString("status-closing"));
    });
    this.buildSkeleton();
    await this.reload();
  }

  private checkLibrary() {
    const library = Zotero.Libraries.get(this.libraryID);
    if (!library) {
      this.setStatus(getString("error-no-library"), "error");
    } else if (!library.editable) {
      this.setStatus(getString("error-read-only"), "error");
    }
  }

  /**
   * Show another library or collection: TagWiz was opened again from there
   * while this window was open. Refused (false) during a run.
   */
  async setScope(params: DialogParams): Promise<boolean> {
    if (this.busy) return false;
    if (
      params.libraryID === this.libraryID &&
      params.collection?.id === this.collection?.id
    ) {
      return true;
    }
    this.libraryID = params.libraryID;
    this.collection = params.collection;
    this.selected.clear();
    this.excluded.clear();
    this.groupOff.clear();
    this.chosen.clear();
    this.unifyTarget = "";
    this.targetTouched = false;
    this.historySelected = undefined;
    this.filter = "";
    // The collection column comes and goes.
    this.columnWidths = {};
    // The rows are the old scope's until the reload below.
    this.loaded = false;
    this.status = { text: "", kind: "info" };
    this.checkLibrary();
    this.buildSkeleton();
    await this.reload();
    return true;
  }

  /**
   * Reload when tags change elsewhere in Zotero (main window, sync, other
   * plugins), so the list and the merge warnings are not stale. Changes
   * during a run are ours; the run reloads when it ends.
   */
  private observeChanges() {
    const id = Zotero.Notifier.registerObserver(
      {
        notify: (
          _event: string,
          type: string,
          ids: Array<string | number>,
          extraData: Record<string, any>,
        ) => {
          if (this.busy || !this.alive) return;
          const otherLibrary =
            type === "item-tag" &&
            ids.every((x) => {
              const lib = extraData?.[x]?.libraryID;
              return lib !== undefined && lib !== this.libraryID;
            });
          // Synced settings ("<libraryID>/<name>") also hold e.g. the
          // reader's last page; only this library's tag colors matter here.
          const otherSetting =
            type === "setting" && !ids.includes(`${this.libraryID}/tagColors`);
          if (otherLibrary || otherSetting) return;
          this.win.clearTimeout(this.reloadTimer);
          this.reloadTimer = this.win.setTimeout(
            () => void this.reload(),
            RELOAD_DELAY,
          );
        },
      },
      ["item-tag", "tag", "setting"],
      "tagwiz",
    );
    this.win.addEventListener("unload", () =>
      Zotero.Notifier.unregisterObserver(id),
    );
  }

  /** Re-read tags from the database and redraw everything. */
  private async reload() {
    if (!this.alive || this.busy) return;
    try {
      // Superseded by a newer load (e.g. setScope meanwhile): that one draws.
      if (!(await this.loadData())) return;
    } catch (e) {
      Zotero.logError(e as Error);
      this.setStatus(
        getString("error-load", { args: { error: errorText(e) } }),
        "error",
      );
      return;
    }
    if (!this.alive) return;
    // Redrawing replaces the inputs: keep the caret where the user types.
    const active = this.doc.activeElement as HTMLInputElement | null;
    const focusID = active?.id;
    const caret = focusID ? active.selectionStart : null;
    // Redrawing also resets the lists' scroll positions, e.g. when a sync
    // changes a tag while the user is far down the list.
    const scrolls = [this.leftEl, this.previewEl].map((pane) => {
      const box = pane.querySelector(".tw-scroll-box");
      return box && { top: box.scrollTop, left: box.scrollLeft };
    });
    this.renderAll();
    [this.leftEl, this.previewEl].forEach((pane, i) => {
      const box = pane.querySelector(".tw-scroll-box");
      const scroll = scrolls[i];
      if (box && scroll) {
        box.scrollTop = scroll.top;
        box.scrollLeft = scroll.left;
      }
    });
    const again = focusID
      ? (this.doc.getElementById(focusID) as HTMLInputElement | null)
      : null;
    if (again) {
      again.focus();
      if (typeof caret === "number" && "setSelectionRange" in again) {
        again.setSelectionRange(caret, caret);
      }
    }
  }

  /**
   * Read tags (and undo state) for the current library and scope. Returns
   * false, changing nothing, if another loadData started meanwhile: loads can
   * overlap (Notifier, subcollection toggle, setScope), and a slower older
   * one would otherwise overwrite newer data, e.g. of another library.
   */
  private async loadData(): Promise<boolean> {
    const seq = ++this.loadSeq;
    const { libraryID, scope } = this;
    const allTags = await loadTags(libraryID);
    const scoped = scope ? await loadTags(libraryID, scope) : [];
    const history =
      this.tab === "history" ? await listHistory(libraryID) : undefined;
    if (seq !== this.loadSeq) return false;
    const listed = scope ? scoped : allTags;

    const refsByName = new Map<string, TagRef[]>();
    for (const tag of allTags) {
      const list = refsByName.get(tag.name) ?? [];
      list.push(tag);
      refsByName.set(tag.name, list);
    }
    const scopeByName = new Map<string, number>();
    for (const tag of scoped) {
      scopeByName.set(
        tag.name,
        (scopeByName.get(tag.name) ?? 0) + (tag.scopeCount ?? 0),
      );
    }
    const names = [...new Set(listed.map((t) => t.name))].sort(byName);
    this.allTags = allTags;
    this.rows = names.map((name) => {
      const refs = refsByName.get(name) ?? [];
      return {
        name,
        refs,
        items: refs.reduce((n, r) => n + r.itemCount, 0),
        scopeItems: scope ? scopeByName.get(name) : undefined,
        type: tagKind(refs),
        color: refs.find((r) => r.color)?.color,
      };
    });
    // Drop selections that no longer exist (e.g. after a rename).
    const existing = new Set(names);
    for (const name of [...this.selected]) {
      if (!existing.has(name)) this.selected.delete(name);
    }
    if (history) {
      this.history = history.entries;
      this.historyUnreadable = history.unreadable;
      // Pruned, discarded, or undone or redone meanwhile.
      if (!historyAction(history.entries, this.historySelected))
        this.historySelected = undefined;
    }
    this.fuzzy = undefined;
    this.recomputeGroups();
    this.loaded = true;
    return true;
  }

  private selectedRefs(): TagRef[] {
    return this.rows
      .filter((r) => this.selected.has(r.name))
      .flatMap((r) => r.refs);
  }

  private listedRefs(): TagRef[] {
    return this.rows.flatMap((r) => r.refs);
  }

  /** User choices (groupOff, chosen) stay valid: they are keyed by members. */
  private recomputeGroups() {
    this.groups = findDuplicateGroups(this.listedRefs(), this.dupTier);
  }

  // ------------------------------------------------------------- plan

  private computePlan(): ChangePlan {
    const refs = this.selectedRefs();
    let plan: ChangePlan;
    switch (this.tab) {
      case "case":
        plan = buildCasePlan(refs, this.caseOpts, this.allTags);
        break;
      case "unify":
        plan =
          refs.length && this.unifyTarget.trim()
            ? buildUnifyPlan(refs, this.unifyTarget, this.allTags)
            : { rows: [] };
        break;
      case "remove":
        plan = buildRemovePlan(refs, this.allTags);
        break;
      case "history":
        plan = { rows: [] };
        break;
      case "duplicates": {
        const active = this.groups.filter(
          (g) => !this.groupOff.has(groupKey(g)),
        );
        const chosen = new Map<DuplicateGroup, TagRef>();
        for (const g of active) {
          const pick = this.chosen.get(groupKey(g));
          // The current member: a reload replaces the TagRef objects.
          const member =
            pick && g.members.find((m) => refKey(m) === refKey(pick));
          if (member) chosen.set(g, member);
        }
        plan = buildDuplicatePlan(active, this.allTags, chosen);
        break;
      }
    }
    for (const row of plan.rows) {
      if (this.excluded.has(opKey(row.op))) row.included = false;
    }
    return plan;
  }

  private displayRows(): DisplayRow[] {
    const grouped = new Map<string, DisplayRow>();
    for (const row of this.plan.rows) {
      const key = opKey(row.op);
      const items =
        row.op.kind === "rename" ? row.op.from.itemCount : row.op.tag.itemCount;
      const existing = grouped.get(key);
      if (existing) {
        existing.rows.push(row);
        existing.items += items;
      } else {
        grouped.set(key, {
          key,
          rows: [row],
          op: row.op,
          items,
          included: row.included,
          blocked: !!row.error,
        });
      }
    }
    return [...grouped.values()];
  }

  private refreshPlan() {
    // A run applies the plan it started with; don't show another meanwhile.
    if (this.busy) return;
    this.plan = this.computePlan();
    this.renderPreview();
    this.renderFooter();
    this.scheduleImpact();
  }

  /** Impact needs a DB query: run it once the selection has settled. */
  private scheduleImpact() {
    this.win.clearTimeout(this.impactTimer);
    if (!includedOps(this.plan).length) {
      void this.updateImpact();
      return;
    }
    this.impactTimer = this.win.setTimeout(
      () => void this.updateImpact(),
      IMPACT_DELAY,
    );
  }

  private async updateImpact() {
    const seq = ++this.impactSeq;
    const ops = includedOps(this.plan);
    if (!ops.length) {
      this.impactText = "";
    } else {
      const names = editedNames(ops);
      let impact: { total: number; outsideScope: number };
      try {
        impact = await measureImpact(this.libraryID, names, this.scope);
      } catch (e) {
        Zotero.logError(e as Error);
        if (seq !== this.impactSeq) return;
        this.impactText = "";
        if (this.alive) this.renderFooter();
        return;
      }
      if (seq !== this.impactSeq) return; // a newer plan superseded this one
      const text = this.scope
        ? getString("impact", {
            args: { total: impact.total, outside: impact.outsideScope },
          })
        : getString("impact-library", { args: { total: impact.total } });
      // Only a new impact replaces the status: not the same one again, as
      // after a reload that left the plan as it was.
      if (text !== this.impactText) this.latest = "impact";
      this.impactText = text;
    }
    if (seq === this.impactSeq && this.alive) this.renderFooter();
  }

  // ----------------------------------------------------------- render

  private buildSkeleton() {
    const { doc } = this;
    clear(this.root);

    const header = h(doc, "div", { class: "tw-header" });
    this.headerEl = header;
    if (this.collection) {
      const sub = h(doc, "input", {
        type: "checkbox",
        id: "tw-sub",
        checked: this.includeSub,
        onchange: async (e: Event) => {
          this.includeSub = (e.target as HTMLInputElement).checked;
          await this.reload();
        },
      });
      append(header, [
        h(
          doc,
          "span",
          {},
          getString("scope-collection", {
            args: { collection: this.collection.name },
          }),
        ),
        h(doc, "div", { class: "tw-separator" }),
        h(
          doc,
          "label",
          { class: "tw-field", for: "tw-sub" },
          sub,
          getString("include-subcollections"),
        ),
      ]);
    } else {
      append(header, [
        h(
          doc,
          "span",
          {},
          getString("scope-library", {
            args: { library: this.libraryName() },
          }),
        ),
      ]);
    }

    const tabs = h(doc, "div", { class: "tw-tabs", role: "tablist" });
    for (const id of TABS) {
      tabs.appendChild(
        h(
          doc,
          "button",
          {
            class: "tw-tab",
            role: "tab",
            type: "button",
            "aria-selected": String(id === this.tab),
            "data-tab": id,
            onclick: () => this.switchTab(id),
          },
          getString(`tab-${id}` as FluentMessageId),
        ),
      );
    }

    this.controlsEl = h(doc, "div", { class: "tw-options" });
    const menu = h(doc, "div", { class: "tw-menu" }, tabs, this.controlsEl);
    this.menuEl = menu;

    this.leftEl = h(doc, "div", { class: "tw-pane" });
    this.previewEl = h(doc, "div", { class: "tw-pane" });
    const body = h(
      doc,
      "div",
      { class: "tw-main" },
      this.leftEl,
      this.previewEl,
    );
    this.mainEl = body;
    this.footerEl = h(doc, "div", { class: "tw-footer" });

    append(this.root, [header, menu, body, this.footerEl]);
  }

  private renderAll() {
    this.renderTabs();
    this.renderLeft();
    this.renderControls();
    this.refreshPlan();
  }

  private renderTabs() {
    for (const el of this.root.querySelectorAll<HTMLElement>(".tw-tab")) {
      el.setAttribute("aria-selected", String(el.dataset.tab === this.tab));
    }
  }

  private switchTab(id: TabID) {
    if (this.busy || id === this.tab) return;
    // Removing is destructive: never carry over tags selected for another
    // task, which may be hidden by the filter or beyond the shown rows.
    if (id === "remove") this.selected.clear();
    this.tab = id;
    if (id === "history") void this.showHistory();
    else this.renderAll();
  }

  /** History is read when shown: runs, undos and pruning change it. */
  private async showHistory() {
    this.renderTabs();
    try {
      if (!(await this.loadData())) return;
    } catch (e) {
      Zotero.logError(e as Error);
      this.setStatus(
        getString("error-load", { args: { error: errorText(e) } }),
        "error",
      );
      return;
    }
    if (this.alive && this.tab === "history") this.renderAll();
  }

  private renderLeft() {
    clear(this.leftEl);
    if (this.tab === "duplicates") this.renderDuplicates();
    else if (this.tab === "history") this.renderHistory();
    else this.renderTagList();
  }

  private visibleRows(): NameRow[] {
    const needle = this.filter.trim().toLowerCase();
    const rows = needle
      ? this.rows.filter((r) => r.name.toLowerCase().includes(needle))
      : this.rows;
    const { key, dir } = this.sort;
    if (key === DEFAULT_SORT.key && dir === DEFAULT_SORT.dir) return rows;
    const sign = dir === "asc" ? 1 : -1;
    const compare = compareRows(key);
    // Stable sort: equal values keep their name order.
    return [...rows].sort((a, b) => sign * compare(a, b));
  }

  private renderTagList() {
    const { doc } = this;
    const countEl = h(doc, "span", { class: "tw-hint" });
    const tbody = h(doc, "tbody");
    const more = h(doc, "div", {
      class: "tw-hint tw-list-notice",
      hidden: true,
    });
    const selectAll = h(
      doc,
      "button",
      {
        type: "button",
        class: "tw-select-all",
        onclick: () => {
          // Only what the user can see: not rows beyond MAX_ROWS. Go by the
          // current filter, not the drawn rows: a filter typed within the
          // last FILTER_DELAY ms is not drawn yet.
          this.win.clearTimeout(this.filterTimer);
          for (const row of this.visibleRows().slice(0, MAX_ROWS)) {
            this.selected.add(row.name);
          }
          this.fillRows(tbody, updateCount, more);
          this.selectionChanged();
        },
      },
      getString("select-shown"),
    );
    const selectNone = h(
      doc,
      "button",
      {
        type: "button",
        class: "tw-select-none",
        onclick: () => {
          this.win.clearTimeout(this.filterTimer);
          this.selected.clear();
          this.fillRows(tbody, updateCount, more);
          this.selectionChanged();
        },
      },
      getString("select-none"),
    );
    const updateCount = () => {
      const count = this.selected.size;
      let hidden = 0;
      for (const name of this.selected)
        if (!this.shownNames.has(name)) hidden++;
      countEl.textContent = hidden
        ? getString("selected-count-hidden", { args: { count, hidden } })
        : getString("selected-count", { args: { count } });
      selectNone.disabled = this.selected.size === 0;
    };
    updateCount();

    const toolbar = h(
      doc,
      "div",
      { class: "tw-pane-header" },
      clearable(
        doc,
        h(doc, "input", {
          type: "search",
          placeholder: getString("filter-placeholder"),
          value: this.filter,
          oninput: (e: Event) => {
            this.filter = (e.target as HTMLInputElement).value;
            this.win.clearTimeout(this.filterTimer);
            this.filterTimer = this.win.setTimeout(
              () => this.fillRows(tbody, updateCount, more),
              FILTER_DELAY,
            );
          },
        }),
        getString("clear-input"),
      ),
      selectAll,
      selectNone,
      countEl,
    );

    const headerUpdates: Array<() => void> = [];
    const sortHeader = (key: SortKey, label: string, cls = "") => {
      const icon = h(doc, "span", {
        class: "tw-sort-icon",
        "aria-hidden": "true",
      });
      const th = h(
        doc,
        "th",
        { class: cls },
        h(
          doc,
          "button",
          {
            type: "button",
            class: "tw-sort-button",
            "data-sort": key,
            // Library and collection names can be long and get truncated.
            title: label,
            onclick: () => {
              this.sort = nextSort(this.sort, key);
              for (const update of headerUpdates) update();
              this.fillRows(tbody, updateCount, more);
            },
          },
          h(doc, "span", { class: "tw-sort-label" }, label),
          icon,
        ),
      );
      th.appendChild(this.columnResizer("tags", th));
      const update = () => {
        const dir = this.sort.key === key ? this.sort.dir : undefined;
        th.setAttribute(
          "aria-sort",
          dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none",
        );
        icon.textContent = dir === "asc" ? "↑" : dir === "desc" ? "↓" : "";
      };
      headerUpdates.push(update);
      update();
      return th;
    };

    const table = h(
      doc,
      "table",
      { class: "tw-table tw-tag-table" },
      h(
        doc,
        "thead",
        {},
        h(
          doc,
          "tr",
          {},
          h(doc, "th", { class: "tw-checkbox" }),
          sortHeader("name", getString("col-tag")),
          sortHeader("type", getString("col-type"), "tw-tag-type"),
          this.collection
            ? sortHeader("scopeItems", this.collection.name, "tw-count")
            : null,
          sortHeader("items", this.libraryName(), "tw-count"),
        ),
      ),
      tbody,
    );
    this.fillRows(tbody, updateCount, more);
    append(this.leftEl, [
      toolbar,
      h(doc, "div", { class: "tw-scroll-box" }, table, more),
    ]);
    // Only once in the document: it reads the headers' computed padding.
    this.applyColumnWidths("tags", table);
  }

  /**
   * The grip at a header's right edge: drag it to resize the column,
   * double-click it to restore the table's default widths.
   */
  private columnResizer(key: ResizableTable, th: HTMLElement) {
    return h(this.doc, "span", {
      class: "tw-col-resizer",
      "aria-hidden": "true",
      onpointerdown: (e: PointerEvent) => this.startResize(e, key, th),
      ondblclick: () => {
        delete this.columnWidths[key];
        this.applyColumnWidths(key, th.closest("table") as HTMLTableElement);
      },
    });
  }

  /**
   * Size a table's columns: the CSS defaults, or the widths the user
   * dragged. Dragged widths are exact, like in a spreadsheet: the table is as
   * wide as its columns, so it may leave room on the right or scroll sideways.
   */
  private applyColumnWidths(key: ResizableTable, table: HTMLTableElement) {
    const cells = [...table.querySelectorAll<HTMLElement>("thead th")];
    const widths = this.columnWidths[key];
    table.classList.toggle("tw-sized", !!widths);
    table.style.width = widths
      ? `${widths.reduce((sum, w) => sum + w, 0)}px`
      : "";
    cells.forEach((th, i) => {
      if (!widths) {
        th.style.width = "";
        return;
      }
      // `width` excludes the padding; the stored widths include it.
      const style = this.win.getComputedStyle(th)!;
      const padding =
        parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      th.style.width = `${Math.max(0, widths[i] - padding)}px`;
    });
  }

  /** Drag a header's right edge to resize its column; the others stay put. */
  private startResize(e: PointerEvent, key: ResizableTable, th: HTMLElement) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    e.stopPropagation();
    const table = th.closest("table") as HTMLTableElement;
    const cells = [...table.querySelectorAll<HTMLElement>("thead th")];
    const index = cells.indexOf(th);
    // Pin every column at its current width, so only this one moves.
    const widths = cells.map((cell) => cell.getBoundingClientRect().width);
    this.columnWidths[key] = widths;
    this.applyColumnWidths(key, table);

    const startX = e.clientX;
    const startWidth = widths[index];
    const grip = e.currentTarget as HTMLElement;
    const root = this.doc.documentElement!;
    grip.classList.add("tw-active");
    root.classList.add("tw-resizing");
    const move = (ev: PointerEvent) => {
      widths[index] = Math.max(
        MIN_COLUMN_WIDTH,
        startWidth + ev.clientX - startX,
      );
      this.applyColumnWidths(key, table);
    };
    const end = () => {
      grip.classList.remove("tw-active");
      root.classList.remove("tw-resizing");
      this.doc.removeEventListener("pointermove", move);
      this.doc.removeEventListener("pointerup", end);
      this.doc.removeEventListener("pointercancel", end);
    };
    this.doc.addEventListener("pointermove", move);
    this.doc.addEventListener("pointerup", end);
    this.doc.addEventListener("pointercancel", end);
  }

  private fillRows(
    tbody: HTMLElement,
    updateCount: () => void,
    more: HTMLElement,
  ) {
    const { doc } = this;
    clear(tbody);
    const all = this.visibleRows();
    const rows = all.slice(0, MAX_ROWS);
    this.shownNames = new Set(rows.map((r) => r.name));
    more.hidden = all.length <= MAX_ROWS;
    more.textContent = getString("tag-list-more", {
      args: { shown: MAX_ROWS, total: all.length },
    });
    if (!rows.length) {
      tbody.appendChild(
        h(
          doc,
          "tr",
          {},
          h(
            doc,
            "td",
            { colspan: this.scope ? 5 : 4, class: "tw-list-notice" },
            getString("tag-list-empty"),
          ),
        ),
      );
    }
    const boxes: HTMLInputElement[] = [];
    const trs: HTMLElement[] = [];
    const set = (index: number, on: boolean) => {
      if (on) this.selected.add(rows[index].name);
      else this.selected.delete(rows[index].name);
      boxes[index].checked = on;
      trs[index].classList.toggle("tw-row-selected", on);
    };
    // Shift + Click: every row from the one clicked last to this one gets
    // this row's new state, like in a file manager. Without a shown anchor
    // (e.g. hidden by the filter since), only this row toggles.
    const selectRange = (index: number) => {
      const on = !this.selected.has(rows[index].name);
      let anchor = rows.findIndex((r) => r.name === this.rangeAnchor);
      if (anchor < 0) anchor = index;
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      for (let i = from; i <= to; i++) set(i, on);
      this.rangeAnchor = rows[index].name;
      updateCount();
      this.selectionChanged();
    };
    for (const [index, row] of rows.entries()) {
      const box = h(doc, "input", {
        type: "checkbox",
        checked: this.selected.has(row.name),
        "aria-label": row.name,
        onclick: (e: MouseEvent) => {
          // The box has already toggled; the change event that follows
          // finds the selection up to date and does nothing.
          if (e.shiftKey) selectRange(index);
        },
        onchange: () => {
          if (this.selected.has(row.name) === box.checked) return;
          set(index, box.checked);
          this.rangeAnchor = row.name;
          updateCount();
          this.selectionChanged();
        },
      });
      boxes.push(box);
      const name = h(
        doc,
        "td",
        { class: "tw-tag-name" },
        row.color ? swatch(doc, row.color) : null,
        row.name,
      );
      const tr = h(
        doc,
        "tr",
        {
          class: this.selected.has(row.name) ? "tw-row-selected" : "",
          // Shift would otherwise extend the text selection.
          onmousedown: (e: MouseEvent) => {
            if (e.shiftKey) e.preventDefault();
          },
        },
        h(doc, "td", { class: "tw-checkbox" }, box),
        name,
        h(
          doc,
          "td",
          { class: "tw-tag-type" },
          getString(TAG_KINDS[row.type].label),
        ),
        this.scope
          ? h(doc, "td", { class: "tw-count" }, row.scopeItems ?? 0)
          : null,
        h(doc, "td", { class: "tw-count" }, row.items),
      );
      trs.push(tr);
      clickInputOnRowClick(tr, box, () => selectRange(index));
      tbody.appendChild(tr);
    }
    updateCount();
  }

  /** Selection changed: refresh dependent controls and the preview. */
  private selectionChanged() {
    if (this.tab === "unify" && !this.targetTouched) {
      const best = this.rows
        .filter((r) => this.selected.has(r.name))
        .sort((a, b) => b.items - a.items)[0];
      this.unifyTarget = best?.name ?? "";
      this.renderControls();
    } else if (this.tab === "unify") {
      this.renderControls();
    }
    this.refreshPlan();
  }

  private renderControls() {
    const { doc } = this;
    clear(this.controlsEl);
    if (this.tab === "case") {
      const style = h(doc, "select", {
        id: "tw-style",
        onchange: (e: Event) => {
          this.caseOpts = {
            ...this.caseOpts,
            style: (e.target as HTMLSelectElement).value as CaseStyle,
          };
          this.refreshPlan();
        },
      });
      for (const [value, label] of CASE_STYLES) {
        style.appendChild(
          h(
            doc,
            "option",
            { value, selected: value === this.caseOpts.style },
            getString(label),
          ),
        );
      }
      const check = (id: string, label: FluentMessageId, key: "keepAcronyms") =>
        h(
          doc,
          "label",
          { class: "tw-field", for: id },
          h(doc, "input", {
            type: "checkbox",
            id,
            checked: !!this.caseOpts[key],
            onchange: (e: Event) => {
              this.caseOpts = {
                ...this.caseOpts,
                [key]: (e.target as HTMLInputElement).checked,
              };
              this.refreshPlan();
            },
          }),
          h(
            doc,
            "span",
            { class: "tw-field-text", title: getString(label) },
            getString(label),
          ),
        );
      append(this.controlsEl, [
        h(
          doc,
          "div",
          { class: "tw-field" },
          h(doc, "label", { for: "tw-style" }, getString("case-style")),
          style,
        ),
        h(doc, "div", { class: "tw-separator" }),
        check("tw-acr", "case-keep-acronyms", "keepAcronyms"),
        h(doc, "div", { class: "tw-separator" }),
        h(
          doc,
          "div",
          { class: "tw-field", title: getString("case-prefix-hint") },
          h(doc, "label", { for: "tw-prefix" }, getString("case-prefix")),
          clearable(
            doc,
            h(doc, "input", {
              type: "text",
              id: "tw-prefix",
              placeholder: getString("case-prefix-placeholder"),
              value: this.caseOpts.prefix ?? "",
              oninput: (e: Event) => {
                this.caseOpts = {
                  ...this.caseOpts,
                  prefix: (e.target as HTMLInputElement).value,
                };
                this.refreshPlan();
              },
            }),
            getString("clear-input"),
          ),
        ),
      ]);
    } else if (this.tab === "unify") {
      const names = this.rows.filter((r) => this.selected.has(r.name));
      const list = h(doc, "datalist", { id: "tw-targets" });
      for (const r of names)
        list.appendChild(h(doc, "option", { value: r.name }));
      append(this.controlsEl, [
        h(
          doc,
          "div",
          { class: "tw-field" },
          h(doc, "label", { for: "tw-target" }, getString("unify-target")),
          clearable(
            doc,
            h(doc, "input", {
              type: "text",
              id: "tw-target",
              placeholder: getString("unify-target-placeholder"),
              list: "tw-targets",
              value: this.unifyTarget,
              oninput: (e: Event) => {
                this.unifyTarget = (e.target as HTMLInputElement).value;
                this.targetTouched = true;
                this.refreshPlan();
              },
            }),
            getString("clear-input"),
          ),
          list,
        ),
        h(
          doc,
          "div",
          { class: "tw-hint", title: getString("unify-hint") },
          getString("unify-hint"),
        ),
      ]);
    } else if (this.tab === "remove") {
      append(this.controlsEl, [
        h(
          doc,
          "div",
          { class: "tw-hint", title: getString("remove-hint") },
          getString("remove-hint"),
        ),
      ]);
    } else if (this.tab === "history") {
      append(this.controlsEl, [
        h(
          doc,
          "div",
          { class: "tw-hint", title: getString("history-hint") },
          getString("history-hint"),
        ),
      ]);
    } else if (this.tab === "duplicates") {
      const tier = h(doc, "select", {
        id: "tw-tier",
        onchange: (e: Event) => {
          this.dupTier = (e.target as HTMLSelectElement).value as DuplicateTier;
          this.groupOff.clear();
          this.chosen.clear();
          this.recomputeGroups();
          this.renderLeft();
          this.refreshPlan();
        },
      });
      for (const [value, label] of DUP_TIERS) {
        tier.appendChild(
          h(
            doc,
            "option",
            { value, selected: value === this.dupTier },
            getString(label),
          ),
        );
      }
      append(this.controlsEl, [
        h(
          doc,
          "div",
          { class: "tw-field" },
          h(doc, "label", { for: "tw-tier" }, getString("dup-level")),
          tier,
        ),
      ]);
    }
  }

  private renderDuplicates() {
    const { doc } = this;
    const scroll = h(doc, "div", { class: "tw-scroll-box" });

    if (!this.groups.length) {
      scroll.appendChild(
        h(doc, "div", { class: "tw-list-notice" }, getString("dup-none")),
      );
    }
    // Like the preview, draw at most MAX_ROWS; the plan has every ticked group.
    for (const group of this.groups.slice(0, MAX_ROWS)) {
      const key = groupKey(group);
      const canonical = this.chosen.get(key) ?? group.canonical;
      const on = h(doc, "input", {
        type: "checkbox",
        checked: !this.groupOff.has(key),
        onchange: () => {
          if (on.checked) this.groupOff.delete(key);
          else this.groupOff.add(key);
          this.refreshPlan();
        },
      });
      const box = h(
        doc,
        "div",
        { class: "tw-duplicate-group" },
        h(doc, "h3", {}, h(doc, "label", {}, on, getString("dup-merge-group"))),
      );
      // The survivor is a name: its manual and automatic uses stay together
      // (buildDuplicatePlan keeps the manual one), so one choice per name.
      const byName = new Map<string, TagRef[]>();
      for (const member of group.members) {
        byName.set(member.name, [...(byName.get(member.name) ?? []), member]);
      }
      for (const [name, refs] of byName) {
        const items = refs.reduce((n, r) => n + r.itemCount, 0);
        box.appendChild(
          h(
            doc,
            "label",
            {},
            h(doc, "input", {
              type: "radio",
              name: `tw-keep-${key}`,
              checked: name === canonical.name,
              "aria-label": `${getString("dup-keep")}: ${name}`,
              onchange: () => {
                this.chosen.set(key, refs.find((r) => r.type === 0) ?? refs[0]);
                this.refreshPlan();
              },
            }),
            h(doc, "span", { class: "tw-tag-name" }, name),
            refs.every((r) => r.type === 1)
              ? h(
                  doc,
                  "span",
                  { class: "tw-auto-badge" },
                  getString("flag-auto"),
                )
              : null,
            h(doc, "span", { class: "tw-hint" }, ` ${items}`),
          ),
        );
      }
      scroll.appendChild(box);
    }
    if (this.groups.length > MAX_ROWS) {
      scroll.appendChild(
        h(
          doc,
          "div",
          { class: "tw-hint tw-list-notice" },
          getString("dup-groups-more", {
            args: { shown: MAX_ROWS, total: this.groups.length },
          }),
        ),
      );
    }

    // Suggest-only: never part of the plan unless the user sends them to Unify.
    this.fuzzy ??= findFuzzyPairs(this.listedRefs());
    const pairs = this.fuzzy;
    if (pairs.length) {
      scroll.appendChild(
        h(
          doc,
          "div",
          { class: "tw-section-title" },
          getString("dup-fuzzy-title"),
        ),
      );
      const table = h(doc, "table", { class: "tw-table" });
      for (const pair of pairs.slice(0, MAX_FUZZY)) {
        table.appendChild(
          h(
            doc,
            "tr",
            {},
            h(doc, "td", { class: "tw-tag-name" }, pair.a.name),
            h(doc, "td", { class: "tw-tag-name" }, pair.b.name),
            h(
              doc,
              "td",
              { class: "tw-hint" },
              getString(
                pair.reason === "typo"
                  ? "dup-fuzzy-reason-typo"
                  : "dup-fuzzy-reason-plural",
              ),
            ),
            h(
              doc,
              "td",
              {},
              h(
                doc,
                "button",
                {
                  type: "button",
                  onclick: () => this.sendToUnify(pair.a, pair.b),
                },
                getString("dup-fuzzy-action"),
              ),
            ),
          ),
        );
      }
      scroll.appendChild(table);
      if (pairs.length > MAX_FUZZY) {
        scroll.appendChild(
          h(
            doc,
            "div",
            { class: "tw-hint tw-list-notice" },
            getString("dup-fuzzy-more", {
              args: { shown: MAX_FUZZY, total: pairs.length },
            }),
          ),
        );
      }
    }

    append(this.leftEl, [
      h(
        doc,
        "div",
        { class: "tw-pane-header" },
        h(
          doc,
          "span",
          { class: "tw-pane-title" },
          getString("dup-groups-title"),
        ),
      ),
      scroll,
    ]);
  }

  private sendToUnify(a: TagRef, b: TagRef) {
    this.selected = new Set([a.name, b.name]);
    this.unifyTarget = (a.itemCount >= b.itemCount ? a : b).name;
    this.targetTouched = false;
    this.tab = "unify";
    this.renderAll();
  }

  /** The History tab's list: one row per kept run, newest first. */
  private renderHistory() {
    const { doc } = this;
    const scroll = h(doc, "div", { class: "tw-scroll-box" });
    if (!this.history.length) {
      scroll.classList.add("tw-empty-box");
      scroll.appendChild(
        h(doc, "div", { class: "tw-list-notice" }, getString("history-empty")),
      );
    } else {
      const header = (label: string, cls = "") => {
        const th = h(doc, "th", { class: cls }, label);
        th.appendChild(this.columnResizer("history", th));
        return th;
      };
      const tbody = h(doc, "tbody");
      for (const entry of this.history) {
        const undone = entry.status === "undone";
        const status = undone
          ? getString("history-status-undone")
          : entry.interrupted
            ? getString("history-status-interrupted")
            : "";
        const classes = [
          undone ? "tw-history-undone" : "",
          entry.id === this.historySelected ? "tw-row-selected" : "",
        ];
        const radio = h(doc, "input", {
          type: "radio",
          name: "tw-history",
          checked: entry.id === this.historySelected,
          // e.g. an interrupted run, which cannot be redone.
          disabled: !historyAction(this.history, entry.id),
          "aria-label": `${formatDate(entry.createdAt)} ${formatTime(entry.createdAt)}`,
          onchange: () => {
            this.historySelected = entry.id;
            // Mark the row without redrawing the list (and its scroll).
            for (const tr of tbody.children) {
              tr.classList.toggle("tw-row-selected", tr === row);
            }
            this.refreshPlan();
          },
        });
        const row = h(
          doc,
          "tr",
          { class: classes.filter(Boolean).join(" ") },
          h(doc, "td", { class: "tw-checkbox" }, radio),
          h(doc, "td", { class: "tw-nowrap" }, formatDate(entry.createdAt)),
          h(doc, "td", { class: "tw-nowrap" }, formatTime(entry.createdAt)),
          h(
            doc,
            "td",
            {},
            getString(`history-kind-${entry.kind}` as FluentMessageId),
          ),
          h(doc, "td", { class: "tw-count" }, entry.items),
          h(doc, "td", { class: "tw-tag-type" }, status),
        );
        clickInputOnRowClick(row, radio);
        tbody.appendChild(row);
      }
      const table = h(
        doc,
        "table",
        { class: "tw-table tw-history-table" },
        h(
          doc,
          "thead",
          {},
          h(
            doc,
            "tr",
            {},
            h(doc, "th", { class: "tw-checkbox" }),
            header(getString("history-col-date")),
            header(getString("history-col-time")),
            header(getString("history-col-kind")),
            header(getString("history-col-items"), "tw-count"),
            header(getString("history-col-status")),
          ),
        ),
        tbody,
      );
      scroll.appendChild(table);
    }
    if (this.historyUnreadable.length) {
      scroll.appendChild(
        h(
          doc,
          "div",
          { class: "tw-hint tw-list-notice" },
          getString("history-unreadable", {
            args: { count: this.historyUnreadable.length },
          }),
        ),
      );
    }
    append(this.leftEl, [
      h(
        doc,
        "div",
        { class: "tw-pane-header" },
        h(doc, "span", { class: "tw-pane-title" }, getString("history-title")),
      ),
      scroll,
    ]);
    // Once in the document: it reads the headers' computed padding.
    const table = scroll.querySelector("table");
    if (table) this.applyColumnWidths("history", table);
  }

  /** What the selected run allows, and the runs that would take. */
  private historyChain(): {
    action?: "undo" | "redo";
    chain: HistoryEntry[];
  } {
    const id = this.historySelected;
    const action = historyAction(this.history, id);
    if (!action || id === undefined) return { chain: [] };
    const chain =
      action === "undo"
        ? undoChain(this.history, id)
        : redoChain(this.history, id);
    return { action, chain };
  }

  /** The History tab's right pane: how many runs Undo or Redo would take. */
  private historySummary(): string {
    const { action, chain } = this.historyChain();
    if (!action) return getString("history-select");
    return getString(
      action === "undo" ? "history-undo-count" : "history-redo-count",
      { args: { count: chain.length } },
    );
  }

  private renderPreview() {
    const { doc } = this;
    clear(this.previewEl);
    // Always empty on the History tab, which has no plan.
    const rows = this.displayRows();
    const head = h(
      doc,
      "div",
      { class: "tw-pane-header" },
      h(doc, "span", { class: "tw-alert" }, getString("edits-library-wide")),
    );
    if (!rows.length) {
      append(this.previewEl, [
        head,
        h(
          doc,
          "div",
          { class: "tw-scroll-box tw-empty-box" },
          h(
            doc,
            "div",
            { class: "tw-list-notice" },
            this.tab === "history"
              ? this.historySummary()
              : getString("preview-empty"),
          ),
        ),
      ]);
      return;
    }
    const tbody = h(doc, "tbody");
    for (const row of rows.slice(0, MAX_ROWS)) {
      const box = h(doc, "input", {
        type: "checkbox",
        checked: row.included && !row.blocked,
        disabled: row.blocked,
        "aria-label": opName(row.op),
        onchange: () => {
          if (box.checked) this.excluded.delete(row.key);
          else this.excluded.add(row.key);
          this.refreshPlan();
        },
      });
      tbody.appendChild(
        h(
          doc,
          "tr",
          { class: row.blocked ? "tw-blocked-row" : "" },
          h(doc, "td", { class: "tw-checkbox" }, box),
          h(doc, "td", { class: "tw-tag-name" }, ...this.describeOp(row.op)),
          h(doc, "td", { class: "tw-count" }, row.items),
          h(doc, "td", {}, ...this.notesFor(row)),
        ),
      );
    }
    const header = (label: string, cls = "") => {
      const th = h(doc, "th", { class: cls }, label);
      th.appendChild(this.columnResizer("preview", th));
      return th;
    };
    const table = h(
      doc,
      "table",
      { class: "tw-table tw-preview-table" },
      h(
        doc,
        "thead",
        {},
        h(
          doc,
          "tr",
          {},
          h(doc, "th", { class: "tw-checkbox" }),
          header(getString("preview-col-change")),
          header(getString("preview-col-items"), "tw-count"),
          header(getString("preview-col-notes")),
        ),
      ),
      tbody,
    );
    append(this.previewEl, [
      head,
      h(
        doc,
        "div",
        { class: "tw-scroll-box" },
        table,
        rows.length > MAX_ROWS
          ? h(
              doc,
              "div",
              { class: "tw-hint tw-list-notice" },
              getString("preview-more", {
                args: { shown: MAX_ROWS, total: rows.length },
              }),
            )
          : null,
      ),
    ]);
    // Rebuilt on every plan change: keep the widths the user dragged.
    this.applyColumnWidths("preview", table);
  }

  private describeOp(op: Op): Node[] {
    const { doc } = this;
    switch (op.kind) {
      case "rename":
        return [
          h(doc, "span", { class: "tw-old-name" }, op.from.name),
          h(doc, "span", { class: "tw-rename-arrow" }, "→"),
          h(doc, "span", {}, op.to),
        ];
      case "remove":
        return [
          h(
            doc,
            "span",
            { class: "tw-warning-text" },
            `${getString("op-remove")}: `,
            h(doc, "strong", {}, op.tag.name),
          ),
        ];
      case "retype":
        return [
          doc.createTextNode(
            getString("op-retype", {
              args: {
                name: op.tag.name,
                type: getString(
                  op.toType === 1 ? "type-automatic" : "type-manual",
                ),
              },
            }),
          ),
        ];
    }
  }

  private notesFor(row: DisplayRow): Node[] {
    const { doc } = this;
    const notes: Node[] = [];
    const first = row.rows[0];
    const errors: Record<string, FluentMessageId> = {
      empty: "note-empty",
      "too-long": "note-too-long",
      "target-is-also-changed": "note-target-changed",
    };
    if (first.error) {
      notes.push(
        h(
          doc,
          "div",
          { class: "tw-error-text" },
          getString(errors[first.error] ?? "note-empty"),
        ),
      );
    }
    if (first.merges && !first.error) {
      notes.push(
        h(doc, "div", { class: "tw-warning-text" }, getString("note-merge")),
      );
    }
    if (row.rows.some((r) => r.warnings.includes("loses-color"))) {
      notes.push(
        h(
          doc,
          "div",
          { class: "tw-warning-text" },
          getString("note-loses-color"),
        ),
      );
    }
    return notes;
  }

  private renderFooter() {
    const { doc } = this;
    clear(this.footerEl);
    const ops = includedOps(this.plan);
    // Two messages side by side: the tag count, then the latest message.
    const message =
      this.latest === "impact" && this.impactText
        ? { text: this.impactText, kind: "info" }
        : this.status;
    // Unique names in the scope, as listed on the left before filtering.
    const total = this.loaded
      ? h(
          doc,
          "div",
          { class: "tw-tag-total" },
          getString(
            this.collection ? "tag-total-collection" : "tag-total-library",
            { args: { count: this.rows.length } },
          ),
        )
      : null;
    const info = h(
      doc,
      "div",
      { class: "tw-footer-info" },
      total,
      total && message.text ? h(doc, "div", { class: "tw-separator" }) : null,
      // Always there, empty or not: it is the live region.
      h(
        doc,
        "div",
        {
          class: "tw-status",
          role: "status",
          "aria-live": "polite",
          "data-kind": message.kind,
        },
        message.text,
      ),
    );
    // On History, Apply undoes or redoes, whichever the selected run allows.
    const history = this.tab === "history";
    const { action } = this.historyChain();
    const apply =
      this.busy && !history
        ? h(
            doc,
            "button",
            {
              type: "button",
              onclick: () => {
                this.cancelRequested = true;
              },
            },
            getString("cancel"),
          )
        : h(
            doc,
            "button",
            {
              type: "button",
              class: "tw-primary-button",
              disabled: history ? this.busy || !action : !ops.length,
              onclick: () =>
                void (action && history
                  ? this.stepHistory(action)
                  : this.apply()),
            },
            getString("apply"),
          );
    const close = h(
      doc,
      "button",
      { type: "button", disabled: this.busy, onclick: () => this.win.close() },
      getString("close"),
    );
    append(this.footerEl, [info, close, apply]);
  }

  private setStatus(text: string, kind: "info" | "error" = "info") {
    this.status = { text, kind };
    this.latest = "status";
    if (this.footerEl && this.alive) this.renderFooter();
  }

  // ---------------------------------------------------------- actions

  private guardMessage(reason: string): string {
    const ids: Record<string, FluentMessageId> = {
      "read-only": "error-read-only",
      "no-library": "error-no-library",
      "tags-not-loaded": "error-tags-not-loaded",
    };
    return getString(ids[reason] ?? "error-no-library");
  }

  /**
   * During a run only the footer (status, Cancel) stays usable: the rest
   * would change a plan that is no longer the one running.
   */
  private setBusy(busy: boolean) {
    this.busy = busy;
    for (const el of [this.headerEl, this.menuEl, this.mainEl]) {
      el?.toggleAttribute("inert", busy);
    }
  }

  /** What a plan would do, to tell whether reloaded data changes it. */
  private planSignature(plan: ChangePlan): string {
    return plan.rows
      .map(
        (r) =>
          `${opKey(r.op)}|${r.included}|${r.merges}|${r.error ?? ""}|${r.warnings.join(",")}`,
      )
      .join("\n");
  }

  private confirm(title: string, text: string): boolean {
    return (Services.prompt as any).confirm(this.win, title, text) as boolean;
  }

  private async apply() {
    if (!includedOps(this.plan).length || this.busy) return;
    // Set before the first await so a second click cannot start another run.
    this.setBusy(true);
    let started = false;
    /** Data changed since the preview was drawn: redraw instead of applying. */
    let stale = false;
    try {
      const guard = preflight(this.libraryID);
      if (!guard.ok) {
        this.setStatus(this.guardMessage(guard.reason), "error");
        return;
      }
      // Tags may have changed elsewhere since the preview was computed
      // (e.g. a new tag this would now merge into): never apply anything
      // other than what the user reviewed.
      const shown = this.planSignature(this.plan);
      const loaded = await this.loadData();
      const fresh = this.computePlan();
      if (!loaded || this.planSignature(fresh) !== shown) {
        stale = true;
        this.setStatus(getString("status-plan-changed"), "error");
        return;
      }
      this.plan = fresh;
      const ops = includedOps(this.plan);
      // Throws for plans that cannot run as shown, before anything changes.
      const tasks = toTasks(ops, this.allTags);
      const names = editedNames(ops);
      const impact = await measureImpact(this.libraryID, names, this.scope);
      const removing = ops.every((op) => op.kind === "remove");
      let text = removing
        ? this.removeConfirmText(names, impact)
        : getString("confirm-body", {
            args: {
              changes: tasks.length,
              items: impact.total,
              outside: impact.outsideScope,
              scope: this.scope ? "collection" : "library",
            },
          });
      if (guard.warnings.includes("sync-in-progress"))
        text += `\n\n${getString("sync-warning")}`;
      const title = getString(
        removing ? "confirm-remove-title" : "confirm-title",
      );
      if (this.closeWhenDone || !this.confirm(title, text)) return;

      this.cancelRequested = false;
      this.setStatus(
        getString("status-working", { args: { done: 0, total: tasks.length } }),
      );
      const result = await applyOps({
        libraryID: this.libraryID,
        ops,
        allTags: this.allTags,
        kind: this.editKind(),
        isCancelled: () => this.cancelRequested,
        onProgress: (done, total) =>
          this.setStatus(
            getString("status-working", { args: { done, total } }),
          ),
      });
      // applyOps throws only before changing anything.
      started = true;
      const args = {
        done: result.completedTasks,
        total: result.totalTasks,
        error: result.error ?? "",
      };
      // Tags changed elsewhere since loading: say so rather than "Done".
      const skipped = result.skippedTasks
        ? ` ${getString("status-skipped", { args: { count: result.skippedTasks } })}`
        : "";
      if (result.status === "done")
        this.setStatus(getString("status-done", { args }) + skipped);
      else if (result.status === "cancelled")
        this.setStatus(
          getString("status-cancelled", { args }) + skipped,
          "error",
        );
      else
        this.setStatus(getString("status-failed", { args }) + skipped, "error");
    } catch (e) {
      this.setStatus(
        getString("status-error", { args: { error: errorText(e) } }),
        "error",
      );
    } finally {
      this.setBusy(false);
      if (started) {
        this.selected.clear();
        this.excluded.clear();
        this.targetTouched = false;
        this.unifyTarget = "";
      }
      await this.afterAction(started || stale);
    }
  }

  /** The History tab's label for a run of the current plan. */
  private editKind(): EditKind {
    switch (this.tab) {
      case "unify":
        // Several sources, or one renamed to a name already in use.
        return this.plan.rows.some((r) => r.included && r.merges)
          ? "merge"
          : "rename";
      case "history":
        throw new Error("The History tab has no plan to apply");
      default:
        return this.tab;
    }
  }

  /** Confirmation for a Remove run: says it deletes, and names the tags. */
  private removeConfirmText(
    names: string[],
    impact: { total: number; outsideScope: number },
  ): string {
    const listed = names.slice(0, MAX_CONFIRM_NAMES).map((n) => `• ${n}`);
    if (names.length > MAX_CONFIRM_NAMES) {
      listed.push(
        getString("confirm-remove-more", {
          args: { count: names.length - MAX_CONFIRM_NAMES },
        }),
      );
    }
    return getString("confirm-remove-body", {
      args: {
        count: names.length,
        items: impact.total,
        outside: impact.outsideScope,
        names: listed.join("\n"),
        scope: this.scope ? "collection" : "library",
      },
    });
  }

  /** Re-render after apply, undo or redo, or close if the user asked to meanwhile. */
  private async afterAction(changed: boolean) {
    if (this.closeWhenDone) {
      if (this.alive) this.win.close();
    } else if (changed) {
      await this.reload();
    } else if (this.alive) {
      this.renderFooter();
    }
  }

  /**
   * Undo the selected run and every newer one, or redo the undone runs up to
   * the selected one. A run whose tags changed since, or that was
   * interrupted, is only taken once the user agrees; declining stops there.
   */
  private async stepHistory(action: "undo" | "redo") {
    const id = this.historySelected;
    if (this.busy || !id) return;
    this.setBusy(true);
    let started = false;
    const undo = action === "undo";
    try {
      const target = this.history.find((e) => e.id === id);
      const chain = this.historyChain();
      if (!target || chain.action !== action) {
        this.setStatus(getString("history-not-found"), "error");
        return;
      }
      const total = chain.chain.length;
      const when = (entry: HistoryEntry) => ({
        date: formatDate(entry.createdAt),
        time: formatTime(entry.createdAt),
      });
      let text = undo
        ? getString("history-undo-confirm", {
            args: { ...when(target), count: total, later: total - 1 },
          })
        : getString("history-redo-confirm", {
            args: { ...when(target), count: total, earlier: total - 1 },
          });
      // IDs sort by time: an unreadable newer run may be one of this
      // library's, which undoing or redoing would then skip: any newer one
      // for undo, any between the oldest redone run and the target for redo.
      const oldest = undo ? target.id : chain.chain[0].id;
      const skipped = this.historyUnreadable.some(
        (u) => u > oldest && (undo || u < target.id),
      );
      if (skipped)
        text = `${getString("history-unreadable-skipped")}\n\n${text}`;
      const guard = preflight(this.libraryID);
      if (guard.ok && guard.warnings.includes("sync-in-progress"))
        text += `\n\n${getString("sync-warning")}`;
      const title = getString(undo ? "history-undo" : "history-redo");
      if (this.closeWhenDone || !this.confirm(title, text)) return;
      started = true;
      const walk = undo ? undoTo : redoTo;
      let steps = 0;
      let result = await walk(this.libraryID, id);
      while (!result.ok && result.reason !== "not-found") {
        steps += result.steps;
        const refused = result;
        const entry = this.history.find((e) => e.id === refused.journalID);
        const args = entry ? when(entry) : { date: "", time: "" };
        const tags = refused.reason === "drifted" ? refused.driftedTags : [];
        const question =
          refused.reason === "interrupted"
            ? getString("history-interrupted", { args })
            : getString(undo ? "history-drifted" : "history-redo-drifted", {
                args: { ...args, tags: tags.slice(0, 10).join(", ") },
              });
        if (this.closeWhenDone || !this.confirm(title, question)) {
          this.setStatus(
            getString(undo ? "history-undo-partial" : "history-redo-partial", {
              args: { done: steps, total },
            }),
            "error",
          );
          return;
        }
        result = await walk(this.libraryID, id, {
          forceRun: refused.journalID,
        });
      }
      if (result.ok)
        this.setStatus(
          getString(undo ? "history-undo-done" : "history-redo-done", {
            args: { count: steps + result.steps },
          }),
        );
      else this.setStatus(getString("history-not-found"), "error");
    } catch (e) {
      this.setStatus(
        getString("status-error", { args: { error: errorText(e) } }),
        "error",
      );
    } finally {
      this.setBusy(false);
      if (started) this.historySelected = undefined;
      await this.afterAction(started);
    }
  }
}

/**
 * Color swatch. Tag colors come from a synced setting that other members of a
 * group library can write, so the value is assigned as one property, never
 * spliced into CSS text where it could add other declarations.
 */
function swatch(doc: Document, color: string): HTMLElement {
  const el = h(doc, "span", {
    class: "tw-color-dot",
    title: getString("flag-color"),
  });
  el.style.backgroundColor = color;
  return el;
}

/**
 * A click anywhere in the row clicks its checkbox or radio button, or calls
 * `onShiftClick` (if given) when Shift is held.
 */
function clickInputOnRowClick(
  row: HTMLElement,
  input: HTMLInputElement,
  onShiftClick?: () => void,
) {
  // A disabled input (e.g. an interrupted run) ignores the click anyway.
  if (!input.disabled) row.classList.add("tw-clickable-row");
  row.addEventListener("click", (e) => {
    if (e.target === input) return; // the input handles its own click
    if ((e as MouseEvent).shiftKey && onShiftClick && !input.disabled) {
      onShiftClick();
      return;
    }
    // Dragging to select text (e.g. a tag name) is not a click on the row.
    if (row.ownerDocument?.defaultView?.getSelection()?.toString()) return;
    input.click();
  });
}

function errorText(e: unknown): string {
  if (e instanceof TaskError) {
    return getString(
      e.code === "two-targets" ? "error-two-targets" : "error-split-types",
      { args: { name: e.tagName } },
    );
  }
  return e instanceof Error ? e.message : String(e);
}

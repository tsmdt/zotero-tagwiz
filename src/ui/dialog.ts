import { DEFAULT_SMALL_WORDS } from "../core/caseStyles";
import {
  DuplicateGroup,
  findDuplicateGroups,
  findFuzzyPairs,
  type FuzzyPair,
} from "../core/duplicates";
import type { DuplicateTier } from "../core/normalize";
import {
  buildCasePlan,
  buildDuplicatePlan,
  buildRemovePlan,
  buildUnifyPlan,
  includedOps,
} from "../core/plan";
import type {
  CaseOptions,
  CaseStyle,
  ChangePlan,
  Op,
  PlanRow,
  TagRef,
} from "../core/types";
import { applyOps, undoJournal } from "../zotero/engine";
import { preflight } from "../zotero/guard";
import { latestUndoable } from "../zotero/journal";
import { loadTags, measureImpact, type Scope } from "../zotero/tagStore";
import { FluentMessageId } from "../../typings/i10n";
import { getString } from "../utils/locale";
import { isWindowAlive } from "../utils/window";
import { append, clear, h } from "./dom";

export interface DialogParams {
  libraryID: number;
  collection?: { id: number; name: string };
}

type TabID = "case" | "unify" | "remove" | "duplicates";
const TABS: TabID[] = ["case", "unify", "remove", "duplicates"];

/** One listed tag name; `refs` are all of its types in the whole library. */
interface NameRow {
  name: string;
  refs: TagRef[];
  items: number;
  scopeItems?: number;
  auto: boolean;
  color?: string;
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

const MAX_FUZZY = 100;
/** Rows rendered at most in the tag list and the preview (all still apply). */
const MAX_ROWS = 1000;
const FILTER_DELAY = 150;
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
function opKey(op: Op): string {
  const type = op.kind === "rename" ? op.from.type : op.tag.type;
  return `${op.kind}\u0000${opName(op)}\u0000${op.kind === "rename" ? op.to : ""}\u0000${op.kind === "retype" ? type : ""}`;
}

export class TagWizDialog {
  private readonly doc: Document;
  private readonly root: HTMLElement;
  private readonly libraryID: number;
  private readonly collection?: { id: number; name: string };

  private tab: TabID = "case";
  private includeSub = true;
  private filter = "";
  private allTags: TagRef[] = [];
  private rows: NameRow[] = [];
  private selected = new Set<string>();
  private excluded = new Set<string>();

  private caseOpts: CaseOptions = {
    style: "title",
    keepAcronyms: true,
    preservePrefix: false,
    smallWords: DEFAULT_SMALL_WORDS,
  };
  private unifyTarget = "";
  private targetTouched = false;

  private dupTier: DuplicateTier = "case";
  private groups: DuplicateGroup[] = [];
  private groupOn = new Set<string>();
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
  private impactSeq = 0;
  private impactTimer?: number;
  private filterTimer?: number;
  private canUndo = false;

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
    const library = Zotero.Libraries.get(this.libraryID);
    if (!library) {
      this.setStatus(getString("error-no-library"), "error");
    } else if (!library.editable) {
      this.setStatus(getString("error-read-only"), "error");
    }
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

  /** Re-read tags from the database and redraw everything. */
  private async reload() {
    if (!this.alive) return;
    try {
      await this.loadData();
    } catch (e) {
      Zotero.logError(e as Error);
      this.setStatus(
        getString("error-load", { args: { error: errorText(e) } }),
        "error",
      );
      return;
    }
    if (this.alive) this.renderAll();
  }

  private async loadData() {
    this.allTags = await loadTags(this.libraryID);
    const scoped = this.scope ? await loadTags(this.libraryID, this.scope) : [];
    const listed = this.scope ? scoped : this.allTags;

    const refsByName = new Map<string, TagRef[]>();
    for (const tag of this.allTags) {
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
    this.rows = names.map((name) => {
      const refs = refsByName.get(name) ?? [];
      return {
        name,
        refs,
        items: refs.reduce((n, r) => n + r.itemCount, 0),
        scopeItems: this.scope ? scopeByName.get(name) : undefined,
        auto: refs.some((r) => r.type === 1),
        color: refs.find((r) => r.color)?.color,
      };
    });
    // Drop selections that no longer exist (e.g. after a rename).
    const existing = new Set(names);
    for (const name of [...this.selected]) {
      if (!existing.has(name)) this.selected.delete(name);
    }
    this.canUndo = !!(await latestUndoable(this.libraryID));
    this.fuzzy = undefined;
    this.recomputeGroups();
  }

  private selectedRefs(): TagRef[] {
    return this.rows
      .filter((r) => this.selected.has(r.name))
      .flatMap((r) => r.refs);
  }

  private listedRefs(): TagRef[] {
    return this.rows.flatMap((r) => r.refs);
  }

  private recomputeGroups() {
    this.groups = findDuplicateGroups(this.listedRefs(), this.dupTier);
    this.groupOn = new Set(this.groups.map(groupKey));
    this.chosen = new Map();
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
      case "duplicates": {
        const active = this.groups.filter((g) => this.groupOn.has(groupKey(g)));
        const chosen = new Map<DuplicateGroup, TagRef>();
        for (const g of active) {
          const pick = this.chosen.get(groupKey(g));
          if (pick) chosen.set(g, pick);
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
      const names = [
        ...new Set(
          ops.flatMap((op) =>
            op.kind === "rename" ? [op.from.name, op.to] : [op.tag.name],
          ),
        ),
      ];
      const impact = await measureImpact(this.libraryID, names, this.scope);
      if (seq !== this.impactSeq) return; // a newer plan superseded this one
      this.impactText = this.scope
        ? getString("impact", {
            args: { total: impact.total, outside: impact.outsideScope },
          })
        : getString("impact-library", { args: { total: impact.total } });
    }
    if (seq === this.impactSeq && this.alive) this.renderFooter();
  }

  // ----------------------------------------------------------- render

  private buildSkeleton() {
    const { doc } = this;
    clear(this.root);

    const header = h(
      doc,
      "div",
      { class: "tc-header" },
      h(doc, "h1", {}, getString("dialog-title")),
    );
    if (this.collection) {
      const sub = h(doc, "input", {
        type: "checkbox",
        id: "tc-sub",
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
        h(
          doc,
          "label",
          { class: "tc-field", for: "tc-sub" },
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
    append(header, [
      h(doc, "span", { class: "tc-note" }, getString("edits-library-wide")),
    ]);

    const tabs = h(doc, "div", { class: "tc-tabs", role: "tablist" });
    for (const id of TABS) {
      tabs.appendChild(
        h(
          doc,
          "button",
          {
            class: "tc-tab",
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

    this.leftEl = h(doc, "div", { class: "tc-pane" });
    this.controlsEl = h(doc, "div", { class: "tc-pane" });
    this.previewEl = h(doc, "div", {
      class: "tc-pane",
      style: "flex:1;min-height:0",
    });
    const right = h(
      doc,
      "div",
      { class: "tc-pane" },
      this.controlsEl,
      this.previewEl,
    );
    const body = h(doc, "div", { class: "tc-body" }, this.leftEl, right);
    this.footerEl = h(doc, "div", { class: "tc-footer" });

    append(this.root, [header, tabs, body, this.footerEl]);
  }

  private renderAll() {
    this.renderTabs();
    this.renderLeft();
    this.renderControls();
    this.refreshPlan();
  }

  private renderTabs() {
    for (const el of this.root.querySelectorAll<HTMLElement>(".tc-tab")) {
      el.setAttribute("aria-selected", String(el.dataset.tab === this.tab));
    }
  }

  private switchTab(id: TabID) {
    if (this.busy || id === this.tab) return;
    this.tab = id;
    this.renderAll();
  }

  private renderLeft() {
    clear(this.leftEl);
    if (this.tab === "duplicates") this.renderDuplicates();
    else this.renderTagList();
  }

  private visibleRows(): NameRow[] {
    const needle = this.filter.trim().toLowerCase();
    return needle
      ? this.rows.filter((r) => r.name.toLowerCase().includes(needle))
      : this.rows;
  }

  private renderTagList() {
    const { doc } = this;
    const countEl = h(doc, "span", { class: "tc-note" });
    const updateCount = () => {
      countEl.textContent = getString("selected-count", {
        args: { count: this.selected.size },
      });
    };
    updateCount();

    const tbody = h(doc, "tbody");
    const more = h(doc, "div", { class: "tc-note tc-empty", hidden: true });
    const toolbar = h(
      doc,
      "div",
      { class: "tc-toolbar" },
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
      h(
        doc,
        "button",
        {
          type: "button",
          onclick: () => {
            for (const r of this.visibleRows()) this.selected.add(r.name);
            this.fillRows(tbody, updateCount, more);
            this.selectionChanged();
          },
        },
        getString("select-shown"),
      ),
      h(
        doc,
        "button",
        {
          type: "button",
          onclick: () => {
            this.selected.clear();
            this.fillRows(tbody, updateCount, more);
            this.selectionChanged();
          },
        },
        getString("select-none"),
      ),
      countEl,
    );

    const table = h(
      doc,
      "table",
      { class: "tc-table" },
      h(
        doc,
        "thead",
        {},
        h(
          doc,
          "tr",
          {},
          h(doc, "th", { class: "tc-check" }),
          h(doc, "th", {}, getString("col-tag")),
          this.scope
            ? h(doc, "th", { class: "tc-num" }, getString("col-in-collection"))
            : null,
          h(doc, "th", { class: "tc-num" }, getString("col-items")),
        ),
      ),
      tbody,
    );
    this.fillRows(tbody, updateCount, more);
    append(this.leftEl, [
      toolbar,
      h(doc, "div", { class: "tc-scroll" }, table, more),
    ]);
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
            { colspan: 4, class: "tc-empty" },
            getString("tag-list-empty"),
          ),
        ),
      );
    }
    for (const row of rows) {
      const box = h(doc, "input", {
        type: "checkbox",
        checked: this.selected.has(row.name),
        "aria-label": row.name,
        onchange: () => {
          if (box.checked) this.selected.add(row.name);
          else this.selected.delete(row.name);
          updateCount();
          this.selectionChanged();
        },
      });
      const name = h(
        doc,
        "td",
        { class: "tc-name" },
        row.color ? swatch(doc, row.color) : null,
        row.name,
        row.auto
          ? h(doc, "span", { class: "tc-badge" }, getString("flag-auto"))
          : null,
      );
      tbody.appendChild(
        h(
          doc,
          "tr",
          {},
          h(doc, "td", { class: "tc-check" }, box),
          name,
          this.scope
            ? h(doc, "td", { class: "tc-num" }, row.scopeItems ?? 0)
            : null,
          h(doc, "td", { class: "tc-num" }, row.items),
        ),
      );
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
        id: "tc-style",
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
      const check = (
        id: string,
        label: FluentMessageId,
        key: "keepAcronyms" | "preservePrefix",
      ) =>
        h(
          doc,
          "label",
          { class: "tc-field", for: id },
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
          getString(label),
        );
      append(this.controlsEl, [
        h(
          doc,
          "div",
          { class: "tc-field" },
          h(doc, "label", { for: "tc-style" }, getString("case-style")),
          style,
        ),
        check("tc-acr", "case-keep-acronyms", "keepAcronyms"),
        check("tc-pre", "case-preserve-prefix", "preservePrefix"),
      ]);
    } else if (this.tab === "unify") {
      const names = this.rows.filter((r) => this.selected.has(r.name));
      const list = h(doc, "datalist", { id: "tc-targets" });
      for (const r of names)
        list.appendChild(h(doc, "option", { value: r.name }));
      append(this.controlsEl, [
        h(doc, "div", { class: "tc-note" }, getString("unify-hint")),
        h(
          doc,
          "div",
          { class: "tc-field" },
          h(doc, "label", { for: "tc-target" }, getString("unify-target")),
          h(doc, "input", {
            type: "text",
            id: "tc-target",
            list: "tc-targets",
            value: this.unifyTarget,
            oninput: (e: Event) => {
              this.unifyTarget = (e.target as HTMLInputElement).value;
              this.targetTouched = true;
              this.refreshPlan();
            },
          }),
          list,
        ),
      ]);
    } else if (this.tab === "remove") {
      append(this.controlsEl, [
        h(doc, "div", { class: "tc-note" }, getString("remove-hint")),
      ]);
    }
  }

  private renderDuplicates() {
    const { doc } = this;
    const tier = h(doc, "select", {
      id: "tc-tier",
      onchange: (e: Event) => {
        this.dupTier = (e.target as HTMLSelectElement).value as DuplicateTier;
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
    const scroll = h(doc, "div", { class: "tc-scroll" });

    if (!this.groups.length) {
      scroll.appendChild(
        h(doc, "div", { class: "tc-empty" }, getString("dup-none")),
      );
    }
    for (const group of this.groups) {
      const key = groupKey(group);
      const canonical = this.chosen.get(key) ?? group.canonical;
      const on = h(doc, "input", {
        type: "checkbox",
        checked: this.groupOn.has(key),
        "aria-label": getString("dup-merge-group"),
        onchange: () => {
          if (on.checked) this.groupOn.add(key);
          else this.groupOn.delete(key);
          this.refreshPlan();
        },
      });
      const box = h(
        doc,
        "div",
        { class: "tc-group" },
        h(doc, "h3", {}, on, getString("dup-merge-group")),
      );
      group.members.forEach((member, index) => {
        const radioName = `tc-keep-${key}`;
        box.appendChild(
          h(
            doc,
            "label",
            {},
            h(doc, "input", {
              type: "radio",
              name: radioName,
              checked:
                member === canonical || refKey(member) === refKey(canonical),
              "aria-label": `${getString("dup-keep")}: ${member.name}`,
              onchange: () => {
                this.chosen.set(key, member);
                this.refreshPlan();
              },
            }),
            h(doc, "span", { class: "tc-name" }, member.name),
            member.type === 1
              ? h(doc, "span", { class: "tc-badge" }, getString("flag-auto"))
              : null,
            h(doc, "span", { class: "tc-note" }, ` ${member.itemCount}`),
            index === 0 ? null : null,
          ),
        );
      });
      scroll.appendChild(box);
    }

    // Suggest-only: never part of the plan unless the user sends them to Unify.
    this.fuzzy ??= findFuzzyPairs(this.listedRefs());
    const pairs = this.fuzzy;
    if (pairs.length) {
      scroll.appendChild(
        h(
          doc,
          "div",
          { class: "tc-section-title" },
          getString("dup-fuzzy-title"),
        ),
      );
      const table = h(doc, "table", { class: "tc-table" });
      for (const pair of pairs.slice(0, MAX_FUZZY)) {
        table.appendChild(
          h(
            doc,
            "tr",
            {},
            h(doc, "td", { class: "tc-name" }, pair.a.name),
            h(doc, "td", { class: "tc-name" }, pair.b.name),
            h(
              doc,
              "td",
              { class: "tc-note" },
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
            { class: "tc-note tc-empty" },
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
        { class: "tc-field" },
        h(doc, "label", { for: "tc-tier" }, getString("dup-level")),
        tier,
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

  private renderPreview() {
    const { doc } = this;
    clear(this.previewEl);
    const rows = this.displayRows();
    const head = h(
      doc,
      "div",
      { class: "tc-section-title", style: "margin:0" },
      getString("preview-title"),
    );
    if (!rows.length) {
      append(this.previewEl, [
        head,
        h(
          doc,
          "div",
          { class: "tc-scroll" },
          h(doc, "div", { class: "tc-empty" }, getString("preview-empty")),
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
          { class: row.blocked ? "tc-disabled" : "" },
          h(doc, "td", { class: "tc-check" }, box),
          h(doc, "td", { class: "tc-name" }, ...this.describeOp(row.op)),
          h(doc, "td", { class: "tc-num" }, row.items),
          h(doc, "td", {}, ...this.notesFor(row)),
        ),
      );
    }
    const table = h(
      doc,
      "table",
      { class: "tc-table" },
      h(
        doc,
        "thead",
        {},
        h(
          doc,
          "tr",
          {},
          h(doc, "th", { class: "tc-check" }),
          h(doc, "th", {}, getString("preview-col-change")),
          h(doc, "th", { class: "tc-num" }, getString("preview-col-items")),
          h(doc, "th", {}, getString("preview-col-notes")),
        ),
      ),
      tbody,
    );
    append(this.previewEl, [
      head,
      h(
        doc,
        "div",
        { class: "tc-scroll" },
        table,
        rows.length > MAX_ROWS
          ? h(
              doc,
              "div",
              { class: "tc-note tc-empty" },
              getString("preview-more", {
                args: { shown: MAX_ROWS, total: rows.length },
              }),
            )
          : null,
      ),
    ]);
  }

  private describeOp(op: Op): Node[] {
    const { doc } = this;
    switch (op.kind) {
      case "rename":
        return [
          h(doc, "span", { class: "tc-from" }, op.from.name),
          h(doc, "span", { class: "tc-arrow" }, "→"),
          h(doc, "span", {}, op.to),
        ];
      case "remove":
        return [
          doc.createTextNode(`${getString("op-remove")}: `),
          h(doc, "strong", {}, op.tag.name),
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
          { class: "tc-bad" },
          getString(errors[first.error] ?? "note-empty"),
        ),
      );
    }
    if (first.merges && !first.error) {
      notes.push(h(doc, "div", { class: "tc-warn" }, getString("note-merge")));
    }
    if (row.rows.some((r) => r.warnings.includes("loses-color"))) {
      notes.push(
        h(doc, "div", { class: "tc-warn" }, getString("note-loses-color")),
      );
    }
    return notes;
  }

  private renderFooter() {
    const { doc } = this;
    clear(this.footerEl);
    const ops = includedOps(this.plan);
    const info = h(
      doc,
      "div",
      { class: "tc-grow" },
      this.impactText ? h(doc, "div", {}, this.impactText) : null,
      h(
        doc,
        "div",
        {
          class: "tc-status",
          role: "status",
          "aria-live": "polite",
          "data-kind": this.status.kind,
        },
        this.status.text,
      ),
    );
    const undo = h(
      doc,
      "button",
      {
        type: "button",
        disabled: this.busy || !this.canUndo,
        onclick: () => void this.undo(),
      },
      getString("undo-last"),
    );
    const apply = this.busy
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
            class: "tc-primary",
            disabled: !ops.length,
            onclick: () => void this.apply(),
          },
          getString("apply"),
        );
    const close = h(
      doc,
      "button",
      { type: "button", disabled: this.busy, onclick: () => this.win.close() },
      getString("close"),
    );
    append(this.footerEl, [info, undo, close, apply]);
  }

  private setStatus(text: string, kind: "info" | "error" = "info") {
    this.status = { text, kind };
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

  private confirm(title: string, text: string): boolean {
    return (Services.prompt as any).confirm(this.win, title, text) as boolean;
  }

  private async apply() {
    const ops = includedOps(this.plan);
    if (!ops.length || this.busy) return;
    // Set before the first await so a second click cannot start another run.
    this.busy = true;
    let started = false;
    try {
      const guard = preflight(this.libraryID);
      if (!guard.ok) {
        this.setStatus(this.guardMessage(guard.reason), "error");
        return;
      }
      const names = [
        ...new Set(
          ops.flatMap((op) =>
            op.kind === "rename" ? [op.from.name, op.to] : [op.tag.name],
          ),
        ),
      ];
      const impact = await measureImpact(this.libraryID, names, this.scope);
      let text = getString("confirm-body", {
        args: {
          changes: ops.length,
          items: impact.total,
          outside: impact.outsideScope,
        },
      });
      if (guard.warnings.includes("sync-in-progress"))
        text += `\n\n${getString("sync-warning")}`;
      if (this.closeWhenDone || !this.confirm(getString("confirm-title"), text))
        return;

      started = true;
      this.cancelRequested = false;
      this.setStatus(
        getString("status-working", { args: { done: 0, total: ops.length } }),
      );
      const result = await applyOps({
        libraryID: this.libraryID,
        ops,
        allTags: this.allTags,
        isCancelled: () => this.cancelRequested,
        onProgress: (done, total) =>
          this.setStatus(
            getString("status-working", { args: { done, total } }),
          ),
      });
      const args = {
        done: result.completedTasks,
        total: result.totalTasks,
        error: result.error ?? "",
      };
      if (result.status === "done")
        this.setStatus(getString("status-done", { args }));
      else if (result.status === "cancelled")
        this.setStatus(getString("status-cancelled", { args }), "error");
      else this.setStatus(getString("status-failed", { args }), "error");
    } catch (e) {
      this.setStatus(
        getString("status-error", { args: { error: errorText(e) } }),
        "error",
      );
    } finally {
      this.busy = false;
      if (started) {
        this.selected.clear();
        this.excluded.clear();
        this.targetTouched = false;
        this.unifyTarget = "";
      }
      await this.afterAction(started);
    }
  }

  /** Re-render after apply/undo, or close if the user asked to meanwhile. */
  private async afterAction(changed: boolean) {
    if (this.closeWhenDone) {
      if (this.alive) this.win.close();
    } else if (changed) {
      await this.reload();
    } else if (this.alive) {
      this.renderFooter();
    }
  }

  private async undo() {
    if (this.busy) return;
    this.busy = true;
    let started = false;
    try {
      const journal = await latestUndoable(this.libraryID);
      if (!journal) {
        this.setStatus(getString("undo-none"));
        return;
      }
      let text = getString("undo-confirm");
      const guard = preflight(this.libraryID);
      if (guard.ok && guard.warnings.includes("sync-in-progress"))
        text += `\n\n${getString("sync-warning")}`;
      if (this.closeWhenDone || !this.confirm(getString("undo-last"), text))
        return;
      started = true;
      let result = await undoJournal(journal.id);
      if (!result.ok && result.reason !== "already-undone") {
        const question =
          result.reason === "drifted"
            ? getString("undo-drifted", {
                args: { tags: result.driftedTags.slice(0, 10).join(", ") },
              })
            : getString("undo-interrupted");
        if (!this.confirm(getString("undo-last"), question)) return;
        result = await undoJournal(journal.id, { force: true });
      }
      if (result.ok)
        this.setStatus(
          getString("undo-done", { args: { count: result.restoredTags } }),
        );
      else
        this.setStatus(
          getString("undo-unavailable", { args: { reason: result.reason } }),
          "error",
        );
    } catch (e) {
      this.setStatus(
        getString("status-error", { args: { error: errorText(e) } }),
        "error",
      );
    } finally {
      this.busy = false;
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
    class: "tc-swatch",
    title: getString("flag-color"),
  });
  el.style.backgroundColor = color;
  return el;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

import { getOrCreate } from "../core/collections";
import { cleanName } from "../core/normalize";
import type { TagRef, TagType } from "../core/types";

export interface Scope {
  collectionID: number;
  includeSubcollections: boolean;
}

interface TagColor {
  name: string;
  color: string;
}

export interface TagState {
  name: string;
  items: Array<{ id: number; type: TagType }>;
  color?: { color: string; position: number };
}

const CHUNK = 500;

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

function* chunks<T>(list: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}

type Row = Record<string, any>;

/**
 * Run a SELECT and return rows as objects keyed by the column aliases in `sql`.
 *
 * Zotero's rows are proxies that throw for unknown column names (there is no
 * getResultByIndex), so every selected column needs an explicit alias. The
 * statement MUST start with SELECT: Zotero.DB.queryAsync returns nothing for
 * anything else (e.g. a leading WITH).
 */
async function query(sql: string, params: unknown[] = []): Promise<Row[]> {
  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new Error("query() only supports statements starting with SELECT");
  }
  return ((await Zotero.DB.queryAsync(sql, params)) || []) as Row[];
}

/**
 * Ordered colored-tag list read straight from the synced setting.
 * Zotero.Tags.getColors() caches positions that can go stale after edits,
 * so positions here are always list indexes.
 */
export function getColorList(libraryID: number): TagColor[] {
  // SyncedSettings is missing from the zotero-types typings.
  const list = (Zotero as any).SyncedSettings.get(libraryID, "tagColors") as
    | TagColor[]
    | null;
  return (list ?? []).map((x) => ({
    name: x.name.normalize(),
    color: x.color,
  }));
}

/** getColorList by name, with each color's position in the list. */
export function colorsByName(
  libraryID: number,
): Map<string, { color: string; position: number }> {
  return new Map(
    getColorList(libraryID).map((x, position) => [
      x.name,
      { color: x.color, position },
    ]),
  );
}

/**
 * IDs of the stored tags that Zotero shows as one of `names` (cleaned names).
 *
 * Zotero cleans names (NFC + trim, see cleanName) when it loads them, so its
 * APIs find a tag stored in another form, e.g. NFD from an old import, but a
 * plain `WHERE name=?` does not. Zotero.Tags.getID covers such a tag; the
 * SQL match covers the exact and decomposed spellings, so a name stored in
 * two forms yields both IDs.
 */
export async function tagIDsOf(names: readonly string[]): Promise<number[]> {
  const ids = new Set<number>();
  for (const list of (await tagIDsByName(names)).values()) {
    for (const id of list) ids.add(id);
  }
  return [...ids];
}

/** tagIDsOf for each name separately. */
async function tagIDsByName(
  names: readonly string[],
): Promise<Map<string, number[]>> {
  const ids = new Map<string, Set<number>>();
  /** Spelling looked up in SQL -> the name it belongs to. */
  const nameOf = new Map<string, string>();
  for (const name of names) {
    const set = getOrCreate(ids, name, () => new Set());
    const known = Zotero.Tags.getID(name);
    if (known) set.add(known);
    nameOf.set(name, name);
    nameOf.set(name.normalize("NFD"), name);
  }
  for (const part of chunks([...nameOf.keys()], CHUNK)) {
    const rows = await query(
      `SELECT tagID AS id, name AS name FROM tags WHERE name IN (${placeholders(part.length)})`,
      part,
    );
    for (const r of rows) {
      const name = nameOf.get(r.name as string);
      if (name !== undefined) ids.get(name)!.add(r.id as number);
    }
  }
  return new Map([...ids].map(([name, set]) => [name, [...set]]));
}

/** Types (0 manual / 1 automatic) under which `name` is used in the library. */
export async function typesOf(
  libraryID: number,
  name: string,
): Promise<TagType[]> {
  const ids = await tagIDsOf([name]);
  if (!ids.length) return [];
  const rows = await query(
    "SELECT DISTINCT it.type AS type FROM itemTags it " +
      "JOIN items i USING (itemID) " +
      `WHERE it.tagID IN (${placeholders(ids.length)}) AND i.libraryID=? ` +
      "ORDER BY it.type",
    [...ids, libraryID],
  );
  return [...new Set(rows.map((r): TagType => (r.type ? 1 : 0)))];
}

/**
 * Snapshot of the given tag names: membership, types and colors. `items` are
 * every item (trash included) that carries the name, ordered by ID, with the
 * type on each. An item carrying two stored forms of a name counts once, as
 * manual if either is manual.
 */
export async function captureStates(
  libraryID: number,
  names: readonly string[],
): Promise<TagState[]> {
  const idsByName = await tagIDsByName(names);
  const nameOfID = new Map<number, string>();
  for (const [name, ids] of idsByName) {
    for (const id of ids) nameOfID.set(id, name);
  }
  /** name -> itemID -> type (manual if any stored form is manual). */
  const typesByName = new Map<string, Map<number, TagType>>();
  for (const part of chunks([...nameOfID.keys()], CHUNK)) {
    const rows = await query(
      "SELECT it.itemID AS itemID, it.type AS type, it.tagID AS tagID " +
        "FROM itemTags it JOIN items i USING (itemID) " +
        `WHERE i.libraryID=? AND it.tagID IN (${placeholders(part.length)})`,
      [libraryID, ...part],
    );
    for (const r of rows) {
      const name = nameOfID.get(r.tagID as number)!;
      const types = getOrCreate(typesByName, name, () => new Map());
      const id = r.itemID as number;
      const type: TagType = r.type ? 1 : 0;
      types.set(id, Math.min(types.get(id) ?? type, type) as TagType);
    }
  }

  const colors = colorsByName(libraryID);
  return names.map((name) => ({
    name,
    items: [...(typesByName.get(name) ?? [])]
      .sort((a, b) => a[0] - b[0])
      .map(([id, type]) => ({ id, type })),
    color: colors.get(name),
  }));
}

/** The items of `name`'s snapshot (see captureStates). */
export async function itemsWithTag(
  libraryID: number,
  name: string,
): Promise<TagState["items"]> {
  return (await captureStates(libraryID, [name]))[0].items;
}

/**
 * SQL selecting the items in scope (one `?` parameter: the root collection):
 * the non-trashed top-level items of the collection (and its non-trashed
 * subcollections), plus their child notes and attachments and the
 * annotations of those attachments. Zotero only puts top-level items into
 * collections, but its tag selector shows the children's tags too.
 * Used as `IN (...)` subquery so the outer statement can start with SELECT.
 * Children trashed on their own are filtered by the callers.
 */
function scopeItemsSql(scope: Scope): string {
  const cols = scope.includeSubcollections
    ? "WITH RECURSIVE scopeCols(id) AS (" +
      "SELECT collectionID FROM collections WHERE collectionID=? " +
      "AND collectionID NOT IN (SELECT collectionID FROM deletedCollections) " +
      "UNION ALL SELECT c.collectionID FROM collections c " +
      "JOIN scopeCols ON c.parentCollectionID=scopeCols.id " +
      "WHERE c.collectionID NOT IN (SELECT collectionID FROM deletedCollections)" +
      "), "
    : "WITH scopeCols(id) AS (" +
      "SELECT collectionID FROM collections WHERE collectionID=?), ";
  return (
    cols +
    "scopeTop(id) AS (SELECT itemID FROM collectionItems " +
    "WHERE collectionID IN (SELECT id FROM scopeCols) " +
    "AND itemID NOT IN (SELECT itemID FROM deletedItems)), " +
    "scopeAtt(id) AS (SELECT itemID FROM itemAttachments " +
    "WHERE parentItemID IN (SELECT id FROM scopeTop)) " +
    "SELECT id FROM scopeTop " +
    "UNION SELECT id FROM scopeAtt " +
    "UNION SELECT itemID FROM itemNotes " +
    "WHERE parentItemID IN (SELECT id FROM scopeTop) " +
    "UNION SELECT itemID FROM itemAnnotations " +
    "WHERE parentItemID IN (SELECT id FROM scopeTop) " +
    "OR parentItemID IN (SELECT id FROM scopeAtt)"
  );
}

/**
 * Tags of a library with usage counts and colors: `all` of them, and the ones
 * `listed` for the scope, i.e. used by (non-trashed) items of the collection
 * (all of them without a scope). With a scope, every tag's `scopeCount` is
 * set; `itemCount` stays library-wide because edits are library-wide.
 */
export async function loadTagsWithScope(
  libraryID: number,
  scope?: Scope,
): Promise<{ all: TagRef[]; listed: TagRef[] }> {
  const totalRows = await query(
    "SELECT t.name AS name, it.type AS type, COUNT(DISTINCT it.itemID) AS n " +
      "FROM itemTags it JOIN tags t USING (tagID) JOIN items i USING (itemID) " +
      "WHERE i.libraryID=? GROUP BY t.tagID, it.type",
    [libraryID],
  );

  const colors = colorsByName(libraryID);

  const scopeCounts = new Map<string, number>();
  if (scope) {
    const rows = await query(
      "SELECT t.name AS name, it.type AS type, COUNT(DISTINCT it.itemID) AS n " +
        "FROM itemTags it JOIN tags t USING (tagID) " +
        `WHERE it.itemID IN (${scopeItemsSql(scope)}) ` +
        "AND it.itemID NOT IN (SELECT itemID FROM deletedItems) " +
        "GROUP BY t.tagID, it.type",
      [scope.collectionID],
    );
    for (const r of rows) {
      const key = `${cleanName(r.name as string)}\u0000${r.type ? 1 : 0}`;
      scopeCounts.set(key, (scopeCounts.get(key) ?? 0) + (r.n as number));
    }
  }

  // Names as Zotero shows them (cleaned): tags stored in two forms of one
  // name (see tagIDsOf) become one entry per type.
  const byKey = new Map<string, TagRef>();
  for (const r of totalRows) {
    const name = cleanName(r.name as string);
    const type: TagType = r.type ? 1 : 0;
    const key = `${name}\u0000${type}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.itemCount += r.n as number;
      continue;
    }
    byKey.set(key, {
      name,
      type,
      itemCount: r.n as number,
      scopeCount: scope ? (scopeCounts.get(key) ?? 0) : undefined,
      color: colors.get(name)?.color,
    });
  }
  const all = [...byKey.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.type - b.type,
  );
  return { all, listed: scope ? all.filter((t) => t.scopeCount) : all };
}

/** The tags listed for the scope (see loadTagsWithScope). */
export async function loadTags(
  libraryID: number,
  scope?: Scope,
): Promise<TagRef[]> {
  return (await loadTagsWithScope(libraryID, scope)).listed;
}

/**
 * How many distinct items an edit of `names` touches, and how many of those
 * are outside the scope (including trashed ones).
 */
export async function measureImpact(
  libraryID: number,
  names: readonly string[],
  scope?: Scope,
): Promise<{ total: number; outsideScope: number }> {
  const tagIDs = await tagIDsOf(names);
  const all = new Set<number>();
  for (const part of chunks(tagIDs, CHUNK)) {
    const rows = await query(
      "SELECT DISTINCT it.itemID AS itemID FROM itemTags it " +
        "JOIN items i USING (itemID) " +
        `WHERE i.libraryID=? AND it.tagID IN (${placeholders(part.length)})`,
      [libraryID, ...part],
    );
    for (const r of rows) all.add(r.itemID as number);
  }
  if (!scope) return { total: all.size, outsideScope: 0 };

  const inside = new Set<number>();
  const rows = await query(
    "SELECT itemID AS itemID FROM items " +
      `WHERE itemID IN (${scopeItemsSql(scope)}) ` +
      "AND itemID NOT IN (SELECT itemID FROM deletedItems)",
    [scope.collectionID],
  );
  for (const r of rows) inside.add(r.itemID as number);
  let outside = 0;
  for (const id of all) if (!inside.has(id)) outside++;
  return { total: all.size, outsideScope: outside };
}

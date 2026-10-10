import { cleanName } from "../core/normalize";
import type { TagRef, TagType } from "../core/types";

export interface Scope {
  collectionID: number;
  includeSubcollections: boolean;
}

export interface TagColor {
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

export function getColorOf(
  libraryID: number,
  name: string,
): { color: string; position: number } | undefined {
  const list = getColorList(libraryID);
  const position = list.findIndex((x) => x.name === name);
  return position < 0 ? undefined : { color: list[position].color, position };
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
  const spellings = new Set<string>();
  for (const name of names) {
    const known = Zotero.Tags.getID(name);
    if (known) ids.add(known);
    spellings.add(name);
    spellings.add(name.normalize("NFD"));
  }
  for (const part of chunks([...spellings], CHUNK)) {
    const rows = await query(
      `SELECT tagID AS id FROM tags WHERE name IN (${placeholders(part.length)})`,
      part,
    );
    for (const r of rows) ids.add(r.id as number);
  }
  return [...ids];
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
 * All item IDs (trash included) that carry `name`, with the type on each.
 * An item carrying two stored forms of the name counts once, as manual if
 * either is manual.
 */
export async function itemsWithTag(
  libraryID: number,
  name: string,
): Promise<Array<{ id: number; type: TagType }>> {
  const ids = await tagIDsOf([name]);
  if (!ids.length) return [];
  const rows = await query(
    "SELECT it.itemID AS itemID, it.type AS type FROM itemTags it " +
      "JOIN items i USING (itemID) " +
      `WHERE it.tagID IN (${placeholders(ids.length)}) AND i.libraryID=? ` +
      "ORDER BY it.itemID",
    [...ids, libraryID],
  );
  const types = new Map<number, TagType>();
  for (const r of rows) {
    const id = r.itemID as number;
    const type: TagType = r.type ? 1 : 0;
    types.set(id, Math.min(types.get(id) ?? type, type) as TagType);
  }
  return [...types].map(([id, type]) => ({ id, type }));
}

/** Snapshot of the given tag names: membership, types and colors. */
export async function captureStates(
  libraryID: number,
  names: readonly string[],
): Promise<TagState[]> {
  const colors = getColorList(libraryID);
  const states: TagState[] = [];
  for (const name of names) {
    const position = colors.findIndex((x) => x.name === name);
    states.push({
      name,
      items: await itemsWithTag(libraryID, name),
      color:
        position < 0 ? undefined : { color: colors[position].color, position },
    });
  }
  return states;
}

/**
 * SQL selecting the collection IDs in scope (one `?` parameter: the root
 * collection). Used as `IN (...)` subquery so the outer statement can start
 * with SELECT. Trashed subcollections are skipped.
 */
function scopeIdsSql(scope: Scope): string {
  if (!scope.includeSubcollections) {
    return "SELECT collectionID FROM collections WHERE collectionID=?";
  }
  return (
    "WITH RECURSIVE cols(id) AS (" +
    "SELECT collectionID FROM collections WHERE collectionID=? " +
    "AND collectionID NOT IN (SELECT collectionID FROM deletedCollections) " +
    "UNION ALL SELECT c.collectionID FROM collections c " +
    "JOIN cols ON c.parentCollectionID=cols.id " +
    "WHERE c.collectionID NOT IN (SELECT collectionID FROM deletedCollections)" +
    ") SELECT id FROM cols"
  );
}

/**
 * Tags of a library with usage counts and colors. With a scope, only tags used
 * by (non-trashed) items of that collection are returned; `itemCount` stays
 * library-wide because edits are library-wide.
 */
export async function loadTags(
  libraryID: number,
  scope?: Scope,
): Promise<TagRef[]> {
  const totalRows = await query(
    "SELECT t.name AS name, it.type AS type, COUNT(DISTINCT it.itemID) AS n " +
      "FROM itemTags it JOIN tags t USING (tagID) JOIN items i USING (itemID) " +
      "WHERE i.libraryID=? GROUP BY t.tagID, it.type",
    [libraryID],
  );

  const colors = getColorList(libraryID);
  const colorByName = new Map(
    colors.map((x, position) => [x.name, { color: x.color, position }]),
  );

  const scopeCounts = new Map<string, number>();
  if (scope) {
    const rows = await query(
      "SELECT t.name AS name, it.type AS type, COUNT(DISTINCT it.itemID) AS n " +
        "FROM itemTags it JOIN tags t USING (tagID) " +
        "JOIN collectionItems ci USING (itemID) " +
        `WHERE ci.collectionID IN (${scopeIdsSql(scope)}) ` +
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
    const scopeCount = scope ? (scopeCounts.get(key) ?? 0) : undefined;
    if (scope && !scopeCount) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.itemCount += r.n as number;
      continue;
    }
    const color = colorByName.get(name);
    byKey.set(key, {
      name,
      type,
      itemCount: r.n as number,
      scopeCount,
      color: color?.color,
      position: color?.position,
    });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.type - b.type,
  );
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
    "SELECT DISTINCT ci.itemID AS itemID FROM collectionItems ci " +
      `WHERE ci.collectionID IN (${scopeIdsSql(scope)}) ` +
      "AND ci.itemID NOT IN (SELECT itemID FROM deletedItems)",
    [scope.collectionID],
  );
  for (const r of rows) inside.add(r.itemID as number);
  let outside = 0;
  for (const id of all) if (!inside.has(id)) outside++;
  return { total: all.size, outsideScope: outside };
}

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

/** Types (0 manual / 1 automatic) under which `name` is used in the library. */
export async function typesOf(
  libraryID: number,
  name: string,
): Promise<TagType[]> {
  const rows = await query(
    "SELECT DISTINCT it.type AS type FROM itemTags it " +
      "JOIN tags t USING (tagID) JOIN items i USING (itemID) " +
      "WHERE t.name=? AND i.libraryID=? ORDER BY it.type",
    [name, libraryID],
  );
  return rows.map((r) => (r.type ? 1 : 0));
}

/** All item IDs (trash included) that carry `name`, with the type on each. */
export async function itemsWithTag(
  libraryID: number,
  name: string,
): Promise<Array<{ id: number; type: TagType }>> {
  const rows = await query(
    "SELECT it.itemID AS itemID, it.type AS type FROM itemTags it " +
      "JOIN tags t USING (tagID) JOIN items i USING (itemID) " +
      "WHERE t.name=? AND i.libraryID=? ORDER BY it.itemID",
    [name, libraryID],
  );
  return rows.map((r) => ({ id: r.itemID as number, type: r.type ? 1 : 0 }));
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
      scopeCounts.set(
        `${(r.name as string).normalize()}\u0000${r.type ? 1 : 0}`,
        r.n as number,
      );
    }
  }

  const tags: TagRef[] = [];
  for (const r of totalRows) {
    const name = (r.name as string).normalize();
    const type: TagType = r.type ? 1 : 0;
    const scopeCount = scope
      ? (scopeCounts.get(`${name}\u0000${type}`) ?? 0)
      : undefined;
    if (scope && !scopeCount) continue;
    const color = colorByName.get(name);
    tags.push({
      name,
      type,
      itemCount: r.n as number,
      scopeCount,
      color: color?.color,
      position: color?.position,
    });
  }
  return tags.sort(
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
  const all = new Set<number>();
  for (const part of chunks(names, CHUNK)) {
    const rows = await query(
      "SELECT DISTINCT it.itemID AS itemID FROM itemTags it " +
        "JOIN tags t USING (tagID) JOIN items i USING (itemID) " +
        `WHERE i.libraryID=? AND t.name IN (${placeholders(part.length)})`,
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

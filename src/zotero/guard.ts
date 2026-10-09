export type GuardResult =
  | { ok: true; warnings: Array<"sync-in-progress"> }
  | { ok: false; reason: "no-library" | "read-only" | "tags-not-loaded" };

/**
 * Checks that must hold before any write. Blocking problems return ok:false;
 * soft problems (sync running) come back as warnings for the UI to confirm.
 */
export function preflight(libraryID: number): GuardResult {
  const library = Zotero.Libraries.get(libraryID);
  if (!library) return { ok: false, reason: "no-library" };
  if (!library.editable) return { ok: false, reason: "read-only" };
  try {
    Zotero.Tags.getID("");
  } catch {
    return { ok: false, reason: "tags-not-loaded" };
  }
  const warnings: Array<"sync-in-progress"> = [];
  if (Zotero.Sync?.Runner?.syncInProgress) warnings.push("sync-in-progress");
  return { ok: true, warnings };
}

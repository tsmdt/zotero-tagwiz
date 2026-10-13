export type GuardResult =
  | { ok: true; warnings: Array<"sync-in-progress"> }
  | { ok: false; reason: "no-library" | "read-only" | "tags-not-loaded" };

/** The error a failed preflight stands for. */
export function guardError(reason: string): Error {
  return new Error(`Cannot edit tags: ${reason}`);
}

/** Throws unless preflight passes. */
export function assertEditable(libraryID: number): void {
  const guard = preflight(libraryID);
  if (!guard.ok) throw guardError(guard.reason);
}

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

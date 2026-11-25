/**
 * The names of the objects beside its table that a view declared
 * `.materialized({ refresh: "auto" })` needs: what its migration creates and
 * what `$refresh` reads (the ordinary view that holds its body). One module,
 * of no dependency, that the migrations and the client both import.
 */

/** The longest name PostgreSQL keeps whole; MySQL keeps 64 characters, SQLite any. */
const OBJECT_NAME_BYTES = 63;

/**
 * `<view>_viborm<suffix>`, unique in the schema as MySQL and SQLite want a
 * trigger's name to be. Where that passes 63 bytes (a table's name is ASCII),
 * the view's name is cut and an eight-character hash of the whole follows it
 * (a 32-bit polynomial hash: a name, not a secret).
 */
export function autoViewObjectName(view: string, suffix: string): string {
  const name = `${view}_viborm${suffix}`;
  if (name.length <= OBJECT_NAME_BYTES) return name;
  let hash = 5381;
  for (let at = 0; at < name.length; at++)
    hash = (hash * 33 + name.charCodeAt(at)) % 0x1_00_00_00_00;
  const tail = `_${hash.toString(16).padStart(8, "0")}_viborm${suffix}`;
  return `${view.slice(0, OBJECT_NAME_BYTES - tail.length)}${tail}`;
}

/** The longest name of a view kept by triggers: its body's view's then fits in 63 bytes. */
export const AUTO_VIEW_NAME_BYTES = OBJECT_NAME_BYTES - "_viborm_body".length;

/**
 * The ordinary view that holds such a view's body: what its triggers, its
 * filling and `$refresh` read. Never cut: the view's own name is at most
 * {@link AUTO_VIEW_NAME_BYTES} long (`W005`), so the client spells it
 * without the hash.
 */
export const autoViewBodyName = (view: string): string => `${view}_viborm_body`;

/**
 * The one virtual-root snapshot. Not a stored second root.
 */

import type { SchemaSnapshot } from "./types";

export function emptyManagedSnapshot(): SchemaSnapshot {
  return { tables: [], enums: [] };
}

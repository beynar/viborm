/**
 * What reads `rows`, `data`, `deletion` and `order` declarations, brought by
 * what declares one: `defineExtension()`, `defineFilters()` and the official
 * extensions. What reads a `rows` member's `verbs` and `confine` comes apart,
 * with `withVerbs()`.
 */
import { admitRows } from "./admission";
import { bindRows, undeclaredControlReferencesOf } from "./rows";
import {
  installRowsRuntime,
  installVerbs,
  type RowsRuntime,
} from "./rows-slot";
import { VERBS } from "./verbs";

const runtime: RowsRuntime = {
  admitRows,
  bindRows,
  undeclaredControlReferencesOf,
};

/** Brings what reads these declarations to every client of this program. */
export const withRows = (): void => installRowsRuntime(runtime);

/**
 * Brings what reads a `rows` member's `verbs` and `confine`: what judges the
 * rows a write produces and what a read carries beside them or hides.
 */
export const withVerbs = (): void => installVerbs(VERBS);

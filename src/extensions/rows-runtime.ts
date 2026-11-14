/**
 * What reads `rows`, `data`, `deletion` and `order` declarations, brought by
 * what declares one: `defineExtension()` and the official extensions.
 */
import { admitRows, isAdmittedRows, isImmutableRowData } from "./admission";
import {
  admittedRowsOf,
  bindRows,
  checkingLazyReferences,
  isLazy,
  undeclaredControlReferencesOf,
} from "./rows";
import { installRowsRuntime, type RowsRuntime } from "./rows-slot";

const runtime: RowsRuntime = {
  admitRows,
  isAdmittedRows,
  isImmutableRowData,
  bindRows,
  checkingLazyReferences,
  undeclaredControlReferencesOf,
  isLazy,
  admittedRowsOf,
};

/** Brings what reads these declarations to every client of this program. */
export const withRows = (): void => installRowsRuntime(runtime);

/**
 * Where the client finds what reads `rows`, `data`, `deletion` and `order`
 * declarations. The client names what it asks of them and brings none of it:
 * what declares one brings it (`withRows`), so a client no extension of that
 * kind is applied to does not carry it.
 */
import { ClientInitializationError } from "@errors";
import type * as Admission from "./admission";
import type * as Rows from "./rows";

export interface RowsRuntime {
  readonly admitRows: typeof Admission.admitRows;
  readonly isAdmittedRows: typeof Admission.isAdmittedRows;
  readonly isImmutableRowData: typeof Admission.isImmutableRowData;
  readonly bindRows: typeof Rows.bindRows;
  readonly checkingLazyReferences: typeof Rows.checkingLazyReferences;
  readonly undeclaredControlReferencesOf: typeof Rows.undeclaredControlReferencesOf;
  readonly isLazy: typeof Rows.isLazy;
  readonly admittedRowsOf: typeof Rows.admittedRowsOf;
}

let installed: RowsRuntime | undefined;

export const installRowsRuntime = (runtime: RowsRuntime): void => {
  installed = runtime;
};

/** What reads the declarations: there once something that declares one was built. */
export function rowsRuntime(): RowsRuntime {
  if (installed === undefined)
    throw new ClientInitializationError(
      "An extension that declares `rows`, `data`, `deletion` or `order` must be built with defineExtension()."
    );
  return installed;
}

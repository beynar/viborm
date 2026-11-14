/**
 * Where the client finds what reads `rows`, `data`, `deletion` and `order`
 * declarations. The client names what it asks of them and brings none of it:
 * what declares one brings it (`withRows`), so a client no extension of that
 * kind is applied to does not carry it. What reads a member's `verbs` and
 * `confine` is brought apart (`withVerbs`): an extension whose rows only
 * filter does not carry it.
 */
import { ClientInitializationError } from "@errors";
import type * as Admission from "./admission";
import type * as Rows from "./rows";
import type { VERBS } from "./verbs";

export interface RowsRuntime {
  readonly admitRows: typeof Admission.admitRows;
  readonly bindRows: typeof Rows.bindRows;
  readonly undeclaredControlReferencesOf: typeof Rows.undeclaredControlReferencesOf;
}

let installed: RowsRuntime | undefined;
let verbs: typeof VERBS | undefined;

export const installRowsRuntime = (runtime: RowsRuntime): void => {
  installed = runtime;
};

export const installVerbs = (reader: typeof VERBS): void => {
  verbs = reader;
};

/** What reads the declarations: there once something that declares one was built. */
export function rowsRuntime(): RowsRuntime {
  if (installed === undefined)
    throw new ClientInitializationError(
      "An extension that declares `rows`, `data`, `deletion` or `order` must be built with defineExtension()."
    );
  return installed;
}

/** What admits `verbs` and `confine`: there once something that declares one was built. */
export function verbsAdmission(): typeof VERBS {
  if (verbs === undefined)
    throw new ClientInitializationError(
      "An extension whose `rows` declare `verbs` or `confine` must be built with defineExtension()."
    );
  return verbs;
}

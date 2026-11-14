/**
 * `parts<Of>()`: the vocabulary typed against one client or one schema, for
 * an extension written apart from the `$extends` it is passed to. The same
 * builders: only their types are bound, so importing it carries every
 * builder.
 */
import { args } from "./args";
import { around, call } from "./call";
import type { Parts, TargetOf } from "./contract";
import { defaults } from "./defaults";
import { disclosure } from "./disclosure";
import { extension } from "./extension";
import { fields } from "./fields";
import { methods } from "./methods-part";
import { target } from "./on";
import { rule } from "./rule";
import { unit } from "./unit";

/** The builders, typed against `Of`: a client's type, or a schema. */
export function parts<Of>(): Parts<TargetOf<Of>>;
export function parts(): unknown {
  return {
    extension,
    call,
    around,
    target,
    unit,
    rule,
    defaults,
    disclosure,
    args,
    methods,
    fields,
  };
}

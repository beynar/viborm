import type { VibSchema } from "../types";
import { fail } from "./helpers";

// Filter parsing is synchronous. Bound semantic filter containers before
// descending, including scalar `not`, without restricting JSON data depth.
let activeDepth = 0;
const MAX_FILTER_DEPTH = 16;

export function limitFilterDepth<S extends VibSchema>(schema: S): S {
  const validate = schema["~standard"].validate;
  Object.defineProperty(schema["~standard"], "validate", {
    value: (value: unknown) => {
      if (activeDepth >= MAX_FILTER_DEPTH)
        return fail(`Filter nesting exceeds ${MAX_FILTER_DEPTH} levels`);
      activeDepth++;
      try {
        return validate(value);
      } finally {
        activeDepth--;
      }
    },
  });
  return schema;
}

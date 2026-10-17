import type { VibSchema } from "../types";
import { fail } from "./helpers";

// Filter parsing is synchronous. Bound semantic filter containers before
// descending, including scalar `not`, without restricting JSON data depth.
let activeDepth = 0;
const MAX_FILTER_DEPTH = 16;
let bounded = true;

/**
 * Run `parse` without the bound: a domain predicate is the application's own
 * data, whose termination its lowering proves (the bound is for payloads).
 */
export function withoutFilterDepthBound<T>(parse: () => T): T {
  const previous = bounded;
  bounded = false;
  try {
    return parse();
  } finally {
    bounded = previous;
  }
}

export function limitFilterDepth<S extends VibSchema>(schema: S): S {
  const validate = schema["~standard"].validate;
  Object.defineProperty(schema["~standard"], "validate", {
    value: (value: unknown) => {
      if (bounded && activeDepth >= MAX_FILTER_DEPTH)
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

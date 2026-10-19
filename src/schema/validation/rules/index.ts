// Advisory validation rules.
//
// Structural relation topology is not here: the mandatory gate
// (`../relation-resolution`) owns it and runs at every effect-capable boundary,
// including the ones that skip this list.

export * from "./model";
export * from "./relation";

import type { ValidationRule } from "../types";
import { modelRules } from "./model";
import { relationRules } from "./relation";

/**
 * Every advisory rule, model rules first. A function, not a module constant:
 * the spread would run at import, so a bundle that never validates advice
 * would still keep every rule.
 */
export function allRules(): ValidationRule[] {
  return [...modelRules, ...relationRules];
}

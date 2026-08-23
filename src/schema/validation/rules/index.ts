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

export const allRules: ValidationRule[] = [...modelRules, ...relationRules];

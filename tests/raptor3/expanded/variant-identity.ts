import assert from "node:assert/strict";
import { G1_VARIANT_IDENTITY_CASE_IDS } from "../contracts";
import { capturedDecimalScenario } from "./captured-decimal";
import { independentArithmeticScenario } from "./independent-arithmetic";
import { uniqueFilterScenarios } from "./unique-filter-identity";
import { variantJunctionScenarios } from "./variant-junctions";
import { variantRowScenarios } from "./variant-rows";

export const variantIdentityScenarios = [
  ...variantRowScenarios,
  ...variantJunctionScenarios,
  ...uniqueFilterScenarios,
  independentArithmeticScenario,
  capturedDecimalScenario,
];

assert.deepEqual(
  variantIdentityScenarios.map((scenario) => scenario.id),
  G1_VARIANT_IDENTITY_CASE_IDS,
  "Missing, duplicate, or reordered G1 variant/identity cell"
);

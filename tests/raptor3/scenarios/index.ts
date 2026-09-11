import assert from "node:assert/strict";
import type { ScenarioId } from "../contracts";
import { expandedScenarios } from "../expanded";
import { lifetimeScenarios } from "../expanded/lifetimes";
import { variantIdentityScenarios } from "../expanded/variant-identity";
import { keyTransitionScenarios } from "../transitions/keys";
import { singularTransitionScenarios } from "../transitions/singular";
import { capturedKeyScenarios } from "../transitions/staleness";
import { junctionTransitionScenarios } from "../transitions/junctions";
import { junctionIdentityScenarios } from "../transitions/junction-identity";
import { membershipOwnWriteScenarios } from "../transitions/membership-own-write";
import { seriesStalenessScenarios } from "../transitions/series-staleness";
import { requiredMembershipScenarios } from "../transitions/required";
import { ownWriteScenarios } from "../transitions/own-write";
import { occupiedKeyScenarios } from "../transitions/occupied-keys";
import { supplierContinuationScenarios } from "../transitions/supplier-continuations";
import { singularLatticeScenarios } from "../transitions/singular-lattice";
import { conditionalUpsertScenarios } from "../transitions/conditional-upsert";
import { sharedKeySupplierScenarios } from "../transitions/shared-key-suppliers";
import { mixedKeyTransitionScenarios } from "../transitions/mixed-key-transitions";
import { variantRemovalScenarios } from "../transitions/variant-removals";
import { polishScenarios } from "../polish/scenarios";
import { clockScenarios } from "./clocks";
import { fixedScenarios } from "./contracts";
import { cutScenarios } from "./cuts";

export const replayScenarios = [
  ...fixedScenarios,
  ...cutScenarios,
  ...clockScenarios,
  ...expandedScenarios,
  ...lifetimeScenarios,
  ...variantIdentityScenarios,
  ...keyTransitionScenarios,
  ...singularTransitionScenarios,
  ...capturedKeyScenarios,
  ...junctionTransitionScenarios,
  ...junctionIdentityScenarios,
  ...membershipOwnWriteScenarios,
  ...seriesStalenessScenarios,
  ...requiredMembershipScenarios,
  ...ownWriteScenarios,
  ...occupiedKeyScenarios,
  ...supplierContinuationScenarios,
  ...singularLatticeScenarios,
  ...conditionalUpsertScenarios,
  ...sharedKeySupplierScenarios,
  ...mixedKeyTransitionScenarios,
  ...variantRemovalScenarios,
  ...polishScenarios,
];

export function findReplayScenario(id: ScenarioId) {
  const scenario = replayScenarios.find((candidate) => candidate.id === id);
  assert(scenario, `Unknown replay scenario ${id}`);
  return scenario;
}

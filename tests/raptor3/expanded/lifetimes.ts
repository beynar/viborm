import { engineReuseScenarios } from "./engine-reuse";
import { upsertLegalityScenarios } from "./upsert-legality";

export const lifetimeScenarios = [
  ...upsertLegalityScenarios,
  ...engineReuseScenarios,
];

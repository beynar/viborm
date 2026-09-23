import { associationScenarios } from "./associations";
import { compoundScenarios } from "./compound";
import { readScenarios } from "./reads";

export const expandedScenarios = [
  ...associationScenarios,
  ...compoundScenarios,
  ...readScenarios,
];

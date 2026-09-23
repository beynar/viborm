import { conditionalScenarios } from "./conditional";
import { correlatedScenarios } from "./correlated";
import { groupedScenarios } from "./grouped";
import { instanceScenarios } from "./instances";

export const fixedScenarios = [
  ...conditionalScenarios,
  ...instanceScenarios,
  ...groupedScenarios,
  ...correlatedScenarios,
];

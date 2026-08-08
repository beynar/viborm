// Validation Rules Index

export * from "./fk";
export * from "./model";
export * from "./relation";

import type { ValidationRule } from "../types";
import { fkRules } from "./fk";
import { modelRules } from "./model";
import { relationRules } from "./relation";

export const allRules: ValidationRule[] = [
  ...modelRules,
  ...relationRules,
  ...fkRules,
];

// Validation Rules Index

export * from "./database";
export * from "./fk";
export * from "./model";
export * from "./relation";

import type { ValidationRule } from "../types";
import { databaseRules } from "./database";
import { fkRules } from "./fk";
import { modelRules } from "./model";
import { relationRules } from "./relation";

export const allRules: ValidationRule[] = [
  ...modelRules,
  ...relationRules,
  ...fkRules,
  ...databaseRules,
];

// Validation Rules Index

export * from "./model";
export * from "./relation";
export * from "./fk";
export * from "./database";

import { modelRules } from "./model";
import { relationRules } from "./relation";
import { fkRules } from "./fk";
import { databaseRules } from "./database";
import type { ValidationRule } from "../types";

export const allRules: ValidationRule[] = [
  ...modelRules,
  ...relationRules,
  ...fkRules,
  ...databaseRules,
];

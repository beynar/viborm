// Validation Rules Index

export * from "./fk";
export * from "./model";
export * from "./polymorphic";
export * from "./relation";

import type { ValidationRule } from "../types";
import { fkRules } from "./fk";
import { modelRules } from "./model";
import { polymorphicRules } from "./polymorphic";
import { relationRules } from "./relation";

export const allRules: ValidationRule[] = [
  ...modelRules,
  ...relationRules,
  ...polymorphicRules,
  ...fkRules,
];

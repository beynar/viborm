// biome-ignore-all lint/style/useFilenamingConvention: OperationFragment is the architecture name.
import type { Sql } from "@sql";

export const OPERATION_VALUE_REFERENCE = Symbol(
  "viborm.operationValueReference"
);

export interface OperationValueReference {
  readonly kind: typeof OPERATION_VALUE_REFERENCE;
  readonly step: string;
  readonly output: string;
}

export type StatementOutputSource =
  | { readonly kind: "rows" }
  | { readonly kind: "insertId" }
  | { readonly kind: "firstRowField"; readonly field: string };

export interface StatementStep {
  readonly id: string;
  readonly kind: "read" | "write";
  readonly statement: Sql;
  readonly outputs: Readonly<Record<string, StatementOutputSource>>;
}

export interface GuardStep {
  readonly id: string;
  readonly kind: "guard";
  readonly premise: {
    readonly kind: "exists" | "notExists";
    readonly statement: Sql;
  };
  readonly failure: {
    readonly kind: "nestedWrite";
    readonly message: string;
    readonly relation: string;
  };
}

export type OperationStep = StatementStep | GuardStep;

export interface OperationFragment {
  readonly steps: readonly OperationStep[];
  readonly outputs: Readonly<Record<string, OperationValueReference>>;
}

export function ref(step: string, output: string): OperationValueReference {
  return { kind: OPERATION_VALUE_REFERENCE, step, output };
}

export function isOperationValueReference(
  value: unknown
): value is OperationValueReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === OPERATION_VALUE_REFERENCE &&
    "step" in value &&
    typeof value.step === "string" &&
    "output" in value &&
    typeof value.output === "string"
  );
}

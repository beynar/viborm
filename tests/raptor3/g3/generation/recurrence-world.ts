import type { Schema } from "@client/types";
import type { PreparedScenario, StateRows } from "../../harness/protocol";
import type { G3GeneratedRecipe } from "./recipe";

export type RecurrenceRecipe = Extract<G3GeneratedRecipe, { contract: "C11" }>;

export interface GeneratedRecurrenceOperation {
  readonly model: string;
  readonly operation: "create" | "update";
  readonly args: unknown;
  readonly expected: unknown;
}

export interface RecurrenceWorld {
  readonly schema: Schema;
  readonly operations: readonly GeneratedRecurrenceOperation[];
  readonly initial: StateRows;
  readonly final: StateRows;
  readonly seed: PreparedScenario["seed"];
  readonly inspect: PreparedScenario["inspect"];
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

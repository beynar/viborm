import type { RelationMutation } from "../../builders/relation-data-builder";
import { NestedWriteError } from "../../types";

const PLANNED_MUTATION_KEYS = [
  "update",
  "updateMany",
  "upsert",
  "deleteMany",
] as const;

type PlannedMutationKey = (typeof PLANNED_MUTATION_KEYS)[number];

type PlannedMutationContext = "create" | "upsertCreate";

export function assertNoPlannedNestedMutationExecution(
  relations: Record<string, RelationMutation>,
  context: PlannedMutationContext
): void {
  for (const [relationName, mutation] of Object.entries(relations)) {
    const plannedKey = getPlannedMutationKey(mutation);
    if (!plannedKey) {
      continue;
    }

    throw new NestedWriteError(
      getPlannedMutationMessage(relationName, plannedKey, context),
      relationName,
      { meta: { operation: plannedKey, context } }
    );
  }
}

function getPlannedMutationKey(
  mutation: RelationMutation
): PlannedMutationKey | undefined {
  return PLANNED_MUTATION_KEYS.find((key) => mutation[key] !== undefined);
}

function getPlannedMutationMessage(
  relationName: string,
  operation: PlannedMutationKey,
  context: PlannedMutationContext
): string {
  const branch =
    context === "create" ? "parent create" : "upsert create branch";
  return (
    `Nested operation '${operation}' on relation '${relationName}' is not supported in ${branch}. ` +
    "Only create, createMany, connect, and connectOrCreate are allowed there."
  );
}

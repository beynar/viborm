// biome-ignore-all lint/style/useFilenamingConvention: RecordUpdateCompiler is the architecture name.
import { getPrimaryKeyFields } from "../builders/correlation-utils";
import { bindRelation } from "../builders/relation-data-builder";
import { buildParsedRelationPrograms } from "../builders/relation-mutation-parser";
import { getWhereUniqueEntries } from "../builders/where-unique-builder";
import type { QueryEngine } from "../query-engine";
import type { QueryScope } from "../types";
import type { ForeignKeyMember } from "./foreign-key-reference";
import type { OperationStep, StatementStep } from "./OperationFragment";
import type { PlanningKnown } from "./Part";
import type { StepScope } from "./StepScope";
import { type NestedTargetLocate, UnsupportedOperationError } from "./shared";
import { UpdateOperation } from "./UpdateOperation";

export interface RecordUpdateCompiler {
  readonly targetReadId: string;
  readonly writeId: string;
  readonly requiredTargetFields: readonly string[];
  planning(): readonly StatementStep[];
  conditionalPlanning(): readonly StatementStep[];
  compile(known: PlanningKnown): readonly OperationStep[];
  assertLegality(): void;
}

export interface RecordUpdateCompilerInput {
  readonly scope: StepScope;
  readonly engine: QueryEngine;
  readonly targetScope: QueryScope;
  readonly data: Record<string, unknown>;
  readonly locate:
    | NestedTargetLocate
    | ((targetReadId: string) => NestedTargetLocate);
  readonly targetReadLabel: string;
  readonly targetReadId?: string;
  readonly writeLabel: string;
  readonly incomingForeignKey?: readonly ForeignKeyMember[];
  readonly deferLegality?: boolean;
}

/** Build the mutation core for one row whose target read belongs to the caller. */
export function buildRecordUpdateCompiler(
  input: RecordUpdateCompilerInput
): RecordUpdateCompiler | undefined {
  const parsed = buildParsedRelationPrograms(input.targetScope, input.data);
  if (
    Object.keys(parsed.scalarData).length === 0 &&
    Object.keys(parsed.relations).length === 0 &&
    (input.incomingForeignKey?.length ?? 0) === 0
  ) {
    return undefined;
  }
  assertUnpinnedTransitionIsCompilable(input, parsed);

  const targetReadId =
    input.targetReadId ?? input.scope.allocate(input.targetReadLabel);
  const writeId = input.scope.allocate(input.writeLabel);
  const locate =
    typeof input.locate === "function"
      ? input.locate(targetReadId)
      : input.locate;

  const operation = new UpdateOperation(
    input.engine,
    input.targetScope.model,
    {},
    {
      scope: input.scope,
      skipOwnWrite: true,
      nestedTarget: {
        data: input.data,
        locate,
        targetReadId,
        writeId,
      },
      ...(input.incomingForeignKey
        ? { incomingForeignKey: input.incomingForeignKey }
        : {}),
      ...(input.deferLegality ? { deferArmLegality: true } : {}),
    }
  );

  return {
    targetReadId: operation.selectedTargetReadId(),
    writeId: operation.selectedWriteId(),
    requiredTargetFields: operation.selectedRequiredTargetFields(),
    planning: () => operation.selectedPlanning(),
    conditionalPlanning: () => operation.selectedConditionalPlanning(),
    compile: (known) => operation.compileSelected(known),
    assertLegality: () => operation.assertArmLegality(),
  };
}

function assertUnpinnedTransitionIsCompilable(
  input: RecordUpdateCompilerInput,
  parsed: ReturnType<typeof buildParsedRelationPrograms>
): void {
  const primaryKey = getPrimaryKeyFields(input.targetScope.model)[0];
  if (!(primaryKey && Object.hasOwn(parsed.scalarData, primaryKey))) return;
  if (typeof input.locate === "function") return;
  const locate = input.locate;
  const pinsPrimaryKey = locate?.where
    ? getWhereUniqueEntries(input.targetScope, locate.where).some(
        (entry) => entry.fieldName === primaryKey
      )
    : false;
  if (pinsPrimaryKey) return;

  for (const program of Object.values(parsed.relations)) {
    const relation = bindRelation(input.targetScope, program.relationInfo);
    if (relation.kind === "junction") continue;
    if (
      relation.referencedFields.includes(primaryKey) &&
      relation.onUpdate !== "cascade"
    ) {
      throw new UnsupportedOperationError(
        `query-engine-v2 update for relation '${locate.relationName}' transitions the target primary key '${primaryKey}' while writing a deeper edge whose foreign key does not cascade on update; it must locate the target by that primary key.`
      );
    }
  }
}

// biome-ignore-all lint/style/useFilenamingConvention: FreshRecordSeriesPart is the architecture name.
import type {
  RecordMutationData,
  RelationMutationEntry,
} from "../builders/relation-mutation-parser";
import { createQueryScope } from "../context/query-scope";
import type { QueryEngine } from "../query-engine";
import type { QueryScope } from "../types";
import type { FreshRecordBuilder, FreshRecordPart } from "./CreateOperation";
import { nestedWriteFailure } from "./fragment-builders";
import { recordMutationCarriesRelations } from "./junction-create-many-routing";
import type { ExecutableOperation } from "./OperationExecutor";
import type {
  OperationFragment,
  PlanningFragment,
  RecordSeriesStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import type {
  RecordSeriesOperation,
  SeriesRootConflictDisposition,
} from "./record-series";
import {
  type FinalReferenceSource,
  type RelationMembershipBinding,
  resolveFinalReferenceRowKey,
  resolveMembershipReferencedPremise,
  resolveMembershipWriteParentRowKey,
} from "./relation-membership";
import type { StepScope } from "./StepScope";
import { selectExecutionMode } from "./shared";
import { completeTargetPresenceGuard } from "./target-projection";

type NestedCreateManyEntry = Extract<
  RelationMutationEntry,
  { kind: "createMany" }
>;

/** One owner for the route question. The returned programs are interpretations of
 * already-validated rows; scalar defaults are not evaluated a second time. */
export function createManyCarriesRelations(
  childScope: QueryScope,
  entry: NestedCreateManyEntry
): boolean {
  return entry.rows.some((row) =>
    recordMutationCarriesRelations(childScope, row)
  );
}

interface FreshSeriesMemberOperation extends ExecutableOperation {
  readonly seriesRootConflict: SeriesRootConflictDisposition | undefined;
}

/**
 * Place relation-bearing createMany rows at one exact point in an enclosing
 * record tree. Each member remains one ordinary fresh-record compiler subtree;
 * the series owns only left-to-right suspension and discards its private result.
 */
interface FreshRecordSeriesPartInput {
  readonly scope: StepScope;
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  readonly relationName: string;
  readonly rows: readonly RecordMutationData[];
  readonly incomingMembership: RelationMembershipBinding;
  /** Complete identity of the already-written parent at this placement. */
  readonly parentRowKey?: Readonly<Record<string, FinalReferenceSource>>;
  readonly skipDuplicates: boolean;
  readonly createFresh: FreshRecordBuilder;
}

export function buildFreshRecordSeriesPart(
  input: FreshRecordSeriesPartInput
): Part {
  const records = input.rows.map((data) =>
    input.createFresh(input.scope, {
      childScope: input.childScope,
      data,
      incomingMembership: input.incomingMembership,
      relationName: input.relationName,
      skipDuplicates: input.skipDuplicates,
    })
  );
  const stepId = input.scope.allocate(`${input.childName}.createManySeries`);
  const mode = selectExecutionMode(input.engine, "create");

  return {
    planning: () => [],
    compile: (scope, enclosingKnown) => [
      {
        id: stepId,
        kind: "recordSeries",
        progressive: progressiveParentGuard(input, stepId, enclosingKnown),
        series: freshRecordSeries(records, scope, enclosingKnown, mode),
      },
    ],
  };
}

function progressiveParentGuard(
  input: FreshRecordSeriesPartInput,
  stepId: string,
  known: PlanningKnown
): RecordSeriesStep["progressive"] {
  if (
    input.engine.driver.supportsTransactions ||
    !input.engine.driver.supportsBatch
  ) {
    return {
      kind: "unsupported",
      reason: "this execution substrate does not use progressive commits",
    };
  }

  const parent = input.incomingMembership.relation.membership.referenced;
  const identity = input.parentRowKey
    ? resolveFinalReferenceRowKey(
        parent,
        Object.entries(input.parentRowKey).map(([field, source]) => ({
          field,
          source,
        })),
        known,
        input.relationName,
        "createMany"
      )
    : resolveMembershipWriteParentRowKey(
        input.incomingMembership,
        known,
        "createMany"
      );
  if (!identity) {
    return {
      kind: "unsupported",
      reason: `nested relation-bearing createMany on relation '${input.relationName}' cannot re-pin the complete parent row key`,
    };
  }

  // Residual I, the H1 carry-item. The selected record's row key answers LIVENESS,
  // and on the shape H1 lifted it is the ONLY thing it answers: the parent was
  // located by a non-primary-key unique and the child's foreign key references that
  // same column, so the value each member is about to write is a captured
  // `code`-like value the liveness guard never mentions. Between two committed
  // segments that value can move to another row, and the guard would still pass —
  // §H1's "a reference value is not row identity", read in the direction it also
  // holds. This fresh-series entrance asks for membership when the selected record
  // supplies `parentRowKey`; RelationWritePart uses the same relation-membership owner
  // with its explicit read/write temporal position.
  const membership = input.parentRowKey
    ? resolveMembershipReferencedPremise(
        input.incomingMembership,
        known,
        "createMany"
      )
    : {};
  if (!membership) {
    return {
      kind: "unsupported",
      reason: `nested relation-bearing createMany on relation '${input.relationName}' cannot re-assert the exact parent membership its rows reference`,
    };
  }

  return {
    kind: "guarded",
    guard: completeTargetPresenceGuard(
      createQueryScope(input.engine, parent),
      `${stepId}.parent`,
      identity,
      nestedWriteFailure(
        `Cannot create relation '${input.relationName}': parent record changed across a committed segment.`,
        input.relationName
      ),
      membership
    ),
  };
}

function freshRecordSeries(
  records: readonly FreshRecordPart[],
  scope: StepScope,
  enclosingKnown: PlanningKnown,
  mode: ExecutableOperation["mode"]
): RecordSeriesOperation {
  return {
    executionKind: "recordSeries",
    capture: (): PlanningFragment => ({ steps: [] }),
    compileMembers: () =>
      records.map(
        (record): FreshSeriesMemberOperation => ({
          mode,
          planning: (): PlanningFragment => ({
            steps: record.planning(scope),
          }),
          compile: (memberKnown): OperationFragment => ({
            steps: record.compile(scope, {
              ...enclosingKnown,
              ...memberKnown,
            }),
            outputs: {},
          }),
          // This operation is a private subtree placement. The enclosing record
          // owns the public result, so the executor intentionally discards this value.
          parse: <T>(): T => undefined as T,
          get seriesRootConflict() {
            return record.seriesRootConflict;
          },
        })
      ),
    compileResultReads: () => [],
    parseSeries: () => undefined,
  };
}

// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this record-series owner.
import { QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import type { JunctionBoundRelation } from "../builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  buildRelationMutationProgram,
  type ParsedRecordPrograms,
  type RecordMutationData,
  type RelationMutationEntry,
} from "../builders/relation-mutation-parser";
import { getTableName } from "../context/query-scope";
import { ManyToManyStatements } from "../ManyToManyStatements";
import { assertUpdateOwnWriteSafety } from "../OwnWriteAnalyzer";
import { buildFind, buildFindUnique } from "../operations";
import { assertPortablePrimaryKeyUpdateInput } from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import {
  assertRelationKeyUpdatesAreCompilable,
  assertSingleTargetMembershipMoveAppliesToRecords,
} from "../relation-key-legality";
import type { QueryScope, RelationInfo } from "../types";
import {
  exactlyOneRow,
  nestedWriteFailure,
  presenceGuard,
} from "./fragment-builders";
import { relationTargetNotFound } from "./messages";
import type { ExecutableOperation } from "./OperationExecutor";
import type {
  GuardStep,
  OperationFragment,
  PlanningFragment,
  ReadStep,
} from "./OperationFragment";
import { planningKey } from "./Part";
import { parseValidated } from "./parse-boundary";
import type {
  RecordCompilerSeam,
  RecordUpdateCompiler,
} from "./RecordUpdateCompiler";
import type { RecordSeriesOperation } from "./record-series";
import {
  type CorrelatedRelationMembershipBinding,
  finalMembershipCondition,
} from "./relation-membership";
import { StepScope } from "./StepScope";
import { parseSeriesRowKeys } from "./series-result-read";
import { getStepModelName, isRecord, selectExecutionMode } from "./shared";
import {
  buildTargetProjection,
  capturedTargetColumnPredicate,
  capturedTargetFilters,
  capturedTargetValues,
  capturedTargetWhere,
  sortCapturedRowKeys,
  type TargetProjection,
  targetProjectionColumns,
  targetProjectionOutputs,
  targetProjectionRowKeySelect,
  targetProjectionSelect,
} from "./target-projection";

type NestedUpdateManyMembership =
  | {
      readonly kind: "childHeld";
      readonly binding: CorrelatedRelationMembershipBinding;
      readonly known: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "junction";
      readonly relation: JunctionBoundRelation;
      readonly parentValue: unknown;
      readonly txMode: boolean;
    };

export interface NestedUpdateManyRecordSeriesInput {
  readonly engine: QueryEngine;
  /** Model whose public relation schema admitted this updateMany payload. */
  readonly sourceScope: QueryScope;
  readonly targetScope: QueryScope;
  readonly relationInfo: RelationInfo;
  readonly data: RecordMutationData;
  readonly capture: ReadStep;
  readonly recordCompilers: RecordCompilerSeam;
  readonly membership: NestedUpdateManyMembership;
}

/**
 * One nested relation-level updateMany whose data carries a record subtree.
 *
 * The relation owner supplies the exact membership capture. This owner only
 * turns each captured complete row key into one selected-record compilation.
 * It publishes no value: the enclosing record operation owns the public result.
 */
export class NestedUpdateManyRecordSeries implements RecordSeriesOperation {
  readonly executionKind = "recordSeries" as const;

  private readonly input: NestedUpdateManyRecordSeriesInput;
  private readonly rowKeyProjection: TargetProjection;
  private readonly source: Record<string, unknown>;

  constructor(input: NestedUpdateManyRecordSeriesInput) {
    this.input = input;
    this.rowKeyProjection = buildTargetProjection(input.targetScope.model);
    this.source = requireReplaySource(input.data, input.relationInfo.name);
  }

  capture(): PlanningFragment {
    return { steps: [this.input.capture] };
  }

  compileMembers(
    captured: Readonly<Record<string, unknown>>
  ): readonly ExecutableOperation[] {
    const rows = this.capturedRows(captured);
    if (rows.length === 0) return [];

    // Build every member before the first effect. Apart from preserving the series
    // contract, this evaluates client defaults once per selected record rather than
    // sharing the enclosing schema parse's already-materialized value.
    const prepared = rows.map((row) => this.prepareMember(row));
    assertSingleTargetMembershipMoveAppliesToRecords(
      this.input.targetScope,
      prepared[0]!.parsed.relations,
      rows.length
    );
    return prepared.flatMap((member) =>
      member.operation ? [member.operation] : []
    );
  }

  compileResultReads(): readonly ExecutableOperation[] {
    return [];
  }

  parseSeries(): undefined {
    return undefined;
  }

  private capturedRows(
    captured: Readonly<Record<string, unknown>>
  ): readonly Record<string, unknown>[] {
    const value = captured[`${this.input.capture.id}.rows`];
    if (!Array.isArray(value)) {
      throw new QueryEngineError(
        `query-engine-v2 nested updateMany for relation '${this.input.relationInfo.name}' did not expose its captured target rows.`
      );
    }
    const rows = value.map((row) => {
      if (!isRecord(row)) {
        throw new QueryEngineError(
          `query-engine-v2 nested updateMany for relation '${this.input.relationInfo.name}' captured an invalid target row.`
        );
      }
      return row;
    });
    return sortCapturedRowKeys(
      this.rowKeyProjection.identityFields,
      parseSeriesRowKeys(
        this.input.engine,
        this.input.targetScope.model,
        "updateManyAndReturn",
        rows
      )
    );
  }

  private prepareMember(row: Record<string, unknown>): PreparedMember {
    const parsed = this.replayData();
    assertPortablePrimaryKeyUpdateInput(
      this.input.targetScope.model,
      "update",
      {
        data: parsed.scalarData,
      }
    );
    assertRelationKeyUpdatesAreCompilable(
      this.input.targetScope,
      parsed.scalarData,
      parsed.relations
    );
    const selector = capturedTargetWhere(
      this.input.targetScope.model,
      this.rowKeyProjection,
      row
    );
    // Client defaults are evaluated again for every selected target. Analyze the
    // replayed program, not the enclosing parse whose defaults may name different
    // targets, before the record compiler trusts its relation decisions.
    assertUpdateOwnWriteSafety(
      this.input.targetScope,
      parsed.scalarData,
      parsed.relations,
      selector
    );

    const scope = new StepScope();
    const childName = getStepModelName(
      this.input.targetScope.model,
      this.input.relationInfo.name
    );
    const failure = nestedWriteFailure(
      relationTargetNotFound(this.input.relationInfo, "update"),
      this.input.relationInfo.name,
      false
    );
    const compiler = this.input.recordCompilers.updateSelected({
      scope,
      engine: this.input.engine,
      targetScope: this.input.targetScope,
      scalarData: parsed.scalarData,
      relations: parsed.relations,
      targetRead: { label: `${childName}.find` },
      rootWrite: { label: `${childName}.update` },
      relationName: this.input.relationInfo.name,
      rootWriteFailure: failure,
      pinnedTarget: capturedTargetValues(
        this.input.targetScope.model,
        this.rowKeyProjection,
        row
      ),
    });
    return {
      parsed,
      operation: compiler
        ? this.memberOperation(compiler, selector, failure)
        : undefined,
    };
  }

  /** Re-enter the same projected nested-update schema that accepted the source. */
  private replayData(): ParsedRecordPrograms {
    const relationName = this.input.relationInfo.name;
    const relationSchemas = this.input.engine.schemaRegistry.getModelSchemas(
      this.input.sourceScope.model
    ).relations[relationName];
    if (!relationSchemas) {
      throw new QueryEngineError(
        `query-engine-v2 internal: no update schema exists for relation '${relationName}'.`
      );
    }
    const sourcePayload = { updateMany: { data: this.source } };
    const parsedPayload = parseValidated(
      relationSchemas.update,
      sourcePayload,
      "update",
      `data.${relationName}`
    );
    const program = buildRelationMutationProgram(
      this.input.relationInfo,
      parsedPayload,
      sourcePayload
    );
    const entry = program?.entries.find(
      (
        candidate
      ): candidate is Extract<RelationMutationEntry, { kind: "updateMany" }> =>
        candidate.kind === "updateMany"
    );
    const replayed = entry?.items[0]?.data;
    if (!replayed) {
      throw new QueryEngineError(
        `query-engine-v2 internal: relation '${relationName}' did not replay nested updateMany data.`
      );
    }
    return buildParsedRelationPrograms(
      this.input.targetScope,
      replayed.parsed,
      replayed.source
    );
  }

  private memberOperation(
    compiler: RecordUpdateCompiler,
    selector: Record<string, unknown>,
    failure: ReturnType<typeof nestedWriteFailure>
  ): ExecutableOperation {
    const columns = targetProjectionColumns(
      this.input.targetScope,
      compiler.targetProjection
    );
    const locate: ReadStep = {
      id: compiler.targetReadId,
      kind: "read",
      statement: buildFindUnique(
        this.input.targetScope,
        {
          where: selector,
          select: targetProjectionSelect(compiler.targetProjection),
          forUpdate: true,
        },
        columns.length
          ? {
              additionalColumns: columns.map((column) => column.sql),
            }
          : {}
      ),
      outputs: {
        rows: { kind: "rows" },
        ...targetProjectionOutputs(compiler.targetProjection),
      },
      expects: exactlyOneRow(failure),
    };
    const mode = selectExecutionMode(this.input.engine, "update");
    const progressive =
      !this.input.engine.driver.supportsTransactions &&
      this.input.engine.driver.supportsOrderedCommittedSegments;
    return {
      mode,
      planning: (): PlanningFragment => ({
        steps: [locate, ...compiler.planning()],
      }),
      compile: (known): OperationFragment => ({
        steps: [
          ...(progressive
            ? [this.memberMembershipGuard(compiler, known, failure)]
            : []),
          ...compiler.compile(known),
        ],
        outputs: {},
      }),
      parse: <T>(): T => undefined as T,
    };
  }

  private memberMembershipGuard(
    compiler: RecordUpdateCompiler,
    known: Readonly<Record<string, unknown>>,
    failure: ReturnType<typeof nestedWriteFailure>
  ): GuardStep {
    const rows = known[planningKey(compiler.targetReadId, "rows")];
    if (!(Array.isArray(rows) && isRecord(rows[0]))) {
      throw new QueryEngineError(
        `query-engine-v2 nested updateMany for relation '${this.input.relationInfo.name}' cannot re-pin an uncaptured target row.`
      );
    }
    const captured = rows[0];
    const capturedColumns = capturedTargetColumnPredicate(
      this.input.targetScope,
      compiler.targetProjection,
      captured,
      this.input.membership.kind === "junction"
        ? getTableName(this.input.targetScope.model)
        : this.input.targetScope.rootAlias
    );
    const statement =
      this.input.membership.kind === "childHeld"
        ? this.childHeldMembershipGuardStatement(
            compiler,
            captured,
            capturedColumns
          )
        : this.junctionMembershipGuardStatement(
            compiler,
            captured,
            capturedColumns
          );
    return presenceGuard(`${compiler.writeId}.membership`, statement, failure);
  }

  private childHeldMembershipGuardStatement(
    compiler: RecordUpdateCompiler,
    captured: Readonly<Record<string, unknown>>,
    capturedColumns: Sql | undefined
  ): Sql {
    const membership = this.input.membership;
    if (membership.kind !== "childHeld") {
      throw new QueryEngineError(
        "query-engine-v2 internal: child-held membership guard received junction topology."
      );
    }
    const condition = finalMembershipCondition(
      this.input.engine,
      this.input.targetScope,
      membership.binding,
      this.input.targetScope.rootAlias,
      membership.known,
      "updateMany"
    );
    const predicates = [condition.predicate, capturedColumns].filter(
      (predicate): predicate is Sql => predicate !== undefined
    );
    return buildFind(
      this.input.targetScope,
      {
        where: {
          AND: [
            ...capturedTargetFilters(
              this.input.targetScope.model,
              compiler.targetProjection,
              captured
            ),
            ...condition.filters,
          ],
        },
        select: targetProjectionRowKeySelect(compiler.targetProjection),
      },
      {
        limit: 1,
        ...(predicates.length > 0
          ? {
              predicate: this.input.targetScope.adapter.operators.and(
                ...predicates
              ),
            }
          : {}),
      }
    );
  }

  private junctionMembershipGuardStatement(
    compiler: RecordUpdateCompiler,
    captured: Readonly<Record<string, unknown>>,
    capturedColumns: Sql | undefined
  ): Sql {
    const membership = this.input.membership;
    if (membership.kind !== "junction") {
      throw new QueryEngineError(
        "query-engine-v2 internal: junction membership guard received child-held topology."
      );
    }
    return new ManyToManyStatements(
      this.input.sourceScope,
      membership.txMode
    ).materialize(membership.relation.relationInfo, "membershipRead", {
      parentValue: membership.parentValue,
      where: {
        AND: capturedTargetFilters(
          this.input.targetScope.model,
          compiler.targetProjection,
          captured
        ),
      },
      select: targetProjectionRowKeySelect(compiler.targetProjection),
      ...(capturedColumns ? { predicate: capturedColumns } : {}),
      take: 1,
    });
  }
}

interface PreparedMember {
  readonly parsed: ParsedRecordPrograms;
  readonly operation: ExecutableOperation | undefined;
}

function requireReplaySource(
  data: RecordMutationData,
  relationName: string
): Record<string, unknown> {
  if (data.source) return data.source;
  throw new QueryEngineError(
    `query-engine-v2 internal: nested updateMany for relation '${relationName}' has no source data to replay per selected record.`
  );
}

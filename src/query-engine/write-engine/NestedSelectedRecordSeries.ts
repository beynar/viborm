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
import { JunctionStatements } from "../JunctionStatements";
import { assertUpdateOwnWriteSafety } from "../OwnWriteAnalyzer";
import { buildFind, buildFindUnique } from "../operations";
import { assertPortablePrimaryKeyUpdateInput } from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import {
  assertRelationKeyUpdatesAreCompilable,
  assertSingleTargetMembershipMoveAppliesToRecords,
} from "../relation-key-legality";
import type { QueryScope, RelationRef } from "../types";
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
  finalMembershipWriteCondition,
} from "./relation-membership";
import { StepScope } from "./StepScope";
import { parseCapturedRows, parseSeriesRowKeys } from "./series-result-read";
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

type NestedSelectedMembership =
  | {
      readonly kind: "childHeld";
      readonly binding: CorrelatedRelationMembershipBinding;
      readonly known: Readonly<Record<string, unknown>>;
      /**
       * Which membership value the captured members carry, and therefore which side
       * of the old-read/new-write split re-asserts them across a committed segment.
       * `existingMembers` are rows that already carried the parent's located value;
       * `suppliedMember` is the row a sibling write in the same fragment just
       * assigned, which is the post-transition value. The two coincide unless the
       * parent's referenced key is in transition.
       */
      readonly correlate: "existingMembers" | "suppliedMember";
    }
  | {
      readonly kind: "junction";
      readonly relation: JunctionBoundRelation;
      readonly parentValue: unknown;
      readonly txMode: boolean;
    };

/**
 * Where one member's record data comes from, and therefore which trust boundary owns
 * its legality. The two arms exist because the two callers genuinely differ, not to
 * make one owner configurable:
 *
 * - `replayPerRecord` — a nested relation-bearing `updateMany`. Its data is ONE payload
 *   applied to N captured targets, so the retained raw source is re-entered through the
 *   projected nested-update schema once per target: client defaults must be evaluated
 *   per record, and the replayed program is what OwnWrite and the relation-key rules
 *   must then judge, with that target's own selector.
 * - `parsedOnce` — a to-one supplier's composed continuation. There is exactly ONE
 *   member, its data was parsed at the enclosing record's own trust boundary, and that
 *   parse IS this member's parse. Re-entering the schema here would materialize a
 *   second set of client defaults, and re-running OwnWrite would be a second analysis
 *   of a subtree the enclosing analyzer already walked. Its portable-key and
 *   relation-key legality run at construction instead, before any I/O.
 */
export type NestedSelectedMember =
  | { readonly kind: "replayPerRecord"; readonly data: RecordMutationData }
  | { readonly kind: "parsedOnce"; readonly programs: ParsedRecordPrograms };

export interface NestedSelectedRecordSeriesInput {
  readonly engine: QueryEngine;
  /** Model whose public relation schema admitted this nested payload. */
  readonly sourceScope: QueryScope;
  readonly targetScope: QueryScope;
  readonly relationRef: RelationRef;
  readonly member: NestedSelectedMember;
  readonly capture: ReadStep;
  readonly recordCompilers: RecordCompilerSeam;
  readonly membership: NestedSelectedMembership;
}

/**
 * One nested relation-level series of SELECTED-record updates.
 *
 * The relation owner supplies the exact membership capture — a correlated set for a
 * nested `updateMany`, or the singular member a to-one supplier has just produced. This
 * owner only turns each captured complete row key into one selected-record compilation,
 * and repeats the owner's membership guard in every later write on a committed-segment
 * substrate. It publishes no value: the enclosing record operation owns the public
 * result.
 */
export class NestedSelectedRecordSeries implements RecordSeriesOperation {
  readonly executionKind = "recordSeries" as const;

  private readonly input: NestedSelectedRecordSeriesInput;
  private readonly rowKeyProjection: TargetProjection;
  /** The input's member arm with the replay source already resolved, so nothing
   *  below asks a second time whether one exists. */
  private readonly member:
    | {
        readonly kind: "replayPerRecord";
        readonly source: Record<string, unknown>;
      }
    | { readonly kind: "parsedOnce"; readonly programs: ParsedRecordPrograms };

  constructor(input: NestedSelectedRecordSeriesInput) {
    this.input = input;
    this.rowKeyProjection = buildTargetProjection(input.targetScope.model);
    this.member =
      input.member.kind === "replayPerRecord"
        ? {
            kind: "replayPerRecord",
            source: requireReplaySource(
              input.member.data,
              input.relationRef.name
            ),
          }
        : input.member;
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
        `query-engine-v2 nested selected series for relation '${this.input.relationRef.name}' did not expose its captured target rows.`
      );
    }
    const rows = value.map((row) => {
      if (!isRecord(row)) {
        throw new QueryEngineError(
          `query-engine-v2 nested selected series for relation '${this.input.relationRef.name}' captured an invalid target row.`
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
    const member = this.member;
    const parsed =
      member.kind === "parsedOnce"
        ? member.programs
        : this.replayData(member.source);
    if (member.kind === "replayPerRecord") {
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
    }
    const selector = capturedTargetWhere(
      this.input.targetScope.model,
      this.rowKeyProjection,
      row
    );
    if (member.kind === "replayPerRecord") {
      // Client defaults are evaluated again for every selected target. Analyze the
      // replayed program, not the enclosing parse whose defaults may name different
      // targets, before the record compiler trusts its relation decisions. The
      // `parsedOnce` arm has no second program to analyze: the enclosing record's own
      // analyzer already walked this exact subtree at its trusted boundary, and a
      // second walk here would be a second verdict on one payload.
      assertUpdateOwnWriteSafety(
        this.input.targetScope,
        parsed.scalarData,
        parsed.relations,
        selector
      );
    }

    const scope = new StepScope();
    const childName = getStepModelName(
      this.input.targetScope.model,
      this.input.relationRef.name
    );
    const failure = nestedWriteFailure(
      relationTargetNotFound(this.input.relationRef, "update"),
      this.input.relationRef.name,
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
      relationName: this.input.relationRef.name,
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
  private replayData(source: Record<string, unknown>): ParsedRecordPrograms {
    const relationName = this.input.relationRef.name;
    const relationSchemas = this.input.engine.schemaRegistry.getModelSchemas(
      this.input.sourceScope.model
    ).relations[relationName];
    if (!relationSchemas) {
      throw new QueryEngineError(
        `query-engine-v2 internal: no update schema exists for relation '${relationName}'.`
      );
    }
    const sourcePayload = { updateMany: { data: source } };
    const parsedPayload = parseValidated(
      relationSchemas.update,
      sourcePayload,
      "update",
      `data.${relationName}`
    );
    const program = buildRelationMutationProgram(
      this.input.relationRef,
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
      this.input.engine.driver.supportsBatch;
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
        `query-engine-v2 nested selected series for relation '${this.input.relationRef.name}' cannot re-pin an uncaptured target row.`
      );
    }
    const rawCaptured = rows[0];
    const captured = parseCapturedRows(
      this.input.engine,
      this.input.targetScope.model,
      [rawCaptured],
      targetProjectionSelect(compiler.targetProjection),
      compiler.targetProjection.columns
    )[0];
    if (!captured) {
      throw new QueryEngineError(
        `query-engine-v2 nested selected series for relation '${this.input.relationRef.name}' cannot re-pin an uncaptured target row.`
      );
    }
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
    const condition =
      membership.correlate === "suppliedMember"
        ? finalMembershipWriteCondition(
            this.input.engine,
            this.input.targetScope,
            membership.binding,
            this.input.targetScope.rootAlias,
            membership.known,
            "update"
          )
        : finalMembershipCondition(
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
    return new JunctionStatements(
      this.input.sourceScope,
      membership.txMode
    ).materialize(membership.relation, "membershipRead", {
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

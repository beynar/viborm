// biome-ignore-all lint/style/useFilenamingConvention: UpdateOperation is the architecture name.
import { NotFoundError, QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../builders/correlation-utils";
import {
  buildPolymorphicMutationProgram,
  buildRelationMutationProgram,
  type ParsedRelationMutation,
  partitionModelData,
} from "../builders/relation-mutation-parser";
import { getWhereUniqueEntries } from "../builders/where-unique-builder";
import {
  createQueryScope,
  getDefaultScalarFieldNames,
} from "../context/query-scope";
import { assertUpdateOwnWriteSafety } from "../OwnWriteAnalyzer";
import {
  buildFind,
  buildFindUnique,
  buildMutationProjectionFold,
  buildUpdate,
  buildUpdateStatement,
} from "../operations";
import { assertPortablePrimaryKeyUpdateInput } from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import { assertRelationKeyUpdatesAreCompilable } from "../relation-key-legality";
import { ResultParser } from "../result/ResultParser";
import {
  buildFreshRecordPart,
  type FreshRecordBuilder,
} from "./CreateOperation";
import {
  affectedRows,
  exactlyOneRow,
  notFoundFailure,
  presenceGuard,
  queryFailure,
} from "./fragment-builders";
import {
  type GuardStep,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  type ReadStep,
  ref,
  type StatementStep,
  type WriteStep,
} from "./OperationFragment";
import { planningKey } from "./Part";
import { parseValidated } from "./parse-boundary";
import {
  buildRecordUpdateCompiler,
  type RecordUpdateCompiler,
} from "./RecordUpdateCompiler";
import { StepScope } from "./StepScope";
import {
  getStepModelName,
  isRecord,
  pinnedTargetValues,
  projectionNamesNoRelation,
  projectionReadsMutatedModel,
  type SubOperationOptions,
  selectExecutionMode,
  setCanFireReferentialAction,
  uniqueSelectorConjuncts,
} from "./shared";
import {
  capturedTargetColumnPredicate,
  targetProjectionColumns,
  targetProjectionOutputs,
} from "./target-projection";

type ExecutionMode = "transaction" | "batch";

/**
 * Public update orchestration. It owns validation, the caller's unique selector,
 * the target read, its batch presence pin, result projection, and terminal read.
 * The selected row's mutation is delegated to {@link RecordUpdateCompiler}.
 */
export class UpdateOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly scope: StepScope;
  private readonly parentWhere: Record<string, unknown>;
  private readonly parentPrimaryKeys: readonly string[];
  private readonly parsedSelect: Record<string, unknown>;
  private readonly parsedInclude: Record<string, unknown> | undefined;
  private readonly resultArgs: Record<string, unknown>;
  private readonly locate: ReadStep;
  private readonly compiler: RecordUpdateCompiler | undefined;
  private readonly updateId: string;
  private readonly terminalId: string;
  private readonly rootGuardId: string;
  private readonly directWrite: WriteStep | undefined;
  private readonly directGuard: GuardStep | undefined;
  /** Captured bulk members return exact row keys for internal addressing. */
  private readonly resultDecimalDecode: "string" | "number";

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>,
    options: SubOperationOptions = {}
  ) {
    this.engine = engine;
    this.model = model;
    this.mode = selectExecutionMode(engine, "update");
    const txMode = this.mode === "transaction";
    this.scope = new StepScope();
    const scope = this.scope;
    const parent = createQueryScope(engine, model);
    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);

    // K5 — a CAPTURED-ROOT member of a relation-bearing `updateMany`. The bulk
    // envelope was validated once by the series (`where`, `select`, `limit`, and the
    // portable-primary-key check, all under the public name `updateMany`), so the
    // whole-args parse below would be a second, differently-named opinion on it. What
    // the member still owns — and what makes it an ordinary update rather than a
    // fragment of one — is everything from `data` down: its own relation parse, its
    // own own-write preflight, its own locate, compiler, transitions and terminal read.
    const captured = options.capturedRoot;
    this.resultDecimalDecode = captured ? "string" : engine.decimalDecode;
    // The whole envelope owns public validation and error ordering. Relation
    // payloads are then transformed exactly once at their existing relation sites.
    const validatedArgs = captured
      ? {
          data: parseValidated(
            parentSchemas.core.update,
            captured.data,
            "updateMany",
            "data"
          ),
          select: captured.select,
          include: undefined,
        }
      : parseValidated(parentSchemas.args.update, args, "update", "");
    const where = captured?.where ?? requireRecord(args.where, "update.where");
    const data = captured?.data ?? requireRecord(args.data, "update.data");
    if (!captured) {
      assertPortablePrimaryKeyUpdateInput(model, "update", { data });
    }

    const partitioned = partitionModelData(parent, data);
    // TWO PASSES, and the grouping is normative twice over: it is the parsed
    // collection's order (ordinary keys, then polymorphic — `ParsedRecordPrograms`),
    // and it is the order these per-relation transforms run in, which decides which
    // `ValidationError` a mixed malformed payload reports first (ATOM §19).
    const relations: ParsedRelationMutation[] = [];
    for (const [relationName, relationPayload] of Object.entries(
      partitioned.relationPayloads
    )) {
      const relationSchemas = parentSchemas.relations[relationName];
      if (!relationSchemas) {
        throw new QueryEngineError(
          `query-engine-v2 internal: no validation schema exists for relation '${relationName}', which the model's own relation set declares.`
        );
      }
      const parsedRelation = parseValidated(
        relationSchemas.update,
        relationPayload.payload,
        "update",
        `data.${relationName}`
      );
      const program = buildRelationMutationProgram(
        relationPayload.relationRef,
        parsedRelation,
        relationPayload.payload
      );
      if (program) {
        relations.push({ kind: "ordinary", name: relationName, program });
      }
    }
    for (const [relationName, relationPayload] of Object.entries(
      partitioned.polymorphicPayloads
    )) {
      const relationSchemas = parentSchemas.polymorphic[relationName];
      if (!relationSchemas) {
        throw new QueryEngineError(
          `query-engine internal: no validation schema exists for polymorphic relation '${relationName}', which the model declares.`
        );
      }
      const parsedRelation = parseValidated(
        relationSchemas.update,
        relationPayload.payload,
        "update",
        `data.${relationName}`
      );
      relations.push(
        buildPolymorphicMutationProgram(
          parent,
          relationPayload.relation,
          parsedRelation,
          relationPayload.payload
        )
      );
    }

    assertRelationKeyUpdatesAreCompilable(
      parent,
      partitioned.scalarData,
      relations
    );

    // A member's selector is not user input: it is the complete captured row key,
    // already built as a `whereUnique` from values this transaction locked and read.
    // Re-parsing it would apply the scalar schemas' transforms to provider-decoded
    // values — a second opinion on a value nobody typed — which is exactly why every
    // other captured-identity consumer in the engine (`ManyAndReturnOperation`'s
    // captured filter, `CreateManyRecordSeries`' final read) feeds the where builder
    // directly too.
    this.parentWhere = captured
      ? captured.where
      : parseValidated(
          parentSchemas.core.whereUniqueExtended,
          where,
          "update",
          "where"
        );
    const projectedSelect = validatedArgs.select;
    const projectedInclude = validatedArgs.include;
    this.parsedSelect = isRecord(projectedSelect)
      ? projectedSelect
      : defaultSelect(model);
    this.parsedInclude = isRecord(projectedInclude)
      ? projectedInclude
      : undefined;
    this.resultArgs = {
      select: this.parsedSelect,
      ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
    };

    const parsedData = requireRecord(validatedArgs.data, "update.data");
    const parsedScalarData = partitionModelData(parent, parsedData).scalarData;
    // A member analyses its OWN selector — the captured row key — which is strictly
    // narrower than the bulk `where` the caller wrote. That is exact rather than
    // lenient: the hazard this preflight guards is a decision read that depends on
    // this operation's own writes, and for root selection the capture already spent
    // the public `where` ONCE, before any effect, so no later write can move which
    // roots were chosen.
    assertUpdateOwnWriteSafety(parent, parsedScalarData, relations, where);

    const scalarData =
      Object.keys(partitioned.scalarData).length === 0
        ? {}
        : parseValidated(
            parentSchemas.core.scalarUpdate,
            partitioned.scalarData,
            "update",
            "data"
          );

    const parentPrimaryKeys = getPrimaryKeyFields(model);
    if (parentPrimaryKeys.length === 0) {
      throw new QueryEngineError(
        "query-engine-v2 internal: update reached a model with no primary key; the where-unique parse admits none."
      );
    }
    this.parentPrimaryKeys = parentPrimaryKeys;

    const parentName = getStepModelName(model, "parent");
    const locateId = scope.allocate(`${parentName}.locate`);
    this.updateId = scope.allocate(`${parentName}.update`);
    this.terminalId = scope.allocate(`${parentName}.select`);
    this.rootGuardId = scope.allocate(`${parentName}.guard.exists`);

    const projectionIsScalarOnly = projectionNamesNoRelation(
      model,
      this.parsedSelect,
      this.parsedInclude
    );
    const writeIsOneStatement =
      engine.adapter.capabilities.supportsReturning &&
      relations.length === 0 &&
      Object.keys(scalarData).length > 0;
    const cteProjectionFold =
      engine.adapter.capabilities.supportsCteWithMutations &&
      !projectionReadsMutatedModel(
        parent,
        this.parsedSelect,
        this.parsedInclude
      ) &&
      !setCanFireReferentialAction(model, scalarData);
    const canFold =
      writeIsOneStatement && (projectionIsScalarOnly || cteProjectionFold);
    const foldsProjectionIntoCte = canFold && !projectionIsScalarOnly;
    const notFound = notFoundFailure(
      `query-engine-v2 update located no '${parentName}' row for its unique where.`
    );
    this.directWrite = canFold
      ? {
          id: this.updateId,
          kind: "write",
          statement: foldsProjectionIntoCte
            ? buildMutationProjectionFold(parent, {
                mutation: buildUpdateStatement(parent, {
                  where: this.parentWhere,
                  data: scalarData,
                }),
                select: this.parsedSelect,
                ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
              })
            : buildUpdate(parent, {
                where: this.parentWhere,
                data: scalarData,
                select: this.parsedSelect,
              }),
          outputs: { result: { kind: "rows" } },
          ...(txMode ? { expects: affectedRows(1, notFound) } : {}),
        }
      : undefined;
    this.directGuard =
      canFold && !txMode
        ? presenceGuard(
            this.rootGuardId,
            buildFindUnique(parent, {
              where: this.parentWhere,
              select: this.pkSelect(),
            }),
            notFound
          )
        : undefined;

    const createFresh: FreshRecordBuilder = (freshScope, input) =>
      buildFreshRecordPart(freshScope, engine, input);
    this.compiler = canFold
      ? undefined
      : buildRecordUpdateCompiler(
          {
            scope,
            engine,
            targetScope: parent,
            scalarData,
            relations,
            targetRead: { id: locateId },
            rootWrite: { id: this.updateId },
            relationName: "record",
            pinnedTarget: pinnedTargetValues(parent, this.parentWhere),
          },
          createFresh
        );

    const locateFields = this.compiler
      ? this.compiler.targetProjection.fields
      : this.parentPrimaryKeys;
    const locateColumns = this.compiler
      ? targetProjectionColumns(parent, this.compiler.targetProjection)
      : [];
    this.locate = {
      id: locateId,
      kind: "read",
      statement: buildFindUnique(
        parent,
        {
          where: this.parentWhere,
          select: Object.fromEntries(
            locateFields.map((field) => [field, true])
          ),
          forUpdate: txMode,
        },
        locateColumns.length
          ? {
              additionalColumns: locateColumns.map((column) => column.sql),
            }
          : {}
      ),
      outputs: {
        rows: { kind: "rows" },
        ...(this.compiler
          ? targetProjectionOutputs(this.compiler.targetProjection)
          : Object.fromEntries(
              locateFields.map((field) => [
                field,
                { kind: "firstRowField", field },
              ])
            )),
      },
      expects: exactlyOneRow(notFound),
    };
  }

  planning(): PlanningFragment {
    if (this.directWrite) return { steps: [] };
    const steps: StatementStep[] = [
      this.locate,
      ...(this.compiler?.planning() ?? []),
    ];
    return { steps };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    if (this.directWrite) {
      return {
        steps: this.directGuard
          ? [this.directGuard, this.directWrite]
          : [this.directWrite],
        outputs: { result: ref(this.updateId, "result") },
      };
    }

    const locateRows = known[planningKey(this.locate.id, "rows")];
    if (!Array.isArray(locateRows)) {
      throw new QueryEngineError(
        "query-engine-v2 update planning did not expose the locate rows."
      );
    }
    if (locateRows.length === 0) {
      throw new NotFoundError(getStepModelName(this.model, "record"), "update");
    }
    const locatedRow = locateRows[0];
    if (!isRecord(locatedRow)) {
      throw new QueryEngineError(
        "query-engine-v2 update planning exposed an invalid locate row."
      );
    }

    const steps: OperationStep[] = [];
    if (this.mode === "batch") {
      steps.push(this.buildRootPresenceGuard(locatedRow));
    }
    if (this.compiler) steps.push(...this.compiler.compile(known));
    steps.push(this.buildTerminal(locatedRow));
    return { steps, outputs: { result: ref(this.terminalId, "result") } };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    if (!Object.hasOwn(outputs, "result")) {
      throw new QueryEngineError(
        "query-engine-v2 update did not expose its result."
      );
    }
    return new ResultParser(
      this.engine,
      this.model,
      this.engine.driver,
      this.resultDecimalDecode
    ).parse<T>("update", outputs.result, this.resultArgs);
  }

  private buildRootPresenceGuard(
    locatedRow: Record<string, unknown>
  ): OperationStep {
    const parent = createQueryScope(this.engine, this.model);
    const failure = notFoundFailure(
      `query-engine-v2 update located no '${getStepModelName(this.model, "record")}' row for its unique where.`
    );
    const capturedColumns = this.compiler
      ? capturedTargetColumnPredicate(
          parent,
          this.compiler.targetProjection,
          locatedRow
        )
      : undefined;
    if (!this.selectorNamesPrimaryKey()) {
      return presenceGuard(
        this.rootGuardId,
        buildFind(
          parent,
          {
            where: {
              AND: [
                ...uniqueSelectorConjuncts(parent, this.parentWhere),
                this.capturedPkFilter(locatedRow),
              ],
            },
            select: this.pkSelect(),
          },
          {
            limit: 1,
            ...(capturedColumns ? { predicate: capturedColumns } : {}),
          }
        ),
        failure
      );
    }
    return presenceGuard(
      this.rootGuardId,
      buildFindUnique(
        parent,
        {
          where: this.parentWhere,
          select: this.pkSelect(),
        },
        capturedColumns ? { predicate: capturedColumns } : {}
      ),
      failure
    );
  }

  private selectorNamesPrimaryKey(): boolean {
    const parent = createQueryScope(this.engine, this.model);
    const named = new Set(
      getWhereUniqueEntries(parent, this.parentWhere).map(
        (entry) => entry.fieldName
      )
    );
    return this.parentPrimaryKeys.every((field) => named.has(field));
  }

  private capturedPkFilter(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    return Object.fromEntries(
      this.parentPrimaryKeys.map((field) => [
        field,
        { equals: locatedRow[field] },
      ])
    );
  }

  private pkSelect(): Record<string, boolean> {
    return Object.fromEntries(
      this.parentPrimaryKeys.map((field) => [field, true])
    );
  }

  private buildTerminal(locatedRow: Record<string, unknown>): ReadStep {
    const parent = createQueryScope(this.engine, this.model);
    const terminalWhere = this.compiler
      ? this.compiler.updatedPrimaryKeyWhere(locatedRow)
      : buildPrimaryKeyWhereUnique(
          this.model,
          Object.fromEntries(
            this.parentPrimaryKeys.map((field) => [field, locatedRow[field]])
          )
        );
    return {
      id: this.terminalId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where: terminalWhere,
        select: this.parsedSelect,
        ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
      }),
      outputs: { result: { kind: "rows" } },
      ...(this.mode === "transaction"
        ? {
            expects: exactlyOneRow(
              queryFailure(
                "query-engine-v2 update terminal read expected exactly one row."
              )
            ),
          }
        : {}),
    };
  }
}

function defaultSelect(model: Model<any>): Record<string, unknown> {
  return Object.fromEntries(
    getDefaultScalarFieldNames(model).map((field) => [field, true])
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(
    `query-engine-v2 internal: '${label}' must be an object after the parse boundary validated the update payload.`
  );
}

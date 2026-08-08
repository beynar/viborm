// biome-ignore-all lint/style/useFilenamingConvention: UpdateOperation is the architecture name.
import { NotFoundError, QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../builders/correlation-utils";
import type { ResolvedPolymorphicMutation } from "../builders/polymorphic-mutation";
import {
  buildPolymorphicMutationProgram,
  buildRelationMutationProgram,
  partitionModelData,
  type RelationMutationProgram,
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
import {
  assertRelationKeyUpdatesAreCompilable,
  assertUpdateManyDataRelationsAreCompilable,
} from "../relation-key-legality";
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
import { planningKey, planningOutputs } from "./Part";
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

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    this.mode = selectExecutionMode(engine, "update");
    const txMode = this.mode === "transaction";
    this.scope = new StepScope();
    const scope = this.scope;
    const parent = createQueryScope(engine.adapter, model);
    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);

    // The whole envelope owns public validation and error ordering. Relation
    // payloads are then transformed exactly once at their existing relation sites.
    const validatedArgs = parseValidated(
      parentSchemas.args.update,
      args,
      "update",
      ""
    );
    const where = requireRecord(args.where, "update.where");
    const data = requireRecord(args.data, "update.data");
    assertPortablePrimaryKeyUpdateInput(model, "update", { data });

    const partitioned = partitionModelData(parent, data);
    const relations: Record<string, RelationMutationProgram> = {};
    const polymorphic: Record<string, ResolvedPolymorphicMutation> = {};
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
        relationPayload.relationInfo,
        parsedRelation
      );
      if (program) relations[relationName] = program;
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
      const built = buildPolymorphicMutationProgram(
        parent,
        relationPayload.relation,
        parsedRelation
      );
      if (built.program) relations[relationName] = built.program;
      polymorphic[relationName] = built.mutation;
    }

    assertRelationKeyUpdatesAreCompilable(
      parent,
      partitioned.scalarData,
      relations
    );
    assertUpdateManyDataRelationsAreCompilable(parent, relations);

    this.parentWhere = parseValidated(
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
      Object.keys(relations).length === 0 &&
      Object.keys(polymorphic).length === 0 &&
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

    const createFresh: FreshRecordBuilder = (input) =>
      buildFreshRecordPart(scope, engine, input);
    this.compiler = canFold
      ? undefined
      : buildRecordUpdateCompiler(
          {
            scope,
            engine,
            targetScope: parent,
            scalarData,
            relations,
            polymorphic,
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
    if (this.directWrite) return { steps: [], outputs: {} };
    const steps: StatementStep[] = [
      this.locate,
      ...(this.compiler?.planning() ?? []),
    ];
    return { steps, outputs: planningOutputs(steps) };
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
      this.engine.adapter,
      this.model,
      this.engine.driver,
      this.engine.decimalDecode
    ).parse<T>("update", outputs.result, this.resultArgs);
  }

  private buildRootPresenceGuard(
    locatedRow: Record<string, unknown>
  ): OperationStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
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
    const parent = createQueryScope(this.engine.adapter, this.model);
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
    const parent = createQueryScope(this.engine.adapter, this.model);
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

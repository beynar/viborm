// biome-ignore-all lint/style/useFilenamingConvention: CreateOperation is the architecture name.
import { QueryEngineError, TransactionError, ValidationError } from "@errors";
import type { Model } from "@schema/model";
import { parse, type VibSchema } from "@validation";
import { getPrimaryKeyFields } from "../query-engine/builders/correlation-utils";
import {
  getFkDirection,
  separateData,
} from "../query-engine/builders/relation-data-builder";
import { getRelationMutationKinds } from "../query-engine/builders/relation-mutation-parser";
import { buildInsert } from "../query-engine/builders/values-builder";
import { getWhereUniqueEntries } from "../query-engine/builders/where-unique-builder";
import {
  createQueryScope,
  getTableName,
} from "../query-engine/context/query-scope";
import { buildCreate, buildFindUnique } from "../query-engine/operations";
import type { QueryEngine } from "../query-engine/query-engine";
import { ResultParser } from "../query-engine/result/ResultParser";
import type { QueryScope } from "../query-engine/types";
import { exactlyOneRow, referenceSql } from "./fragment-builders";
import {
  type OperationFragment,
  ref,
  type StatementStep,
} from "./OperationFragment";
import { OwnWritePreflight } from "./OwnWritePreflight";
import { planningOutputs } from "./Part";
import { RelationUpsertPart, refParentId } from "./RelationUpsertPart";
import { StepScope } from "./StepScope";
import { getStepModelName, isRecord } from "./shared";

type ExecutionMode = "transaction" | "batch";

export class CreateOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly scope: StepScope;
  private readonly resultArgs: Record<string, unknown>;
  private readonly childParts: readonly RelationUpsertPart[];
  private readonly createParent: StatementStep;
  private readonly selectParent: StatementStep;
  private readonly resultOutputs: OperationFragment["outputs"];

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    this.mode = selectExecutionMode(engine);
    const txMode = this.mode === "transaction";
    this.scope = new StepScope();
    const scope = this.scope;

    // 1. Validate literals and resolve the one supported relation shape.
    assertExactKeys(args, ["data", "select"], "create arguments");
    const data = requireRecord(args.data, "create.data");
    const select = requireRecord(args.select, "create.select");
    const parent = createQueryScope(engine.adapter, model);
    const separated = separateData(parent, data);
    const relationEntries = Object.entries(separated.relations);

    if (relationEntries.length !== 1) {
      throw new QueryEngineError(
        "query-engine-v2 create requires exactly one nested relation upsert."
      );
    }

    const [relationName, mutation] = relationEntries[0]!;
    if (
      mutation.relationInfo.type !== "oneToMany" ||
      getRelationMutationKinds(mutation).join(",") !== "upsert"
    ) {
      throw new QueryEngineError(
        `query-engine-v2 supports only one-to-many nested upsert; received '${relationName}'.`
      );
    }

    const relationInput = requireRecord(data[relationName], relationName);
    if (Array.isArray(relationInput.upsert)) {
      throw new QueryEngineError(
        `Relation '${relationName}' requires exactly one nested upsert object.`
      );
    }

    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);
    const relationSchemas = parentSchemas.relations[relationName];
    if (!relationSchemas) {
      throw new QueryEngineError(
        `No validation schema exists for relation '${relationName}'.`
      );
    }

    const parentData = parseRecord(
      parentSchemas.core.scalarCreate,
      separated.scalarData,
      "data"
    );
    // Slice (a), made honest (PLAN P−1.2): validate the nested upsert through
    // the relation's first-class CREATE-input schema — which now carries an
    // `upsert` member with global-lookup, adopt-and-update semantics — not the
    // update schema. The update-schema smuggling is deleted; invalid upsert
    // payloads now fail at validation, before the engine ever runs.
    const parsedRelation = parseRecord(
      relationSchemas.create,
      relationInput,
      `data.${relationName}`
    );
    const parsedSelect = parseRecord(
      parentSchemas.core.select,
      select,
      "select"
    );
    this.resultArgs = { select: parsedSelect };
    const upsert = requireSingleUpsert(parsedRelation.upsert, relationName);
    const where = requireRecord(upsert.where, `${relationName}.upsert.where`);
    const create = requireRecord(
      upsert.create,
      `${relationName}.upsert.create`
    );
    const update = requireRecord(
      upsert.update,
      `${relationName}.upsert.update`
    );
    const child = createQueryScope(
      engine.adapter,
      mutation.relationInfo.targetModel
    );
    const childCreate = separateData(child, create);
    const childUpdate = separateData(child, update);
    if (
      Object.keys(childCreate.relations).length > 0 ||
      Object.keys(childUpdate.relations).length > 0
    ) {
      throw new QueryEngineError(
        `Relation '${relationName}' does not support deeper relation mutations in query-engine-v2.`
      );
    }

    const fk = getFkDirection(parent, mutation.relationInfo);
    const parentPrimaryKey = requireGeneratedPrimaryKey(model, parentData);
    if (
      fk.holdsFK ||
      fk.fkFields.length !== 1 ||
      fk.pkFields.length !== 1 ||
      fk.pkFields[0] !== parentPrimaryKey
    ) {
      throw new QueryEngineError(
        `Relation '${relationName}' must expose one child-held foreign key referencing the generated parent primary key.`
      );
    }

    const childForeignKey = fk.fkFields[0]!;
    if (
      Object.hasOwn(childCreate.scalarData, childForeignKey) ||
      Object.hasOwn(childUpdate.scalarData, childForeignKey)
    ) {
      throw new QueryEngineError(
        `Relation '${relationName}' owns '${childForeignKey}'; omit it from nested create and update data.`
      );
    }

    assertMatchingCreateIdentity(
      child,
      where,
      childCreate.scalarData,
      relationName
    );

    const parentName = getStepModelName(model, "parent");
    const childName = getStepModelName(
      mutation.relationInfo.targetModel,
      relationName
    );
    const childPrimaryKeys = getPrimaryKeyFields(child.model);
    if (childPrimaryKeys.length !== 1) {
      throw new QueryEngineError(
        `Relation '${relationName}' requires a child with one primary key.`
      );
    }

    const childPrimaryKey = childPrimaryKeys[0]!;

    // 2. Own-write preflight (ATOM §4): reject any payload whose nested decision
    //    reads depend on this operation's own earlier writes, before planning.
    new OwnWritePreflight().assertCreate(parent, data);

    // 3. Build the shared root steps once; the nested upsert becomes a
    //    composable child part. Step ids are scope-allocated so two same-model
    //    children under one parent can never collide.
    const parentCreateId = scope.allocate(`${parentName}.create`);
    const resultId = scope.allocate(`${parentName}.select`);
    const selectedParentId = referenceSql(
      engine,
      model,
      parentPrimaryKey,
      ref(parentCreateId, "id")
    );

    this.createParent = {
      id: parentCreateId,
      kind: "write",
      statement: txMode
        ? buildCreate(parent, {
            data: parentData,
            select: { [parentPrimaryKey]: true },
          })
        : buildInsert(parent, getTableName(model), parentData),
      outputs: {
        id:
          txMode && engine.adapter.capabilities.supportsReturning
            ? { kind: "firstRowField", field: parentPrimaryKey }
            : { kind: "insertId" },
      },
    };

    this.selectParent = {
      id: resultId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where: { [parentPrimaryKey]: selectedParentId },
        select: parsedSelect,
      }),
      outputs: { result: { kind: "rows" } },
      ...(txMode
        ? {
            expects: exactlyOneRow({
              kind: "query",
              message: `query-engine-v2 create terminal read for relation '${relationName}' expected exactly one row.`,
              raceable: false,
            }),
          }
        : {}),
    };

    this.resultOutputs = { result: ref(resultId, "result") };

    // The nested upsert is a child-held-FK to-many under a fresh parent: global
    // lookup, adopt-and-update (ATOM §4), its FK a Ref to the create above.
    this.childParts = [
      new RelationUpsertPart(scope, {
        engine,
        childScope: child,
        childName,
        relationName,
        where,
        createData: childCreate.scalarData,
        updateData: childUpdate.scalarData,
        fkFields: [childForeignKey],
        referencedFields: [parentPrimaryKey],
        childPrimaryKey,
        parentId: refParentId(parentCreateId),
        correlation: "global-adopt",
        txMode,
      }),
    ];
  }

  planning(): OperationFragment {
    const steps = this.childParts.flatMap((part) => part.planning(this.scope));
    return { steps, outputs: planningOutputs(steps) };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    // Build-don't-select (P1.2): each child part CONSTRUCTS its taken arm; the
    // shared root write and terminal read are emitted once around them, spliced
    // by FK direction (child-held FK → after the parent write). Guards are
    // hoisted ahead of every write (batch mode pins the premise first).
    const childSteps = this.childParts.flatMap((part) =>
      part.compile(this.scope, known)
    );
    const guards = childSteps.filter((step) => step.kind === "guard");
    const afterParent = childSteps.filter((step) => step.kind !== "guard");
    return {
      steps: [...guards, this.createParent, ...afterParent, this.selectParent],
      outputs: this.resultOutputs,
    };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    if (!Object.hasOwn(outputs, "result")) {
      throw new QueryEngineError(
        "query-engine-v2 create did not expose its result."
      );
    }
    return new ResultParser(
      this.engine.adapter,
      this.model,
      this.engine.driver
    ).parse<T>("create", outputs.result, this.resultArgs);
  }
}

function selectExecutionMode(engine: QueryEngine): ExecutionMode {
  if (engine.driver.supportsTransactions) return "transaction";
  if (engine.driver.supportsBatch) return "batch";
  throw new TransactionError(
    `Driver '${engine.driver.driverName}' supports neither transactions nor atomic batch execution.`
  );
}

function parseRecord(
  schema: VibSchema,
  value: unknown,
  path: string
): Record<string, unknown> {
  const result = parse(schema, value);
  if ("issues" in result && result.issues) {
    throw new ValidationError(
      "create",
      result.issues.map((issue) => ({
        path: [path, ...(issue.path?.map(String) ?? [])].join("."),
        message: issue.message,
      }))
    );
  }
  if (!isRecord(result.value)) {
    throw new QueryEngineError(`Validated '${path}' is not an object.`);
  }
  return result.value;
}

function requireSingleUpsert(
  value: unknown,
  relation: string
): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new QueryEngineError(
      `Relation '${relation}' requires exactly one nested upsert object.`
    );
  }
  return value[0];
}

function requireGeneratedPrimaryKey(
  model: Model<any>,
  data: Record<string, unknown>
): string {
  const fields = getPrimaryKeyFields(model);
  const field = fields[0];
  const scalar = field ? model["~"].state.scalars[field] : undefined;
  if (
    fields.length !== 1 ||
    !field ||
    scalar?.["~"].state.autoGenerate !== "increment" ||
    data[field] !== undefined
  ) {
    throw new QueryEngineError(
      "query-engine-v2 create requires one omitted auto-increment primary key."
    );
  }
  return field;
}

function assertMatchingCreateIdentity(
  child: QueryScope,
  where: Record<string, unknown>,
  create: Record<string, unknown>,
  relation: string
): void {
  for (const { fieldName, value } of getWhereUniqueEntries(child, where)) {
    if (
      !(Object.hasOwn(create, fieldName) && Object.is(create[fieldName], value))
    ) {
      throw new QueryEngineError(
        `Relation '${relation}' requires nested create field '${fieldName}' to match its unique where value.`
      );
    }
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const allowed = new Set(expected);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length === 0 && missing.length === 0) return;
  throw new QueryEngineError(
    `${label} requires exactly ${expected.join(", ")}; received ${Object.keys(value).join(", ") || "none"}.`
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(`'${label}' must be an object.`);
}

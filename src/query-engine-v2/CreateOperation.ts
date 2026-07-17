// biome-ignore-all lint/style/useFilenamingConvention: CreateOperation is the architecture name.
import { QueryEngineError, TransactionError, ValidationError } from "@errors";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { parse, type VibSchema } from "@validation";
import { getPrimaryKeyFields } from "../query-engine/builders/correlation-utils";
import {
  getFkDirection,
  separateData,
} from "../query-engine/builders/relation-data-builder";
import { getRelationMutationKinds } from "../query-engine/builders/relation-mutation-parser";
import {
  buildInsert,
  getScalarCastType,
} from "../query-engine/builders/values-builder";
import { getWhereUniqueEntries } from "../query-engine/builders/where-unique-builder";
import {
  createQueryScope,
  getTableName,
} from "../query-engine/context/query-scope";
import {
  buildCreate,
  buildFindUnique,
  buildUpdate,
} from "../query-engine/operations";
import type { QueryEngine } from "../query-engine/query-engine";
import { ResultParser } from "../query-engine/result/ResultParser";
import type { QueryScope } from "../query-engine/types";
import {
  type GuardStep,
  type OperationFragment,
  type OperationStep,
  type OperationValueReference,
  ref,
  type StatementStep,
} from "./OperationFragment";

type ExecutionMode = "transaction" | "batch";

export class CreateOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly resultArgs: Record<string, unknown>;
  private readonly planningFragment: OperationFragment;
  private readonly existingFragment: OperationFragment;
  private readonly missingFragment: OperationFragment;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    this.mode = selectExecutionMode(engine);

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
    const parsedRelation = parseRecord(
      relationSchemas.update,
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

    // 2. Build symbolic SQL only after every user-provided value is validated.
    const parentCreateId = `${parentName}.create`;
    const childFindId = `${childName}.find`;
    const resultId = `${parentName}.select`;
    const parentId = ref(parentCreateId, "id");
    const childParentId = referenceSql(
      engine,
      child.model,
      childForeignKey,
      parentId
    );
    const selectedParentId = referenceSql(
      engine,
      model,
      parentPrimaryKey,
      parentId
    );
    const childIdentitySelect = { [childPrimaryKey]: true };
    const guardProbe = buildFindUnique(child, {
      where,
      select: childIdentitySelect,
      forUpdate: true,
    });
    const find: StatementStep = {
      id: childFindId,
      kind: "read",
      statement: buildFindUnique(child, {
        where,
        select: childIdentitySelect,
        forUpdate: this.mode === "transaction",
      }),
      outputs: { rows: { kind: "rows" } },
    };
    const createParent: StatementStep = {
      id: parentCreateId,
      kind: "write",
      statement:
        this.mode === "batch"
          ? buildInsert(parent, getTableName(model), parentData)
          : buildCreate(parent, {
              data: parentData,
              select: { [parentPrimaryKey]: true },
            }),
      outputs: {
        id:
          this.mode === "transaction" &&
          engine.adapter.capabilities.supportsReturning
            ? { kind: "firstRowField", field: parentPrimaryKey }
            : { kind: "insertId" },
      },
    };
    const updateChild: StatementStep = {
      id: `${childName}.update`,
      kind: "write",
      statement: buildUpdate(child, {
        where,
        data: {
          ...childUpdate.scalarData,
          [childForeignKey]: childParentId,
        },
        select: childIdentitySelect,
      }),
      outputs: {},
    };
    const createChild: StatementStep = {
      id: `${childName}.create`,
      kind: "write",
      statement: buildInsert(child, getTableName(child.model), {
        ...childCreate.scalarData,
        [childForeignKey]: childParentId,
      }),
      outputs: {},
    };
    const selectParent: StatementStep = {
      id: resultId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where: { [parentPrimaryKey]: selectedParentId },
        select: parsedSelect,
      }),
      outputs: { result: { kind: "rows" } },
    };
    const resultOutputs = { result: ref(resultId, "result") };
    const existingSteps: OperationStep[] = [
      createParent,
      updateChild,
      selectParent,
    ];
    const missingSteps: OperationStep[] = [
      createParent,
      createChild,
      selectParent,
    ];

    if (this.mode === "batch") {
      existingSteps.unshift(
        createGuard(
          `${childName}.guard.exists`,
          "exists",
          guardProbe,
          relationName
        )
      );
      missingSteps.unshift(
        createGuard(
          `${childName}.guard.notExists`,
          "notExists",
          guardProbe,
          relationName
        )
      );
    }

    // 3. Freeze planning and both capability-specialized linear outcomes.
    this.planningFragment = {
      steps: [find],
      outputs: { rows: ref(childFindId, "rows") },
    };
    this.existingFragment = {
      steps: existingSteps,
      outputs: resultOutputs,
    };
    this.missingFragment = {
      steps: missingSteps,
      outputs: resultOutputs,
    };
  }

  createPlanningFragment(): OperationFragment {
    return this.planningFragment;
  }

  createFragment(
    planningOutputs: Readonly<Record<string, unknown>>
  ): OperationFragment {
    const rows = planningOutputs.rows;
    if (!Array.isArray(rows)) {
      throw new QueryEngineError(
        "query-engine-v2 create planning did not expose rows."
      );
    }
    return rows.length > 0 ? this.existingFragment : this.missingFragment;
  }

  parseResult<T>(outputs: Readonly<Record<string, unknown>>): T {
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

function referenceSql(
  engine: QueryEngine,
  model: Model<any>,
  field: string,
  reference: OperationValueReference
): Sql {
  const value = engine.adapter.literals.value(reference);
  const cast = getScalarCastType(model, field);
  return cast ? engine.adapter.expressions.cast(value, cast) : value;
}

function createGuard(
  id: string,
  kind: "exists" | "notExists",
  statement: Sql,
  relation: string
): GuardStep {
  return {
    id,
    kind: "guard",
    premise: { kind, statement },
    failure: {
      kind: "nestedWrite",
      message: `Nested upsert premise changed for relation '${relation}'.`,
      relation,
    },
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getStepModelName(model: Model<any>, fallback: string): string {
  return model["~"].names.ts ?? model["~"].names.sql ?? fallback;
}

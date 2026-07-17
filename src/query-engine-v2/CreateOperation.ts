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
import { uniqueConflictTarget } from "../query-engine/WritePrograms";
import { validateProbe } from "./FragmentValidator";
import {
  type Failure,
  type GuardStep,
  type OperationFragment,
  type OperationStep,
  type OperationValueReference,
  type Postcondition,
  type Probe,
  ref,
  type StatementStep,
  type TargetConstraintPin,
} from "./OperationFragment";
import { StepScope } from "./StepScope";
import { getStepModelName, isRecord } from "./shared";

type ExecutionMode = "transaction" | "batch";

export class CreateOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly resultArgs: Record<string, unknown>;
  private readonly planningFragment: OperationFragment;
  private readonly probe: Probe;
  private readonly createParent: StatementStep;
  private readonly updateChild: StatementStep;
  private readonly createChild: StatementStep;
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
    const scope = new StepScope();

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
    //    Step ids come from the scope allocator so no two writes can collide.
    const parentCreateId = scope.allocate(`${parentName}.create`);
    const childFindId = scope.allocate(`${childName}.find`);
    const resultId = scope.allocate(`${parentName}.select`);
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

    const find: StatementStep = {
      id: childFindId,
      kind: "read",
      statement: buildFindUnique(child, {
        where,
        select: childIdentitySelect,
        forUpdate: txMode,
      }),
      outputs: { rows: { kind: "rows" } },
    };

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

    this.updateChild = {
      id: scope.allocate(`${childName}.update`),
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
      // The found premise is pinned by the locked probe (tx) or the exists guard
      // (batch); an affected-row miss there is a not-found, never a race.
      ...(txMode
        ? {
            expects: affectedRows(1, {
              kind: "notFound",
              message: `Nested upsert target for relation '${relationName}' vanished before its update.`,
              relation: relationName,
              raceable: false,
            }),
          }
        : {}),
    };

    this.createChild = {
      id: scope.allocate(`${childName}.create`),
      kind: "write",
      statement: buildInsert(child, getTableName(child.model), {
        ...childCreate.scalarData,
        [childForeignKey]: childParentId,
      }),
      outputs: {},
      // The missing premise is enforced by the child's unique constraint; its
      // violation is the raceable signal, matched against this pinned target.
      racePin: childRacePin(child, where),
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

    // 3. Pair the planning read with the premise its decision creates (ATOM §2).
    //    The found branch is pinned by the exists guard in batch mode; the
    //    missing branch is enforced by the constraint, never a notExists guard.
    const foundPin: GuardStep | "none" = txMode
      ? "none"
      : existsGuard(
          scope.allocate(`${childName}.guard.exists`),
          buildFindUnique(child, { where, select: childIdentitySelect }),
          relationName
        );
    this.probe = {
      read: find,
      pin: { whenFound: foundPin, whenMissing: "constraint" },
    };
    validateProbe(this.probe);

    // 4. Freeze the planning fragment; the final fragment is compiled per branch.
    this.planningFragment = {
      steps: [find],
      outputs: { rows: ref(childFindId, "rows") },
    };
  }

  planning(): OperationFragment {
    return this.planningFragment;
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    const rows = known.rows;
    if (!Array.isArray(rows)) {
      throw new QueryEngineError(
        "query-engine-v2 create planning did not expose rows."
      );
    }
    const steps: OperationStep[] = [];
    if (rows.length > 0) {
      if (this.probe.pin.whenFound !== "none") {
        steps.push(this.probe.pin.whenFound);
      }
      steps.push(this.createParent, this.updateChild, this.selectParent);
    } else {
      // whenMissing === "constraint": the create INSERT carries the racePin and
      // no guard pins the premise (Pin Rule).
      steps.push(this.createParent, this.createChild, this.selectParent);
    }
    return { steps, outputs: this.resultOutputs };
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

function childRacePin(
  child: QueryScope,
  where: Record<string, unknown>
): TargetConstraintPin {
  return uniqueConflictTarget(child, where);
}

function affectedRows(
  expected: number | { readonly min: number },
  failure: Failure
): Postcondition {
  return { kind: "affectedRows", expected, failure };
}

function exactlyOneRow(failure: Failure): Postcondition {
  return { kind: "exactlyOneRow", failure };
}

function existsGuard(id: string, statement: Sql, relation: string): GuardStep {
  return {
    id,
    kind: "guard",
    premise: { kind: "exists", statement },
    failure: {
      kind: "nestedWrite",
      message: `Nested upsert premise changed for relation '${relation}'.`,
      relation,
      raceable: false,
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

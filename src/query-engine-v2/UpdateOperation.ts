// biome-ignore-all lint/style/useFilenamingConvention: UpdateOperation is the architecture name.
import { NotFoundError, QueryEngineError, ValidationError } from "@errors";
import type { Model } from "@schema/model";
import { parse, type VibSchema } from "@validation";
import { getPrimaryKeyFields } from "../query-engine/builders/correlation-utils";
import { separateData } from "../query-engine/builders/relation-data-builder";
import { getRelationMutationKinds } from "../query-engine/builders/relation-mutation-parser";
import { createQueryScope } from "../query-engine/context/query-scope";
import { buildFindUnique, buildUpdate } from "../query-engine/operations";
import type { QueryEngine } from "../query-engine/query-engine";
import { ResultParser } from "../query-engine/result/ResultParser";
import { affectedRows, exactlyOneRow } from "./fragment-builders";
import {
  type OperationFragment,
  ref,
  type StatementStep,
} from "./OperationFragment";
import { OwnWritePreflight } from "./OwnWritePreflight";
import { planningKey, planningOutputs } from "./Part";
import {
  buildToManyUpsertParts,
  plannedParentId,
  type RelationUpsertPart,
} from "./RelationUpsertPart";
import { StepScope } from "./StepScope";
import { getStepModelName, isRecord } from "./shared";

type ExecutionMode = "transaction" | "batch";

/**
 * The canonical parity slice (PLAN P1.1(b)): a root `update` located by a
 * **non-PK unique** — which forces a locate planning read whose output the
 * child arms consume — carrying an atomic scalar update (e.g. `increment`) and
 * one or more **correlated** nested to-many upserts by child unique, with a deep
 * terminal select. It is the second materially different operation: it composes
 * the same `RelationUpsertPart`, executor, and fragment vocabulary as
 * `CreateOperation`, adding only local update semantics.
 *
 * Scoped strictly to this family; every other shape is rejected typed before
 * I/O. P2 broadens.
 */
export class UpdateOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly scope: StepScope;
  private readonly resultArgs: Record<string, unknown>;
  private readonly childParts: readonly RelationUpsertPart[];
  private readonly locate: StatementStep;
  private readonly updateParent: StatementStep;
  private readonly parentPrimaryKey: string;
  private readonly parsedSelect: Record<string, unknown>;
  private readonly relationName: string;
  private readonly terminalId: string;

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

    // 1. Validate the payload family. `where` is a unique locator; `data` is a
    //    non-empty scalar update plus one-to-many correlated upsert relations.
    assertExactKeys(args, ["where", "data", "select"], "update arguments");
    const where = requireRecord(args.where, "update.where");
    const data = requireRecord(args.data, "update.data");
    const select = requireRecord(args.select, "update.select");
    const parent = createQueryScope(engine.adapter, model);
    const separated = separateData(parent, data);
    const relationEntries = Object.entries(separated.relations);
    if (relationEntries.length === 0) {
      throw new QueryEngineError(
        "query-engine-v2 update requires at least one nested relation upsert."
      );
    }
    if (Object.keys(separated.scalarData).length === 0) {
      throw new QueryEngineError(
        "query-engine-v2 update requires a scalar update (e.g. an increment) on the root."
      );
    }

    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);
    const parentPrimaryKeys = getPrimaryKeyFields(model);
    if (parentPrimaryKeys.length !== 1) {
      throw new QueryEngineError(
        "query-engine-v2 update requires a parent with one primary key."
      );
    }
    this.parentPrimaryKey = parentPrimaryKeys[0]!;

    const parentWhere = parseRecord(
      parentSchemas.core.whereUnique,
      where,
      "where"
    );
    const parentData = parseRecord(
      parentSchemas.core.scalarUpdate,
      separated.scalarData,
      "data"
    );
    this.parsedSelect = parseRecord(
      parentSchemas.core.select,
      select,
      "select"
    );
    this.resultArgs = { select: this.parsedSelect };

    // 2. Own-write preflight (ATOM §4): the same-child-unique upsert pair (and
    //    every other decision-read-over-own-write) is rejected here with V1's
    //    typed "split these operations" error, before planning.
    new OwnWritePreflight().assertUpdate(parent, data, where);

    const parentName = getStepModelName(model, "parent");
    const locateId = scope.allocate(`${parentName}.locate`);
    const updateId = scope.allocate(`${parentName}.update`);
    this.terminalId = scope.allocate(`${parentName}.select`);
    this.relationName = relationEntries.map(([name]) => name).join(",");

    // 3. The locate planning read: a non-PK-unique `where` means the parent id
    //    is not a compile-time literal — it is produced here (a planning value)
    //    and consumed by every correlated child arm and by the terminal read at
    //    the compile-data boundary (`known`), not a SQL planning→planning ref
    //    (ATOM §8.1 design note (a): the upsert family cannot construct one).
    this.locate = {
      id: locateId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where: parentWhere,
        select: { [this.parentPrimaryKey]: true },
        forUpdate: txMode,
      }),
      outputs: { rows: { kind: "rows" } },
    };

    // 4. The shared root write, emitted once: the atomic scalar update located
    //    by the same unique. In tx mode it carries the notFound postcondition
    //    (batch-mode affectedRows assertion is P2a — missing root is caught at
    //    compile from the locate read, below).
    this.updateParent = {
      id: updateId,
      kind: "write",
      statement: buildUpdate(parent, {
        where: parentWhere,
        data: parentData,
        select: { [this.parentPrimaryKey]: true },
      }),
      outputs: {},
      ...(txMode
        ? {
            expects: affectedRows(1, {
              kind: "notFound",
              message: `query-engine-v2 update located no '${parentName}' row for its unique where.`,
              raceable: false,
            }),
          }
        : {}),
    };

    // 5. One correlated upsert part per upsert item (across every relation and
    //    every array element), each recursively composing its own update-arm
    //    children (depth). The scope disambiguates two same-model children.
    const parts: RelationUpsertPart[] = [];
    for (const [relationName, mutation] of relationEntries) {
      if (
        mutation.relationInfo.type !== "oneToMany" ||
        getRelationMutationKinds(mutation).join(",") !== "upsert"
      ) {
        throw new QueryEngineError(
          `query-engine-v2 update supports only one-to-many nested upsert; received '${relationName}'.`
        );
      }
      const relationSchemas = parentSchemas.relations[relationName];
      if (!relationSchemas) {
        throw new QueryEngineError(
          `No validation schema exists for relation '${relationName}'.`
        );
      }
      const relationInput = requireRecord(data[relationName], relationName);
      // Validate the whole nested tree once, through the relation's update
      // schema (its `upsert.update` recurses into the child's own relations).
      const parsed = parseRecord(
        relationSchemas.update,
        relationInput,
        `data.${relationName}`
      );
      parts.push(
        ...buildToManyUpsertParts(
          scope,
          parent,
          this.engine,
          relationName,
          mutation.relationInfo,
          normalizeUpsertItems(parsed.upsert, relationName),
          plannedParentId(locateId, this.parentPrimaryKey),
          this.parentPrimaryKey,
          "correlated",
          txMode
        )
      );
    }
    this.childParts = parts;
  }

  planning(): OperationFragment {
    const steps = [
      this.locate,
      ...this.childParts.flatMap((part) => part.planning(this.scope)),
    ];
    return { steps, outputs: planningOutputs(steps) };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    // Missing root: the locate read decided it at planning. Fail closed with the
    // typed notFound before constructing any write (both substrates).
    const locateRows = known[planningKey(this.locate.id, "rows")];
    if (!Array.isArray(locateRows)) {
      throw new QueryEngineError(
        "query-engine-v2 update planning did not expose the locate rows."
      );
    }
    if (locateRows.length === 0) {
      throw new NotFoundError(getStepModelName(this.model, "record"), "update");
    }
    const locatedId = (locateRows[0] as Record<string, unknown>)[
      this.parentPrimaryKey
    ];

    // Build-don't-select (P1.2): each child part constructs its taken arm; the
    // shared update and the deep terminal read (keyed on the located id — a
    // planning value, not a Ref: a final-fragment step may not ref a planning
    // step) are emitted once, spliced by FK direction. Guards hoist to front.
    const childSteps = this.childParts.flatMap((part) =>
      part.compile(this.scope, known)
    );
    const guards = childSteps.filter((step) => step.kind === "guard");
    const afterParent = childSteps.filter((step) => step.kind !== "guard");
    const terminal = this.buildTerminal(locatedId);
    return {
      steps: [...guards, this.updateParent, ...afterParent, terminal],
      outputs: { result: ref(this.terminalId, "result") },
    };
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
      this.engine.driver
    ).parse<T>("update", outputs.result, this.resultArgs);
  }

  private buildTerminal(locatedId: unknown): StatementStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    const txMode = this.mode === "transaction";
    return {
      id: this.terminalId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where: { [this.parentPrimaryKey]: locatedId },
        select: this.parsedSelect,
      }),
      outputs: { result: { kind: "rows" } },
      ...(txMode
        ? {
            expects: exactlyOneRow({
              kind: "query",
              message: `query-engine-v2 update terminal read for '${this.relationName}' expected exactly one row.`,
              raceable: false,
            }),
          }
        : {}),
    };
  }
}

function selectExecutionMode(engine: QueryEngine): ExecutionMode {
  if (engine.driver.supportsTransactions) return "transaction";
  if (engine.driver.supportsBatch) return "batch";
  throw new QueryEngineError(
    `Driver '${engine.driver.driverName}' supports neither transactions nor atomic batch execution.`
  );
}

function normalizeUpsertItems(
  value: unknown,
  relation: string
): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!isRecord(item)) {
      throw new QueryEngineError(
        `Relation '${relation}' upsert item must be an object.`
      );
    }
    return item;
  });
}

function parseRecord(
  schema: VibSchema,
  value: unknown,
  path: string
): Record<string, unknown> {
  const result = parse(schema, value);
  if ("issues" in result && result.issues) {
    throw new ValidationError(
      "update",
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

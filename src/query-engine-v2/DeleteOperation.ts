// biome-ignore-all lint/style/useFilenamingConvention: DeleteOperation is the architecture name.
import { NotFoundError, QueryEngineError, ValidationError } from "@errors";
import type { Model } from "@schema/model";
import { parse, type VibSchema } from "@validation";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../query-engine/builders/correlation-utils";
import {
  createQueryScope,
  getDefaultScalarFieldNames,
} from "../query-engine/context/query-scope";
import { buildDelete, buildFindUnique } from "../query-engine/operations";
import type { QueryEngine } from "../query-engine/query-engine";
import { ResultParser } from "../query-engine/result/ResultParser";
import {
  affectedRows,
  exactlyOneRow,
  notFoundFailure,
  presenceGuard,
} from "./fragment-builders";
import {
  type OperationFragment,
  type OperationStep,
  ref,
  type StatementStep,
} from "./OperationFragment";
import { planningKey, planningOutputs } from "./Part";
import { StepScope } from "./StepScope";
import {
  getStepModelName,
  isRecord,
  selectExecutionMode,
  UnsupportedOperationError,
} from "./shared";

type ExecutionMode = "transaction" | "batch";

/**
 * The root `delete` (PLAN P2a). It locates the row by any unique `where`,
 * captures its selected shape as the result **before** removing it (portable
 * across drivers with and without `RETURNING`), then deletes it. The `notFound`
 * postcondition is a locate-read postcondition enforced at planning on both
 * substrates; batch mode additionally pins the row's presence inside the atomic
 * unit so a concurrent delete aborts the batch typed (ATOM §8.1 note (b)).
 */
export class DeleteOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly scope: StepScope;
  private readonly resultArgs: Record<string, unknown>;
  private readonly parentWhere: Record<string, unknown>;
  private readonly parsedSelect: Record<string, unknown> | undefined;
  private readonly parsedInclude: Record<string, unknown> | undefined;
  private readonly parentPrimaryKeys: readonly string[];
  private readonly locate: StatementStep;
  private readonly readId: string;
  private readonly deleteId: string;
  private readonly rootGuardId: string;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    this.mode = selectExecutionMode(engine, "delete");
    const txMode = this.mode === "transaction";
    this.scope = new StepScope();
    const scope = this.scope;

    // `select` is optional (default the scalar projection, exactly as V1's
    // no-select delete returns the whole row) and `include` rides alongside it —
    // the same result-shaping surface `create` already owns (CreateOperation).
    assertDeleteKeys(args);
    const where = requireRecord(args.where, "delete.where");
    const parent = createQueryScope(engine.adapter, model);

    const parentPrimaryKeys = getPrimaryKeyFields(model);
    if (parentPrimaryKeys.length === 0) {
      throw new UnsupportedOperationError(
        "query-engine-v2 delete requires a parent with a primary key."
      );
    }
    // Compound primary keys are supported: the locate/guard select every PK
    // field, and the delete targets the parsed compound where-unique.
    this.parentPrimaryKeys = parentPrimaryKeys;

    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);
    this.parentWhere = parseRecord(
      parentSchemas.core.whereUnique,
      where,
      "where"
    );
    // The projection: an explicit `select`, else the default scalar projection
    // (respecting `.omit()`). `include` rides alongside the default scalars —
    // when both are absent the row is captured with every non-omitted scalar,
    // V1's default delete shape. An all-`.omit()` model with no include yields
    // undefined (the read builder + parser then produce `{}`, as ReadOperation
    // does), preserved here so a delete cannot leak an omitted column.
    this.parsedInclude = isRecord(args.include) ? args.include : undefined;
    this.parsedSelect = isRecord(args.select)
      ? parseRecord(parentSchemas.core.select, args.select, "select")
      : defaultSelect(model);
    this.resultArgs = {
      ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
      ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
    };

    const parentName = getStepModelName(model, "parent");
    const locateId = scope.allocate(`${parentName}.locate`);
    this.readId = scope.allocate(`${parentName}.read`);
    this.deleteId = scope.allocate(`${parentName}.delete`);
    this.rootGuardId = scope.allocate(`${parentName}.guard.exists`);

    // The locate planning read enforces notFound before any write on both
    // substrates (a missing row aborts at planning; batch adds the in-unit
    // presence guard). It selects only the PK — the row's public shape is
    // captured by the final-fragment read below, whose output is fragment-local.
    this.locate = {
      id: locateId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where: this.parentWhere,
        select: this.pkSelect(),
        forUpdate: txMode,
      }),
      outputs: { rows: { kind: "rows" } },
      expects: exactlyOneRow(
        notFoundFailure(
          `query-engine-v2 delete located no '${parentName}' row for its unique where.`
        )
      ),
    };
  }

  planning(): OperationFragment {
    const steps = [this.locate];
    return { steps, outputs: planningOutputs(steps) };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    // Defensive: the locate postcondition already aborts a missing root at
    // planning; this keeps compile fail-closed if it is ever called directly.
    const rows = known[planningKey(this.locate.id, "rows")];
    if (!Array.isArray(rows)) {
      throw new QueryEngineError(
        "query-engine-v2 delete planning did not expose the locate rows."
      );
    }
    if (rows.length === 0) {
      throw new NotFoundError(getStepModelName(this.model, "record"), "delete");
    }
    const locatedRow = rows[0] as Record<string, unknown>;
    const parent = createQueryScope(this.engine.adapter, this.model);
    const txMode = this.mode === "transaction";
    // Address the row by the PK captured at the (FOR UPDATE) locate rather than
    // the original `where`: locating by an alternate unique then mutating by the
    // immutable captured PK is V1's `WHERE id` mechanic (the alternate unique
    // could be concurrently rewritten). Transaction mode only — batch mode keeps
    // the original `where` so the write and its presence guard pin the same row.
    const where = this.writeWhere(locatedRow);
    const readFull: StatementStep = {
      id: this.readId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where,
        ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
        ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
        // `FOR UPDATE` cannot be applied to an include's relation join/aggregate
        // (Postgres 0A000). The PK-only locate above already took the row lock in
        // transaction mode, so the shape-capturing read never needs to re-lock —
        // it drops `FOR UPDATE` whenever a relation projection is present, exactly
        // as the create/update terminal reads (which never re-lock) do.
        forUpdate: txMode && !this.parsedInclude,
      }),
      outputs: { result: { kind: "rows" } },
    };
    const deleteRow: StatementStep = {
      id: this.deleteId,
      kind: "write",
      statement: buildDelete(parent, { where }),
      outputs: {},
      ...(txMode
        ? {
            expects: affectedRows(
              1,
              notFoundFailure(
                `query-engine-v2 delete located no '${getStepModelName(this.model, "parent")}' row for its unique where.`
              )
            ),
          }
        : {}),
    };
    const steps: OperationStep[] = [];
    if (this.mode === "batch") {
      steps.push(this.buildRootPresenceGuard());
    }
    // Capture the row, then delete it — both in the final fragment, so the
    // result output resolves fragment-locally at parse (ATOM §9 inv. 4).
    steps.push(readFull, deleteRow);
    return { steps, outputs: { result: ref(this.readId, "result") } };
  }

  /** The row's post-locate address: the captured PK in transaction mode (V1's
   *  `WHERE id`), the original `where` in batch mode (guard/write pin one row). */
  private writeWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    if (this.mode !== "transaction") return this.parentWhere;
    return buildPrimaryKeyWhereUnique(
      this.model,
      Object.fromEntries(
        this.parentPrimaryKeys.map((pk) => [pk, locatedRow[pk]])
      )
    );
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    if (!Object.hasOwn(outputs, "result")) {
      throw new QueryEngineError(
        "query-engine-v2 delete did not expose its result."
      );
    }
    return new ResultParser(
      this.engine.adapter,
      this.model,
      this.engine.driver
    ).parse<T>("delete", outputs.result, this.resultArgs);
  }

  private pkSelect(): Record<string, boolean> {
    return Object.fromEntries(this.parentPrimaryKeys.map((pk) => [pk, true]));
  }

  private buildRootPresenceGuard(): OperationStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    return presenceGuard(
      this.rootGuardId,
      buildFindUnique(parent, {
        where: this.parentWhere,
        select: this.pkSelect(),
      }),
      notFoundFailure(
        `query-engine-v2 delete located no '${getStepModelName(this.model, "record")}' row for its unique where.`
      )
    );
  }
}

function parseRecord(
  schema: VibSchema,
  value: unknown,
  path: string
): Record<string, unknown> {
  const result = parse(schema, value);
  if ("issues" in result && result.issues) {
    throw new ValidationError(
      "delete",
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

function assertDeleteKeys(value: Record<string, unknown>): void {
  const allowed = new Set(["where", "select", "include"]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (Object.hasOwn(value, "where") && unexpected.length === 0) return;
  throw new UnsupportedOperationError(
    `delete arguments require where (optional select, include); received ${Object.keys(value).join(", ") || "none"}.`
  );
}

function defaultSelect(model: Model<any>): Record<string, unknown> | undefined {
  // V1's default projection is every scalar EXCEPT `.omit()`-ed fields. An
  // all-omitted model yields undefined (the read builder + parser then produce
  // `{}`, as ReadOperation does with no select), so a delete never leaks an
  // omitted column.
  const fields = getDefaultScalarFieldNames(model);
  if (fields.length === 0) return undefined;
  return Object.fromEntries(fields.map((field: string) => [field, true]));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new UnsupportedOperationError(`'${label}' must be an object.`);
}

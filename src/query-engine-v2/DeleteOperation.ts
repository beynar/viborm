// biome-ignore-all lint/style/useFilenamingConvention: DeleteOperation is the architecture name.
import { NotFoundError, QueryEngineError, ValidationError } from "@errors";
import type { Model } from "@schema/model";
import { parse, type VibSchema } from "@validation";
import { getPrimaryKeyFields } from "../query-engine/builders/correlation-utils";
import { createQueryScope } from "../query-engine/context/query-scope";
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
  private readonly parentPrimaryKey: string;
  private readonly locate: StatementStep;
  private readonly readFull: StatementStep;
  private readonly deleteRow: StatementStep;
  private readonly rootGuardId: string;

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

    assertExactKeys(args, ["where", "select"], "delete arguments");
    const where = requireRecord(args.where, "delete.where");
    const select = requireRecord(args.select, "delete.select");
    const parent = createQueryScope(engine.adapter, model);

    const parentPrimaryKeys = getPrimaryKeyFields(model);
    if (parentPrimaryKeys.length !== 1) {
      throw new UnsupportedOperationError(
        "query-engine-v2 delete requires a parent with one primary key."
      );
    }
    this.parentPrimaryKey = parentPrimaryKeys[0]!;

    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);
    this.parentWhere = parseRecord(
      parentSchemas.core.whereUnique,
      where,
      "where"
    );
    const parsedSelect = parseRecord(
      parentSchemas.core.select,
      select,
      "select"
    );
    this.resultArgs = { select: parsedSelect };

    const parentName = getStepModelName(model, "parent");
    const locateId = scope.allocate(`${parentName}.locate`);
    const readId = scope.allocate(`${parentName}.read`);
    const deleteId = scope.allocate(`${parentName}.delete`);
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
        select: { [this.parentPrimaryKey]: true },
        forUpdate: txMode,
      }),
      outputs: { rows: { kind: "rows" } },
      expects: exactlyOneRow(
        notFoundFailure(
          `query-engine-v2 delete located no '${parentName}' row for its unique where.`
        )
      ),
    };

    // The final-fragment read that captures the row's selected shape immediately
    // before it is deleted — portable across drivers with and without RETURNING
    // (no dialect branch), and fragment-local so its output resolves at parse.
    this.readFull = {
      id: readId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where: this.parentWhere,
        select: parsedSelect,
        forUpdate: txMode,
      }),
      outputs: { result: { kind: "rows" } },
    };

    this.deleteRow = {
      id: deleteId,
      kind: "write",
      statement: buildDelete(parent, { where: this.parentWhere }),
      outputs: {},
      ...(txMode
        ? {
            expects: affectedRows(
              1,
              notFoundFailure(
                `query-engine-v2 delete located no '${parentName}' row for its unique where.`
              )
            ),
          }
        : {}),
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
    const steps: OperationStep[] = [];
    if (this.mode === "batch") {
      steps.push(this.buildRootPresenceGuard());
    }
    // Capture the row, then delete it — both in the final fragment, so the
    // result output resolves fragment-locally at parse (ATOM §9 inv. 4).
    steps.push(this.readFull, this.deleteRow);
    return { steps, outputs: { result: ref(this.readFull.id, "result") } };
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

  private buildRootPresenceGuard(): OperationStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    return presenceGuard(
      this.rootGuardId,
      buildFindUnique(parent, {
        where: this.parentWhere,
        select: { [this.parentPrimaryKey]: true },
      }),
      notFoundFailure(
        `query-engine-v2 delete located no '${getStepModelName(this.model, "record")}' row for its unique where.`
      )
    );
  }
}

function selectExecutionMode(engine: QueryEngine): ExecutionMode {
  if (engine.driver.supportsTransactions) return "transaction";
  if (engine.driver.supportsBatch) return "batch";
  throw new QueryEngineError(
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

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const allowed = new Set(expected);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length === 0 && missing.length === 0) return;
  throw new UnsupportedOperationError(
    `${label} requires exactly ${expected.join(", ")}; received ${Object.keys(value).join(", ") || "none"}.`
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new UnsupportedOperationError(`'${label}' must be an object.`);
}

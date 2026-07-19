// biome-ignore-all lint/style/useFilenamingConvention: CreateManyOperation is the architecture name.
import { QueryEngineError, ValidationError } from "@errors";
import type { Model } from "@schema/model";
import { parse, type VibSchema } from "@validation";
import { createQueryScope } from "../query-engine/context/query-scope";
import { buildCreateManyPlan } from "../query-engine/operations";
import type { QueryEngine } from "../query-engine/query-engine";
import {
  type FragmentOutputSource,
  type OperationFragment,
  type OperationValueReference,
  ref,
  type StatementStep,
} from "./OperationFragment";
import { StepScope } from "./StepScope";
import {
  getStepModelName,
  isRecord,
  UnsupportedOperationError,
} from "./shared";

type ExecutionMode = "transaction" | "batch";

/**
 * The root `createMany` (PLAN P2c). It inserts a batch of rows and returns
 * `{ count }`. A bulk insert is *one INSERT where the dialect allows*, but two
 * portable facts force a plan of several statements whose counts **sum**
 * (ATOM §1 fragment outputs as ordered source lists):
 *
 * - rows whose explicit column shapes differ cannot share one `VALUES` clause,
 *   so `buildCreateManyPlan` groups them into contiguous same-shape statements
 *   (the SQLite multi-statement plan, but the rule is dialect-agnostic);
 * - `skipDuplicates` on a dialect whose strategy is `recoverableUniqueError`
 *   (MySQL — no `ON CONFLICT DO NOTHING` that reports a skipped-row count) has
 *   no plain SQL leaf, so each row runs as a savepoint-wrapped **executor
 *   effect** (`onUniqueConflict: "skip"`, ATOM §8), a unique violation absorbed
 *   as a zero-row result rather than aborting the batch. Dialects whose skip
 *   IS a plain SQL leaf (`ON CONFLICT DO NOTHING`, `INSERT OR IGNORE`) carry the
 *   semantics in the leaf and never set the effect.
 *
 * There is no planning read and no decision — `createMany` is a straight write
 * fragment. Its result parses fragment-locally from the summed row counts.
 */
export class CreateManyOperation {
  readonly mode: ExecutionMode;

  private readonly writes: readonly StatementStep[];
  private readonly countOutput: FragmentOutputSource;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>
  ) {
    this.mode = selectExecutionMode(engine);
    const scope = new StepScope();

    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);
    const parsed = parseRecord(
      parentSchemas.args.createMany,
      args,
      "createMany"
    );
    const data = parsed.data;
    if (!Array.isArray(data)) {
      throw new QueryEngineError(
        "query-engine-v2 createMany requires a data array."
      );
    }
    const skipDuplicates = parsed.skipDuplicates === true;

    const parentName = getStepModelName(model, "record");
    const parent = createQueryScope(engine.adapter, model);

    if (data.length === 0) {
      // Prisma's contract: createMany over no rows is a no-op returning count 0.
      this.writes = [];
      this.countOutput = [];
      return;
    }

    const plan = buildCreateManyPlan(parent, { data, skipDuplicates }, false);
    // Dialects whose skip is a recoverable unique error (MySQL) have no plain
    // SQL leaf, so each per-row statement runs behind a savepoint. Dialects whose
    // skip IS a SQL leaf never set the effect — the leaf carries the semantics.
    const recoverUnique =
      skipDuplicates &&
      engine.adapter.mutations.skipDuplicatesStrategy ===
        "recoverableUniqueError";

    const refs: OperationValueReference[] = [];
    this.writes = plan.statements.map((statement) => {
      const id = scope.allocate(`${parentName}.createMany`);
      refs.push(ref(id, "count"));
      return {
        id,
        kind: "write",
        statement: statement.sql,
        outputs: { count: { kind: "rowCount" } },
        ...(recoverUnique ? { onUniqueConflict: "skip" as const } : {}),
      };
    });
    this.countOutput = refs;
  }

  planning(): OperationFragment {
    // No decision, no planning read — createMany is a straight write.
    return { steps: [], outputs: {} };
  }

  compile(_known: Readonly<Record<string, unknown>>): OperationFragment {
    // An empty batch has no statements and no resolvable output — parse returns
    // count 0 directly (a `{ count: [] }` output would fail the validator).
    if (this.writes.length === 0) return { steps: [], outputs: {} };
    return { steps: [...this.writes], outputs: { count: this.countOutput } };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    if (this.writes.length === 0) return { count: 0 } as T;
    const count = outputs.count;
    if (typeof count !== "number" && typeof count !== "bigint") {
      throw new QueryEngineError(
        "query-engine-v2 createMany did not resolve a numeric count."
      );
    }
    return { count: Number(count) } as T;
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
): { data: unknown; skipDuplicates?: unknown } {
  const result = parse(schema, value);
  if ("issues" in result && result.issues) {
    throw new ValidationError(
      "createMany",
      result.issues.map((issue) => ({
        path: [path, ...(issue.path?.map(String) ?? [])].join("."),
        message: issue.message,
      }))
    );
  }
  if (!isRecord(result.value)) {
    throw new UnsupportedOperationError(
      "query-engine-v2 createMany requires an object argument."
    );
  }
  return result.value as { data: unknown; skipDuplicates?: unknown };
}

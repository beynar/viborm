// biome-ignore-all lint/style/useFilenamingConvention: CreateManyOperation is the architecture name.
import { QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import { createQueryScope } from "../context/query-scope";
import { buildCreateManyPlan } from "../operations";
import type { QueryEngine } from "../query-engine";
import type { QueryScope } from "../types";
import {
  type PreparedBulkPolymorphicConnects,
  prepareBulkPolymorphicConnects,
} from "./bulk-polymorphic-connect";
import {
  type FragmentOutputSource,
  type OperationFragment,
  type OperationValueReference,
  type PlanningFragment,
  ref,
  type WriteStep,
} from "./OperationFragment";
import { parseValidated } from "./parse-boundary";
import { StepScope } from "./StepScope";
import { getStepModelName, selectExecutionMode } from "./shared";

type ExecutionMode = "transaction" | "batch";

/**
 * The root `createMany` inserts a batch of rows and returns
 * `{ count }`. A bulk insert is *one INSERT where the dialect allows*, but two
 * portable facts force a plan of several statements whose counts **sum**
 * (ATOM “The execution vocabulary”: fragment outputs are ordered source lists):
 *
 * - rows whose explicit column shapes differ cannot share one `VALUES` clause,
 *   so `buildCreateManyPlan` groups them into contiguous same-shape statements
 *   (the SQLite multi-statement plan, but the rule is dialect-agnostic);
 * - `skipDuplicates` on a dialect whose strategy is `recoverableUniqueError`
 *   (MySQL — no `ON CONFLICT DO NOTHING` that reports a skipped-row count) has
 *   no plain SQL leaf, so each row runs as a savepoint-wrapped **executor
 *   effect** (`onUniqueConflict: "skip"`, ATOM “Bulk specializations”), a unique violation absorbed
 *   as a zero-row result rather than aborting the batch. Dialects whose skip
 *   IS a plain SQL leaf (`ON CONFLICT DO NOTHING`, `INSERT OR IGNORE`) carry the
 *   semantics in the leaf and never set the effect.
 *
 * There is no planning read and no decision — `createMany` is a straight write
 * fragment. Its result parses fragment-locally from the summed row counts.
 */
export class CreateManyOperation {
  readonly mode: ExecutionMode;
  readonly validatedArgs: Record<string, unknown>;

  private writes: readonly WriteStep[];
  private countOutput: FragmentOutputSource;
  private readonly engine: QueryEngine;
  private readonly parent: QueryScope;
  private readonly scope: StepScope;
  private readonly parentName: string;
  private readonly data: readonly Record<string, unknown>[];
  private readonly skipDuplicates: boolean;
  private readonly polymorphic: PreparedBulkPolymorphicConnects;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>
  ) {
    this.mode = selectExecutionMode(engine, "createMany");
    const scope = new StepScope();
    this.engine = engine;
    this.scope = scope;

    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);
    const parsed = parseValidated(
      parentSchemas.args.createMany,
      args,
      "createMany",
      "createMany"
    );
    this.validatedArgs = parsed;
    const data = parsed.data;
    if (!Array.isArray(data)) {
      throw new QueryEngineError(
        "query-engine-v2 createMany requires a data array."
      );
    }
    const skipDuplicates = parsed.skipDuplicates === true;
    this.skipDuplicates = skipDuplicates;

    const parentName = getStepModelName(model, "record");
    const parent = createQueryScope(engine, model);
    this.parentName = parentName;
    this.parent = parent;
    this.polymorphic = prepareBulkPolymorphicConnects(
      engine,
      parent,
      data,
      scope,
      this.mode === "transaction"
    );
    this.data = this.polymorphic.scalarRows;

    if (data.length === 0) {
      // Prisma's contract: createMany over no rows is a no-op returning count 0.
      this.writes = [];
      this.countOutput = [];
      return;
    }

    if (this.polymorphic.probes.length > 0) {
      this.writes = [];
      this.countOutput = [];
      return;
    }

    const plan = buildCreateManyPlan(
      parent,
      { data: this.data, skipDuplicates },
      false,
      undefined,
      engine.maxBindParametersPerStatement
    );
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

  /**
   * A DIRECT empty `createMany` is Prisma's documented `{ count: 0 }` no-op
   * (returned by {@link parse}). But V1 builds its batch plan during
   * `$transaction([...])` array preparation, and `buildCreateManyPlan` throws
   * "No data to insert for createMany." on empty data — so a batch-prepared empty
   * `createMany` rejects, byte-identically, where V1 does. This gate fires ONLY on
   * the batch-preparation seam (never the direct execute path), keeping the direct
   * no-op intact.
   */
  assertBatchPreparable(): void {
    if (this.writes.length === 0) {
      throw new QueryEngineError("No data to insert for createMany.");
    }
  }

  planning(): PlanningFragment {
    const steps = this.polymorphic.probes;
    return { steps };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    if (this.polymorphic.probes.length > 0) {
      const { storageByRow, guards } = this.polymorphic.resolve(known);
      const plan = buildCreateManyPlan(
        this.parent,
        { data: this.data, skipDuplicates: this.skipDuplicates },
        false,
        storageByRow,
        this.engine.maxBindParametersPerStatement
      );
      const recoverUnique =
        this.skipDuplicates &&
        this.engine.adapter.mutations.skipDuplicatesStrategy ===
          "recoverableUniqueError";
      const refs: OperationValueReference[] = [];
      this.writes = plan.statements.map((statement) => {
        const id = this.scope.allocate(`${this.parentName}.createMany`);
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
      return {
        steps: [...guards, ...this.writes],
        outputs: { count: this.countOutput },
      };
    }
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

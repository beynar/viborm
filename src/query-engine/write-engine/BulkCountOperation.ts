// biome-ignore-all lint/style/useFilenamingConvention: BulkCountOperation is the architecture name.
import { QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { createQueryScope } from "../context/query-scope";
import { buildDeleteMany, buildUpdateMany } from "../operations";
import type { QueryEngine } from "../query-engine";
import { ResultParser } from "../result/ResultParser";
import type { Operation } from "../types";
import { validate } from "../validator";
import {
  type OperationFragment,
  type PlanningFragment,
  ref,
  type WriteStep,
} from "./OperationFragment";
import { isRecord, selectExecutionMode } from "./shared";

type ExecutionMode = "transaction" | "batch";
type BulkCountKind = "updateMany" | "deleteMany";

/**
 * Root `updateMany` / `deleteMany` with a `{ count }` result. A bulk mutation whose
 * public result is `{ count }` — one write step whose `rowCount` **source**
 * carries the count (ATOM “The execution vocabulary”). There is no planning read and no decision: the
 * `WHERE` filter is a scalar predicate, so the whole operation is one statement,
 * reusing V1's `buildUpdateMany` / `buildDeleteMany` verbatim.
 *
 * THIS SHELL SEES SCALAR-ONLY `updateMany` DATA, and the router is what
 * guarantees it — not the schema. `getUpdateManyArgs` binds `data` to the FULL
 * `core.update` schema (plan §5.2, Package K), so a relation key parses; routing
 * then sends that call to `UpdateManyRecordSeries` instead of here. What this
 * class must never become is the owner of a relation payload: the SET builder
 * skips non-scalar keys silently, which is exactly the wrong-success defect the
 * lift removed. The docblock that used to stand here claimed the parse boundary
 * rejected relation keys; it did not, and no test was written because of it.
 *
 * `limit` (Prisma 6.x) caps the affected row count, so the returned count is
 * `min(matching, limit)`. `limit: 0` is the one shape with NO statement at all:
 * the operation compiles to an empty plan and answers `{ count: 0 }`. Executing
 * a capped-to-nothing write would be a pointless round trip, and on the
 * PK-subquery dialects it would still take locks.
 */
export class BulkCountOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly kind: BulkCountKind;
  private readonly args: Record<string, unknown>;
  /** `undefined` only for `limit: 0` — the write that affects nothing. */
  private readonly write: WriteStep | undefined;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    kind: BulkCountKind,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    this.kind = kind;
    this.mode = selectExecutionMode(engine, kind);

    // The parse boundary applies the model's updateMany/deleteMany arg schema
    // (updateMany `data` is scalar-only, so a relation key rejects as an
    // unknown key) and the portable-PK-update check, so an unsupported payload
    // rejects with a typed ValidationError before any statement is built.
    this.args = validate<Record<string, unknown>>(
      engine.schemaRegistry,
      model,
      kind as Operation,
      args
    );

    this.write =
      this.limit() === 0
        ? undefined
        : {
            id: kind,
            kind: "write",
            statement: this.buildWriteSql(),
            outputs: { count: { kind: "rowCount" } },
          };
  }

  planning(): PlanningFragment {
    return { steps: [], outputs: {} };
  }

  compile(_known: Readonly<Record<string, unknown>>): OperationFragment {
    if (!this.write) return { steps: [], outputs: {} };
    return {
      steps: [this.write],
      outputs: { count: ref(this.write.id, "count") },
    };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    // `limit: 0` compiled to nothing, so there is no rowCount to read: the
    // answer is the count the caller asked for, zero.
    const count = this.write ? outputs.count : 0;
    if (typeof count !== "number" && typeof count !== "bigint") {
      throw new QueryEngineError(
        `query-engine-v2 ${this.kind} did not resolve a numeric count.`
      );
    }
    // Route through the same ResultParser + `{ rowCount }` carrier V1 uses for
    // batch mutations, so the public `{ count }` shape is byte-identical.
    return new ResultParser(
      this.engine.adapter,
      this.model,
      this.engine.driver,
      this.engine.decimalDecode
    ).parse<T>(this.kind as Operation, { rowCount: Number(count) }, this.args);
  }

  /** The validated `limit`, or `undefined` when the caller omitted it. */
  private limit(): number | undefined {
    return typeof this.args.limit === "number" ? this.args.limit : undefined;
  }

  private buildWriteSql(): Sql {
    const ctx = createQueryScope(this.engine.adapter, this.model);
    const where = isRecord(this.args.where) ? this.args.where : undefined;
    const limit = this.limit();
    const scope = {
      ...(where ? { where } : {}),
      ...(limit === undefined ? {} : { limit }),
    };
    if (this.kind === "deleteMany") {
      return buildDeleteMany(ctx, scope);
    }
    const data = this.args.data;
    if (!isRecord(data)) {
      throw new QueryEngineError(
        "query-engine-v2 updateMany is missing a data object."
      );
    }
    return buildUpdateMany(ctx, { ...scope, data });
  }
}

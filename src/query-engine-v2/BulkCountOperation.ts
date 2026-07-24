// biome-ignore-all lint/style/useFilenamingConvention: BulkCountOperation is the architecture name.
import { QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { createQueryScope } from "../query-engine/context/query-scope";
import { buildDeleteMany, buildUpdateMany } from "../query-engine/operations";
import type { QueryEngine } from "../query-engine/query-engine";
import { ResultParser } from "../query-engine/result/ResultParser";
import type { Operation } from "../query-engine/types";
import { validate } from "../query-engine/validator";
import {
  type OperationFragment,
  ref,
  type StatementStep,
} from "./OperationFragment";
import { isRecord, selectExecutionMode } from "./shared";

type ExecutionMode = "transaction" | "batch";
type BulkCountKind = "updateMany" | "deleteMany";

/**
 * Root `updateMany` / `deleteMany` (PLAN P4 item 2b). A bulk mutation whose
 * public result is `{ count }` — one write step whose `rowCount` **source**
 * carries the count (ATOM §1). There is no planning read and no decision: the
 * `WHERE` filter is a scalar predicate, so the whole operation is one statement,
 * reusing V1's `buildUpdateMany` / `buildDeleteMany` verbatim. `updateMany` with
 * relation data is rejected by V1's own validation schema (reused here), so a
 * relation payload never reaches the builder — parity is inherited, not
 * re-derived.
 */
export class BulkCountOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly kind: BulkCountKind;
  private readonly args: Record<string, unknown>;
  private readonly write: StatementStep;

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

    // V1's validator applies the model's updateMany/deleteMany arg schema (which
    // forbids relation data on updateMany) and the portable-PK-update check, so
    // an unsupported payload rejects with V1's exact ValidationError.
    this.args = validate<Record<string, unknown>>(
      engine.schemaRegistry,
      model,
      kind as Operation,
      args
    );

    this.write = {
      id: kind,
      kind: "write",
      statement: this.buildWriteSql(),
      outputs: { count: { kind: "rowCount" } },
    };
  }

  planning(): OperationFragment {
    return { steps: [], outputs: {} };
  }

  compile(_known: Readonly<Record<string, unknown>>): OperationFragment {
    return {
      steps: [this.write],
      outputs: { count: ref(this.write.id, "count") },
    };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    const count = outputs.count;
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
      this.engine.driver
    ).parse<T>(this.kind as Operation, { rowCount: Number(count) }, this.args);
  }

  private buildWriteSql(): Sql {
    const ctx = createQueryScope(this.engine.adapter, this.model);
    const where = isRecord(this.args.where) ? this.args.where : undefined;
    if (this.kind === "deleteMany") {
      return buildDeleteMany(ctx, where ? { where } : {});
    }
    const data = this.args.data;
    if (!isRecord(data)) {
      throw new QueryEngineError(
        "query-engine-v2 updateMany is missing a data object."
      );
    }
    return buildUpdateMany(ctx, where ? { where, data } : { data });
  }
}

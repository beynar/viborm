// biome-ignore-all lint/style/useFilenamingConvention: ReadOperation is the architecture name.
import { NotFoundError, QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { createQueryScope } from "../query-engine/context/query-scope";
import {
  buildAggregate,
  buildCount,
  buildFind,
  buildFindUnique,
  buildGroupBy,
} from "../query-engine/operations";
import type { QueryEngine } from "../query-engine/query-engine";
import { ResultParser } from "../query-engine/result/ResultParser";
import type { Operation } from "../query-engine/types";
import { validate } from "../query-engine/validator";
import {
  type OperationFragment,
  ref,
  type StatementStep,
} from "./OperationFragment";
import {
  isRecord,
  selectExecutionMode,
  UnsupportedOperationError,
} from "./shared";

type ExecutionMode = "transaction" | "batch";

/** The read operations V2 owns — each a single read step (PLAN P4 item 1). */
type ReadBase =
  | "findUnique"
  | "findFirst"
  | "findMany"
  | "count"
  | "aggregate"
  | "groupBy"
  | "exist";

const OR_THROW_SUFFIX = "OrThrow";

/**
 * A read as a single read step (PLAN P4 item 1). `find*`/`count`/`aggregate`/
 * `groupBy`/`exist` are genuinely single-statement operations: the compiled
 * fragment is EXACTLY ONE read step wrapping the same SQL the V1 read builders
 * produce (`buildFind`/`buildFindUnique`/`buildCount`/`buildAggregate`/
 * `buildGroupBy` — reused, never re-derived), parsed through the same
 * {@link ResultParser}. Planning is empty — a read makes no decision.
 *
 * The kill signal (PLAN P4) is any read needing more than one step; none here
 * do, so every read is one step and the boundary holds.
 *
 * `OrThrow` is not a postcondition: a `findUnique` returning `null` is a value,
 * not a violated invariant. The absence is surfaced from the *result* — matching
 * V1's exact error class and message (`No <model> record found for <operation>`,
 * carrying the original `…OrThrow` operation name).
 */
export class ReadOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly base: ReadBase;
  private readonly requestedOperation: string;
  private readonly throwIfNotFound: boolean;
  private readonly args: Record<string, unknown>;
  private readonly read: StatementStep;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    requestedOperation: string,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    this.mode = selectExecutionMode(engine, requestedOperation);
    this.requestedOperation = requestedOperation;

    const isOrThrow = requestedOperation.endsWith(OR_THROW_SUFFIX);
    const base = isOrThrow
      ? requestedOperation.slice(0, -OR_THROW_SUFFIX.length)
      : requestedOperation;
    if (!isReadBase(base)) {
      throw new UnsupportedOperationError(
        `query-engine-v2 read does not handle '${requestedOperation}'.`
      );
    }
    this.base = base;
    // OrThrow only exists for findUnique/findFirst; other reads never throw on
    // an empty result (Prisma has no findManyOrThrow / countOrThrow).
    this.throwIfNotFound =
      isOrThrow && (base === "findUnique" || base === "findFirst");

    // Validate through V1's own validator so arg errors are byte-identical
    // (it also runs `assertPortablePrimaryKeyUpdateInput`, a no-op for reads).
    this.args = validate<Record<string, unknown>>(
      engine.schemaRegistry,
      model,
      base as Operation,
      args
    );

    this.read = {
      id: "read",
      kind: "read",
      statement: this.buildReadSql(),
      outputs: { result: { kind: "rows" } },
    };
  }

  planning(): OperationFragment {
    // A read makes no decision — planning is empty (PLAN P4 item 1).
    return { steps: [], outputs: {} };
  }

  compile(_known: Readonly<Record<string, unknown>>): OperationFragment {
    return {
      steps: [this.read],
      outputs: { result: ref(this.read.id, "result") },
    };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    const rows = outputs.result;
    if (!Array.isArray(rows)) {
      throw new QueryEngineError(
        "query-engine-v2 read did not expose its result rows."
      );
    }
    const parsed = new ResultParser(
      this.engine.adapter,
      this.model,
      this.engine.driver
    ).parse<T>(this.base as Operation, rows, this.args);
    // A negative `take` on findMany selects from the end but is executed as a
    // reversed positive limit; the row order is restored here, exactly as V1.
    const ordered =
      this.base === "findMany" &&
      typeof this.args.take === "number" &&
      this.args.take < 0 &&
      Array.isArray(parsed)
        ? ([...parsed].reverse() as T)
        : parsed;
    if (this.throwIfNotFound && ordered === null) {
      // Byte-identical to V1's `PendingOperation` (`names.ts ?? "unknown"`, the
      // original `…OrThrow` operation name) — not the sql-name fallback.
      throw new NotFoundError(
        this.model["~"].names.ts ?? "unknown",
        this.requestedOperation
      );
    }
    return ordered;
  }

  private buildReadSql(): Sql {
    const ctx = createQueryScope(this.engine.adapter, this.model);
    const args = this.args;
    switch (this.base) {
      case "findUnique":
        return buildFindUnique(ctx, requireFindUniqueArgs(args));
      case "findFirst":
        return buildFind(ctx, args, { limit: 1 });
      case "findMany": {
        const take = args.take;
        if (take !== undefined && typeof take !== "number") {
          throw new QueryEngineError(
            "query-engine-v2 findMany received a non-numeric take value."
          );
        }
        return buildFind(ctx, args, { limit: take });
      }
      case "count":
      case "exist":
        return buildCount(ctx, args);
      case "aggregate":
        return buildAggregate(ctx, args);
      case "groupBy": {
        const by = args.by;
        if (typeof by !== "string" && !Array.isArray(by)) {
          throw new QueryEngineError(
            "query-engine-v2 groupBy is missing a valid by value."
          );
        }
        return buildGroupBy(ctx, { ...args, by });
      }
      default: {
        const exhaustive: never = this.base;
        throw new QueryEngineError(`Unknown read operation: ${exhaustive}`);
      }
    }
  }
}

function isReadBase(operation: string): operation is ReadBase {
  return (
    operation === "findUnique" ||
    operation === "findFirst" ||
    operation === "findMany" ||
    operation === "count" ||
    operation === "aggregate" ||
    operation === "groupBy" ||
    operation === "exist"
  );
}

function requireFindUniqueArgs(args: Record<string, unknown>): {
  where: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
} {
  if (!isRecord(args.where)) {
    throw new QueryEngineError(
      "query-engine-v2 findUnique is missing a where object."
    );
  }
  return {
    where: args.where,
    ...(isRecord(args.select) ? { select: args.select } : {}),
    ...(isRecord(args.include) ? { include: args.include } : {}),
  };
}

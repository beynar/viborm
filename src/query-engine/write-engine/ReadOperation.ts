// biome-ignore-all lint/style/useFilenamingConvention: ReadOperation is the architecture name.
import { NotFoundError, QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { createQueryScope } from "../context/query-scope";
import {
  buildAggregate,
  buildCount,
  buildFind,
  buildFindUnique,
  buildGroupBy,
} from "../operations";
import type { QueryEngine } from "../query-engine";
import {
  type CacheResultCodec,
  compileCacheResultCodec,
} from "../result/cache-result-codec";
import {
  parsePreparedResult,
  prepareResultRows,
  ResultParser,
} from "../result/ResultParser";
import type { CompiledRowParser } from "../result/result-row-parser";
import { buildExpectedResultShape } from "../result/result-shape";
import type { ExpectedResultShape, Operation } from "../types";
import { validate } from "../validator";
import {
  type OperationFragment,
  type PlanningFragment,
  type ReadStep,
  ref,
} from "./OperationFragment";
import { isRecord, selectExecutionMode } from "./shared";

type ExecutionMode = "transaction" | "batch";

/** The read operations the engine owns as one statement each. */
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
 * A read as a single read step. `find*`/`count`/`aggregate`/
 * `groupBy`/`exist` are genuinely single-statement operations: the compiled
 * fragment is EXACTLY ONE read step wrapping the same SQL the V1 read builders
 * produce (`buildFind`/`buildFindUnique`/`buildCount`/`buildAggregate`/
 * `buildGroupBy` — reused, never re-derived), parsed through the same
 * {@link ResultParser}. Planning is empty — a read makes no decision.
 *
 * A read that needed more than one step would not belong to this owner; none do,
 * so every read keeps the one-step boundary.
 *
 * `OrThrow` is not a postcondition: a `findUnique` returning `null` is a value,
 * not a violated invariant. The absence is surfaced from the *result* — matching
 * V1's exact error class and message (`No <model> record found for <operation>`,
 * carrying the original `…OrThrow` operation name).
 */
export class ReadOperation {
  readonly mode: ExecutionMode;

  get preparedResultRows(): this {
    return this;
  }

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly base: ReadBase;
  private readonly requestedOperation: string;
  private readonly throwIfNotFound: boolean;
  /**
   * The validated payload — also the cache flow's keying surface (see
   * {@link ExecutableOperation.validatedArgs}), which is why it is readable
   * rather than private.
   */
  readonly validatedArgs: Record<string, unknown>;
  private readonly expectedResultShape: ExpectedResultShape | undefined;
  private cacheResultCodec: CacheResultCodec | undefined;
  private readonly read: ReadStep;

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
      // Unreachable by construction: `constructOperation`
      // builds a `ReadOperation` only when `READ_OPERATIONS.has(operation)`, and stripping
      // the `OrThrow` suffix from that set yields exactly the seven `ReadBase` members. A
      // name outside `ROUTED_OPERATIONS` never reaches any operation constructor —
      // `constructRoutedOperation` returns `undefined` and the client answers "Unknown
      // operation". No public spelling reaches this line.
      throw new QueryEngineError(
        `query-engine-v2 internal: read construction reached '${requestedOperation}', which is not a read base; the routed read set admits only the read families.`
      );
    }
    this.base = base;
    // OrThrow only exists for findUnique/findFirst; other reads never throw on
    // an empty result (Prisma has no findManyOrThrow / countOrThrow).
    this.throwIfNotFound =
      isOrThrow && (base === "findUnique" || base === "findFirst");

    // Validate through V1's own validator so arg errors are byte-identical
    // (it also runs `assertPortablePrimaryKeyUpdateInput`, a no-op for reads).
    this.validatedArgs = validate<Record<string, unknown>>(
      engine.schemaRegistry,
      model,
      base as Operation,
      args
    );
    this.expectedResultShape = buildExpectedResultShape(
      this.model,
      this.base as Operation,
      this.validatedArgs,
      this.engine.relations
    );

    this.read = {
      id: "read",
      kind: "read",
      statement: this.buildReadSql(),
      outputs: { result: { kind: "rows" } },
    };
  }

  planning(): PlanningFragment {
    // A read makes no decision, so planning is empty.
    return { steps: [] };
  }

  compile(_known: Readonly<Record<string, unknown>>): OperationFragment {
    return {
      steps: [this.read],
      outputs: { result: ref(this.read.id, "result") },
    };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    const rows = this.resultRows(outputs);
    const parsed = new ResultParser(
      this.engine,
      this.model,
      this.engine.driver
    ).parse<T>(
      this.base as Operation,
      rows,
      this.validatedArgs,
      this.expectedResultShape
    );
    return this.finishParsedResult(parsed);
  }

  createResultParser(): ResultParser {
    return new ResultParser(this.engine, this.model, this.engine.driver);
  }

  createExpectedResultShape(): ExpectedResultShape | undefined {
    return this.expectedResultShape;
  }

  createCacheResultCodec(): CacheResultCodec {
    const shape = this.expectedResultShape;
    if (!shape) {
      throw new QueryEngineError(
        "query-engine-v2 read has no expected result shape for cache encoding."
      );
    }
    this.cacheResultCodec ??= compileCacheResultCodec(
      this.model,
      this.base as Operation,
      this.requestedOperation,
      shape
    );
    return this.cacheResultCodec;
  }

  compileResultRows(
    parser: ResultParser,
    shape: ExpectedResultShape | undefined
  ): CompiledRowParser | undefined {
    return shape
      ? prepareResultRows(parser, this.base as Operation, shape)
      : undefined;
  }

  parseResultWithProgram<T>(
    outputs: Readonly<Record<string, unknown>>,
    parser: ResultParser,
    shape: ExpectedResultShape | undefined,
    compiled: CompiledRowParser | undefined,
    consumableRows?: unknown[]
  ): T {
    const rows = this.resultRows(outputs);
    const parsed =
      compiled && shape
        ? parsePreparedResult<T>(
            parser,
            this.base as Operation,
            rows,
            this.validatedArgs,
            shape,
            compiled,
            consumableRows
          )
        : parser.parse<T>(
            this.base as Operation,
            rows,
            this.validatedArgs,
            shape
          );
    return this.finishParsedResult(parsed);
  }

  private resultRows(outputs: Readonly<Record<string, unknown>>): unknown[] {
    const rows = outputs.result;
    if (!Array.isArray(rows)) {
      throw new QueryEngineError(
        "query-engine-v2 read did not expose its result rows."
      );
    }
    return rows;
  }

  private finishParsedResult<T>(parsed: T): T {
    // A negative `take` on findMany selects from the end but is executed as a
    // reversed positive limit; the row order is restored here, exactly as V1.
    const ordered =
      this.base === "findMany" &&
      typeof this.validatedArgs.take === "number" &&
      this.validatedArgs.take < 0 &&
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
    const ctx = createQueryScope(this.engine, this.model);
    const args = this.validatedArgs;
    // biome-ignore lint/style/useDefaultSwitchClause: every arm returns and there is no trailing return — the switch's exhaustiveness is what makes this compile, so a default clause would turn a missing arm from a type error into a silent undefined.
    switch (this.base) {
      case "findUnique":
        return buildFindUnique(ctx, requireFindUniqueArgs(args));
      case "findFirst": {
        const take = args.take;
        if (take !== undefined && typeof take !== "number") {
          throw new QueryEngineError(
            "query-engine-v2 findFirst received a non-numeric take value."
          );
        }
        // Prisma parity: a negative take selects from the end of the window —
        // the signed unit limit makes buildFind flip the order while still
        // emitting LIMIT 1; take 0 is an empty window (LIMIT 0 → null).
        return buildFind(ctx, args, {
          limit: take === undefined ? 1 : Math.sign(take),
        });
      }
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

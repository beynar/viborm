import type { Operations } from "@client/types";
import type { QueryExecutionContext } from "@drivers/types";
import { NotFoundError } from "@errors";
import type { PreparedBatchOperation } from "../../types";
import {
  type ExecutionBinding,
  OperationContext,
} from "../shared/operation-context";
import type { Leaf, ProjectionShape, Read } from "../shared/query";
import { Queries } from "../shared/query";
import {
  type Arguments,
  type EngineConfig,
  EngineSchema,
  isReadOperation,
  type Operation,
} from "../shared/schema";
import { Commands } from "./commands";

/** The admitted operation an `…OrThrow` verb shares its whole envelope with. */
function admittedOperation(operation: Operations): Operation | undefined {
  switch (operation) {
    case "findUniqueOrThrow":
      return "findUnique";
    case "findFirstOrThrow":
      return "findFirst";
    case "create":
    case "createMany":
    case "update":
    case "upsert":
    case "updateMany":
    case "delete":
    case "deleteMany":
    case "findMany":
    case "findUnique":
    case "findFirst":
    case "count":
    case "exist":
    case "aggregate":
    case "groupBy":
      return operation;
    default:
      return undefined;
  }
}

/**
 * What a prepared read publishes before it runs.
 *
 * These are not a second statement of the read owner's decision — they are read
 * FROM it, by asking the prepared `Read` what it publishes for zero rows, so the
 * two cannot disagree for any verb.
 */
export interface PreparedRead {
  /**
   * The shape of the ROW the prepared statement decodes. For every verb whose
   * public value is the row (or the rows), this is the public value's shape too;
   * `count` and `exist` publish a value DERIVED from that row (`_count`), and
   * {@link PreparedRead.empty} is what tells a consumer which it is looking at.
   */
  readonly shape: ProjectionShape;
  /**
   * The PUBLIC value's own shape, which is not always the row shape: `count`
   * publishes a number and `exist` a boolean, and `findMany`/`groupBy` publish
   * a collection of rows.
   */
  readonly value: ProjectionShape | Leaf;
  /**
   * Does this read publish ONE row-like value rather than the row set? True for
   * `findUnique`, `findFirst`, `aggregate` and a selected `count`; false for
   * `findMany`, `groupBy`, a plain `count` (a number) and `exist` (a boolean).
   */
  readonly single: boolean;
  /**
   * The read owner's own publication for zero rows: `null` (a row), `[]` (the
   * set), `{}` (an aggregate record), `0` (`count`), `false` (`exist`). A cache
   * result codec reads the public value's kind here instead of assuming the row
   * shape is the value's shape — `count` publishes `3`, never `{_count: 3}`.
   */
  readonly empty: unknown;
}

/**
 * The published facts, forwarded from the prepared `Read` itself. The read owner
 * STATES the cardinality and the public value's shape beside the statement it
 * decodes (`Queries.read`), so nothing here re-derives either from behavior.
 */
function publishedFacts(value: Read): PreparedRead {
  return {
    shape: value.query.shape,
    value: value.value,
    single: value.single,
    empty: value.result([]),
  };
}

/**
 * One admitted operation, before any execution.
 *
 * The client lifecycle is admission-first by construction — a cache must key
 * before it can look up, and an interceptor must see the payload before it calls
 * `proceed()` — so admission, the prepared read shape and the cardinality are
 * published here, exactly once, and execution consumes that same construction
 * (g4/unit03/note.md B-1). Admission itself stays lazy, because the client's own
 * `PendingOperation` is lazy (LX-01).
 */
export interface PreparedOperation {
  /** The ONE admission of this input. */
  readonly args: Arguments;
  /** Present for read verbs: the one prepared read's published facts. */
  readonly read?: PreparedRead;
  execute(
    binding?: ExecutionBinding,
    attribution?: QueryExecutionContext
  ): Promise<unknown>;
  prepareBatch(
    attribution?: QueryExecutionContext
  ): Promise<PreparedBatchOperation<unknown> | undefined>;
}

export function createCommandEngine(config: EngineConfig) {
  const schema = new EngineSchema(config.schema, config.resolved);
  // One engine-lifetime query owner for the prepared read. The adapter is pinned
  // by identity across transaction scoping (`TransactionBoundDriver` copies
  // `baseDriver.adapter`), so the statement and shape prepared here are valid for
  // every binding of this driver's lineage.
  const queries = new Queries(schema, config.driver.adapter);
  const resolve = (operation: Operations): Operation => {
    const admitted = admittedOperation(operation);
    if (!admitted)
      throw new Error(
        `Raptor 3 G1 operation is not implemented: ${operation}`
      );
    return admitted;
  };
  const prepare = (
    modelName: string,
    requested: Operations,
    rawArgs: unknown
  ): PreparedOperation => {
    const operation = resolve(requested);
    const model = config.schema[modelName]!;
    let admitted: Arguments | undefined;
    let prepared: Read | undefined;
    let facts: PreparedRead | undefined;
    const args = (): Arguments =>
      (admitted ??= schema.admit(model, operation, rawArgs));
    const read = (): Read | undefined => {
      if (!isReadOperation(operation)) return undefined;
      return (prepared ??= queries.read(model, operation, args()));
    };
    const missing =
      requested === operation
        ? undefined
        : () =>
            new NotFoundError(model["~"].names.ts ?? "unknown", requested);
    const body = (context: OperationContext) => {
      const value = read();
      if (value) return context.run(() => context.publish(value, missing));
      // The physical form is constructed BEFORE the envelope decision and runs
      // once, whichever envelope the rule chooses.
      const plan = new Commands(context).plan(
        model,
        args(),
        rawArgs as Arguments
      );
      return context.run(plan.run, plan.single);
    };
    return {
      get args() {
        return args();
      },
      get read() {
        const value = read();
        if (!value) return undefined;
        return (facts ??= publishedFacts(value));
      },
      async execute(binding?, attribution?) {
        return body(
          new OperationContext(
            schema,
            config.driver,
            modelName,
            operation,
            binding,
            false,
            attribution
          )
        );
      },
      async prepareBatch(attribution?) {
        const context = new OperationContext(
          schema,
          config.driver,
          modelName,
          operation,
          undefined,
          true,
          attribution
        );
        try {
          await body(context);
        } catch (error) {
          if (context.isIncompletePreparation(error)) return undefined;
          throw error;
        }
        return context.preparedBatch();
      },
    };
  };
  return {
    prepare,
    async execute(
      modelName: string,
      operation: Operations,
      rawArgs: unknown,
      binding?: ExecutionBinding,
      attribution?: QueryExecutionContext
    ): Promise<unknown> {
      return prepare(modelName, operation, rawArgs).execute(
        binding,
        attribution
      );
    },
    async prepareBatch(
      modelName: string,
      operation: Operations,
      rawArgs: unknown,
      attribution?: QueryExecutionContext
    ): Promise<PreparedBatchOperation<unknown> | undefined> {
      return prepare(modelName, operation, rawArgs).prepareBatch(attribution);
    },
  };
}

/**
 * A driver whose database reads SurrealQL: `docs/architecture/query-backend-frontier.md`.
 * Not a package entry. {@link SurrealQueries} and {@link SurrealOperationContext}
 * write its statements, and it declares only what the engine asks of any driver.
 */

import { passThroughParseResult } from "@adapters/adapter-result-parser";
import type { EngineFacts } from "@adapters/database-adapter";
import {
  ForbiddenError,
  ForeignKeyError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
  VibORMErrorCode,
} from "@errors";
import type { Sql } from "@sql";
import {
  DateTime,
  Decimal,
  GeometryPoint,
  RecordId,
  SizedNumber,
  type Surreal,
  Uuid,
} from "surrealdb";
import { Driver, TransactionBoundDriver } from "../driver";
import { getExecutionTransactionPhases } from "../execution-context";
import type { TransactionOptionSupport, TransactionOptions } from "../shared";
import { createTransactionCleanupError } from "../shared/transactions";
import type { QueryExecutionContext, QueryResult } from "../types";
import { SurrealOperationContext } from "./operation-context";
import { SurrealQueries } from "./queries";
import { FORBIDDEN_ROW, isConflict, ReplayedTransaction } from "./transaction";

/** What the engine asks of any driver. */
const FACTS: EngineFacts = {
  namespace: undefined,
  // A point's statements are this driver's own: the fact is that it holds them.
  geoPoint: {},
  // A strategy `Commands` asks about, not syntax: `INSERT IGNORE` skips.
  mutations: { skipDuplicatesStrategy: "sql" },
  // A widened sum asks whether it travels in parts here, and it never does.
  aggregates: {},
  result: {
    nativeScalarPassthrough: true,
    parseResult: passThroughParseResult,
    parseRelation: (_value, next) => next(),
    parseField: (_value, _type, next) => next(),
  },
  capabilities: {
    supportsReturning: true,
    supportsCteWithMutations: false,
    supportsFullOuterJoin: false,
    supportsLateralJoins: false,
    supportsVector: true,
    supportsUpsertWhere: false,
    supportsTargetedUpsert: true,
    supportsMutationTargetInSubquery: false,
    supportsMutationRowLimit: false,
    supportsRowLocks: false,
  },
};

/** A provider value as the engine's decoders read it. */
function plain(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof RecordId) return plain(value.id);
  if (value instanceof GeometryPoint) return value.toJSON();
  if (value instanceof DateTime) return value.toISOString();
  if (value instanceof Decimal || value instanceof Uuid)
    return value.toString();
  if (value instanceof SizedNumber) return value.value;
  if (Array.isArray(value)) return value.map(plain);
  if (ArrayBuffer.isView(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, plain(member)])
    );
  }
  return value;
}

const UNIQUE_REFUSAL = /already contains|already exists/;
const REFERENCE_REFUSAL =
  /must conform to.*exists\(\)|ON (?:DELETE|UPDATE) REJECT/s;
const OUT_OF_RANGE =
  /Expected `(?:none \| )?i32` but found|must conform to.*math::abs|Cannot perform (?:addition|subtraction|multiplication) with/s;
const TOO_DEEP = /Exceeded (?:query|expression) recursion depth limit/;

/**
 * A provider failure in viborm's own words. Refusals carry no code here, so their
 * sentences are the only evidence.
 */
function refusal(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error : undefined;
  if (isConflict(error)) return new TransactionError(message, { cause });
  if (message.includes(FORBIDDEN_ROW))
    return new ForbiddenError("row", "write", { cause });
  if (UNIQUE_REFUSAL.test(message))
    return new UniqueConstraintError(`Unique constraint failed: ${message}`, {
      cause,
    });
  if (REFERENCE_REFUSAL.test(message))
    return new ForeignKeyError(message, { cause });
  if (OUT_OF_RANGE.test(message))
    return new QueryError(message, {
      cause,
      code: VibORMErrorCode.QUERY_OUT_OF_RANGE,
    });
  if (TOO_DEEP.test(message))
    return new UnsupportedOperationError(
      "This statement nests deeper than the SurrealDB server parses: raise its SURREAL_MAX_QUERY_PARSING_DEPTH, or read in two steps.",
      { cause }
    );
  return error;
}

/** SurrealQL names its parameters: `$p1`, as {@link SurrealDriver.execute} binds them. */
function namedStatement(query: Sql): string {
  return query.strings.reduce(
    (text, next, index) => `${text}$p${index}${next}`
  );
}

class SurrealTransactionDriver extends TransactionBoundDriver<
  Surreal,
  ReplayedTransaction
> {
  readonly replayed: ReplayedTransaction;

  constructor(
    base: Driver<Surreal, ReplayedTransaction>,
    tx: ReplayedTransaction,
    context?: QueryExecutionContext
  ) {
    super(base, tx, context);
    this.replayed = tx;
  }

  protected override buildStatement(query: Sql): string {
    return namedStatement(query);
  }

  protected override createTransactionBoundDriver(
    tx: ReplayedTransaction,
    context: QueryExecutionContext
  ): SurrealTransactionDriver {
    return new SurrealTransactionDriver(this, tx, context);
  }

  /** A nested scope is a savepoint, which the transaction keeps for itself. */
  protected override async transaction<T>(
    client: Surreal | ReplayedTransaction,
    fn: (tx: ReplayedTransaction) => Promise<T>
  ): Promise<T> {
    const tx = client as ReplayedTransaction;
    const mark = tx.mark;
    try {
      return await fn(tx);
    } catch (error) {
      await tx.rollbackTo(mark).catch((cleanup: unknown) => {
        throw createTransactionCleanupError(error, [cleanup]);
      });
      throw error;
    }
  }
}

const CALLBACK = "$transaction(callback)";

export interface SurrealDriverOptions {
  /**
   * How many more times a `$transaction` callback may run when a concurrent write
   * changed what it read, instead of failing with `V5001`. PostgreSQL would make it
   * wait, and running it again is the only way to give it the new value. Everything
   * the callback does outside the database happens again too, such as sending an
   * email, so this is off unless asked for.
   */
  readonly rerunsOnConflict?: number;
}

export class SurrealDriver extends Driver<Surreal, ReplayedTransaction> {
  readonly adapter = FACTS;
  override readonly backend = {
    queries: SurrealQueries,
    context: SurrealOperationContext,
  };
  readonly supportsTransactions = true;
  readonly supportsBatch = false;
  readonly supportsOrderedCommittedSegments = false;

  readonly #rerunsOnConflict: number;

  constructor(client: Surreal, options: SurrealDriverOptions = {}) {
    super("surrealql", "surrealdb");
    this.client = client;
    this.#rerunsOnConflict = options.rerunsOnConflict ?? 0;
  }

  /**
   * A caller's callback runs again only when asked. A conflict its statements can
   * replay never reaches here, and a coordinated extension has already collected
   * what the failed run wrote, so its callback does not run twice.
   */
  override async withTransaction<T>(
    fn: (txDriver: Driver<Surreal, ReplayedTransaction>) => Promise<T>,
    options?: TransactionOptions,
    context?: QueryExecutionContext
  ): Promise<T> {
    let reruns =
      context?.operation === CALLBACK && !getExecutionTransactionPhases(context)
        ? this.#rerunsOnConflict
        : 0;
    for (let run = 1; ; run++) {
      let replayed: ReplayedTransaction | undefined;
      try {
        return await super.withTransaction(
          (driver) => {
            ({ replayed } = driver as SurrealTransactionDriver);
            return fn(driver);
          },
          options,
          context
        );
      } catch (error) {
        // A refusal after the conflict hides it, so the transaction is who says.
        if (reruns-- === 0 || !replayed?.conflicted) throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * 20 * run)
      );
    }
  }

  protected override buildStatement(query: Sql): string {
    return namedStatement(query);
  }

  protected override createTransactionBoundDriver(
    tx: ReplayedTransaction,
    context: QueryExecutionContext
  ): SurrealTransactionDriver {
    return new SurrealTransactionDriver(this, tx, context);
  }

  protected async initClient(): Promise<Surreal> {
    return this.client as Surreal;
  }

  protected async closeClient(): Promise<void> {
    // The caller connected it and owns it.
  }

  protected async execute<T>(
    client: Surreal | ReplayedTransaction,
    statement: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const values = Object.fromEntries(
      params.map((value, index) => [`p${index + 1}`, value])
    );
    try {
      // The SDK's client answers the same call.
      const answers = await (client as ReplayedTransaction).query<unknown[]>(
        statement,
        values
      );
      // What a statement holds ahead of itself answers first.
      const result = answers.at(-1);
      const rows = Array.isArray(result) ? result : [];
      return { rows: plain(rows) as T[], rowCount: rows.length };
    } catch (error) {
      throw refusal(error);
    }
  }

  protected executeRaw<T>(
    client: Surreal | ReplayedTransaction,
    statement: string,
    params: unknown[] | undefined,
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.execute<T>(client, statement, params ?? []);
  }

  protected override transactionOptionSupport(): TransactionOptionSupport {
    const reason = "The SurrealDB prototype takes the server's own isolation.";
    return {
      isolationLevel: "unsupported",
      isolationLevelReason: reason,
      timeout: false,
      timeoutReason: reason,
      maxWait: "unsupported",
      maxWaitReason: reason,
    };
  }

  protected async transaction<T>(
    client: Surreal | ReplayedTransaction,
    fn: (tx: ReplayedTransaction) => Promise<T>
  ): Promise<T> {
    const transaction = await ReplayedTransaction.begin(client as Surreal);
    let result: T;
    try {
      result = await fn(transaction);
    } catch (error) {
      await transaction.cancel().catch(() => undefined);
      throw error;
    }
    try {
      await transaction.commit();
    } catch (error) {
      throw refusal(error);
    }
    return result;
  }
}

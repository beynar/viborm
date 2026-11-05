/**
 * PROTOTYPE, read-only: `docs/architecture/query-backend-frontier.md` step 4.
 * Not a package entry.
 *
 * Reads run through {@link SurrealReadBackend}, and this driver speaks no SQL:
 * see {@link noSqlAdapter}.
 */

import { passThroughParseResult } from "@adapters/adapter-result-parser";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import {
  ForeignKeyError,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
} from "@errors";
import type { Queries, ReadBackend } from "@query-engine/raptor3/shared/query";
import type { Sql } from "@sql";
import {
  DateTime,
  Decimal,
  GeometryPoint,
  RecordId,
  type Surreal,
  type SurrealTransaction,
  Uuid,
} from "surrealdb";
import { Driver, TransactionBoundDriver } from "../driver";
import type { TransactionOptionSupport } from "../shared";
import type { QueryExecutionContext, QueryResult } from "../types";
import { isConflict, SurrealOperationContext } from "./operation-context";
import { SurrealReadBackend } from "./read-backend";

/** What decoding a row and starting a client read of an adapter, and no more. */
const ROW_FACTS = {
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
} as unknown as DatabaseAdapter;

/**
 * The `adapter` a driver must still declare, holding the row facts alone. Every
 * other member is SQL syntax this database cannot read, so reaching for one
 * refuses, where a real adapter would write a statement that fails later.
 */
function noSqlAdapter(): DatabaseAdapter {
  return new Proxy(ROW_FACTS, {
    get(facts, member, receiver) {
      if (typeof member === "symbol" || member in facts)
        return Reflect.get(facts, member, receiver);
      throw new UnsupportedOperationError(
        `The SurrealDB driver speaks no SQL: nothing may read 'adapter.${member}'.`
      );
    },
  }) as DatabaseAdapter;
}

/** A provider value as the engine's decoders read it. */
function plain(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof RecordId) return plain(value.id);
  if (value instanceof GeometryPoint) return value.toJSON();
  if (value instanceof DateTime) return value.toISOString();
  if (value instanceof Decimal || value instanceof Uuid)
    return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (ArrayBuffer.isView(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) out[key] = plain(member);
    return out;
  }
  return value;
}

const UNIQUE_REFUSAL = /already contains|already exists/;
const REFERENCE_REFUSAL = /must conform to.*exists\(\)|ON DELETE REJECT/s;

/**
 * A provider failure in viborm's own words. Unique and foreign key refusals
 * carry no code here, so their sentences are the only evidence.
 */
function refusal(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error : undefined;
  if (isConflict(error)) return new TransactionError(message, { cause });
  if (UNIQUE_REFUSAL.test(message))
    return new UniqueConstraintError(message, { cause });
  if (REFERENCE_REFUSAL.test(message))
    return new ForeignKeyError(message, { cause });
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
  Surreal | SurrealTransaction
> {
  protected override buildStatement(query: Sql): string {
    return namedStatement(query);
  }

  protected override createTransactionBoundDriver(
    tx: Surreal | SurrealTransaction,
    context: QueryExecutionContext
  ): SurrealTransactionDriver {
    return new SurrealTransactionDriver(this, tx, context);
  }

  /**
   * SurrealDB has no savepoints, and one failed statement fails its whole
   * transaction, so a nested scope runs in the one it is in: a caller that
   * catches a failed write cannot continue that transaction.
   */
  protected override transaction<T>(
    client: Surreal | SurrealTransaction,
    fn: (tx: Surreal | SurrealTransaction) => Promise<T>
  ): Promise<T> {
    return fn(client);
  }
}

export class SurrealDriver extends Driver<
  Surreal,
  Surreal | SurrealTransaction
> {
  readonly adapter = noSqlAdapter();
  override readonly operationContext = SurrealOperationContext;
  readonly supportsTransactions = true;
  readonly supportsBatch = false;
  readonly supportsOrderedCommittedSegments = false;

  constructor(client: Surreal) {
    super("surrealql", "surrealdb");
    this.client = client;
  }

  override readBackend(queries: Queries): ReadBackend {
    return new SurrealReadBackend(queries);
  }

  protected override buildStatement(query: Sql): string {
    return namedStatement(query);
  }

  protected override createTransactionBoundDriver(
    tx: Surreal | SurrealTransaction,
    context: QueryExecutionContext
  ): SurrealTransactionDriver {
    return new SurrealTransactionDriver(
      this as unknown as Driver<Surreal, Surreal | SurrealTransaction>,
      tx,
      context
    );
  }

  protected async initClient(): Promise<Surreal> {
    return this.client as Surreal;
  }

  protected async closeClient(): Promise<void> {
    // The caller connected it and owns it.
  }

  protected async execute<T>(
    client: Surreal | SurrealTransaction,
    statement: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const values = Object.fromEntries(
      params.map((value, index) => [`p${index + 1}`, value])
    );
    try {
      const [result] = await client.query<[unknown]>(statement, values);
      const rows = Array.isArray(result) ? result : [];
      return { rows: plain(rows) as T[], rowCount: rows.length };
    } catch (error) {
      throw refusal(error);
    }
  }

  protected executeRaw<T>(
    client: Surreal | SurrealTransaction,
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
    client: Surreal | SurrealTransaction,
    fn: (tx: SurrealTransaction) => Promise<T>
  ): Promise<T> {
    if (!("beginTransaction" in client))
      throw new UnsupportedOperationError(
        "The SurrealDB driver has no savepoints: a transaction cannot nest."
      );
    const transaction = await client.beginTransaction();
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

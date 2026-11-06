/**
 * PROTOTYPE, read-only: `docs/architecture/query-backend-frontier.md` step 4.
 * Not a package entry.
 *
 * Reads run through {@link SurrealReadBackend}, and this driver speaks no SQL:
 * see {@link noSqlAdapter}.
 */

import { installAdapterInternals } from "@adapters/adapter-internals";
import { passThroughParseResult } from "@adapters/adapter-result-parser";
import { createNamedConstraintIdentities } from "@adapters/constraint-identity";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import {
  ForeignKeyError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
  VibORMErrorCode,
} from "@errors";
import type { Queries, ReadBackend } from "@query-engine/raptor3/shared/query";
import { type Sql, sql } from "@sql";
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
import type { TransactionOptionSupport } from "../shared";
import { createTransactionCleanupError } from "../shared/transactions";
import type { QueryExecutionContext, QueryResult } from "../types";
import { SurrealOperationContext } from "./operation-context";
import { SurrealReadBackend } from "./read-backend";
import { isConflict, ReplayedTransaction } from "./transaction";

/** What decoding a row and starting a client read of an adapter, and no more. */
const ROW_FACTS = {
  namespace: undefined,
  // Migrations probe a table with these, and they read the same in both languages.
  identifiers: {
    escape: sql.raw,
    table: sql.raw,
    aliased: (column: Sql, alias: string) =>
      sql`${column} AS ${sql.raw(alias)}`,
  },
  literals: {
    value: (value: unknown) => sql`${value}`,
    list: (values: readonly Sql[]) => sql`[${sql.join([...values], ", ")}]`,
  },
  operators: {
    notIn: (column: Sql, list: Sql) => sql`${column} NOT IN ${list}`,
  },
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

/** No SQL: only a refusal's constraint names are this adapter's to answer. */
installAdapterInternals(ROW_FACTS, {
  // A refusal here names no constraint, so no key is ever recognised by one.
  constraints: createNamedConstraintIdentities((table) => `${table}_pkey`),
  select: () => noSql("select"),
  batchRefs: {} as never,
});

function noSql(member: string): never {
  throw new UnsupportedOperationError(
    `The SurrealDB driver speaks no SQL: nothing may read 'adapter.${member}'.`
  );
}

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
      return noSql(member);
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
const TOO_DEEP = /Exceeded query recursion depth limit/;

/**
 * A provider failure in viborm's own words. Refusals carry no code here, so their
 * sentences are the only evidence.
 */
function refusal(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error : undefined;
  if (isConflict(error)) return new TransactionError(message, { cause });
  if (UNIQUE_REFUSAL.test(message))
    return new UniqueConstraintError(message, { cause });
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

export class SurrealDriver extends Driver<Surreal, ReplayedTransaction> {
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
      const [result] = await (client as ReplayedTransaction).query<[unknown]>(
        statement,
        values
      );
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

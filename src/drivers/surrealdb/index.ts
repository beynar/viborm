/**
 * PROTOTYPE, read-only: `docs/architecture/query-backend-frontier.md` step 4.
 * Not a package entry.
 *
 * Reads run through {@link SurrealReadBackend}, and this driver speaks no SQL:
 * see {@link noSqlAdapter}.
 */

import { passThroughParseResult } from "@adapters/adapter-result-parser";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { UnsupportedOperationError } from "@errors";
import type { Queries, ReadBackend } from "@query-engine/raptor3/shared/query";
import type { Sql } from "@sql";
import { DateTime, Decimal, RecordId, type Surreal, Uuid } from "surrealdb";
import { Driver } from "../driver";
import {
  type TransactionOptionSupport,
  unsupportedCallbackTransactionError,
} from "../shared";
import type { QueryExecutionContext, QueryResult } from "../types";
import { SurrealReadBackend } from "./read-backend";

/** What decoding a row and starting a client read of an adapter, and no more. */
const ROW_FACTS: Pick<
  DatabaseAdapter,
  "result" | "capabilities" | "namespace" | "geoPoint"
> = {
  namespace: undefined,
  geoPoint: undefined,
  result: {
    nativeScalarPassthrough: true,
    parseResult: passThroughParseResult,
    parseRelation: (_value, next) => next(),
    parseField: (_value, _type, next) => next(),
  },
  capabilities: {
    supportsReturning: false,
    supportsCteWithMutations: false,
    supportsFullOuterJoin: false,
    supportsLateralJoins: false,
    supportsVector: false,
    supportsUpsertWhere: false,
    supportsTargetedUpsert: false,
    supportsMutationTargetInSubquery: false,
    supportsMutationRowLimit: false,
    supportsRowLocks: false,
  },
};

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
  if (value instanceof RecordId) return value.id;
  if (value instanceof DateTime) return value.toISOString();
  if (value instanceof Decimal || value instanceof Uuid)
    return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) out[key] = plain(member);
    return out;
  }
  return value;
}

export class SurrealDriver extends Driver<Surreal, Surreal> {
  readonly adapter = noSqlAdapter();
  readonly supportsTransactions = false;
  readonly supportsBatch = false;
  readonly supportsOrderedCommittedSegments = false;

  constructor(client: Surreal) {
    super("surrealql", "surrealdb");
    this.client = client;
  }

  override readBackend(queries: Queries): ReadBackend {
    return new SurrealReadBackend(queries);
  }

  /** SurrealQL names its parameters: `$p1`, as {@link execute} binds them. */
  protected override buildStatement(query: Sql): string {
    return query.strings.reduce(
      (text, next, index) => `${text}$p${index}${next}`
    );
  }

  protected async initClient(): Promise<Surreal> {
    return this.client!;
  }

  protected async closeClient(): Promise<void> {
    // The caller connected it and owns it.
  }

  protected async execute<T>(
    client: Surreal,
    statement: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const values = Object.fromEntries(
      params.map((value, index) => [`p${index + 1}`, value])
    );
    const [rows] = await client.query<[unknown[]]>(statement, values);
    return { rows: plain(rows) as T[], rowCount: rows.length };
  }

  protected executeRaw<T>(
    client: Surreal,
    statement: string,
    params: unknown[] | undefined,
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.execute<T>(client, statement, params ?? []);
  }

  protected override transactionOptionSupport(): TransactionOptionSupport {
    const reason = "The SurrealDB prototype reads and opens no transaction.";
    return {
      isolationLevel: "unsupported",
      isolationLevelReason: reason,
      timeout: false,
      timeoutReason: reason,
      maxWait: "unsupported",
      maxWaitReason: reason,
    };
  }

  protected transaction<T>(): Promise<T> {
    return Promise.reject(unsupportedCallbackTransactionError(this.driverName));
  }
}

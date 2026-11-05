/**
 * PROTOTYPE, read-only: `docs/architecture/query-backend-frontier.md` step 4.
 * Not a package entry.
 *
 * Reads run through {@link SurrealReadBackend}. The PostgreSQL adapter is here
 * only because a driver must declare one and the engine decodes rows through it:
 * nothing it spells reaches this database, and it is the next coupling to cut.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import type { Queries, ReadBackend } from "@query-engine/raptor3/shared/query";
import { DateTime, Decimal, RecordId, type Surreal, Uuid } from "surrealdb";
import { Driver } from "../driver";
import {
  type TransactionOptionSupport,
  unsupportedCallbackTransactionError,
} from "../shared";
import type { QueryExecutionContext, QueryResult } from "../types";
import { SurrealReadBackend } from "./read-backend";

const POSITIONAL = /\$(\d+)\b/g;

/** A provider value as the engine's decoders read a PostgreSQL one. */
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
  readonly adapter: DatabaseAdapter = new PostgresAdapter();
  readonly supportsTransactions = false;
  readonly supportsBatch = false;
  readonly supportsOrderedCommittedSegments = false;

  constructor(client: Surreal) {
    super("postgresql", "surrealdb");
    this.client = client;
  }

  override readBackend(queries: Queries): ReadBackend {
    return new SurrealReadBackend(queries);
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
    const text = statement.replace(POSITIONAL, (_, at) => `$p${at}`);
    const values = Object.fromEntries(
      params.map((value, index) => [`p${index + 1}`, value])
    );
    const [rows] = await client.query<[unknown[]]>(text, values);
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

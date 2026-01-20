/**
 * Cloudflare D1 HTTP Driver
 *
 * Driver implementation for Cloudflare D1 using the REST API.
 * Note: D1 HTTP API does not support transactions.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import { Driver, type DriverResultParser } from "../driver";
import { convertValuesForSQLite, sqliteResultParser } from "../shared";
import type { BatchQuery, QueryResult, TransactionOptions } from "../types";

// ============================================================
// TYPE DECLARATIONS FOR D1 HTTP API
// ============================================================

interface D1HTTPResponse<T = unknown> {
  result: Array<{
    results: T[];
    success: boolean;
    meta: {
      duration: number;
      changes: number;
      last_row_id: number;
      rows_read: number;
      rows_written: number;
    };
  }>;
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
}

interface D1HTTPClient {
  accountId: string;
  databaseId: string;
  apiToken: string;
  baseUrl: string;
}

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface D1HTTPDriverOptions {
  accountId: string;
  databaseId: string;
  apiToken: string;
  baseUrl?: string;
}

export type D1HTTPClientConfig<C extends DriverConfig> = D1HTTPDriverOptions &
  C;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class D1HTTPDriver extends Driver<D1HTTPClient, D1HTTPClient> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly result: DriverResultParser = sqliteResultParser;
  readonly supportsTransactions = false;
  readonly supportsBatch = true;

  private readonly driverOptions: D1HTTPDriverOptions;

  constructor(options: D1HTTPDriverOptions) {
    super("sqlite", "d1-http");
    this.driverOptions = options;
  }

  protected async initClient(): Promise<D1HTTPClient> {
    return {
      accountId: this.driverOptions.accountId,
      databaseId: this.driverOptions.databaseId,
      apiToken: this.driverOptions.apiToken,
      baseUrl:
        this.driverOptions.baseUrl ?? "https://api.cloudflare.com/client/v4",
    };
  }

  protected async closeClient(_client: D1HTTPClient): Promise<void> {
    // HTTP client doesn't need to be closed
  }

  private async executeQuery<T>(
    client: D1HTTPClient,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const url = `${client.baseUrl}/accounts/${client.accountId}/d1/database/${client.databaseId}/query`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sql,
        params,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`D1 HTTP API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as D1HTTPResponse<T>;

    if (!data.success) {
      const errorMsg = data.errors.map((e) => e.message).join(", ");
      throw new Error(`D1 query failed: ${errorMsg}`);
    }

    const result = data.result[0];
    if (!result) {
      return { rows: [], rowCount: 0 };
    }

    return {
      rows: result.results,
      rowCount: result.meta.changes || result.results.length,
    };
  }

  protected async execute<T>(
    client: D1HTTPClient,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const values = convertValuesForSQLite(params);
    return this.executeQuery<T>(client, sql, values);
  }

  protected async executeRaw<T>(
    client: D1HTTPClient,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const values = params ? convertValuesForSQLite(params) : [];
    return this.executeQuery<T>(client, sql, values);
  }

  protected async transaction<T>(
    client: D1HTTPClient,
    fn: (tx: D1HTTPClient) => Promise<T>,
    _options?: TransactionOptions
  ): Promise<T> {
    // D1 HTTP API does not support transactions
    console.warn(
      "D1 HTTP API does not support transactions. Operations will execute without transaction isolation."
    );
    return fn(client);
  }

  /**
   * Execute multiple queries atomically using D1 HTTP API batch endpoint.
   * The API accepts an array of queries in the request body.
   */
  protected async executeBatch<T>(
    client: D1HTTPClient,
    queries: BatchQuery[]
  ): Promise<Array<QueryResult<T>>> {
    const url = `${client.baseUrl}/accounts/${client.accountId}/d1/database/${client.databaseId}/query`;

    // Format queries for the batch API
    const body = queries.map((query) => ({
      sql: query.sql,
      params: query.params ? convertValuesForSQLite(query.params) : [],
    }));

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`D1 HTTP API batch error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as D1HTTPResponse<T>;

    if (!data.success) {
      const errorMsg = data.errors.map((e) => e.message).join(", ");
      throw new Error(`D1 batch query failed: ${errorMsg}`);
    }

    // Map results to QueryResult format
    return data.result.map((result) => ({
      rows: result.results,
      rowCount: result.meta.changes || result.results.length,
    }));
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<C extends DriverConfig>(
  config: D1HTTPClientConfig<C>
) {
  const { accountId, databaseId, apiToken, baseUrl, ...restConfig } = config;

  const driver = new D1HTTPDriver({
    accountId,
    databaseId,
    apiToken,
    baseUrl,
  });

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: D1HTTPDriver }>;
}

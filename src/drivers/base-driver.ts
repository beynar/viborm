/**
 * Base Driver with Lazy Initialization
 *
 * Provides a common pattern for drivers that need lazy client initialization.
 * Handles race conditions between init and disconnect gracefully.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import type { Sql } from "@sql";
import type { Driver, DriverResultParser } from "./driver";
import type { Dialect, QueryResult, TransactionOptions } from "./types";

/**
 * Abstract base class for drivers with lazy client initialization.
 *
 * Subclasses must implement:
 * - `initClient()`: Creates the database client
 * - `closeClient()`: Closes the database client
 * - `executeWithClient()`: Executes a query with the client
 * - `executeRawWithClient()`: Executes raw SQL with the client
 * - `transactionWithClient()`: Runs a transaction with the client
 *
 * @example
 * ```ts
 * class MyDriver extends LazyDriver<MyClient> {
 *   readonly dialect = "postgresql";
 *   readonly adapter = new PostgresAdapter();
 *
 *   protected async initClient() {
 *     return new MyClient(this.options);
 *   }
 *
 *   protected async closeClient(client: MyClient) {
 *     await client.end();
 *   }
 *
 *   protected async executeWithClient<T>(client: MyClient, query: Sql) {
 *     return client.query(query);
 *   }
 *   // ...
 * }
 * ```
 */
export abstract class LazyDriver<TClient> implements Driver {
  abstract readonly dialect: Dialect;
  abstract readonly adapter: DatabaseAdapter;

  /**
   * Optional result parser for driver-specific parsing
   */
  readonly result?: DriverResultParser;

  /**
   * The initialized client instance (null until first query)
   */
  protected client: TClient | null = null;

  /**
   * Promise tracking ongoing initialization
   */
  private initPromise: Promise<TClient> | null = null;

  /**
   * Flag to prevent new queries during disconnect
   */
  private isDisconnecting = false;

  /**
   * Get or initialize the client.
   *
   * Thread-safe: concurrent calls will share the same init promise.
   * Will throw if called during/after disconnect.
   */
  protected async getClient(): Promise<TClient> {
    if (this.isDisconnecting) {
      throw new Error("Driver is disconnecting");
    }

    // Fast path: client already initialized
    if (this.client) return this.client;

    // Lazy init: create promise if not exists
    if (!this.initPromise) {
      this.initPromise = this.initClient().then((client) => {
        this.client = client;
        return client;
      });
    }

    return this.initPromise;
  }

  /**
   * Initialize the database client.
   * Called once on first query. Must be implemented by subclasses.
   */
  protected abstract initClient(): Promise<TClient>;

  /**
   * Close the database client.
   * Called during disconnect. Must be implemented by subclasses.
   */
  protected abstract closeClient(client: TClient): Promise<void>;

  /**
   * Execute a query with the client.
   * Must be implemented by subclasses.
   */
  protected abstract executeWithClient<T>(
    client: TClient,
    query: Sql
  ): Promise<QueryResult<T>>;

  /**
   * Execute raw SQL with the client.
   * Must be implemented by subclasses.
   */
  protected abstract executeRawWithClient<T>(
    client: TClient,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;

  /**
   * Run a transaction with the client.
   * Must be implemented by subclasses.
   */
  protected abstract transactionWithClient<T>(
    client: TClient,
    fn: (tx: Driver) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T>;

  // ============================================================
  // PUBLIC API (implements Driver interface)
  // ============================================================

  async execute<T = Record<string, unknown>>(
    query: Sql
  ): Promise<QueryResult<T>> {
    const client = await this.getClient();
    return this.executeWithClient<T>(client, query);
  }

  async executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const client = await this.getClient();
    return this.executeRawWithClient<T>(client, sql, params);
  }

  async transaction<T>(
    fn: (tx: Driver) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const client = await this.getClient();
    return this.transactionWithClient(client, fn, options);
  }

  async disconnect(): Promise<void> {
    // Prevent new queries
    this.isDisconnecting = true;

    // Wait for any pending init to complete (don't leave dangling promises)
    if (this.initPromise) {
      try {
        await this.initPromise;
      } catch {
        // Ignore init errors during disconnect
      }
    }

    // Close the client if it was initialized
    if (this.client) {
      await this.closeClient(this.client);
    }

    // Reset state
    this.client = null;
    this.initPromise = null;
    this.isDisconnecting = false;
  }
}

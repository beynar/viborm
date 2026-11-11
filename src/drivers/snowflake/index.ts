/**
 * `viborm/snowflake`: read a Snowflake warehouse through its SQL API v2.
 *
 * VibORM only READS Snowflake. `findMany`, `findFirst`, `findUnique` (and their
 * `OrThrow` forms) with nested `include`/`select`, `count`, `exist`,
 * `aggregate`, `groupBy` and `$queryRaw` run; every write — `create`,
 * `update`, `delete`, `upsert`, the `Many` forms, nested writes,
 * `$executeRaw` — and every migration command is refused with a
 * `FeatureNotSupportedError` before anything is sent (`read-only.ts` says
 * why). There is no transaction either: the SQL API runs each statement on
 * its own.
 *
 * The transport is `fetch` and the signature WebCrypto, so the driver runs in
 * Node, Bun, Cloudflare Workers and Durable Objects without `snowflake-sdk`.
 */

import {
  createClientFromDriverConfig,
  type DriverConfig,
  type LinkedClientConfig,
  type NoExtraDriverConfigKeys,
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import { SnowflakeAdapter } from "@adapters/databases/snowflake/snowflake-adapter";
import {
  ClientInitializationError,
  isVibORMError,
  QueryError,
  type QueryErrorCode,
  VibORMErrorCode,
} from "@errors";
import { queryBackend } from "@query-engine/raptor3/shared/query-backend";
import { Driver, type QueryExecutionContext } from "../driver";
import type { TransactionOptionSupport } from "../shared";
import {
  defineImmutableDriverFact,
  refuseUnknownDriverConfigKeys,
} from "../shared/driver-options";
import { unsupportedCallbackTransactionError } from "../shared/transactions";
import type { QueryResult } from "../types";
import { SnowflakeAuthenticator, type SnowflakeTokenType } from "./auth";
import { SnowflakeQueries } from "./queries";
import {
  isRawWrite,
  readOnlyRefusal,
  SnowflakeOperationContext,
} from "./read-only";
import {
  SnowflakeApiError,
  type SnowflakeContext,
  SnowflakeTransport,
} from "./transport";
import { decodeRow, encodeBindings } from "./values";

export interface SnowflakeDriverOptions {
  /**
   * `snowflake://USER@ACCOUNT/DATABASE/SCHEMA?warehouse=WH&role=ROLE`. The key
   * or token is passed beside it, never in it. A field given beside the URL
   * takes precedence over the URL's.
   */
  readonly databaseUrl?: string;
  /** The account identifier: `ORGNAME-ACCOUNTNAME`, or a locator (`xy12345.us-east-1`). */
  readonly account?: string;
  readonly username?: string;
  /** The RSA private key of key-pair authentication: PKCS#8 or PKCS#1 PEM, unencrypted, or an imported `CryptoKey`. */
  readonly privateKey?: string | CryptoKey;
  /** An OAuth (or programmatic access) token, or a function answering a fresh one. */
  readonly token?: string | (() => string | Promise<string>);
  readonly tokenType?: Exclude<SnowflakeTokenType, "KEYPAIR_JWT">;
  readonly warehouse?: string;
  readonly database?: string;
  /**
   * The Snowflake schema every statement runs in, and the one VibORM
   * qualifies its tables with (the adapter's namespace), spelled as the
   * catalog spells it (usually upper case).
   */
  readonly namespace?: string;
  readonly role?: string;
  /** Seconds a statement may run before Snowflake and the driver stop it. */
  readonly timeout?: number;
  /** Where the API lives, when not `https://<account>.snowflakecomputing.com`. */
  readonly host?: string;
  /** The `fetch` to send with: a Worker's, a proxy's, a test's. */
  readonly fetch?: typeof fetch;
  /** Session parameters added to every statement's. `TIMEZONE` stays UTC. */
  readonly parameters?: Readonly<Record<string, string>>;
}

export type SnowflakeClientConfig<C extends DriverConfig> =
  SnowflakeDriverOptions & C;

const SNOWFLAKE_CONFIG_KEYS: Record<keyof SnowflakeDriverOptions, true> = {
  databaseUrl: true,
  account: true,
  username: true,
  privateKey: true,
  token: true,
  tokenType: true,
  warehouse: true,
  database: true,
  namespace: true,
  role: true,
  timeout: true,
  host: true,
  fetch: true,
  parameters: true,
};

/**
 * The session every statement runs in. A `TIMESTAMP_NTZ` is read as UTC, and
 * the database compares it with an instant the same way only in a UTC
 * session; the result format is the JSON the driver decodes.
 */
const SESSION = {
  TIMEZONE: "UTC",
} as const;

function configuration(message: string): ClientInitializationError {
  return new ClientInitializationError(message, {
    meta: { driver: "snowflake", operation: "configuration" },
  });
}

/** The fields a `snowflake://` URL names. */
export function parseSnowflakeUrl(url: string): SnowflakeDriverOptions {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw configuration("The Snowflake databaseUrl is not a URL.");
  }
  if (parsed.protocol !== "snowflake:")
    throw configuration(
      `A Snowflake databaseUrl starts with snowflake://, not ${parsed.protocol}//.`
    );
  if (parsed.password)
    throw configuration(
      "A Snowflake databaseUrl carries no secret: pass privateKey or token beside it."
    );
  const [database, schema, extra] = parsed.pathname
    .split("/")
    .filter((part) => part.length > 0)
    .map(decodeURIComponent);
  if (extra !== undefined)
    throw configuration(
      "A Snowflake databaseUrl names at most /DATABASE/SCHEMA."
    );
  const query = (name: string) => parsed.searchParams.get(name) ?? undefined;
  return {
    account: decodeURIComponent(parsed.hostname),
    ...(parsed.username
      ? { username: decodeURIComponent(parsed.username) }
      : {}),
    ...(database ? { database } : {}),
    ...(schema ? { namespace: schema } : {}),
    ...(query("warehouse") ? { warehouse: query("warehouse") } : {}),
    ...(query("role") ? { role: query("role") } : {}),
    ...(query("host") ? { host: query("host") } : {}),
  };
}

/** Snowflake's failure in VibORM's words; a VibORM error passes as it is. */
export function snowflakeFailure(error: unknown): unknown {
  if (isVibORMError(error) || !(error instanceof SnowflakeApiError))
    return error;
  const meta = {
    driver: "snowflake",
    providerCode: error.code,
    sqlState: error.sqlstate,
    statementHandle: error.statementHandle,
    status: error.status,
  };
  // 390xxx: authentication and session; 000606: no warehouse is running.
  if (error.code?.startsWith("390") || error.code === "000606")
    return new ClientInitializationError(
      `Snowflake refused the session: ${error.message}`,
      { cause: error, meta }
    );
  let code: QueryErrorCode = VibORMErrorCode.QUERY_FAILED;
  if (
    error.code === "000630" ||
    error.code === "000604" ||
    error.sqlstate === "57014"
  )
    code = VibORMErrorCode.QUERY_TIMEOUT;
  else if (
    error.code === "002003" ||
    error.code === "000904" ||
    error.sqlstate === "42S02" ||
    error.sqlstate === "42S22"
  )
    code = VibORMErrorCode.QUERY_SCHEMA_MISMATCH;
  else if (error.code === "001003") code = VibORMErrorCode.QUERY_SYNTAX;
  else if (error.sqlstate === "22003") code = VibORMErrorCode.QUERY_OUT_OF_RANGE;
  return new QueryError(`Snowflake refused the statement: ${error.message}`, {
    cause: error,
    code,
    meta,
  });
}

export class SnowflakeDriver extends Driver<
  SnowflakeTransport,
  SnowflakeTransport
> {
  declare readonly adapter: SnowflakeAdapter;
  override readonly backend = queryBackend({
    queries: SnowflakeQueries,
    context: SnowflakeOperationContext,
  });
  // The SQL API runs each statement on its own: there is nothing to hold a
  // transaction open across two, and a read needs none.
  readonly supportsTransactions = false;
  readonly supportsBatch = false;
  readonly supportsOrderedCommittedSegments = false;

  readonly #options: SnowflakeDriverOptions;
  readonly #context: SnowflakeContext;

  constructor(options: SnowflakeDriverOptions = {}) {
    super("snowflake", "snowflake");
    const fromUrl = options.databaseUrl
      ? parseSnowflakeUrl(options.databaseUrl)
      : {};
    const resolved: SnowflakeDriverOptions = {
      ...options,
      account: options.account ?? fromUrl.account,
      username: options.username ?? fromUrl.username,
      warehouse: options.warehouse ?? fromUrl.warehouse,
      database: options.database ?? fromUrl.database,
      namespace: options.namespace ?? fromUrl.namespace,
      role: options.role ?? fromUrl.role,
      host: options.host ?? fromUrl.host,
    };
    if (!resolved.account)
      throw configuration(
        "Snowflake needs an account (ORGNAME-ACCOUNTNAME), or a databaseUrl naming one."
      );
    if (
      resolved.timeout !== undefined &&
      !(Number.isSafeInteger(resolved.timeout) && resolved.timeout > 0)
    )
      throw configuration(
        "The Snowflake timeout is a positive whole number of seconds."
      );
    this.#options = resolved;
    this.#context = {
      ...(resolved.warehouse ? { warehouse: resolved.warehouse } : {}),
      ...(resolved.database ? { database: resolved.database } : {}),
      ...(resolved.namespace ? { schema: resolved.namespace } : {}),
      ...(resolved.role ? { role: resolved.role } : {}),
    };
    defineImmutableDriverFact(
      this,
      "adapter",
      new SnowflakeAdapter(resolved.namespace)
    );
  }

  protected async initClient(): Promise<SnowflakeTransport> {
    const options = this.#options;
    const account = options.account!;
    // Throws a configuration error for a missing or double credential, before
    // any request.
    const authenticator = new SnowflakeAuthenticator({
      account,
      ...(options.username ? { username: options.username } : {}),
      ...(options.privateKey ? { privateKey: options.privateKey } : {}),
      ...(options.token ? { token: options.token } : {}),
      ...(options.tokenType ? { tokenType: options.tokenType } : {}),
    });
    const send = options.fetch ?? globalThis.fetch;
    if (typeof send !== "function")
      throw configuration(
        "This runtime has no fetch: pass one as the Snowflake driver's fetch option."
      );
    return new SnowflakeTransport({
      baseUrl: (
        options.host ?? `https://${account.toLowerCase()}.snowflakecomputing.com`
      ).replace(/\/+$/, ""),
      authenticator,
      context: this.#context,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      parameters: { ...options.parameters, ...SESSION },
      // A Worker's fetch must be called unbound from the global.
      fetch: (input, init) => send(input, init),
    });
  }

  protected async closeClient(): Promise<void> {
    // HTTP keeps nothing open.
  }

  protected execute<T>(
    client: SnowflakeTransport,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.#run<T>(client, statement, params, context);
  }

  protected executeRaw<T>(
    client: SnowflakeTransport,
    statement: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.#run<T>(client, statement, params ?? [], context);
  }

  async #run<T>(
    client: SnowflakeTransport,
    statement: string,
    params: readonly unknown[],
    context: QueryExecutionContext | undefined
  ): Promise<QueryResult<T>> {
    if (isRawWrite(context?.operation))
      throw readOnlyRefusal(context!.operation!);
    try {
      const result = await client.run(statement, encodeBindings(params));
      const rows = result.rows.map((row) => decodeRow<T>(result.columns, row));
      return { rows, rowCount: rows.length };
    } catch (error) {
      throw snowflakeFailure(error);
    }
  }

  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "unsupported",
      isolationLevelReason:
        "the Snowflake SQL API runs each statement on its own",
      timeout: false,
      timeoutReason: "the Snowflake SQL API runs each statement on its own",
      maxWait: "unsupported",
      maxWaitReason: "the Snowflake SQL API runs each statement on its own",
    };
  }

  protected transaction<T>(): Promise<T> {
    return Promise.reject(unsupportedCallbackTransactionError(this.driverName));
  }
}

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: SnowflakeClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, SnowflakeDriverOptions, S>
): VibORMClient<{
  [P in keyof LinkedClientConfig<
    C & { driver: SnowflakeDriver }
  >]: LinkedClientConfig<C & { driver: SnowflakeDriver }>[P];
}> {
  refuseUnknownDriverConfigKeys(config, "snowflake", SNOWFLAKE_CONFIG_KEYS);
  const {
    databaseUrl,
    account,
    username,
    privateKey,
    token,
    tokenType,
    warehouse,
    database,
    namespace,
    role,
    timeout,
    host,
    fetch,
    parameters,
  } = config;
  return createClientFromDriverConfig<S, C, SnowflakeDriver>(
    config,
    new SnowflakeDriver({
      databaseUrl,
      account,
      username,
      privateKey,
      token,
      tokenType,
      warehouse,
      database,
      namespace,
      role,
      timeout,
      host,
      fetch,
      parameters,
    })
  );
}

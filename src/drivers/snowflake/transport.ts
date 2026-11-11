/**
 * Snowflake's SQL API v2 over `fetch`: one statement per request, so it runs
 * wherever `fetch` and WebCrypto do (Node, Bun, Workers, Durable Objects).
 *
 * docs.snowflake.com/en/developer-guide/sql-api:
 *
 * - `POST /api/v2/statements?requestId=<uuid>` runs a statement with its
 *   context (warehouse, database, schema, role) and typed bindings. It answers
 *   200 with the first partition of the result, 202 while it still runs, or
 *   422 with the failure;
 * - `GET /api/v2/statements/<handle>` is asked until a 202 becomes 200 or 422
 *   (429 also means "still running");
 * - `GET /api/v2/statements/<handle>?partition=<n>` reads partition n > 0;
 * - `POST /api/v2/statements/<handle>/cancel` stops a statement this driver
 *   no longer waits for.
 *
 * A request that failed before Snowflake answered (a network error, 429 on
 * submission, 502/503/504) is sent again with the same `requestId` and
 * `retry=true`, which Snowflake runs at most once.
 */

import {
  ClientInitializationError,
  ConnectionError,
  QueryError,
  VibORMErrorCode,
} from "@errors";
import type { SnowflakeAuthenticator } from "./auth";
import type { SnowflakeBinding, SnowflakeColumn } from "./values";

export interface SnowflakeContext {
  readonly warehouse?: string;
  readonly database?: string;
  readonly schema?: string;
  readonly role?: string;
}

export interface SnowflakeTransportOptions {
  /** `https://<account>.snowflakecomputing.com`, without a trailing slash. */
  readonly baseUrl: string;
  readonly authenticator: SnowflakeAuthenticator;
  readonly context: SnowflakeContext;
  /** Seconds a statement may run, server-side and client-side. */
  readonly timeout?: number;
  /** Session parameters every statement runs with. */
  readonly parameters: Readonly<Record<string, string>>;
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** First poll delay; doubles up to {@link MAX_POLL_MS}. */
  readonly pollIntervalMs?: number;
  /** Partitions read at once. */
  readonly partitionConcurrency?: number;
  /** Sends of one request before its failure is final. */
  readonly attempts?: number;
  readonly userAgent?: string;
}

export interface StatementResult {
  readonly columns: readonly SnowflakeColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly handle: string;
}

interface ResultSetBody {
  readonly statementHandle?: string;
  readonly statementStatusUrl?: string;
  readonly code?: string;
  readonly sqlState?: string;
  readonly message?: string;
  readonly data?: unknown[][];
  readonly resultSetMetaData?: {
    readonly numRows?: number;
    readonly rowType?: SnowflakeColumn[];
    readonly partitionInfo?: unknown[];
  };
}

const MAX_POLL_MS = 2000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** A failure Snowflake answered, as the error mapping reads it. */
export class SnowflakeApiError extends Error {
  readonly code: string | undefined;
  readonly sqlstate: string | undefined;
  readonly status: number;
  readonly statementHandle: string | undefined;
  constructor(
    status: number,
    body: ResultSetBody | undefined,
    fallback: string
  ) {
    super(body?.message ?? fallback);
    this.name = "SnowflakeApiError";
    this.status = status;
    this.code = body?.code;
    this.sqlstate = body?.sqlState;
    this.statementHandle = body?.statementHandle;
  }
}

function malformedResult(reason: string): QueryError {
  return new QueryError(
    `Snowflake answered a result VibORM cannot read: ${reason}.`,
    {
      code: VibORMErrorCode.QUERY_RESULT_INVALID,
      meta: { driver: "snowflake" },
    }
  );
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

async function readBody(
  response: Response
): Promise<ResultSetBody | undefined> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as ResultSetBody;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

export class SnowflakeTransport {
  readonly #options: SnowflakeTransportOptions;

  constructor(options: SnowflakeTransportOptions) {
    this.#options = options;
  }

  /** Run one statement and read every partition of its result. */
  async run(
    statement: string,
    bindings: Record<string, SnowflakeBinding> | undefined,
    signal?: AbortSignal
  ): Promise<StatementResult> {
    const { timeout } = this.#options;
    const deadline = new AbortController();
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(
            () =>
              deadline.abort(
                new QueryError(
                  `The Snowflake statement ran past its ${timeout} s timeout and was cancelled.`,
                  {
                    code: VibORMErrorCode.QUERY_TIMEOUT,
                    meta: { driver: "snowflake" },
                  }
                )
              ),
            timeout * 1000
          );
    const onAbort = () => deadline.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let handle: string | undefined;
    try {
      const requestId = crypto.randomUUID();
      const body = JSON.stringify({
        statement,
        ...(timeout === undefined ? {} : { timeout }),
        ...this.#options.context,
        ...(bindings ? { bindings } : {}),
        parameters: this.#options.parameters,
      });
      let answer = await this.#send(
        (attempt) =>
          `/api/v2/statements?requestId=${requestId}${attempt > 0 ? "&retry=true" : ""}`,
        { method: "POST", body },
        deadline.signal
      );
      handle = answer.body?.statementHandle;
      let delay = this.#options.pollIntervalMs ?? 100;
      while (answer.status === 202 || answer.status === 429) {
        if (!handle)
          throw new SnowflakeApiError(
            answer.status,
            answer.body,
            "Snowflake accepted the statement without a handle to poll."
          );
        await sleep(delay, deadline.signal);
        delay = Math.min(delay * 2, MAX_POLL_MS);
        answer = await this.#send(
          () => `/api/v2/statements/${encodeURIComponent(handle!)}`,
          { method: "GET" },
          deadline.signal
        );
      }
      if (answer.status !== 200)
        throw new SnowflakeApiError(
          answer.status,
          answer.body,
          `Snowflake answered HTTP ${answer.status}.`
        );
      const result = answer.body;
      const metadata = result?.resultSetMetaData;
      // A result states its columns and its first partition, empty or not;
      // without them the rows are not known, and no read answers [] for them.
      if (!(Array.isArray(metadata?.rowType) && Array.isArray(result?.data)))
        throw malformedResult("its rowType or its data is missing");
      handle = result.statementHandle ?? handle ?? "";
      const partitions = metadata.partitionInfo?.length ?? 1;
      const rows: (readonly unknown[])[] = [...result.data];
      if (partitions > 1)
        for (const part of await this.#partitions(
          handle,
          partitions,
          deadline.signal
        ))
          for (const row of part) rows.push(row);
      if (
        typeof metadata.numRows === "number" &&
        rows.length !== metadata.numRows
      )
        throw malformedResult(
          `it states ${metadata.numRows} rows and holds ${rows.length}`
        );
      return { columns: metadata.rowType, rows, handle };
    } catch (error) {
      if (deadline.signal.aborted && handle) await this.cancel(handle);
      throw deadline.signal.aborted && deadline.signal.reason instanceof Error
        ? deadline.signal.reason
        : error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Stop a statement; a failure to stop it is not the caller's failure. */
  async cancel(handle: string): Promise<void> {
    try {
      await this.#request(
        `/api/v2/statements/${encodeURIComponent(handle)}/cancel`,
        { method: "POST" }
      );
    } catch {
      // The statement's own timeout ends it anyway.
    }
  }

  /** Partitions 1..count-1, in order, at most `partitionConcurrency` at once. */
  async #partitions(
    handle: string,
    count: number,
    signal: AbortSignal
  ): Promise<unknown[][][]> {
    const out: unknown[][][] = new Array(count - 1);
    let next = 1;
    const worker = async () => {
      while (next < count) {
        const partition = next++;
        const answer = await this.#send(
          () =>
            `/api/v2/statements/${encodeURIComponent(handle)}?partition=${partition}`,
          { method: "GET" },
          signal
        );
        if (answer.status !== 200)
          throw new SnowflakeApiError(
            answer.status,
            answer.body,
            `Snowflake answered HTTP ${answer.status} for partition ${partition}.`
          );
        const data = answer.body?.data;
        if (!Array.isArray(data))
          throw malformedResult(`partition ${partition} holds no data`);
        out[partition - 1] = data;
      }
    };
    const workers = Math.min(
      this.#options.partitionConcurrency ?? 4,
      count - 1
    );
    await Promise.all(Array.from({ length: workers }, worker));
    return out;
  }

  /**
   * One request, sent again while it failed before Snowflake ran it. A 4xx
   * other than 429, and every 2xx, is Snowflake's answer and is returned.
   */
  async #send(
    path: (attempt: number) => string,
    init: { method: string; body?: string },
    signal: AbortSignal
  ): Promise<{ status: number; body: ResultSetBody | undefined }> {
    const attempts = this.#options.attempts ?? 3;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.#request(path(attempt), init, signal);
      } catch (error) {
        if (signal.aborted || attempt + 1 >= attempts) throw error;
        await sleep(200 * 2 ** attempt, signal);
        continue;
      }
      const retry =
        RETRYABLE_STATUS.has(response.status) &&
        // A 429 while polling means "still running", not "send again".
        !(response.status === 429 && init.method === "GET");
      if (retry && attempt + 1 < attempts) {
        await response.body?.cancel();
        await sleep(200 * 2 ** attempt, signal);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        const body = await readBody(response);
        throw new ClientInitializationError(
          `Snowflake refused the credentials: ${body?.message ?? `HTTP ${response.status}`}`,
          {
            cause: new SnowflakeApiError(response.status, body, "unauthorized"),
            meta: { driver: "snowflake", providerCode: body?.code },
          }
        );
      }
      return { status: response.status, body: await readBody(response) };
    }
  }

  async #request(
    path: string,
    init: { method: string; body?: string },
    signal?: AbortSignal
  ): Promise<Response> {
    const { token, type } = await this.#options.authenticator.authorization();
    try {
      return await this.#options.fetch(`${this.#options.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Snowflake-Authorization-Token-Type": type,
          Accept: "application/json",
          "User-Agent": this.#options.userAgent ?? "viborm",
          ...(init.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new ConnectionError("Snowflake could not be reached", {
        cause: error instanceof Error ? error : undefined,
        meta: { driver: "snowflake" },
      });
    }
  }
}

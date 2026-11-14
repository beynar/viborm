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
import { isRecord } from "@validation/value-guards";
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
  /**
   * Sends of one submission before its failure is final; a status or a
   * partition read gets {@link MORE_READ_ATTEMPTS} more.
   */
  readonly attempts?: number;
  readonly userAgent?: string;
}

export interface StatementResult {
  readonly columns: readonly SnowflakeColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly handle: string;
}

/** An answer's JSON body, read field by field: nothing in it is trusted. */
type Body = Readonly<Record<string, unknown>>;

function text(body: Body | undefined, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === "string" ? value : undefined;
}

function isColumn(value: unknown): value is SnowflakeColumn {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.type === "string"
  );
}

function isRows(value: unknown): value is unknown[][] {
  return Array.isArray(value) && value.every((row) => Array.isArray(row));
}

const MAX_POLL_MS = 2000;
/** How long a cancel may hold the caller's error back. */
const CANCEL_MS = 2000;
/**
 * More sends for a status read than for a submission: a GET changes nothing,
 * and giving up on one leaves a statement running.
 */
const MORE_READ_ATTEMPTS = 3;

/** A failure Snowflake answered, as the error mapping reads it. */
export class SnowflakeApiError extends Error {
  readonly code: string | undefined;
  readonly sqlstate: string | undefined;
  readonly status: number;
  readonly statementHandle: string | undefined;
  constructor(status: number, body: Body | undefined, fallback: string) {
    super(text(body, "message") ?? fallback);
    this.name = "SnowflakeApiError";
    this.status = status;
    this.code = text(body, "code");
    this.sqlstate = text(body, "sqlState");
    this.statementHandle = text(body, "statementHandle");
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

/** `promise`, or `signal`'s reason as soon as it aborts. */
function untilAborted<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function readBody(response: Response): Promise<Body | undefined> {
  const answered = await response.text();
  if (answered.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(answered);
    return isRecord(parsed) ? parsed : { message: answered.slice(0, 500) };
  } catch {
    return { message: answered.slice(0, 500) };
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
    // Until Snowflake answers the statement's outcome, a failure here leaves
    // it running: it is cancelled then, whatever the failure.
    let settled = false;
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
      handle = text(answer.body, "statementHandle");
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
      settled = true;
      if (answer.status !== 200)
        throw new SnowflakeApiError(
          answer.status,
          answer.body,
          `Snowflake answered HTTP ${answer.status}.`
        );
      const result = answer.body;
      const metadata = isRecord(result?.resultSetMetaData)
        ? result.resultSetMetaData
        : undefined;
      const columns = metadata?.rowType;
      const first = result?.data;
      // A result states its columns and its first partition, empty or not;
      // without them the rows are not known, and no read answers [] for them.
      if (
        !(
          metadata &&
          Array.isArray(columns) &&
          columns.every(isColumn) &&
          isRows(first)
        )
      )
        throw malformedResult("its rowType or its data is missing");
      handle = text(result, "statementHandle") ?? handle ?? "";
      const partitions = Array.isArray(metadata.partitionInfo)
        ? metadata.partitionInfo.length
        : 1;
      const rows: (readonly unknown[])[] = [...first];
      if (partitions > 1)
        for (const part of await this.#partitions(
          handle,
          partitions,
          deadline.signal
        ))
          for (const row of part) rows.push(row);
      const { numRows } = metadata;
      if (typeof numRows === "number" && rows.length !== numRows)
        throw malformedResult(
          `it states ${numRows} rows and holds ${rows.length}`
        );
      return { columns, rows, handle };
    } catch (error) {
      if (handle && !settled) await this.cancel(handle);
      throw deadline.signal.aborted && deadline.signal.reason instanceof Error
        ? deadline.signal.reason
        : error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Stop a statement, waiting at most `CANCEL_MS` for Snowflake to say so: a
   * failure to stop it is not the caller's failure, and the caller's deadline
   * must not wait on it.
   */
  async cancel(handle: string): Promise<void> {
    try {
      await this.#request(
        `/api/v2/statements/${encodeURIComponent(handle)}/cancel`,
        { method: "POST" },
        AbortSignal.timeout(CANCEL_MS)
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
        if (!isRows(data))
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
   * One request, sent again while it failed before Snowflake answered it: a
   * network failure, a 5xx, or a 429 on a submission (the same `requestId`
   * with `retry=true` never runs a statement twice). A 4xx other than 429,
   * and every 2xx, is Snowflake's answer and is returned; a 5xx still
   * answered after the last send is a connection failure, not a refusal,
   * whose statement may have started.
   */
  async #send(
    path: (attempt: number) => string,
    init: { method: string; body?: string },
    signal: AbortSignal
  ): Promise<{ status: number; body: Body | undefined }> {
    const attempts =
      (this.#options.attempts ?? 3) +
      (init.method === "GET" ? MORE_READ_ATTEMPTS : 0);
    const pause = (attempt: number) =>
      sleep(Math.min(200 * 2 ** attempt, MAX_POLL_MS), signal);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.#request(path(attempt), init, signal);
      } catch (error) {
        if (signal.aborted || attempt + 1 >= attempts) throw error;
        await pause(attempt);
        continue;
      }
      const unanswered =
        response.status >= 500 ||
        // A 429 while polling means "still running", not "send again".
        (response.status === 429 && init.method !== "GET");
      if (unanswered && attempt + 1 < attempts) {
        await response.body?.cancel();
        await pause(attempt);
        continue;
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        // A 5xx can follow the start of the statement (a gateway's 504):
        // its outcome is not known, and a submission's has no handle.
        throw new ConnectionError(
          init.method === "POST"
            ? `Snowflake answered HTTP ${response.status} to ${attempts} sends of the statement: its outcome is not known, and it may have started, with no handle to cancel it by; its timeout bounds it.`
            : `Snowflake answered HTTP ${response.status} to ${attempts} reads of the statement.`,
          { meta: { driver: "snowflake", status: response.status } }
        );
      }
      if (response.status === 401 || response.status === 403) {
        const body = await readBody(response);
        throw new ClientInitializationError(
          `Snowflake refused the credentials: ${text(body, "message") ?? `HTTP ${response.status}`}`,
          {
            cause: new SnowflakeApiError(response.status, body, "unauthorized"),
            meta: { driver: "snowflake", providerCode: text(body, "code") },
          }
        );
      }
      // The headers came; the body can still be cut off on its way, which is
      // a failed send like any other.
      let body: Body | undefined;
      try {
        body = await readBody(response);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (attempt + 1 >= attempts)
          throw new ConnectionError(
            `Snowflake's answer was cut off ${attempts} times before it ended.`,
            {
              cause: error instanceof Error ? error : undefined,
              meta: { driver: "snowflake" },
            }
          );
        await pause(attempt);
        continue;
      }
      return { status: response.status, body };
    }
  }

  async #request(
    path: string,
    init: { method: string; body?: string },
    signal?: AbortSignal
  ): Promise<Response> {
    // A token function may be slow to refresh: the request's deadline bounds
    // that wait too.
    const { token, type } = await untilAborted(
      this.#options.authenticator.authorization(),
      signal
    );
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

/**
 * A node-postgres pool that records the text of every statement its clients
 * send, and can make the next statement containing `fail` fail as a provider
 * refusal would (SQLSTATE `XX000`), before the server sees it.
 */

import pg from "pg";

export interface RecordingPool {
  readonly pool: pg.Pool;
  readonly log: string[];
  fail?: string;
}

type Callback = (...args: unknown[]) => void;

export function recordingPgPool(config: pg.PoolConfig): RecordingPool {
  const pool = new pg.Pool(config);
  const recording: RecordingPool = { pool, log: [] };
  const wrapped = new WeakSet<object>();
  const wrap = (client: pg.PoolClient) => {
    if (wrapped.has(client)) return;
    wrapped.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    Object.defineProperty(client, "query", {
      value: (...args: unknown[]) => {
        const [first] = args;
        const text =
          typeof first === "string"
            ? first
            : String((first as { text?: unknown } | undefined)?.text ?? "");
        recording.log.push(text);
        if (recording.fail && text.includes(recording.fail)) {
          recording.fail = undefined;
          const failure = Object.assign(new Error("injected failure"), {
            code: "XX000",
          });
          const callback = args.at(-1);
          if (typeof callback === "function") {
            queueMicrotask(() => (callback as Callback)(failure));
            return;
          }
          return Promise.reject(failure);
        }
        return query(...args);
      },
    });
  };
  const connect = pool.connect.bind(pool) as (callback?: Callback) => unknown;
  Object.defineProperty(pool, "connect", {
    value: (callback?: Callback) => {
      if (typeof callback === "function") {
        return connect((error, client, release) => {
          if (client) wrap(client as pg.PoolClient);
          callback(error, client, release);
        });
      }
      return (connect() as Promise<pg.PoolClient>).then((client) => {
        wrap(client);
        return client;
      });
    },
  });
  return recording;
}

/** The transactions a log committed. */
export const commitsIn = (log: readonly string[]): number =>
  log.filter((text) => text.trim().toUpperCase() === "COMMIT").length;

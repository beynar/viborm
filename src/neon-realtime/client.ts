// viborm/neon-realtime/client: the browser half. It reaches no driver, SQL
// compiler or server SDK, only the decoder the ordinary read uses.

import {
  createRealtimeClient,
  defineParsers,
  type LiveQueryState,
  pgTypeOids,
  QueryRefreshController,
  type RealtimeLogger,
  type RealtimeLogLevel,
} from "@neon/realtime/client";
import { readArrayLiteralText } from "../adapters/databases/postgres/array-literal";
import { NotFoundError } from "../errors/query";
import { ProjectionDecoder } from "../query-engine/result/projection-decoder";
import { publishReadResult } from "../query-engine/result/read-publication";
import { READ_ORDINAL_RESULT_KEY } from "../query-engine/result-aliases";
import {
  type Plan,
  type RealtimeRenewal,
  readPlan,
  realtimeData,
  type TransportRow,
} from "./plan";

export type {
  RealtimePlan,
  RealtimeQuery,
  RealtimeRenewal,
  TransportRow,
} from "./plan";
// `realtimeEnvelope` is the server half's: it encodes with this decoder's codec.
export { realtimeData, realtimeEnvelope } from "./plan";

/** Neon's lifecycle and the read's current value, in its ordinary shape. */
export interface RealtimeSnapshot<Data> {
  readonly status: LiveQueryState["status"];
  readonly error: Error | undefined;
  readonly data: Data | undefined;
}

export interface RealtimeSubscriptionOptions<Data> {
  /** The Neon Realtime proxy's WebSocket URL. */
  readonly url: string;
  /** The same endpoint with `{ initialData: false }`, called before each capability expires. */
  readonly refreshQuery?: () => Promise<RealtimeRenewal<NoInfer<Data>>>;
  readonly onChange?: (snapshot: RealtimeSnapshot<Data>) => void;
  readonly logLevel?: RealtimeLogLevel;
  readonly logger?: RealtimeLogger;
}

export interface RealtimeSubscription<Data> {
  getSnapshot(): RealtimeSnapshot<Data>;
  /** Apply a capability for the same read now. */
  renew(query: RealtimeRenewal<NoInfer<Data>>): Promise<void>;
  unsubscribe(): void;
}

// Timestamps stay PostgreSQL text: the decoder owns their meaning.
const exact = (text: string) => text;
const parsers = defineParsers({
  [pgTypeOids.date]: exact,
  [pgTypeOids.timestamp]: exact,
  [pgTypeOids.timestamptz]: exact,
});

/** A carried list arrives as its array text, whose members are PostgreSQL text. */
const listReader = (type: string) => (value: unknown) => {
  const members =
    typeof value === "string" ? readArrayLiteralText(value) : undefined;
  if (members === undefined) return value;
  if (type === "boolean")
    return members.map((member) => (member === null ? null : member === "t"));
  return type === "json"
    ? members.map((member) => (member === null ? null : JSON.parse(member)))
    : members;
};

/** The read's value from Neon's rows: ranked, decoded and published as the ordinary read does. */
function publisher(plan: Plan) {
  const decoder = new ProjectionDecoder({
    result: { enumListRepresentation: "arrayText" },
    integerSum: false,
    listReader,
  });
  const rank = (row: TransportRow) => Number(row[READ_ORDINAL_RESULT_KEY]);
  return (rows: readonly TransportRow[]) => {
    const ordered = [...rows].sort((left, right) => rank(left) - rank(right));
    const value = publishReadResult(
      decoder.decodeRows(plan.shape, ordered),
      plan.rule
    );
    if (value === null && plan.missing)
      throw new NotFoundError(plan.missing.model, plan.missing.operation);
    return value;
  };
}

class RealtimeError extends Error {
  constructor(cause: unknown) {
    super("The live read failed.", { cause });
    this.name = "RealtimeError";
  }
}

/**
 * Subscribe to a live read. Its first result shows until Neon's first live
 * baseline; a refused update (an `OrThrow` read losing its row, a value the
 * plan cannot decode) ends the subscription in `error`, with the cause.
 */
export function subscribe<Data>(
  query: RealtimeRenewal<Data> & { readonly encoded?: unknown },
  options: RealtimeSubscriptionOptions<Data>
): RealtimeSubscription<Data> {
  const plan = readPlan(query);
  const identity = JSON.stringify(plan);
  const sameRead = (renewal: RealtimeRenewal<Data>) => {
    if (JSON.stringify(renewal.plan) !== identity)
      throw new TypeError("A renewal must be for the same live read.");
    return renewal.sealed;
  };
  const publish = publisher(plan);
  const client = createRealtimeClient({
    url: options.url,
    parsers,
    logLevel: options.logLevel,
    logger: options.logger,
  });
  const native = client.subscribe<TransportRow>(query.sealed);
  let snapshot: RealtimeSnapshot<Data> = Object.freeze({
    status: "connecting",
    error: undefined,
    data: realtimeData(query),
  });
  let rows: readonly TransportRow[] | undefined;
  let closed = false;

  const close = (next: RealtimeSnapshot<Data>) => {
    if (closed) return;
    closed = true;
    refresh.stop();
    native.unsubscribe();
    client.close();
    snapshot = next;
    options.onChange?.(snapshot);
  };
  const fail = (cause: unknown) =>
    close(
      Object.freeze({
        status: "error",
        error: new RealtimeError(cause),
        data: snapshot.data,
      })
    );
  const read = (): RealtimeSnapshot<Data> => {
    if (closed) return snapshot;
    const current = native.getSnapshot();
    try {
      let data = snapshot.data;
      if (current.data !== undefined && current.data !== rows) {
        data = publish(current.data) as Data;
        rows = current.data;
      }
      if (
        data !== snapshot.data ||
        current.status !== snapshot.status ||
        current.error !== snapshot.error
      )
        snapshot = Object.freeze({
          status: current.status,
          error: current.error,
          data,
        });
    } catch (cause) {
      fail(cause);
    }
    return snapshot;
  };

  const refresh = new QueryRefreshController<TransportRow>({
    query: query.sealed,
    subscription: native,
    refreshQuery:
      options.refreshQuery &&
      (async () => {
        const renewal = await options.refreshQuery!();
        try {
          return sameRead(renewal);
        } catch (error) {
          fail(error);
          throw error;
        }
      }),
    renewSubscription: (sealed) => native.renew(sealed),
    onRefreshExhausted: fail,
  });
  native.onChange(() => {
    const previous = snapshot;
    if (read() !== previous && !closed) options.onChange?.(snapshot);
  });
  refresh.start();

  return {
    getSnapshot: read,
    renew: async (renewal) => refresh.replaceSealedQuery(sameRead(renewal)),
    unsubscribe: () =>
      close(
        Object.freeze({
          status: "closed",
          error: undefined,
          data: snapshot.data,
        })
      ),
  };
}

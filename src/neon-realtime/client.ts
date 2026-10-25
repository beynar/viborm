// viborm/neon-realtime/client: the browser half. It reaches no driver, SQL
// compiler or server SDK, only the decoder the ordinary read uses.

import {
  createRealtimeClient,
  defineParsers,
  type LiveQueryState,
  pgTypeOids,
  QueryRefreshController,
} from "@neon/realtime/client";
import { readArrayLiteralText } from "../adapters/databases/postgres/array-literal";
import { NotFoundError } from "../errors/query";
import { ProjectionDecoder } from "../query-engine/result/projection-decoder";
import type { Leaf } from "../query-engine/result/projection-shape";
import { publishReadResult } from "../query-engine/result/read-publication";
import { READ_ORDINAL_RESULT_KEY } from "../query-engine/result-aliases";
import {
  type Plan,
  type RealtimeQuery,
  type RealtimeRenewal,
  readPlan,
  realtimeData,
  type TransportRow,
} from "./plan";

// The browser build's own copy: decoded decimals are its instances, not the
// server entries' `Decimal`'s.
export { Decimal } from "../validation/primitives/decimal-value";
export type {
  RealtimePlan,
  RealtimeQuery,
  RealtimeRenewal,
  TransportRow,
} from "./plan";
export { realtimeData } from "./plan";

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
class TransportDecoder extends ProjectionDecoder {
  protected override compileList(leaf: Leaf, internal: boolean) {
    const read = super.compileList(leaf, internal);
    return (value: unknown) => {
      const members =
        typeof value === "string" ? readArrayLiteralText(value) : undefined;
      if (members === undefined) return read(value);
      return read(
        leaf.type === "boolean"
          ? members.map((member) => (member === null ? null : member === "t"))
          : members
      );
    };
  }
}

/** The read's value from Neon's rows: ranked, decoded and published as the ordinary read does. */
function publisher(plan: Plan) {
  const decoder = new TransportDecoder({
    result: { enumListRepresentation: "arrayText" },
    integerSum: false,
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
  query: RealtimeRenewal<Data> | RealtimeQuery<Data>,
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
  const client = createRealtimeClient({ url: options.url, parsers });
  const native = client.subscribe<TransportRow>(query.sealed);
  let snapshot: RealtimeSnapshot<Data> = Object.freeze({
    status: "connecting",
    error: undefined,
    data: "encoded" in query ? realtimeData(query) : undefined,
  });
  let rows: readonly TransportRow[] | undefined;
  let closed = false;

  const close = (next: RealtimeSnapshot<Data>) => {
    if (closed) return;
    closed = true;
    refresh.stop();
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

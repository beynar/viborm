import type { SealedLiveQuery } from "@neon/realtime/client";
import {
  arrayCodec,
  compileFactsCodec,
  compileProjectionValue,
  compileWidenedSumCodec,
  nullableCodec,
  type ValueCodec,
} from "../query-engine/result/cache-value-codecs";
import type {
  Leaf,
  ProjectionShape,
} from "../query-engine/result/projection-shape";
import type { ReadResultRule } from "../query-engine/result/read-publication";

/** One live row as Neon delivers it: physical cells, decoded by the plan. */
export type TransportRow = Readonly<Record<string, unknown>>;

const PLAN_VERSION = 1;

/** How the browser reads the sealed statement's rows. Plain JSON, opaque to applications. */
export interface RealtimePlan {
  readonly version: typeof PLAN_VERSION;
}

/** The plan's facts: the row shape without schema objects, and the read's publication. */
export interface Plan extends RealtimePlan {
  readonly shape: Extract<ProjectionShape, { kind: "object" }>;
  readonly rule: ReadResultRule;
  /** An `OrThrow` read: no row is its `NotFoundError`. */
  readonly missing?: { readonly model: string; readonly operation: string };
}

/** A fresh capability for a live read, and the plan its rows decode with. */
export interface RealtimeRenewal<Data> {
  readonly kind: "viborm.realtime";
  readonly sealed: SealedLiveQuery<TransportRow>;
  readonly plan: RealtimePlan;
  /** Type-only: a string phantom survives JSON-typed transports. */
  readonly __data?: string & { readonly __type: Data };
}

/**
 * A live read with its first result. `encoded` is that result as plain JSON,
 * which every transport carries; `realtimeData(query)` reads it back.
 */
export interface RealtimeQuery<Data> extends RealtimeRenewal<Data> {
  readonly encoded: unknown;
  /**
   * The first result, on the server that read it only: not enumerable, so no
   * transport carries it. Elsewhere, read `realtimeData(query)`.
   */
  readonly data?: Data;
}

/** The read's public value, encoded with the cache's own value codecs. */
function dataCodec(plan: Plan): ValueCodec {
  const leaf = (facts: Leaf): ValueCodec => {
    if (!facts.widened)
      return compileFactsCodec({
        ...facts,
        type: facts.id ? "string" : facts.type,
        array: facts.list,
      });
    const sum = compileWidenedSumCodec(facts);
    return facts.nullable ? nullableCodec(sum) : sum;
  };
  const { rule, shape } = plan;
  if (rule.kind === "scalar")
    return compileProjectionValue(shape.fields[rule.field]!, leaf);
  const row = compileProjectionValue(shape, leaf);
  return rule.kind === "rows" ? arrayCodec(row) : row;
}

/**
 * The envelope `neonRealtime` answers: a renewal, or with `data` a live read
 * and its first result. It lives here, beside its decoder, so the server
 * encodes with the codec the browser reads; the browser entry exports it only
 * because the server half imports that file.
 */
export function realtimeEnvelope<Data>(
  sealed: SealedLiveQuery<TransportRow>,
  facts: Omit<Plan, "version">,
  ...data: [] | [Data]
): RealtimeRenewal<Data> | RealtimeQuery<Data> {
  const plan: Plan = { version: PLAN_VERSION, ...facts };
  const renewal = { kind: "viborm.realtime" as const, sealed, plan };
  if (data.length === 0) return Object.freeze(renewal);
  const query: Omit<RealtimeQuery<Data>, "data"> = {
    ...renewal,
    encoded: dataCodec(plan).snapshot(data[0], new WeakSet()),
  };
  return Object.freeze(
    Object.defineProperty(query, "data", { value: data[0] })
  ) as RealtimeQuery<Data>;
}

/** The plan of a live read issued by this version, or a refusal. */
export function readPlan(query: RealtimeRenewal<unknown>): Plan {
  if (query.plan.version !== PLAN_VERSION)
    throw new TypeError("This live read was issued by another VibORM version.");
  return query.plan as Plan;
}

/** A live read's first result: the server's own value, or the one it encoded. */
export function realtimeData<Data>(query: RealtimeQuery<Data>): Data {
  if ("data" in query) return query.data as Data;
  return dataCodec(readPlan(query)).materialize(
    query.encoded,
    new WeakSet()
  ) as Data;
}

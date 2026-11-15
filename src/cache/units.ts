/**
 * The cache's units (`get`, `set`, `invalidate`, `revalidate`, and the
 * `delete` and `clear` an invalidation runs) and the outcomes of a read
 * (`hit`, a stale `hit`, `miss`, `bypass`, `cache-set-failed`), written with
 * the words any extension has: each step is a `cache` unit it emits with
 * `work` (on the call's context or `run`, a method's scope, or the unit of
 * the step it is part of), and what a presenter shows of it is noted on it
 * with `note`, in the shape the official instrumentation presents any
 * extension's units with (`InstrumentationNote`): the span as the unit
 * starts, then its attributes and its logs. A read's outcomes are noted on
 * the call's own `operation` unit.
 */
import type { UnitContext } from "@extensions/contract";
import type { Database } from "@extensions/database";
import { work } from "@extensions/observation";
import { note } from "@extensions/unit-words";
import {
  ATTR_CACHE_DRIVER,
  ATTR_CACHE_TTL,
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  ATTR_VIBORM_CORRELATION_ID,
  SPAN_OPERATION,
  type VibORMSpanName,
} from "../instrumentation/spans";
import type { InstrumentationNote } from "../instrumentation/types";

/** The call a step's logs name: its model and the operation it asked. */
interface CacheCall {
  readonly model: string;
  readonly operation: string;
}

/**
 * One decision of a read, as a cache log presents it: the call is named
 * where the note is not on the call's own unit. Never a key or a suffix.
 */
export const cacheOutcome = (
  event: string,
  status?: string,
  error?: unknown,
  call?: CacheCall
): InstrumentationNote => ({
  log: "cache",
  at: Date.now(),
  meta: { event, status },
  error,
  ...call,
});

/**
 * A background set failure joins its read's outcomes while that read's
 * operation still runs, so it presents after the logical miss; otherwise the
 * set unit presents it itself.
 */
export function placeSetFailure(
  background: object,
  failure: unknown,
  unit: UnitContext,
  call: CacheCall | undefined
): void {
  if (!note(background, cacheOutcome("miss", "cache-set-failed", failure)))
    note(unit, cacheOutcome("miss", "cache-set-failed", failure, call));
}

/**
 * Run one cache step as a `cache` unit of the chain `origin` belongs to;
 * `execute` is handed the unit, to note what the step learns. A step asked
 * with no origin (a backend method called directly) belongs to no chain.
 */
export function cacheStep<T>(
  step: "get" | "set" | "invalidate" | "delete" | "clear",
  origin: object | undefined,
  driverName: string,
  execute: (unit?: UnitContext) => Promise<T>,
  ttl?: number
): Promise<T> {
  if (origin === undefined) return execute();
  const attributes: InstrumentationNote["attributes"] = {
    [ATTR_CACHE_DRIVER]: driverName,
    ...(ttl === undefined ? {} : { [ATTR_CACHE_TTL]: String(ttl) }),
    // A backend step of an invalidation names its driver alone.
    ...(step === "delete" || step === "clear"
      ? { [ATTR_VIBORM_CORRELATION_ID]: undefined }
      : {}),
  };
  return work(
    origin,
    // Its span is the public `SPAN_CACHE_<STEP>`: spelled from the step,
    // which costs no bytes, and checked against those constants.
    {
      kind: "cache",
      operation: step,
      note: {
        span: `viborm.cache.${step}` satisfies VibORMSpanName,
        attributes,
      },
    },
    execute
  );
}

/**
 * What a revalidation's own `cache` unit starts with: it is presented as the
 * root operation it replays.
 */
export const revalidationStart = (
  call: CacheCall,
  database: Database
): InstrumentationNote => ({
  ...cacheOutcome("revalidate", "start", undefined, call),
  span: SPAN_OPERATION,
  root: true,
  database,
  attributes: {
    [ATTR_DB_COLLECTION]: call.model,
    [ATTR_DB_OPERATION_NAME]: call.operation,
  },
});

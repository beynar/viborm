/**
 * Where a call's words find what they read: a first moment's context and a
 * second moment's `run` carry the call (`CALL`), a method's scope carries its
 * view (`SCOPE`). Symbols, so a call, a run or a scope shows them to the words
 * that import this module and to nothing else.
 */
import type { QueryExecutionContext } from "@drivers/types";
import type { QueryEngine } from "@query-engine/query-engine";
import type { PreparedOperation } from "@query-engine/raptor3/commands";
import type { AdmittedArgs } from "./arguments";
import type { Seconds } from "./call";
import type { Attempt, WriteOutcomeRegistration } from "./query";
import type { Watched } from "./watch-part";

/** The key of the call a first moment's context and a `run` belong to. */
export const CALL = Symbol("viborm.call");
/** The key of the view a method's scope serves. */
export const SCOPE = Symbol("viborm.scope");
/** The key of what a second moment's `run` started, which `again` and `via` read. */
export const ATTEMPT = Symbol("viborm.attempt");

/**
 * One call, as its words and its parts read it: a model call's own object, a
 * raw statement's resolved query. Each part that keeps something for the
 * call writes its own field, and only it reads that field: what it keeps
 * lives as long as the call, never on a chain or a part, which outlive it.
 */
export interface CallOrigin {
  /** The arguments of the extensions the call admitted. */
  readonly values?: AdmittedArgs;
  /** Set once the call is an operation of an engine: absent on a raw statement. */
  of?: {
    readonly engine: QueryEngine;
    readonly context: QueryExecutionContext;
    /** The call prepared once: what runs is this preparation. */
    readonly prepared: () => PreparedOperation;
  };
  /** `around` (`call.ts`): what each part's first moment left its second. */
  seconds?: Seconds;
  /** `watch` and `settled` on a model call (`watch-part.ts`): per extension. */
  watched?: Watched;
  /** `settled` on a raw statement, in an `around`'s first moment (`call.ts`). */
  told?: WriteOutcomeRegistration[];
}

/** The view one extension's method scope serves. */
export interface ScopeOrigin {
  readonly engine: QueryEngine;
  readonly extension: string;
}

// Only this module and the core write these keys: what they hold is what
// the core put there.
const isCall = <T = CallOrigin>(value: unknown): value is T =>
  typeof value === "object" && value !== null;
const isScope = (value: unknown): value is ScopeOrigin =>
  typeof value === "object" && value !== null && "engine" in value;

/** The call a first moment's context or a `run` belongs to, if it has one. */
export function callOf(x: object): CallOrigin | undefined {
  const call: unknown = Reflect.get(x, CALL);
  return isCall(call) ? call : undefined;
}

/** What a second moment's `run` started, if `x` is one. */
export function attemptOf(x: object): Attempt | undefined {
  const attempt: unknown = Reflect.get(x, ATTEMPT);
  return isCall<Attempt>(attempt) ? attempt : undefined;
}

/** The view a method's scope serves, if `x` is one. */
export function scopeOf(x: object): ScopeOrigin | undefined {
  const scope: unknown = Reflect.get(x, SCOPE);
  return isScope(scope) ? scope : undefined;
}

/** The engine a call, a run or a scope works on. */
export function engineOf(x: object): QueryEngine | undefined {
  return callOf(x)?.of?.engine ?? scopeOf(x)?.engine;
}

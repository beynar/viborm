/**
 * Where a call's words find what they read: a first moment's context and a
 * second moment's `run` carry the call (`CALL`), a method's scope carries its
 * view (`SCOPE`). Symbols, so a call, a run or a scope shows them to the words
 * that import this module and to nothing else.
 */
import type { QueryExecutionContext } from "@drivers/types";
import type { QueryEngine } from "@query-engine/query-engine";
import type { PreparedOperation } from "@query-engine/raptor3/commands";
import type { AdmittedControls } from "./controls";

/** The key of the call a first moment's context and a `run` belong to. */
export const CALL = Symbol("viborm.call");
/** The keys a second moment's `run` carries for `again` and `via`. */
export const AGAIN = Symbol("viborm.again");
export const VIA = Symbol("viborm.via");
/** The key of the view a method's scope serves. */
export const SCOPE = Symbol("viborm.scope");

/** One model call, as its words read it. */
export interface CallOrigin {
  /** The arguments of the extensions the call admitted. */
  readonly controls?: AdmittedControls;
  /** Set once the call is an operation of an engine: absent on a raw statement. */
  of?: {
    readonly engine: QueryEngine;
    readonly context: QueryExecutionContext;
    /** The call prepared once: what runs is this preparation. */
    readonly prepared: () => PreparedOperation;
  };
}

/** The view one extension's method scope serves. */
export interface ScopeOrigin {
  readonly engine: QueryEngine;
  readonly extension: string;
}

// Only this module and the core write these keys: what they hold is what
// the core put there.
const isCall = (value: unknown): value is CallOrigin =>
  typeof value === "object" && value !== null;
const isScope = (value: unknown): value is ScopeOrigin =>
  typeof value === "object" && value !== null && "engine" in value;

/** The call a first moment's context or a `run` belongs to, if it has one. */
export function callOf(x: object): CallOrigin | undefined {
  const call: unknown = Reflect.get(x, CALL);
  return isCall(call) ? call : undefined;
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

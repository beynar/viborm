// The part of the official `on` extension the core client reads: whether a
// chain carries it, and the plan it makes for one write. The runtime (which
// rows a write reports, how they are read, when hooks run) is installed by
// `on()` from `viborm/on`, so an application that never creates the
// extension loads none of it.

import type { QueryExecutionContext } from "@drivers/types";
import type { AnyModel } from "@schema/model";
import type { ResolvedExtensionChain } from "./chain";
import type { AdmittedControls } from "./controls";
import type { WriteOutcomeRegistration } from "./query";

/** One write the extension reports: its arguments, value and delivery. */
export interface WritePlan {
  /** The arguments the engine runs: the caller's, widened to whole rows. */
  readonly args: Record<string, unknown>;
  /**
   * The caller's value from the engine's, then `then` (the chain's computed
   * fields) over it; a promise when hooks run before the write resolves.
   */
  finish(value: unknown, then?: (value: unknown) => unknown): unknown;
  /**
   * The write's one registration on the outcome rail, after `cached`'s;
   * `controls` decide whether a managed delete leaves a tombstone.
   */
  register(
    context: QueryExecutionContext,
    controls: AdmittedControls | undefined,
    cached: WriteOutcomeRegistration | undefined
  ): WriteOutcomeRegistration;
}

export interface WritesCapability {
  /** `undefined` when no hook concerns the write: it runs as written. */
  plan(
    model: AnyModel,
    operation: string,
    args: Record<string, unknown>,
    chain: ResolvedExtensionChain
  ): WritePlan | undefined;
}

const capabilities = new WeakMap<object, WritesCapability>();

/** Recognize `query` as the official `on` contribution. `on()` only. */
export function registerOfficialWrites(
  query: object,
  capability: WritesCapability
): void {
  capabilities.set(query, capability);
}

export const officialWritesOf = (query: unknown) =>
  capabilities.get(query as object);

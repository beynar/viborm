/**
 * The chain an extension value builds, without a client: for the tests below
 * the client (a driver's dispatch, an execution context, an engine) that take
 * a chain where an application gets one from `client.$extends`.
 */
import type { Schema } from "@client/types";
import type { ResolvedExtensionChain } from "@extensions/chain-state";
import { isAppliedExtension } from "@extensions/extension";

/** `chain` with `value` applied over `schema`, as `$extends` applies it. */
export function appendExtension(
  chain: ResolvedExtensionChain | undefined,
  value: unknown,
  schema: Schema
): ResolvedExtensionChain {
  if (!isAppliedExtension(value))
    throw new TypeError("appendExtension takes an extension value");
  return value.append(chain, schema);
}

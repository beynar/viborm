/**
 * The part of default omit the client reads: which chain carries one, and its
 * configuration. What builds one (`defaultOmit()`) is in
 * `default-omit-extension.ts`, which the client does not load.
 */
import type { ResolvedExtensionChain } from "@extensions/chain";
import type { ClientOmitConfig } from "./omit";
import type { Schema } from "./types";

export interface OfficialDefaultOmitCapability {
  readonly config: ClientOmitConfig<Schema>;
}

const capabilitiesByChain = new WeakMap<
  ResolvedExtensionChain,
  OfficialDefaultOmitCapability
>();

export function getOfficialDefaultOmitChainCapability(
  chain: ResolvedExtensionChain | undefined
): OfficialDefaultOmitCapability | undefined {
  return chain === undefined ? undefined : capabilitiesByChain.get(chain);
}

export function registerOfficialDefaultOmitChain(
  chain: ResolvedExtensionChain,
  capability: OfficialDefaultOmitCapability
): void {
  capabilitiesByChain.set(chain, capability);
}

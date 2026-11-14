/**
 * The fields `defaults` leaves out of results (`fields: { f: omitted }`), as
 * a chain meets them: each extension's joined per model with those of the
 * extensions before it, and carried by every later chain, which the client
 * reads (`default-omit-chain.ts`).
 */
import type { ExtensionPart } from "@extensions/chain";
import {
  getOfficialDefaultOmitChainCapability,
  registerOfficialDefaultOmitChain,
} from "./default-omit-chain";
import type { ClientOmitConfig } from "./omit";
import type { Schema } from "./types";

export const omitPart: ExtensionPart = {
  carry: true,
  seal({ next, chain, definition }) {
    const prior = getOfficialDefaultOmitChainCapability(chain)?.config;
    const own = definition.omit;
    if (own === undefined) {
      if (prior !== undefined)
        registerOfficialDefaultOmitChain(next, { config: prior });
      return;
    }
    const config: ClientOmitConfig<Schema> = { ...prior };
    for (const [model, fields] of Object.entries(own))
      config[model] = Object.freeze({ ...config[model], ...fields });
    registerOfficialDefaultOmitChain(next, { config: Object.freeze(config) });
  },
};

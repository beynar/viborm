/**
 * The fields `defaults` leaves out of results (`fields: { f: omitted }`), as
 * a chain meets them: each extension's joined per model with those of the
 * extensions before it, on the chain (`chain.omit`), which every later chain
 * keeps and the client reads.
 */
import type { ExtensionPart } from "@extensions/chain";
import type { ClientOmitConfig } from "./omit";
import type { Schema } from "./types";

export const omitPart: ExtensionPart = {
  seal({ next, chain, definition }) {
    const own = definition.omit;
    if (own === undefined) return;
    const config: ClientOmitConfig<Schema> = { ...chain?.omit?.config };
    for (const [model, fields] of Object.entries(own))
      config[model] = Object.freeze({ ...config[model], ...fields });
    next.omit = Object.freeze({ config: Object.freeze(config) });
  },
};

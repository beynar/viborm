/**
 * The fields `defaults` leaves out of results (`fields: { f: omitted }`), as
 * a chain meets them: each joined per model with those before it, on the
 * chain (`chain.omit`), which every later chain keeps and the client reads.
 */
import type { ExtensionPart } from "@extensions/chain";
import type { ClientOmitConfig } from "./omit";
import type { Schema } from "./types";

/** What one `omitted` brings: its field left out of its model's results. */
export function omitPart(model: string, field: string): ExtensionPart {
  return {
    seal({ next }) {
      const config: ClientOmitConfig<Schema> = { ...next.omit?.config };
      config[model] = Object.freeze({ ...config[model], [field]: true });
      next.omit = Object.freeze({ config: Object.freeze(config) });
    },
  };
}

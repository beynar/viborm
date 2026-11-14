/**
 * The part of default omit the client reads: the configuration a chain
 * carries (`chain.omit`). What builds one (`defaultOmit()`, `omitted`) is in
 * `default-omit-extension.ts` and `default-omit-identity.ts`, which the
 * client does not load.
 */
import type { ClientOmitConfig } from "./omit";
import type { Schema } from "./types";

export interface OfficialDefaultOmitCapability {
  readonly config: ClientOmitConfig<Schema>;
}

// Shared types for model schemas

import type { VibSchema } from "@validation";
import type { ModelState } from "../model";
import type { ModelArgs } from "./args";
import type { CoreSchemas } from "./core";

/**
 * Schema entries record type
 */
export type SchemaEntries = Record<string, VibSchema>;

/**
 * Complete model schemas type
 * Used as explicit return type for getModelSchemas to avoid TS7056
 */
export type ModelSchemas<T extends ModelState> = CoreSchemas<T> & {
  args: ModelArgs<T>;
};

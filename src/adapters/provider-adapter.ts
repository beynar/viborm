import type { Schema } from "@client/types";
import type { QueryContext } from "@query-engine/types";
import type { Sql } from "@sql";

export interface ProviderAdapter {
  schema: Schema;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  execute: (query: Sql) => Promise<any>;
  transaction: (callback: (ctx: QueryContext) => Promise<any>) => Promise<any>;
}

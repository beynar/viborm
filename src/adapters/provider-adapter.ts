import { Schema } from "@client/types";
import { QueryContext } from "@query-engine/types";
import { Sql } from "@sql";

export interface ProviderAdapter {
  schema: Schema;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  execute: (query: Sql) => Promise<any>;
  transaction: (callback: (ctx: QueryContext) => Promise<any>) => Promise<any>;
}

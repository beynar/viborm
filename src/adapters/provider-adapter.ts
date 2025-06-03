import { BuilderContext } from "../query-parser/types";
import { Schema } from "@schema";
import { Sql } from "@sql";

export interface ProviderAdapter {
  schema: Schema;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  execute: (query: Sql) => Promise<any>;
  transaction: (
    callback: (ctx: BuilderContext) => Promise<any>
  ) => Promise<any>;
}

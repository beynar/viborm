import { Sql } from "@sql";
import { DatabaseAdapter } from "../../adapters/database-adapter";
import { BuilderContext, RelationHandler, RelationContext } from "../types";
import type { QueryParser } from "../query-parser";

/**
 * RelationFilterBuilder - Relation Filter Generation Component
 */
export class RelationFilterBuilder implements RelationHandler {
  readonly name = "RelationFilterBuilder";
  readonly dependencies: string[] = [];

  constructor(private parser: QueryParser, private adapter: DatabaseAdapter) {}

  canHandle(relationType: string): boolean {
    return true;
  }

  handle(context: RelationContext, ...args: any[]): any {
    throw new Error("RelationFilterBuilder.handle() not implemented yet");
  }
}

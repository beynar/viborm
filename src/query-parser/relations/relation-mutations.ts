import { Sql } from "@sql";
import { DatabaseAdapter } from "../../adapters/database-adapter";
import { BuilderContext, RelationHandler, RelationContext } from "../types";
import type { QueryParser } from "../index";

/**
 * RelationMutationBuilder - Relation Mutation Operation Component
 */
export class RelationMutationBuilder implements RelationHandler {
  readonly name = "RelationMutationBuilder";
  readonly dependencies: string[] = [];

  constructor(private parser: QueryParser, private adapter: DatabaseAdapter) {}

  canHandle(relationType: string): boolean {
    return true;
  }

  handle(context: RelationContext, ...args: any[]): any {
    throw new Error("RelationMutationBuilder.handle() not implemented yet");
  }
}

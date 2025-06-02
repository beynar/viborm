import { Sql } from "../../sql/sql";
import { DatabaseAdapter } from "../../adapters/database-adapter";
import { BuilderContext, FieldHandler } from "../types";
import type { QueryParser } from "../index";

/**
 * FieldUpdateBuilder - Field-Specific Update Operation Component
 */
export class FieldUpdateBuilder implements FieldHandler {
  readonly name = "FieldUpdateBuilder";
  readonly dependencies: string[] = [];

  constructor(private parser: QueryParser, private adapter: DatabaseAdapter) {}

  canHandle(fieldType: string): boolean {
    return true;
  }

  handle(context: BuilderContext, ...args: any[]): any {
    throw new Error("FieldUpdateBuilder.handle() not implemented yet");
  }
}

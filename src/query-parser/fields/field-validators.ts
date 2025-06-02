import { Sql } from "../../sql/sql";
import { DatabaseAdapter } from "../../adapters/database-adapter";
import { BuilderContext, FieldHandler } from "../types";
import type { QueryParser } from "../index";

/**
 * FieldValidatorBuilder - Field-Specific Validation Component
 */
export class FieldValidatorBuilder implements FieldHandler {
  readonly name = "FieldValidatorBuilder";
  readonly dependencies: string[] = [];

  constructor(private parser: QueryParser, private adapter: DatabaseAdapter) {}

  canHandle(fieldType: string): boolean {
    return true;
  }

  handle(context: BuilderContext, ...args: any[]): any {
    throw new Error("FieldValidatorBuilder.handle() not implemented yet");
  }
}

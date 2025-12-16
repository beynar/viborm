// Shared types for model schemas

import type { ObjectSchema, BaseSchema } from "valibot";
import type { AnySchema } from "../../fields/common";

/**
 * Schema entries record type
 */
export type SchemaEntries = Record<string, AnySchema>;

/**
 * Core schemas bundle passed to args factories
 */
export interface CoreSchemas {
  where: BaseSchema<any, any, any>;
  whereUnique: ObjectSchema<any, any>;
  create: ObjectSchema<any, any>;
  update: ObjectSchema<any, any>;
  select: ObjectSchema<any, any>;
  include: ObjectSchema<any, any>;
  orderBy: ObjectSchema<any, any>;
  scalarCreate: ObjectSchema<any, any>;
}

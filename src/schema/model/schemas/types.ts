// Shared types for model schemas

import type { ObjectSchema, BaseSchema } from "valibot";
import type { AnySchema } from "../../fields/common";
import type { ModelState } from "../model";
import type {
  WhereSchema,
  WhereUniqueSchema,
  CreateSchema,
  UpdateSchema,
  SelectSchema,
  IncludeSchema,
  OrderBySchema,
  ScalarCreateSchema,
} from "./core";

/**
 * Schema entries record type
 */
export type SchemaEntries = Record<string, AnySchema>;

/**
 * Core schemas bundle passed to args factories
 * Generic over ModelState for proper type inference
 */
export interface CoreSchemas<T extends ModelState = ModelState> {
  where: WhereSchema<T>;
  whereUnique: WhereUniqueSchema<T>;
  create: CreateSchema<T>;
  update: UpdateSchema<T>;
  select: SelectSchema<T>;
  include: IncludeSchema<T>;
  orderBy: OrderBySchema<T>;
  scalarCreate: ScalarCreateSchema<T>;
}

/**
 * Loose CoreSchemas for runtime (without generics)
 */
export interface LooseCoreSchemas {
  where: BaseSchema<any, any, any>;
  whereUnique: ObjectSchema<any, any>;
  create: ObjectSchema<any, any>;
  update: ObjectSchema<any, any>;
  select: ObjectSchema<any, any>;
  include: ObjectSchema<any, any>;
  orderBy: ObjectSchema<any, any>;
  scalarCreate: ObjectSchema<any, any>;
}


// Shared types for model schemas

import type { VibSchema } from "@validation";
import type { ModelState } from "../model";
import type {
  CreateSchema,
  IncludeSchema,
  OrderBySchema,
  ScalarCreateSchema,
  SelectSchema,
  UpdateSchema,
  WhereSchema,
  WhereUniqueSchema,
} from "./core";

/**
 * Schema entries record type
 */
export type SchemaEntries = Record<string, VibSchema>;

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
  where: VibSchema<any, any>;
  whereUnique: VibSchema<any, any>;
  create: VibSchema<any, any>;
  update: VibSchema<any, any>;
  select: VibSchema<any, any>;
  include: VibSchema<any, any>;
  orderBy: VibSchema<any, any>;
  scalarCreate: VibSchema<any, any>;
}

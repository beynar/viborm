/**
 * PostgreSQL Migration Adapter
 *
 * Implements database introspection and DDL generation for PostgreSQL.
 */

import type { MigrationAdapter } from "../../../database-adapter";
import { generateDDL } from "./ddl";
import { getDefaultExpression, getEnumColumnType } from "./defaults";
import { mapFieldType } from "./field-types";
import { introspect } from "./introspect";

export const postgresMigrations: MigrationAdapter = {
  introspect,
  generateDDL,
  mapFieldType,
  getDefaultExpression,
  supportsNativeEnums: true,
  getEnumColumnType,
};

// Mutation Schema Builders
// Builds runtime ArkType schemas for mutation operation arguments

import { type, Type } from "arktype";
import type { CoreSchemas } from "./index";

// =============================================================================
// MUTATION OPERATION SCHEMA BUILDERS
// All mutation schemas use only CoreSchemas - no model access needed
// =============================================================================

export const buildCreateArgsSchema = (core: CoreSchemas): Type =>
  type({
    data: core.create,
    "select?": core.selectNested,
    "include?": core.includeNested,
  });

export const buildUpdateArgsSchema = (core: CoreSchemas): Type =>
  type({
    where: core.whereUnique,
    data: core.update,
    "select?": core.selectNested,
    "include?": core.includeNested,
  });

export const buildUpdateManyArgsSchema = (core: CoreSchemas): Type =>
  type({
    "where?": core.where,
    data: core.update,
  });

export const buildDeleteArgsSchema = (core: CoreSchemas): Type =>
  type({
    where: core.whereUnique,
    "select?": core.selectNested,
    "include?": core.includeNested,
  });

export const buildDeleteManyArgsSchema = (core: CoreSchemas): Type =>
  type({
    "where?": core.where,
  });

export const buildUpsertArgsSchema = (core: CoreSchemas): Type =>
  type({
    where: core.whereUnique,
    create: core.create,
    update: core.update,
    "select?": core.selectNested,
    "include?": core.includeNested,
  });

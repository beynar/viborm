import type { Model, ModelState } from "@schema/model/model";
import type { ObjectSchema } from "@validation/primitives/object";
import type { VibSchema } from "@validation/types";
import v, { type V } from "@validation/primitives/v";

type AnyModel = Model<ModelState>;

// =============================================================================
// COMPOUND ID - @@id([field1, field2])
// =============================================================================

/**
 * Get the compound ID schema from a model's state.
 * Returns the ObjectSchema for the compound primary key if defined.
 */
export type CompoundIdSchema<M extends AnyModel> =
  M["~"]["state"]["compoundId"] extends Record<string, ObjectSchema<any>>
    ? M["~"]["state"]["compoundId"][keyof M["~"]["state"]["compoundId"]]
    : never;

/**
 * Get the name of the compound ID constraint
 */
export type CompoundIdName<M extends AnyModel> =
  M["~"]["state"]["compoundId"] extends Record<string, ObjectSchema<any>>
    ? keyof M["~"]["state"]["compoundId"]
    : never;

/**
 * Build the compound ID schema from a model.
 * Returns undefined if no compound ID is defined.
 *
 * @example
 * const order = s.model({
 *   tenantId: s.string(),
 *   orderId: s.string(),
 *   data: s.json(),
 * }).id(["tenantId", "orderId"]);
 *
 * const compoundIdSchema = getCompoundIdSchema(order);
 * // Schema: { tenantId: string, orderId: string }
 */
export const getCompoundIdSchema = <M extends AnyModel>(
  model: M,
): CompoundIdSchema<M> | undefined => {
  const compoundId = model["~"].state.compoundId;
  if (!compoundId) return undefined;

  const keys = Object.keys(compoundId);
  if (keys.length === 0) return undefined;

  return compoundId[keys[0] as string] as CompoundIdSchema<M>;
};

/**
 * Check if a model has a compound ID
 */
export const hasCompoundId = <M extends AnyModel>(model: M): boolean => {
  const compoundId = model["~"].state.compoundId;
  return compoundId !== undefined && Object.keys(compoundId).length > 0;
};

// =============================================================================
// COMPOUND UNIQUES - All compound constraints (@@id + @@unique)
// Compound IDs are inherently unique, so they're included here
// =============================================================================

/**
 * Merge compound ID and compound uniques into a single record type.
 * Both @@id and @@unique are unique constraints at the database level.
 */
export type CompoundUniqueSchemas<M extends AnyModel> =
  (M["~"]["state"]["compoundId"] extends Record<string, ObjectSchema<any>>
    ? M["~"]["state"]["compoundId"]
    : {}) &
    (M["~"]["state"]["compoundUniques"] extends Record<
      string,
      ObjectSchema<any>
    >
      ? M["~"]["state"]["compoundUniques"]
      : {});

/**
 * Get the names of all compound unique constraints (includes @@id)
 */
export type CompoundUniqueNames<M extends AnyModel> =
  keyof CompoundUniqueSchemas<M>;

/**
 * Get a specific compound unique schema by name
 */
export type CompoundUniqueSchemaByName<
  M extends AnyModel,
  Name extends CompoundUniqueNames<M>,
> = CompoundUniqueSchemas<M>[Name];

/**
 * Build all compound unique schemas from a model (includes @@id).
 * Returns a record where keys are constraint names and values are schemas.
 *
 * @example
 * const order = s.model({
 *   tenantId: s.string(),
 *   orderId: s.string(),
 *   email: s.string(),
 *   slug: s.string(),
 * })
 *   .id(["tenantId", "orderId"])
 *   .unique(["email", "tenantId"]);
 *
 * const compoundUniques = getCompoundUniqueSchemas(order);
 * // { tenantId_orderId: { tenantId, orderId }, email_tenantId: { email, tenantId } }
 */
export const getCompoundUniqueSchemas = <M extends AnyModel>(
  model: M,
): CompoundUniqueSchemas<M> | undefined => {
  const result: Record<string, ObjectSchema<Record<string, VibSchema>>> = {};
  let hasAny = false;

  const compoundId = model["~"].state.compoundId;
  if (compoundId) {
    for (const [key, schema] of Object.entries(compoundId)) {
      result[key] = schema;
      hasAny = true;
    }
  }

  const compoundUniques = model["~"].state.compoundUniques;
  if (compoundUniques) {
    for (const [key, schema] of Object.entries(compoundUniques)) {
      result[key] = schema;
      hasAny = true;
    }
  }

  if (!hasAny) return undefined;

  return result as CompoundUniqueSchemas<M>;
};

/**
 * Get a specific compound unique schema by name
 */
export const getCompoundUniqueSchemaByName = <
  M extends AnyModel,
  Name extends string,
>(
  model: M,
  name: Name,
): ObjectSchema<Record<string, VibSchema>> | undefined => {
  const compoundId = model["~"].state.compoundId;
  if (compoundId?.[name]) return compoundId[name];

  const compoundUniques = model["~"].state.compoundUniques;
  if (compoundUniques?.[name]) return compoundUniques[name];

  return undefined;
};

/**
 * Check if a model has any compound unique constraints (includes @@id)
 */
export const hasCompoundUnique = <M extends AnyModel>(model: M): boolean => {
  const compoundId = model["~"].state.compoundId;
  const compoundUniques = model["~"].state.compoundUniques;

  return (
    (compoundId !== undefined && Object.keys(compoundId).length > 0) ||
    (compoundUniques !== undefined && Object.keys(compoundUniques).length > 0)
  );
};

/**
 * Get all compound unique schemas as a union.
 * Returns a union schema that accepts any of the compound constraints.
 */
export const getCompoundUniqueUnionSchema = <M extends AnyModel>(
  model: M,
): V.Union<readonly ObjectSchema<Record<string, VibSchema>>[]> | undefined => {
  const schemas: ObjectSchema<Record<string, VibSchema>>[] = [];

  const compoundId = model["~"].state.compoundId;
  if (compoundId) {
    for (const schema of Object.values(compoundId)) {
      schemas.push(schema);
    }
  }

  const compoundUniques = model["~"].state.compoundUniques;
  if (compoundUniques) {
    for (const schema of Object.values(compoundUniques)) {
      schemas.push(schema);
    }
  }

  if (schemas.length === 0) return undefined;

  return v.union(schemas) as V.Union<
    readonly ObjectSchema<Record<string, VibSchema>>[]
  >;
};

import { emptyRecord, put } from "@schema/record";
import type { AnyRelation } from "@schema/relation";
import { refuseRelationInput } from "@schema/relation/terminal";
// Deep import: the references-stage predicate is the `s.model(...)` boundary's
// own instrument and is deliberately not part of the relation package surface.
import { isReferencesStage } from "@schema/relation/to-one";
import type { Scalar } from "@schema/scalars/base";

/**
 * Record of model fields - the canonical type for scalar and relation definitions.
 * A model field is either a scalar or a relation; ONE relation map holds both
 * target domains.
 */
export type AnyModelField = Scalar | AnyRelation;
export type ModelShape = Record<string, AnyModelField>;

export type NameFromKeys<
  TFields extends string[],
  TName extends string = "",
> = TFields extends readonly [
  infer F extends string,
  ...infer R extends string[],
]
  ? R extends []
    ? `${TName}_${F}`
    : NameFromKeys<R, TName extends "" ? F : `${TName}_${F}`>
  : never;

export interface CompoundConstraint<
  TFields extends string[],
  TName extends string | undefined = undefined,
> {
  fields: TFields;
  name: TName extends undefined ? NameFromKeys<TFields> : TName;
}

/** Any compound constraint (for loose typing) */
export type AnyCompoundConstraint = CompoundConstraint<string[]>;

export type ToString<T> = T extends
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  ? `${T}`
  : never;

export type StringKeyOf<T extends Record<string, any>> = {
  [K in keyof T]: K extends string ? K : never;
}[keyof T];

export type ScalarKeys<T extends ModelShape> = {
  [K in keyof T]: T[K] extends Scalar ? ToString<K> : never;
}[keyof T];

/** Extract relation keys from ModelState */
export type RelationKeys<T extends ModelShape> = {
  [K in keyof T]: T[K] extends AnyRelation ? ToString<K> : never;
}[keyof T];

export type RequiredScalarKeys<T extends ModelShape> = {
  [K in keyof T]: T[K] extends Scalar
    ? T[K]["~"]["state"]["optional"] extends true
      ? never
      : ToString<K>
    : never;
}[keyof T];

export type UniqueScalarKeys<T extends ModelShape> = {
  [K in keyof T]: T[K] extends Scalar
    ? T[K]["~"]["state"]["isId"] extends true
      ? ToString<K>
      : T[K]["~"]["state"]["isUnique"] extends true
        ? ToString<K>
        : never
    : never;
}[keyof T];

/** Numeric scalar types for aggregations (avg, sum) */
export type NumericScalarType = "int" | "float" | "decimal" | "bigint";

/** Extract keys of numeric scalars from a ModelShape */
export type NumericScalarKeys<T extends ModelShape> = {
  [K in keyof T]: T[K] extends Scalar
    ? T[K]["~"]["state"]["type"] extends NumericScalarType
      ? ToString<K>
      : never
    : never;
}[keyof T];

export type ScalarMap<T extends ModelShape> = {
  [K in ScalarKeys<T>]: T[K] extends Scalar ? T[K] : never;
};

export type RelationMap<T extends ModelShape> = {
  [K in RelationKeys<T>]: T[K] extends AnyRelation ? T[K] : never;
};

export type UniqueScalarMap<T extends ModelShape> = {
  [K in UniqueScalarKeys<T>]: T[K] extends Scalar ? T[K] : never;
};

/**
 * ONE relation boundary, keyed on the internal brand.
 *
 * Trusted relation state originates only in `s.toOne` / `s.toMany`, and both
 * target domains carry `kind: "relation"` — so a model has one relation map and
 * no consumer has to ask which family a member belongs to. Scalars keep
 * `state.type`, so the two brands cannot collide.
 */
function isRelation(value: unknown): value is AnyRelation {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return false;
  }
  const internal = Reflect.get(value, "~");
  if (typeof internal !== "object" || internal === null) return false;
  const state = Reflect.get(internal, "state");
  return (
    typeof state === "object" &&
    state !== null &&
    Reflect.get(state, "kind") === "relation"
  );
}

const SCALAR_TYPES = new Set<string>([
  "string",
  "int",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "date",
  "time",
  "bigint",
  "json",
  "blob",
  "vector",
  "point",
  "enum",
]);

function isScalar(value: unknown): value is Scalar {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return false;
  }
  const internal = Reflect.get(value, "~");
  if (typeof internal !== "object" || internal === null) return false;
  const state = Reflect.get(internal, "state");
  if (typeof state !== "object" || state === null) return false;
  const type = Reflect.get(state, "type");
  return typeof type === "string" && SCALAR_TYPES.has(type);
}

/**
 * The classified member maps are a PROJECTION of the shape: every member an
 * extractor recognizes appears in the map that claims it, under the key the
 * shape gave it. A shape key comes from the caller — a hand-written literal, a
 * generated schema, a JSON document's field name — so it can be any string, and
 * `map[key] = value` would lose a `__proto__` member to `Object.prototype`'s
 * setter, leaving `state.shape` and `state.scalars` disagreeing with no
 * diagnostic anywhere. `emptyRecord`/`put` make that unrepresentable: a data key
 * can only ever be an own entry.
 *
 * Whether such a key is a LEGAL identifier is a separate question with a
 * separate owner (`isValidSchemaIdentifier`, enforced at hydration and by the
 * document reader). Keeping the member is what lets that owner name it.
 */
export const extractScalarMap = <T extends ModelShape>(fields: T) => {
  const scalars = emptyRecord<Scalar>();
  for (const [key, value] of Object.entries(fields)) {
    if (isScalar(value)) {
      put(scalars, key, value);
    }
  }
  return scalars as ScalarMap<T>;
};

/**
 * The `s.model(...)` member-classification boundary for relations.
 *
 * It gains exactly ONE refusal: a transient references stage — a chain that
 * started `.fields(...)` and never received `.references(...)` — is rejected
 * loudly rather than silently dropped, because that member declares a foreign
 * key the schema would then never have. Every other unrecognized member keeps
 * its existing silent-drop behavior; widening that is a separate decision.
 */
export const extractRelationMap = <T extends ModelShape>(fields: T) => {
  const relations = emptyRecord<AnyRelation>();
  for (const [key, value] of Object.entries(fields)) {
    if (isRelation(value)) {
      put(relations, key, value);
    } else if (isReferencesStage(value)) {
      refuseRelationInput(
        "s.model",
        key,
        `Relation '${key}' started \`.fields(...)\` without \`.references(...)\`; complete the foreign key before using it as a model field`
      );
    }
  }
  return relations as RelationMap<T>;
};

export const extractUniqueScalarMap = <T extends ModelShape>(fields: T) => {
  const uniques = emptyRecord<Scalar>();
  for (const [key, value] of Object.entries(fields)) {
    if (
      isScalar(value) &&
      (value["~"].state.isUnique || value["~"].state.isId)
    ) {
      put(uniques, key, value);
    }
  }
  return uniques as UniqueScalarMap<T>;
};

export const getNameFromKeys = <
  Name extends string | undefined,
  TFields extends any[],
>(
  name: Name,
  fields: TFields
) => {
  return (
    name ??
    (fields.join("_") as Name extends undefined ? NameFromKeys<TFields> : Name)
  );
};

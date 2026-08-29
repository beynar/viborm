// The interpreter: a document, read through the SAME public builders a human
// calls.
//
// There is no second schema representation here. `s.model`, `s.string()`,
// `s.toOne(...)` produce the real classes, so hydration, the resolution gate,
// the query engine and migrations consume the result unchanged and emit their
// existing diagnostics for free. What this file owns is the ORDER in which
// modifiers are applied and the conversion of a JSON literal into the value a
// builder takes; every refusal below either belongs to a builder and is
// re-thrown with the document location, or is a fact only a document can state.
//
// The parser never interns models, scalars or relation terminals across calls:
// write-once model naming (`M003`) and the per-terminal `settleTarget` once-cell
// both punish a reused declaration, so every parse is a fresh object graph.

import type { Schema } from "@schema/hydration";
import type { AnyModel } from "@schema/model";
import type { ModelShape } from "@schema/model/helper";
import { model as modelFactory } from "@schema/model/model";
import { toMany, toOne } from "@schema/relation";
import type { Getter } from "@schema/relation/types";
import { enumScalar } from "@schema/scalars";
import type { Scalar } from "@schema/scalars/base";
import type { ScalarType } from "@schema/scalars/common";
import {
  buildDecimalScalar,
  DecimalScalar,
  withValidatedDecimalDefault,
} from "@schema/scalars/decimal/scalar";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { JsonValue } from "@validation/primitives/json";
import { toError } from "../../errors/diagnostic-safety";
import { decodeDefault } from "./default-codec";
import type {
  EnumDocument,
  EnumFieldDocument,
  GenerateDocument,
  ModelDocument,
  ModelTargetDocument,
  RelationFieldDocument,
  ScalarFieldDocument,
  SchemaDocument,
  VariantTargetDocument,
} from "./document";
import { isRelationField } from "./document";
import { builderMethod, SCALAR_FACTORIES } from "./factories";
import {
  addIssue,
  type DocumentIssues,
  documentRoot,
  pointer,
  refuseDocument,
  refuseFromBuilder,
} from "./issues";

/**
 * Standard Schema validators to attach, keyed `"<model>.<field>"`.
 *
 * `.schema()` has no document spelling — a validator is arbitrary code — so a
 * hybrid codebase contributes them here, where the interpreter can apply them
 * LAST, after `.nullable()`/`.array()` have finished rebuilding the base.
 */
export type FieldSchemaMap = Record<string, StandardSchemaV1<any, any>>;

/**
 * Build a schema from a document.
 *
 * Pass 1 creates every model against a registry that is still filling; a
 * relation target is `() => registry[key]`, and nothing invokes a getter before
 * the resolution gate, which runs after the registry is complete. The getter
 * returns the registered object BY IDENTITY, which is what the gate requires.
 */
export function interpret(
  document: SchemaDocument,
  fieldSchemas?: FieldSchemaMap
): Schema {
  const registry: Schema = {};
  const modelsPath = pointer(documentRoot, "models");
  refuseUnknownFieldSchemas(document, fieldSchemas);
  for (const [modelKey, modelDocument] of Object.entries(document.models)) {
    registry[modelKey] = buildModel(
      modelKey,
      modelDocument,
      document,
      registry,
      pointer(modelsPath, modelKey),
      fieldSchemas
    );
  }
  return registry;
}

/**
 * A validator keyed to a field the schema does not have hides nothing and
 * validates nothing — the same silence `.omit()` refuses at the type level.
 */
function refuseUnknownFieldSchemas(
  document: SchemaDocument,
  fieldSchemas: FieldSchemaMap | undefined
): void {
  if (fieldSchemas === undefined) return;
  const issues: DocumentIssues = [];
  for (const path of Object.keys(fieldSchemas)) {
    const separator = path.indexOf(".");
    const field =
      document.models[path.slice(0, separator)]?.fields[
        path.slice(separator + 1)
      ];
    if (field !== undefined && !isRelationField(field)) continue;
    addIssue(
      issues,
      documentRoot,
      "J006",
      `Field schema '${path}' does not name a scalar field of this schema; spell it '<model>.<field>'`
    );
  }
  if (issues.length > 0) throw refuseDocument(issues);
}

// =============================================================================
// MODEL
// =============================================================================

function buildModel(
  modelKey: string,
  document: ModelDocument,
  schema: SchemaDocument,
  registry: Schema,
  path: string,
  fieldSchemas: FieldSchemaMap | undefined
): AnyModel {
  const fieldsPath = pointer(path, "fields");
  const shape: ModelShape = {};
  for (const [fieldKey, field] of Object.entries(document.fields)) {
    const fieldPath = pointer(fieldsPath, fieldKey);
    if (isRelationField(field)) {
      shape[fieldKey] = buildRelation(field, registry, fieldPath);
      continue;
    }
    shape[fieldKey] = buildScalar(
      field,
      schema,
      fieldPath,
      fieldSchemas?.[`${modelKey}.${fieldKey}`]
    );
  }

  let model: AnyModel = call(path, () => modelFactory(shape));
  if (document.table !== undefined) {
    const table = document.table;
    model = call(pointer(path, "table"), () => model.map(table));
  }
  for (const [position, index] of (document.indexes ?? []).entries()) {
    const indexPath = pointer(path, "indexes", String(position));
    const options = {
      ...(index.name === undefined ? {} : { name: index.name }),
      ...(index.unique === undefined ? {} : { unique: index.unique }),
      ...(index.type === undefined ? {} : { type: index.type }),
    };
    model = call(indexPath, () => model.index(index.fields, options));
  }
  for (const [position, compound] of (document.ids ?? []).entries()) {
    const idPath = pointer(path, "ids", String(position));
    model = call(idPath, () =>
      model.id(compound.fields, options(compound.name))
    );
  }
  for (const [position, compound] of (document.uniques ?? []).entries()) {
    const uniquePath = pointer(path, "uniques", String(position));
    model = call(uniquePath, () =>
      model.unique(compound.fields, options(compound.name))
    );
  }
  if (document.omit !== undefined) {
    const hidden: Record<string, true> = {};
    for (const name of document.omit) hidden[name] = true;
    model = call(pointer(path, "omit"), () => model.omit(hidden));
  }
  return model;
}

function options(name: string | undefined): { name?: string } {
  return name === undefined ? {} : { name };
}

// =============================================================================
// SCALAR
// =============================================================================

/**
 * The fixed modifier order.
 *
 * `.array()` and `.nullable()` rebuild the base schema from the OTHER flags, so
 * they run first and in this order; `.id()` installs a generator that a later
 * `generate` may replace; `.default()` is validated against the base those
 * first two produced; `.map()` renames a column and depends on nothing.
 * `.schema()` rebuilds the base too, and runs last so a contributed validator
 * sees the finished nullability and arity.
 */
function buildScalar(
  document: ScalarFieldDocument,
  schema: SchemaDocument,
  path: string,
  fieldSchema: StandardSchemaV1<any, any> | undefined
): Scalar {
  const type = document.type;
  let scalar = createScalar(document, schema, path);
  if (document.array) {
    scalar = modify(scalar, "array", [], type, pointer(path, "array"));
  }
  if (document.nullable) {
    scalar = modify(scalar, "nullable", [], type, pointer(path, "nullable"));
  }
  if (document.id) {
    scalar = modify(scalar, "id", [], type, pointer(path, "id"));
  }
  if (document.unique) {
    scalar = modify(scalar, "unique", [], type, pointer(path, "unique"));
  }
  if (document.withoutTimezone) {
    scalar = modify(
      scalar,
      "withoutTimezone",
      [],
      type,
      pointer(path, "withoutTimezone")
    );
  }
  if (document.dimension !== undefined) {
    scalar = modify(
      scalar,
      "dimension",
      [document.dimension],
      type,
      pointer(path, "dimension")
    );
  }
  if (document.generate !== undefined) {
    scalar = applyGenerate(scalar, document.generate, type, path);
  }
  const literal = document.default;
  if (literal !== undefined) {
    scalar = applyDefault(scalar, document, literal, path);
  }
  if (document.column !== undefined) {
    scalar = modify(
      scalar,
      "map",
      [document.column],
      type,
      pointer(path, "column")
    );
  }
  if (fieldSchema !== undefined) {
    scalar = modify(
      scalar,
      "schema",
      [fieldSchema],
      type,
      pointer(path, "schema")
    );
  }
  return scalar;
}

function createScalar(
  document: ScalarFieldDocument,
  schema: SchemaDocument,
  path: string
): Scalar {
  if (document.type === "decimal") {
    // The domain is the factory's ARGUMENT, not a modifier, because a decimal
    // has no state without it. The two numbers are handed over exactly as the
    // node carries them — `s.decimal` owns whether they name a domain, and
    // `call` turns its refusal into this node's issue.
    const { precision, scale } = document;
    return call(path, () => buildDecimalScalar({ precision, scale }));
  }
  if (document.type !== "enum") {
    const factory = SCALAR_FACTORIES[document.type];
    return call(path, () => factory(document.native));
  }
  const definition = resolveEnum(document, schema, path);
  const scalar = call(path, () =>
    enumScalar(definition.values, document.native)
  );
  if (definition.name === undefined) return scalar;
  const name = definition.name;
  return modify(scalar, "name", [name], "enum", pointer(path, "enum"));
}

/**
 * An enum field states its values inline or names an `enums` definition. The
 * definition's `name` is the DB type; without one, each column keeps its own
 * derived type — the same fact `.name()` decides for a coded schema.
 *
 * This is the one owner of the `enums` reference: the first boundary that needs
 * the definition, so a dangling reference is refused exactly once.
 */
function resolveEnum(
  document: EnumFieldDocument,
  schema: SchemaDocument,
  path: string
): EnumDocument {
  const reference = document.enum;
  if (Array.isArray(reference)) return { values: reference };
  const definition = schema.enums?.[reference];
  if (definition !== undefined) return definition;
  const issues: DocumentIssues = [];
  addIssue(
    issues,
    pointer(path, "enum"),
    "J006",
    `\`enum\` names '${reference}', which \`enums\` does not declare`
  );
  throw refuseDocument(issues);
}

/**
 * Apply one modifier BY NAME.
 *
 * The scalar class surface is the only table of which modifiers a type has, and
 * an absent method is exactly what "this type has no such modifier" means. Blob
 * refuses `array`/`id`/`unique` by throwing instead — a deliberate runtime
 * refusal — and that throw comes back as this node's own issue.
 */
function modify(
  scalar: Scalar,
  name: string,
  args: unknown[],
  type: ScalarType,
  path: string
): Scalar {
  const method = builderMethod(scalar, name);
  if (method === undefined) {
    const issues: DocumentIssues = [];
    addIssue(
      issues,
      path,
      "J007",
      `A '${type}' field has no '${name}' modifier`
    );
    throw refuseDocument(issues);
  }
  return call(path, () => method.apply(scalar, args));
}

/**
 * `generate.kind` names the scalar method that installs the generator, so the
 * seven tokens are the seven methods.
 *
 * Whether that method TAKES a prefix or a length is read back from the state it
 * wrote rather than from a second arity table: a generator that ignored the
 * argument records nothing, and a declaration the builder cannot honor is
 * refused instead of silently dropped.
 */
function applyGenerate(
  scalar: Scalar,
  generate: GenerateDocument,
  type: ScalarType,
  path: string
): Scalar {
  const generatePath = pointer(path, "generate");
  const args =
    generate.kind === "nanoid"
      ? [generate.length, generate.prefix]
      : [generate.prefix];
  const generated = modify(scalar, generate.kind, args, type, generatePath);
  const applied = generated["~"].state.autoGenerate;
  if (
    applied?.prefix === generate.prefix &&
    applied?.length === generate.length
  ) {
    return generated;
  }
  const issues: DocumentIssues = [];
  addIssue(
    issues,
    generatePath,
    "J007",
    `The '${generate.kind}' generator does not take the 'prefix' or 'length' this node declares`
  );
  throw refuseDocument(issues);
}

/**
 * A literal default, converted into the value the field's own domain holds.
 *
 * The codec owns the conversion — which tag denotes which domain, how deep it
 * reaches, and what a cycle costs. What is owned HERE is the check that follows
 * it: defaults BYPASS validation downstream — the create schema substitutes a
 * default without checking it — so a wrong-typed one is a late failure at bind
 * time. The field's own base schema is the single statement of its domain, and
 * checking against it here moves that failure to the document that wrote it.
 */
function applyDefault(
  scalar: Scalar,
  document: ScalarFieldDocument,
  literal: JsonValue,
  path: string
): Scalar {
  const defaultPath = pointer(path, "default");
  const value = decodeDefault(literal, defaultPath);
  const verdict = scalar["~"].state.base["~standard"].validate(value);
  if (verdict.issues) {
    const issues: DocumentIssues = [];
    addIssue(
      issues,
      defaultPath,
      "J008",
      `A '${document.type}' default must be a value of the field's own domain: ${verdict.issues.map((issue) => issue.message).join("; ")}`
    );
    throw refuseDocument(issues);
  }
  if (scalar instanceof DecimalScalar) {
    return withValidatedDecimalDefault(scalar, verdict.value);
  }
  return modify(scalar, "default", [value], document.type, defaultPath);
}

// =============================================================================
// RELATION
// =============================================================================

function buildRelation(
  document: RelationFieldDocument,
  registry: Schema,
  path: string
) {
  const relation =
    document.target === undefined
      ? buildVariantRelation(document, registry, path)
      : buildModelRelation(document, registry, path);
  if (document.name === undefined) return relation;
  const name = document.name;
  return call(pointer(path, "name"), () => relation.name(name));
}

function buildModelRelation(
  document: ModelTargetDocument,
  registry: Schema,
  path: string
) {
  const target = document.target;
  const getter: Getter = () => registry[target];
  const factory = document.type === "toOne" ? toOne : toMany;
  let relation = call(path, () => Reflect.apply(factory, undefined, [getter]));
  if (document.fields !== undefined) {
    const fields = document.fields;
    relation = call(pointer(path, "fields"), () => relation.fields(...fields));
  }
  if (document.references !== undefined) {
    const references = document.references;
    relation = call(pointer(path, "references"), () =>
      relation.references(...references)
    );
  }
  for (const action of ["onDelete", "onUpdate"] as const) {
    const value = document[action];
    if (value === undefined) continue;
    relation = call(pointer(path, action), () => relation[action](value));
  }
  if (document.junction !== undefined) {
    relation = applyJunction(relation, document.junction, path);
  }
  return relation;
}

function buildVariantRelation(
  document: VariantTargetDocument,
  registry: Schema,
  path: string
) {
  const variants: Record<string, Getter> = {};
  for (const [key, target] of Object.entries(document.variants)) {
    variants[key] = () => registry[target];
  }
  const factory = document.type === "toOne" ? toOne : toMany;
  const args =
    document.values === undefined
      ? [variants]
      : [variants, { values: document.values }];
  let relation = call(path, () => Reflect.apply(factory, undefined, args));
  if (document.through !== undefined) {
    const through = document.through;
    relation = call(pointer(path, "through"), () => relation.through(through));
  }
  if (document.optional) {
    relation = call(pointer(path, "optional"), () => relation.optional());
  }
  return relation;
}

/**
 * Junction overrides are four independent modifiers, not one bag: the document
 * nests them so `target` cannot collide with the relation's own target key, and
 * each declared key becomes the call that writes it.
 */
function applyJunction(
  relation: any,
  junction: NonNullable<ModelTargetDocument["junction"]>,
  path: string
) {
  let overridden = relation;
  const junctionPath = pointer(path, "junction");
  for (const key of [
    "table",
    "source",
    "target",
    "onDelete",
    "onUpdate",
  ] as const) {
    const value = junction[key];
    if (value === undefined) continue;
    const method = key === "table" ? "through" : key;
    overridden = call(pointer(junctionPath, key), () =>
      overridden[method](value)
    );
  }
  return overridden;
}

// =============================================================================
// BUILDER ENTRY
// =============================================================================

/**
 * Enter a builder, and give its refusal the document location that produced it.
 *
 * Every semantic refusal in the declaration surface belongs to a builder — a
 * blob that cannot be an array, an incomplete foreign key, a stored-value bag
 * that is not exact, a junction token that is not an identifier. None of them
 * is restated here; each keeps its own message and becomes the `cause`.
 */
function call<T>(path: string, build: () => T): T {
  try {
    return build();
  } catch (thrown) {
    return refuseFromBuilder(path, toError(thrown));
  }
}

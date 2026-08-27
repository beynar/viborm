// The reverse direction: a coded schema stated as a document.
//
// It walks `model["~"].state` and reads DECLARATIONS, not the resolved
// topology — the resolver derives foreign-key ownership, junction naming and
// slot nullability, and emitting those would put facts in the document the
// author never wrote.
//
// It does NOT mutate the schema it is given. Hydration write-once-binds a model
// to a schema key and `settleTarget` permanently caches a getter's outcome
// (including a thrown Error), so a serializer that hydrated would foreclose
// ever binding those models under other keys and would poison a terminal whose
// getter throws. Target keys come from an identity scan of the caller's own
// record instead, which means an unbound — or even topologically broken —
// schema stays dumpable for diagnosis.
//
// `{ validate: true }` DELIBERATELY GIVES THAT UP, and is off by default for
// exactly this reason. Refusing garbage before emitting it means running the
// validator, and the validator hydrates and settles — so an opted-in call binds
// the passed record's keys and settles its targets, precisely as `createClient`
// would. Diagnosis keeps the default; a producer that means to publish a
// document asks for the check.

import type { Schema } from "@schema/hydration";
import { isValidSchemaIdentifier } from "@schema/identifier";
import type { AnyModel } from "@schema/model";
import type { IndexDefinition } from "@schema/model/model";
import { emptyRecord, own, put } from "@schema/record";
import type {
  AnyRelation,
  Getter,
  RelationState,
  VariantEntry,
  VariantRelationState,
} from "@schema/relation/types";
import { isVariantRelationState } from "@schema/relation/types";
import type { Scalar } from "@schema/scalars/base";
import { isGeneratorDefault, type ScalarState } from "@schema/scalars/common";
import type { JsonValue } from "@validation/primitives/json";
import type { ObjectSchema } from "@validation/primitives/object";
import { isFunction } from "@validation/value-guards";
import { encodeDefault } from "./default-codec";
import type {
  CompoundKeyDocument,
  EnumDocument,
  FieldDocument,
  IndexDocument,
  JunctionDocument,
  ModelDocument,
  ModelTargetDocument,
  RelationFieldDocument,
  ScalarFieldDocument,
  SchemaDocument,
  VariantJunctionDocument,
  VariantTargetDocument,
} from "./document";
import { SCHEMA_DOCUMENT_VERSION } from "./document";
import { builderMethod } from "./factories";
import {
  addIssue,
  type DocumentIssues,
  documentRoot,
  pointer,
  refuseDocument,
  throwIfRefused,
  toError,
} from "./issues";
import { isNativeTypeInCatalog, nativeTypeRefusal } from "./native-catalog";
import type { ExactSchemaJsonOptions, SchemaJsonOptions } from "./validate";
import { readValidateOption, validateGraph } from "./validate";

/**
 * The `enums` section under construction: the definitions keyed by document
 * REF, plus the database-name → ref map that makes two fields naming one
 * database enum type share one definition.
 */
type EnumRegistry = {
  readonly refs: Map<string, string>;
  readonly definitions: Record<string, EnumDocument>;
};

/**
 * Write the document a schema denotes.
 *
 * Every refusal below names a fact the format cannot carry, loudly — a silent
 * drop would produce a document that parses into a DIFFERENT schema, which is
 * the one failure a round trip must not have.
 *
 * `{ validate: true }` runs the schema validator FIRST — the same full rule list
 * `push` and the CLI run — so a schema whose graph does not resolve is refused
 * before a single node is emitted, in the validator's own vocabulary
 * (`SchemaValidationError`, `M0xx`/`R0xx`/`P0xx`), never as a `J0xx` code.
 *
 * It costs the non-mutation guarantee: validating hydrates the schema under the
 * keys of the record passed here and settles its relation targets. The default
 * keeps the guarantee, and keeps a broken schema dumpable.
 */
export function serializeSchema<
  Options extends SchemaJsonOptions = SchemaJsonOptions,
>(schema: Schema, options?: ExactSchemaJsonOptions<Options>): SchemaDocument {
  if (readValidateOption(options)) validateGraph(schema);
  const issues: DocumentIssues = [];
  const enums: EnumRegistry = { refs: new Map(), definitions: emptyRecord() };
  const models = emptyRecord<ModelDocument>();
  const modelsPath = pointer(documentRoot, "models");
  for (const [modelKey, model] of Object.entries(schema)) {
    put(
      models,
      modelKey,
      serializeModel(
        model,
        schema,
        enums,
        pointer(modelsPath, modelKey),
        issues
      )
    );
  }
  throwIfRefused(issues);
  const document: SchemaDocument = {
    version: SCHEMA_DOCUMENT_VERSION,
    models,
  };
  if (Object.keys(enums.definitions).length > 0) {
    document.enums = enums.definitions;
  }
  return document;
}

function serializeModel(
  model: AnyModel,
  schema: Schema,
  enums: EnumRegistry,
  path: string,
  issues: DocumentIssues
): ModelDocument {
  const state = model["~"].state;
  const relations: Record<string, AnyRelation> = state.relations;
  const scalars: Record<string, Scalar> = state.scalars;
  const fields = emptyRecord<FieldDocument>();
  const fieldsPath = pointer(path, "fields");
  // `shape` holds scalars and relations interleaved in DECLARATION order, and
  // that order is the document's own — DDL column order follows it.
  for (const fieldKey of Object.keys(state.shape)) {
    const relation = own(relations, fieldKey);
    const scalar = own(scalars, fieldKey);
    const fieldPath = pointer(fieldsPath, fieldKey);
    if (relation !== undefined) {
      put(
        fields,
        fieldKey,
        serializeRelation(relation, schema, fieldPath, issues)
      );
      continue;
    }
    if (scalar !== undefined) {
      put(fields, fieldKey, serializeScalar(scalar, enums, fieldPath, issues));
    }
    // A shape member that is neither is one `s.model(...)` already dropped;
    // the document states what the model holds, not what was handed to it.
  }

  const document: ModelDocument = { fields };
  if (state.tableName !== undefined) document.table = state.tableName;
  const indexes = serializeIndexes(state.indexes, path, issues);
  if (indexes.length > 0) document.indexes = indexes;
  const ids = serializeCompound(state.compoundId);
  if (ids.length > 0) document.ids = ids;
  const uniques = serializeCompound(state.compoundUniques);
  if (uniques.length > 0) document.uniques = uniques;
  if (state.omit !== undefined) {
    // Canonical order: `omit` is a set spelled as an array.
    document.omit = Object.keys(state.omit).sort();
  }
  return document;
}

function serializeIndexes(
  indexes: readonly IndexDefinition[],
  path: string,
  issues: DocumentIssues
): IndexDocument[] {
  const documents: IndexDocument[] = [];
  for (const [position, index] of indexes.entries()) {
    const indexPath = pointer(path, "indexes", String(position));
    if (index.options.where !== undefined) {
      addIssue(
        issues,
        indexPath,
        "J009",
        "This index carries a `where` predicate — raw SQL the v1 document refuses to carry. Drop the partial index or keep this schema in code"
      );
      continue;
    }
    const document: IndexDocument = { fields: [...index.fields] };
    if (index.options.name !== undefined) document.name = index.options.name;
    if (index.options.unique !== undefined) {
      document.unique = index.options.unique;
    }
    if (index.options.type !== undefined) document.type = index.options.type;
    documents.push(document);
  }
  return documents;
}

/**
 * A compound constraint's fields are the keys of the object schema `.id()` /
 * `.unique()` built, and its name is the record key. A name equal to the
 * default — the fields joined by `_` — is the ABSENCE of a name, so the
 * canonical document omits it.
 */
function serializeCompound(
  constraints: Record<string, ObjectSchema<Record<string, unknown>>> | undefined
): CompoundKeyDocument[] {
  const documents: CompoundKeyDocument[] = [];
  for (const [name, schema] of Object.entries(constraints ?? {})) {
    const fields = Object.keys(schema.entries);
    const document: CompoundKeyDocument = { fields };
    if (name !== fields.join("_")) document.name = name;
    documents.push(document);
  }
  return documents;
}

// =============================================================================
// SCALAR
// =============================================================================

function serializeScalar(
  scalar: Scalar,
  enums: EnumRegistry,
  path: string,
  issues: DocumentIssues
): ScalarFieldDocument {
  const state = scalar["~"].state;
  const document: ScalarFieldDocument =
    state.type === "enum"
      ? {
          type: "enum",
          enum: serializeEnum(scalar, state, enums, path, issues),
        }
      : { type: state.type };
  const native = scalar["~"].nativeType;
  if (native !== undefined) {
    // The catalog owns `native.type` at the parse boundary, where the document
    // is untrusted. Emitting a value that gate would refuse would write a
    // document this parser cannot read back — a round trip that loses a schema —
    // so the same rule refuses it here, by name.
    if (isNativeTypeInCatalog(native.db, native.type)) {
      // Copy `{ db, type }`: the document is the caller's to edit, and it must
      // not alias the scalar's own native object (mutating one would reach the
      // other's declaration state).
      document.native = { db: native.db, type: native.type };
    } else {
      addIssue(
        issues,
        pointer(path, "native", "type"),
        "J011",
        nativeTypeRefusal(native.db)
      );
    }
  }
  if (state.array) document.array = true;
  if (state.nullable) document.nullable = true;
  if (state.isId) document.id = true;
  // `.id()` implies uniqueness; only a standalone `.unique()` is a declaration.
  if (state.isUnique && !state.isId) document.unique = true;
  // `withTimezone` starts `false` for every scalar and `true` for the two whose
  // factories set it, so the modifier's PRESENCE is what tells a declaration
  // apart from a state that never had the fact.
  if (
    state.withTimezone === false &&
    builderMethod(scalar, "withoutTimezone") !== undefined
  ) {
    document.withoutTimezone = true;
  }
  if (state.dimension !== undefined) document.dimension = state.dimension;
  if (state.columnName !== undefined) document.column = state.columnName;
  if (state.autoGenerate !== undefined) {
    document.generate = { kind: state.autoGenerate.kind };
    if (state.autoGenerate.prefix !== undefined) {
      document.generate.prefix = state.autoGenerate.prefix;
    }
    if (state.autoGenerate.length !== undefined) {
      document.generate.length = state.autoGenerate.length;
    }
  }
  if (state.schema !== undefined) {
    addIssue(
      issues,
      path,
      "J009",
      "This field carries a custom `.schema()` validator — arbitrary code the document cannot hold. Re-attach it with `attachFieldSchemas`"
    );
  }
  const literal = serializeDefault(state, path, issues);
  if (literal !== undefined) document.default = literal;
  return document;
}

/**
 * The two names an enum has.
 *
 * `enumName` is the only fact that decides ONE database enum type, so a named
 * enum becomes a shared `enums` definition and an anonymous one stays inline,
 * keeping its per-column derived type. But a database identifier is NOT a
 * document reference: `status-v2` is a perfectly good database type name and
 * not a schema identifier, and `__proto__` is a name a caller can pass and a
 * property every object already has. The REF addresses the definition inside
 * this document and follows the identifier grammar the parser enforces; `name`
 * carries the database's own spelling. Two different value sets under one
 * database name are two types with one name: a state the document cannot hold
 * and the migration serializer silently resolves in favour of whichever it met
 * first.
 */
function serializeEnum(
  scalar: Scalar,
  state: ScalarState,
  enums: EnumRegistry,
  path: string,
  issues: DocumentIssues
): string | string[] {
  const values = readEnumValues(scalar);
  const name = state.enumName;
  if (name === undefined) return values;
  const existing = enums.refs.get(name);
  if (existing !== undefined) {
    const definition = own(enums.definitions, existing);
    if (!sameValues(definition?.values, values)) {
      addIssue(
        issues,
        path,
        "J009",
        `Enum type '${name}' is declared with two different value sets; one database enum type holds one set`
      );
    }
    return existing;
  }
  const ref = claimRef(name, enums);
  enums.refs.set(name, ref);
  put(enums.definitions, ref, { values, name });
  return ref;
}

/**
 * The document key one database enum name gets.
 *
 * Its own spelling when that is already an identifier and nothing has claimed
 * it, which keeps the ordinary document readable; otherwise the first free
 * `enum_<n>`, numbered by DECLARATION ORDER so one schema always writes one
 * document. The taken-check runs for the identifier case too: a database name
 * of `enum_1` can arrive after a derived key has taken it.
 */
function claimRef(name: string, enums: EnumRegistry): string {
  const taken = (candidate: string): boolean =>
    own(enums.definitions, candidate) !== undefined;
  if (isValidSchemaIdentifier(name) && !taken(name)) return name;
  let index = enums.refs.size + 1;
  while (taken(`enum_${index}`)) index += 1;
  return `enum_${index}`;
}

/**
 * Two value sets are the same ONLY element for element. A joined-string compare
 * would call `["a b", "c"]` and `["a", "b c"]` equal — both join to `"a b c"` —
 * and let the second silently inherit the first's values.
 */
function sameValues(
  left: readonly string[] | undefined,
  right: readonly string[]
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * An enum scalar's values live in its base schema and are published by the
 * class's own `enumValues` getter — the same read the migration serializer
 * makes. `state.type === "enum"` is the guarantee that the getter is there.
 */
function readEnumValues(scalar: Scalar): string[] {
  const values: string[] = Reflect.get(scalar, "enumValues");
  return [...values];
}

/**
 * The literal a `.default(...)` holds, stated as JSON by the codec.
 *
 * `.nullable()` installs `default: null` as a side effect, so a null default on
 * a nullable field is the nullability being restated and never a declaration.
 * `.increment()` installs a generator with no value at all.
 */
function serializeDefault(
  state: ScalarState,
  path: string,
  issues: DocumentIssues
): JsonValue | undefined {
  if (!state.hasDefault) return;
  const value = state.default;
  if (value === undefined) return;
  if (value === null) return state.nullable ? undefined : null;
  if (isFunction(value)) return serializeFunctionDefault(state, path, issues);
  return encodeDefault(value, pointer(path, "default"), issues);
}

/**
 * A function default is either the generator's own closure — already stated by
 * `generate`, so it is omitted — or a caller's, which the document cannot hold.
 *
 * `autoGenerate !== undefined` does NOT decide which: a generator writes both
 * facts, and a later `.default(fn)` replaces only the closure, leaving the
 * generator declaration in place. Emitting `generate` on that state would
 * publish a field that produces random values where the original produced a
 * fixed one, so the closure's own IDENTITY decides, recorded by the modifiers
 * that installed it.
 */
function serializeFunctionDefault(
  state: ScalarState,
  path: string,
  issues: DocumentIssues
): undefined {
  if (state.autoGenerate !== undefined && isGeneratorDefault(state.default)) {
    return;
  }
  addIssue(
    issues,
    pointer(path, "default"),
    "J009",
    "This field carries a function default, which the document cannot hold. Use one of the seven `generate` kinds, a literal default, or a database default through `native`"
  );
  return;
}

// =============================================================================
// RELATION
// =============================================================================

function serializeRelation(
  relation: AnyRelation,
  schema: Schema,
  path: string,
  issues: DocumentIssues
): RelationFieldDocument {
  const state = relation["~"].state;
  const type = state.cardinality === "one" ? "toOne" : "toMany";
  const document = isVariantRelationState(state)
    ? withVariantTargetFacts(type, state, schema, path, issues)
    : withModelTargetFacts(
        {
          type,
          target: resolveTargetKey(state.target.getter, schema, path, issues),
        },
        state
      );
  if (state.name !== undefined) document.name = state.name;
  return document;
}

function withModelTargetFacts(
  document: ModelTargetDocument,
  state: RelationState
): ModelTargetDocument {
  const foreignKey = state.foreignKey;
  if (foreignKey !== undefined) {
    document.fields = [...foreignKey.fields];
    document.references = [...foreignKey.references];
    if (foreignKey.onDelete !== undefined) {
      document.onDelete = foreignKey.onDelete;
    }
    if (foreignKey.onUpdate !== undefined) {
      document.onUpdate = foreignKey.onUpdate;
    }
  }
  const junction = state.junction;
  if (junction !== undefined) {
    const overrides: JunctionDocument = {};
    if (junction.table !== undefined) overrides.table = junction.table;
    if (junction.source !== undefined) overrides.source = junction.source;
    if (junction.target !== undefined) overrides.target = junction.target;
    if (junction.onDelete !== undefined) overrides.onDelete = junction.onDelete;
    if (junction.onUpdate !== undefined) overrides.onUpdate = junction.onUpdate;
    document.junction = overrides;
  }
  return document;
}

/**
 * `values` is all-or-nothing: the factory demands a bag exact over the variant
 * keys, so a partial one is illegal. The document carries the full bag, or none
 * at all when every stored value already equals its public key.
 */
function withVariantTargetFacts(
  type: "toOne" | "toMany",
  state: VariantRelationState,
  schema: Schema,
  path: string,
  issues: DocumentIssues
): VariantTargetDocument {
  const variants: Record<string, string> = {};
  const values: Record<string, string> = {};
  const through: Record<string, VariantJunctionDocument> = {};
  let renamed = false;
  for (const [variantKey, entry] of Object.entries(state.target.entries)) {
    const member: VariantEntry = entry;
    variants[variantKey] = resolveTargetKey(
      member.getter,
      schema,
      pointer(path, "variants", variantKey),
      issues
    );
    values[variantKey] = member.storedValue;
    if (member.storedValue !== variantKey) renamed = true;
    const junction = readVariantJunction(member);
    if (junction !== undefined) through[variantKey] = junction;
  }
  const document: VariantTargetDocument = { type, variants };
  if (renamed) document.values = values;
  if (Object.keys(through).length > 0) document.through = through;
  if (state.optional === true) document.optional = true;
  return document;
}

function readVariantJunction(
  entry: VariantEntry
): VariantJunctionDocument | undefined {
  const junction = Reflect.get(entry, "junction");
  if (junction === undefined) return;
  return {
    table: junction.table,
    source: junction.source,
    target: junction.target,
  };
}

/**
 * The schema key a target getter names.
 *
 * The getter is invoked DIRECTLY, not through `settleTarget`: settling is a
 * once-cell whose outcome every later consumer inherits, and a diagnostic dump
 * must not decide it. The answer is matched by identity against the caller's
 * own record, which is the same identity the resolution gate requires.
 */
function resolveTargetKey(
  getter: Getter,
  schema: Schema,
  path: string,
  issues: DocumentIssues
): string {
  const target = readTarget(getter, path);
  for (const [modelKey, model] of Object.entries(schema)) {
    if (model === target) return modelKey;
  }
  addIssue(
    issues,
    path,
    "J006",
    "This relation targets a model that is not a member of the schema record being serialized"
  );
  return "";
}

/**
 * Invoke one target getter. The factories admit only a function here, so the
 * one thing that can go wrong is the getter itself throwing — which a document
 * cannot describe, and which the caller is told about rather than handed as a
 * half-written model.
 */
function readTarget(getter: Getter, path: string): unknown {
  try {
    return getter();
  } catch (thrown) {
    const issue: DocumentIssues = [];
    addIssue(
      issue,
      path,
      "J006",
      "This relation's target getter threw; the schema cannot be serialized"
    );
    throw refuseDocument(issue, toError(thrown));
  }
}

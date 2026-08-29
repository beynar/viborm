// Document SHAPE: the one owner of "does this value have the format's shape".
//
// It answers exactly that, and nothing semantic. Whether a scalar type HAS the
// modifier a node spells, whether a foreign key pairs, whether a stored-value
// bag is exact, whether a graph resolves — those belong to the scalar classes,
// the relation factories and the resolution gate, which already refuse them by
// name. What this boundary uniquely owns is the JSON POINTER: it is the first
// place that knows where in the author's artifact a fact was written, and the
// only place that can report every such fact at once instead of the first.
//
// The document is caller-controlled input, and inspecting it is executable too:
// a property accessor, a `getPrototypeOf` trap and an `ownKeys` trap can all run
// code. So every value read, every prototype check and every key enumeration
// goes through the boundary's guarded inspection owner (`member`,
// `inspectPlainRecord`, `inspectKeys`), and any value rendered into a message
// through `renderValue` — a hostile object can neither smuggle inherited entries
// nor throw its way out as the caller's own value.

import { isValidSchemaIdentifier } from "@schema/identifier";
import type { IndexType } from "@schema/model/model";
import type {
  JunctionReferentialAction,
  ReferentialAction,
} from "@schema/relation/types";
import type { AutoGenerateType, ScalarType } from "@schema/scalars/common";
import type { NativeType } from "@schema/scalars/native-types";
import { readDefaultValue } from "./default-codec";
import type {
  CompoundKeyDocument,
  EnumDocument,
  FieldDocument,
  GenerateDocument,
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
import { isRelationField, SCHEMA_DOCUMENT_VERSION } from "./document";
import { SCALAR_TYPE_NAMES } from "./factories";
import {
  addIssue,
  type DocumentIssues,
  documentRoot,
  inspectKeys,
  inspectPlainRecord,
  member,
  pointer,
  refuseDocument,
  renderValue,
  throwIfRefused,
} from "./issues";
import { isNativeTypeInCatalog, nativeTypeRefusal } from "./native-catalog";

// =============================================================================
// CLOSED VOCABULARIES
// =============================================================================

// Each vocabulary is spelled as a `Record<Union, true>` so the type it narrows
// to is the only statement of its membership: a token added to the union and
// not to the record is a compile error, and the reverse is too. The relation
// terminal and the scalar classes still own these vocabularies for CODED
// schemas; here they are part of the document's shape.

const REFERENTIAL_ACTIONS: Record<ReferentialAction, true> = {
  cascade: true,
  setNull: true,
  restrict: true,
  noAction: true,
};

const JUNCTION_ACTIONS: Record<JunctionReferentialAction, true> = {
  cascade: true,
  restrict: true,
  noAction: true,
};

const INDEX_TYPES: Record<IndexType, true> = {
  btree: true,
  hash: true,
  gin: true,
  gist: true,
  fulltext: true,
  spatial: true,
};

const GENERATE_KINDS: Record<AutoGenerateType, true> = {
  uuid: true,
  ulid: true,
  nanoid: true,
  cuid: true,
  increment: true,
  now: true,
  updatedAt: true,
};

const NATIVE_DIALECTS: Record<NativeType["db"], true> = {
  pg: true,
  mysql: true,
  sqlite: true,
};

const isReferentialAction = (value: unknown): value is ReferentialAction =>
  typeof value === "string" && Object.hasOwn(REFERENTIAL_ACTIONS, value);

const isJunctionAction = (value: unknown): value is JunctionReferentialAction =>
  typeof value === "string" && Object.hasOwn(JUNCTION_ACTIONS, value);

const isIndexType = (value: unknown): value is IndexType =>
  typeof value === "string" && Object.hasOwn(INDEX_TYPES, value);

const isGenerateKind = (value: unknown): value is AutoGenerateType =>
  typeof value === "string" && Object.hasOwn(GENERATE_KINDS, value);

const isNativeDialect = (value: unknown): value is NativeType["db"] =>
  typeof value === "string" && Object.hasOwn(NATIVE_DIALECTS, value);

const isScalarTypeName = (value: unknown): value is ScalarType =>
  typeof value === "string" && SCALAR_TYPE_NAMES.has(value);

// =============================================================================
// NODE KEY SETS
// =============================================================================

const DOCUMENT_KEYS = ["version", "enums", "models"];
const ENUM_KEYS = ["values", "name"];
const MODEL_KEYS = ["table", "fields", "indexes", "ids", "uniques", "omit"];
const INDEX_KEYS = ["fields", "name", "unique", "type", "where"];
const COMPOUND_KEYS = ["fields", "name"];
const NATIVE_KEYS = ["db", "type"];
const GENERATE_KEYS = ["kind", "prefix", "length"];
const JUNCTION_KEYS = ["table", "source", "target", "onDelete", "onUpdate"];
const VARIANT_JUNCTION_KEYS = ["table", "source", "target"];
const SCALAR_FIELD_KEYS = [
  "type",
  "native",
  "nullable",
  "array",
  "id",
  "unique",
  "column",
  "default",
  "generate",
  "enum",
  "dimension",
  "precision",
  "scale",
  "withoutTimezone",
];

/**
 * Every key SOME field node declares.
 *
 * Used only when `type` names no field at all: the arm is then undecided, so
 * the keys that can still be called unknown are the ones no arm has. Reporting
 * `fields` beside an unknown `type` would be telling an author their `toOne`
 * key is wrong when the parser does not yet know it is not a `toOne`.
 */
const ANY_FIELD_KEYS = [
  ...new Set([
    ...SCALAR_FIELD_KEYS,
    ...relationKeys({ cardinality: "one", variants: false }),
    ...relationKeys({ cardinality: "many", variants: false }),
    ...relationKeys({ cardinality: "one", variants: true }),
    ...relationKeys({ cardinality: "many", variants: true }),
  ]),
];

/**
 * The keys one relation arm admits.
 *
 * The four arms are the four capability surfaces the factories publish — a
 * model-target `toOne` has `.fields()`, a variant-target `toOne` has
 * `.optional()`, and so on. Those surfaces exist only as TYPES over private
 * terminal classes, so the document's own exactness is stated here.
 */
function relationKeys(node: RelationArm): string[] {
  const keys = ["type", "name"];
  if (node.variants) {
    keys.push("variants", "values");
    keys.push(node.cardinality === "one" ? "optional" : "through");
    return keys;
  }
  keys.push("target");
  if (node.cardinality === "one") {
    keys.push("fields", "references", "onDelete", "onUpdate");
    return keys;
  }
  keys.push("junction");
  return keys;
}

type RelationArm = {
  readonly cardinality: "one" | "many";
  readonly variants: boolean;
};

// =============================================================================
// GUARDED VALUE READS
// =============================================================================

/**
 * Every element of a caller-supplied array, read through the one guarded
 * accessor. An array's INDEXES are ordinary properties, so each of them is
 * executable input exactly as a named key is.
 */
function elements(
  value: readonly unknown[],
  path: string,
  issues: DocumentIssues
): unknown[] {
  const read: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    read.push(member(value, String(index), path, issues));
  }
  return read;
}

function asRecord(
  value: unknown,
  path: string,
  issues: DocumentIssues,
  what: string
): Record<string, unknown> | undefined {
  if (inspectPlainRecord(value, path, issues, "J004")) return value;
  addIssue(issues, path, "J004", `${what} must be a plain JSON object`);
  return;
}

function asString(
  value: unknown,
  path: string,
  issues: DocumentIssues,
  what: string
): string | undefined {
  if (typeof value === "string") return value;
  addIssue(issues, path, "J004", `${what} must be a string`);
  return;
}

function asBoolean(
  value: unknown,
  path: string,
  issues: DocumentIssues,
  what: string
): boolean | undefined {
  if (typeof value === "boolean") return value;
  addIssue(issues, path, "J004", `${what} must be a boolean`);
  return;
}

function asNumber(
  value: unknown,
  path: string,
  issues: DocumentIssues,
  what: string
): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  addIssue(issues, path, "J004", `${what} must be a finite number`);
  return;
}

function asStringArray(
  value: unknown,
  path: string,
  issues: DocumentIssues,
  what: string
): string[] | undefined {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "J004", `${what} must be an array of strings`);
    return;
  }
  // Every bad element is reported, not the first: an author fixing a list of
  // names should see the whole list's verdict in one pass. The array itself is
  // still refused — a partial one would build a declaration nobody wrote.
  const strings: string[] = [];
  let complete = true;
  for (const [position, entry] of elements(value, path, issues).entries()) {
    const text = asString(entry, pointer(path, String(position)), issues, what);
    if (text === undefined) {
      complete = false;
      continue;
    }
    strings.push(text);
  }
  return complete ? strings : undefined;
}

/**
 * A node's own keys, walked ONCE: an unknown key is refused, and an own key
 * whose value is explicitly `undefined` is refused too.
 *
 * Object input can carry `key: undefined`; JSON text cannot, and object input
 * describes exactly what JSON text can — so absence is spelled by omitting the
 * key, never by setting it to `undefined`. Read as absent, an own `undefined`
 * silently became a node the author did not write. This is the ONE place that
 * rule lives (external review 7); the OPTIONS bag is the deliberate exception
 * and reads its own way — `validate?: boolean` admits `undefined` by the TS
 * optional-property idiom, which refusing would fight.
 */
function refuseUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: DocumentIssues,
  declarer = "this node"
): void {
  for (const key of inspectKeys(record, path, issues, "J004")) {
    if (!allowed.includes(key)) {
      addIssue(
        issues,
        pointer(path, key),
        "J003",
        `Unknown key '${key}'; ${declarer} declares ${renderKeys(allowed)}`
      );
      continue;
    }
    if (member(record, key, path, issues) === undefined) {
      addIssue(
        issues,
        pointer(path, key),
        "J004",
        `'${key}' is \`undefined\`; a document omits an absent key rather than setting it to \`undefined\``
      );
    }
  }
}

/**
 * A key that names a model, a field, a variant or an enum definition.
 *
 * It runs BEFORE anything is constructed. `isValidSchemaIdentifier` already
 * owns the rule at hydration, but a `__proto__` model key assigned into the
 * registry first would set a prototype and create no own key at all, so
 * hydration's own enumeration would never see it — the rule has to be applied
 * at the first boundary that reads the key.
 */
function refuseInvalidKey(
  key: string,
  path: string,
  issues: DocumentIssues,
  what: string
): boolean {
  if (isValidSchemaIdentifier(key)) return true;
  addIssue(
    issues,
    path,
    "J005",
    `${what} '${key}' is not a valid schema identifier`
  );
  return false;
}

function renderKeys(keys: readonly string[]): string {
  return keys.map((key) => `'${key}'`).join(", ");
}

// =============================================================================
// DOCUMENT
// =============================================================================

/**
 * Read a document from JSON text or a caller-built object.
 *
 * Every shape issue in the whole artifact is collected, then thrown once. What
 * comes back is the document the author wrote — not yet a schema: `interpret`
 * turns it into models.
 */
export function readDocument(input: string | object): SchemaDocument {
  const issues: DocumentIssues = [];
  const value = intake(input, issues);
  throwIfRefused(issues);
  const node = asRecord(value, documentRoot, issues, "A schema document");
  if (node === undefined) throw refuseDocument(issues);
  refuseUnknownKeys(node, DOCUMENT_KEYS, documentRoot, issues);

  const version = member(node, "version", documentRoot, issues);
  if (version !== SCHEMA_DOCUMENT_VERSION) {
    addIssue(
      issues,
      pointer(documentRoot, "version"),
      "J002",
      `Unsupported document version ${renderValue(version)}; this parser reads version ${SCHEMA_DOCUMENT_VERSION}`
    );
    throw refuseDocument(issues);
  }

  const document: SchemaDocument = {
    version: SCHEMA_DOCUMENT_VERSION,
    models: readModels(node, issues),
  };
  const enums = readEnums(node, issues);
  if (enums !== undefined) document.enums = enums;
  resolveReferences(document, issues);
  throwIfRefused(issues);
  return document;
}

function intake(input: string | object, issues: DocumentIssues): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch (thrown) {
    // `JSON.parse` answers a `SyntaxError` naming the offset it stopped at.
    addIssue(
      issues,
      documentRoot,
      "J001",
      `The document is not valid JSON: ${String(thrown)}`
    );
    return;
  }
}

function readEnums(
  node: Record<string, unknown>,
  issues: DocumentIssues
): Record<string, EnumDocument> | undefined {
  const path = pointer(documentRoot, "enums");
  const raw = member(node, "enums", documentRoot, issues);
  if (raw === undefined) return;
  const record = asRecord(raw, path, issues, "`enums`");
  if (record === undefined) return;
  const enums: Record<string, EnumDocument> = {};
  for (const key of inspectKeys(record, path, issues, "J004")) {
    const entryPath = pointer(path, key);
    if (!refuseInvalidKey(key, entryPath, issues, "Enum reference")) continue;
    const definition = readEnumNode(
      member(record, key, path, issues),
      entryPath,
      issues
    );
    if (definition !== undefined) enums[key] = definition;
  }
  return enums;
}

function readEnumNode(
  value: unknown,
  path: string,
  issues: DocumentIssues
): EnumDocument | undefined {
  const node = asRecord(value, path, issues, "An enum definition");
  if (node === undefined) return;
  refuseUnknownKeys(node, ENUM_KEYS, path, issues);
  const values = asStringArray(
    member(node, "values", path, issues),
    pointer(path, "values"),
    issues,
    "`values`"
  );
  if (values === undefined) return;
  const definition: EnumDocument = { values };
  const name = member(node, "name", path, issues);
  if (name !== undefined) {
    const text = asString(name, pointer(path, "name"), issues, "`name`");
    if (text !== undefined) definition.name = text;
  }
  return definition;
}

function readModels(
  node: Record<string, unknown>,
  issues: DocumentIssues
): Record<string, ModelDocument> {
  const path = pointer(documentRoot, "models");
  const models: Record<string, ModelDocument> = {};
  const record = asRecord(
    member(node, "models", documentRoot, issues),
    path,
    issues,
    "`models`"
  );
  if (record === undefined) return models;
  for (const key of inspectKeys(record, path, issues, "J004")) {
    const modelPath = pointer(path, key);
    if (!refuseInvalidKey(key, modelPath, issues, "Model key")) continue;
    const model = readModelNode(
      member(record, key, path, issues),
      modelPath,
      issues
    );
    if (model !== undefined) models[key] = model;
  }
  return models;
}

// =============================================================================
// MODEL
// =============================================================================

function readModelNode(
  value: unknown,
  path: string,
  issues: DocumentIssues
): ModelDocument | undefined {
  const node = asRecord(value, path, issues, "A model");
  if (node === undefined) return;
  refuseUnknownKeys(node, MODEL_KEYS, path, issues);
  const model: ModelDocument = { fields: readFields(node, path, issues) };

  const table = member(node, "table", path, issues);
  if (table !== undefined) {
    const text = asString(table, pointer(path, "table"), issues, "`table`");
    if (text !== undefined) model.table = text;
  }
  const indexes = readIndexes(node, path, issues);
  if (indexes !== undefined) model.indexes = indexes;
  const ids = readCompoundKeys(node, "ids", path, issues);
  if (ids !== undefined) model.ids = ids;
  const uniques = readCompoundKeys(node, "uniques", path, issues);
  if (uniques !== undefined) model.uniques = uniques;
  const omit = readOmit(node, path, issues);
  if (omit !== undefined) model.omit = omit;
  return model;
}

function readFields(
  node: Record<string, unknown>,
  modelPath: string,
  issues: DocumentIssues
): Record<string, FieldDocument> {
  const path = pointer(modelPath, "fields");
  const fields: Record<string, FieldDocument> = {};
  const record = asRecord(
    member(node, "fields", modelPath, issues),
    path,
    issues,
    "`fields`"
  );
  if (record === undefined) return fields;
  for (const key of inspectKeys(record, path, issues, "J004")) {
    const fieldPath = pointer(path, key);
    if (!refuseInvalidKey(key, fieldPath, issues, "Field key")) continue;
    const field = readFieldNode(
      member(record, key, path, issues),
      fieldPath,
      issues
    );
    if (field !== undefined) fields[key] = field;
  }
  return fields;
}

function readIndexes(
  node: Record<string, unknown>,
  modelPath: string,
  issues: DocumentIssues
): IndexDocument[] | undefined {
  const path = pointer(modelPath, "indexes");
  const raw = member(node, "indexes", modelPath, issues);
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    addIssue(issues, path, "J004", "`indexes` must be an array");
    return;
  }
  const indexes: IndexDocument[] = [];
  for (const [position, entry] of elements(raw, path, issues).entries()) {
    const index = readIndexNode(entry, pointer(path, String(position)), issues);
    if (index !== undefined) indexes.push(index);
  }
  return indexes;
}

function readIndexNode(
  value: unknown,
  path: string,
  issues: DocumentIssues
): IndexDocument | undefined {
  const node = asRecord(value, path, issues, "An index");
  if (node === undefined) return;
  // `where` is a KNOWN key with its own refusal, not an unknown one: it exists
  // in the builder, and an author who spells it is told why v1 has no slot for
  // it rather than that the key does not exist.
  if (inspectKeys(node, path, issues, "J004").includes("where")) {
    addIssue(
      issues,
      pointer(path, "where"),
      "J009",
      "`where` is refused in v1: it is raw SQL interpolated unescaped into DDL, and a machine-written document must not carry an execution channel. It returns when a structured predicate form exists"
    );
  }
  refuseUnknownKeys(node, INDEX_KEYS, path, issues);
  const fields = asStringArray(
    member(node, "fields", path, issues),
    pointer(path, "fields"),
    issues,
    "`fields`"
  );
  if (fields === undefined) return;
  const index: IndexDocument = { fields };
  const name = member(node, "name", path, issues);
  if (name !== undefined) {
    const text = asString(name, pointer(path, "name"), issues, "`name`");
    if (text !== undefined) index.name = text;
  }
  const unique = member(node, "unique", path, issues);
  if (unique !== undefined) {
    const flag = asBoolean(unique, pointer(path, "unique"), issues, "`unique`");
    if (flag !== undefined) index.unique = flag;
  }
  const type = member(node, "type", path, issues);
  if (type !== undefined) {
    if (isIndexType(type)) {
      index.type = type;
    } else {
      addIssue(
        issues,
        pointer(path, "type"),
        "J004",
        `\`type\` must be one of ${renderKeys(Object.keys(INDEX_TYPES))}`
      );
    }
  }
  return index;
}

function readCompoundKeys(
  node: Record<string, unknown>,
  key: "ids" | "uniques",
  modelPath: string,
  issues: DocumentIssues
): CompoundKeyDocument[] | undefined {
  const path = pointer(modelPath, key);
  const raw = member(node, key, modelPath, issues);
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    addIssue(issues, path, "J004", `\`${key}\` must be an array`);
    return;
  }
  const constraints: CompoundKeyDocument[] = [];
  for (const [position, entry] of elements(raw, path, issues).entries()) {
    const constraint = readCompoundKeyNode(
      entry,
      pointer(path, String(position)),
      issues
    );
    if (constraint !== undefined) constraints.push(constraint);
  }
  return constraints;
}

function readCompoundKeyNode(
  value: unknown,
  path: string,
  issues: DocumentIssues
): CompoundKeyDocument | undefined {
  const node = asRecord(value, path, issues, "A compound key");
  if (node === undefined) return;
  refuseUnknownKeys(node, COMPOUND_KEYS, path, issues);
  const fields = asStringArray(
    member(node, "fields", path, issues),
    pointer(path, "fields"),
    issues,
    "`fields`"
  );
  if (fields === undefined) return;
  const constraint: CompoundKeyDocument = { fields };
  const name = member(node, "name", path, issues);
  if (name !== undefined) {
    const text = asString(name, pointer(path, "name"), issues, "`name`");
    if (text !== undefined) constraint.name = text;
  }
  return constraint;
}

function readOmit(
  node: Record<string, unknown>,
  modelPath: string,
  issues: DocumentIssues
): string[] | undefined {
  const raw = member(node, "omit", modelPath, issues);
  if (raw === undefined) return;
  return asStringArray(raw, pointer(modelPath, "omit"), issues, "`omit`");
}

// =============================================================================
// FIELD
// =============================================================================

function readFieldNode(
  value: unknown,
  path: string,
  issues: DocumentIssues
): FieldDocument | undefined {
  const node = asRecord(value, path, issues, "A field");
  if (node === undefined) return;
  const type = member(node, "type", path, issues);
  if (type === "toOne" || type === "toMany") {
    return readRelationField(node, type, path, issues);
  }
  if (isScalarTypeName(type)) {
    return readScalarField(node, type, path, issues);
  }
  addIssue(
    issues,
    pointer(path, "type"),
    "J004",
    `\`type\` must be 'toOne', 'toMany', or one of ${renderKeys([...SCALAR_TYPE_NAMES])}`
  );
  // The node is still read for the keys no arm declares: an author who
  // misspelled `type` AND a modifier deserves both, in one pass.
  refuseUnknownKeys(node, ANY_FIELD_KEYS, path, issues, "a field node");
  return;
}

function readScalarField(
  node: Record<string, unknown>,
  type: ScalarType,
  path: string,
  issues: DocumentIssues
): ScalarFieldDocument | undefined {
  refuseUnknownKeys(node, SCALAR_FIELD_KEYS, path, issues);
  const field = readScalarArm(node, type, path, issues);
  if (field === undefined) return;

  readFlag(node, "nullable", path, issues, field);
  readFlag(node, "array", path, issues, field);
  readFlag(node, "id", path, issues, field);
  readFlag(node, "unique", path, issues, field);
  readFlag(node, "withoutTimezone", path, issues, field);

  const column = member(node, "column", path, issues);
  if (column !== undefined) {
    const text = asString(column, pointer(path, "column"), issues, "`column`");
    if (text !== undefined) field.column = text;
  }
  const dimension = member(node, "dimension", path, issues);
  if (dimension !== undefined) {
    if (type === "point") {
      refusePointModifier("dimension", path, issues);
    } else {
      const size = asNumber(
        dimension,
        pointer(path, "dimension"),
        issues,
        "`dimension`"
      );
      if (size !== undefined) field.dimension = size;
    }
  }
  if (type !== "decimal") {
    refuseDecimalDomainBound(node, "precision", path, issues);
    refuseDecimalDomainBound(node, "scale", path, issues);
  }
  const native = member(node, "native", path, issues);
  if (native !== undefined) {
    if (field.type === "point") {
      refusePointModifier("native", path, issues);
    } else if (field.type === "decimal") {
      addIssue(
        issues,
        pointer(path, "native"),
        "J003",
        "`native` does not belong to a decimal field; its physical type is derived from `precision` and `scale`"
      );
    } else {
      const nativeType = readNativeNode(
        native,
        pointer(path, "native"),
        issues
      );
      if (nativeType !== undefined) field.native = nativeType;
    }
  }
  const generate = member(node, "generate", path, issues);
  if (generate !== undefined) {
    if (type === "point") {
      refusePointModifier("generate", path, issues);
    } else {
      const declaration = readGenerateNode(
        generate,
        pointer(path, "generate"),
        issues
      );
      if (declaration !== undefined) field.generate = declaration;
    }
  }
  const defaultValue = member(node, "default", path, issues);
  if (defaultValue !== undefined) {
    const literal = readDefaultValue(
      defaultValue,
      pointer(path, "default"),
      issues
    );
    if (literal !== undefined) field.default = literal;
  }
  return field;
}

/**
 * One half of a decimal's declared domain. The document carries the two numbers
 * verbatim. This reader owns their required presence and number representation;
 * `s.decimal` still owns whether the pair names a domain — integrality, range,
 * and `scale <= precision` — through the interpreter's construction boundary.
 */
function readRequiredDomainBound(
  node: Record<string, unknown>,
  key: "precision" | "scale",
  path: string,
  issues: DocumentIssues
): number | undefined {
  const value = member(node, key, path, issues);
  if (value === undefined) {
    addIssue(
      issues,
      pointer(path, key),
      "J004",
      `A decimal field must declare \`${key}\``
    );
    return;
  }
  const bound = asNumber(value, pointer(path, key), issues, `\`${key}\``);
  return bound;
}

/** A fixed-decimal domain has no meaning on any other scalar arm. */
function refuseDecimalDomainBound(
  node: Record<string, unknown>,
  key: "precision" | "scale",
  path: string,
  issues: DocumentIssues
): void {
  if (member(node, key, path, issues) === undefined) return;
  addIssue(
    issues,
    pointer(path, key),
    "J003",
    `\`${key}\` belongs only to a field of type 'decimal'`
  );
}

function readScalarArm(
  node: Record<string, unknown>,
  type: ScalarType,
  path: string,
  issues: DocumentIssues
): ScalarFieldDocument | undefined {
  const raw = member(node, "enum", path, issues);
  const enumPath = pointer(path, "enum");
  if (type !== "enum") {
    if (raw !== undefined) {
      addIssue(
        issues,
        enumPath,
        "J003",
        "`enum` belongs to a field of type 'enum'"
      );
    }
    if (type === "decimal") {
      const precision = readRequiredDomainBound(
        node,
        "precision",
        path,
        issues
      );
      const scale = readRequiredDomainBound(node, "scale", path, issues);
      if (precision === undefined || scale === undefined) return;
      return { type, precision, scale };
    }
    return { type };
  }
  if (raw === undefined) {
    addIssue(
      issues,
      enumPath,
      "J004",
      "An enum field declares `enum` as an `enums` reference or an inline array of values"
    );
    return;
  }
  if (typeof raw === "string") return { type, enum: raw };
  const values = asStringArray(raw, enumPath, issues, "`enum`");
  if (values === undefined) return;
  return { type, enum: values };
}

type ScalarFlagKey = "nullable" | "array" | "id" | "unique" | "withoutTimezone";

function readFlag(
  node: Record<string, unknown>,
  key: ScalarFlagKey,
  path: string,
  issues: DocumentIssues,
  field: ScalarFieldDocument
): void {
  const raw = member(node, key, path, issues);
  if (raw === undefined) return;
  if (field.type === "point" && key !== "nullable") {
    refusePointModifier(key, path, issues);
    return;
  }
  const flag = asBoolean(raw, pointer(path, key), issues, `\`${key}\``);
  if (flag === undefined) return;
  if (key === "nullable") {
    field.nullable = flag;
    return;
  }
  if (field.type !== "point") field[key] = flag;
}

function refusePointModifier(
  key: string,
  path: string,
  issues: DocumentIssues
): void {
  addIssue(
    issues,
    pointer(path, key),
    "J007",
    `A 'point' field has no '${key}' modifier`
  );
}

function readNativeNode(
  value: unknown,
  path: string,
  issues: DocumentIssues
): NativeType | undefined {
  const node = asRecord(value, path, issues, "`native`");
  if (node === undefined) return;
  refuseUnknownKeys(node, NATIVE_KEYS, path, issues);
  const db = member(node, "db", path, issues);
  const type = asString(
    member(node, "type", path, issues),
    pointer(path, "type"),
    issues,
    "`native.type`"
  );
  if (!isNativeDialect(db)) {
    addIssue(
      issues,
      pointer(path, "db"),
      "J004",
      `\`native.db\` must be one of ${renderKeys(Object.keys(NATIVE_DIALECTS))}`
    );
    return;
  }
  if (type === undefined) return;
  // The catalog is closed PER DIALECT: a value belongs only to the catalog of
  // its own `db`. `text` is a pg type, `TEXT` a mysql/sqlite one.
  if (!isNativeTypeInCatalog(db, type)) {
    addIssue(issues, pointer(path, "type"), "J011", nativeTypeRefusal(db));
    return;
  }
  return { db, type };
}

function readGenerateNode(
  value: unknown,
  path: string,
  issues: DocumentIssues
): GenerateDocument | undefined {
  const node = asRecord(value, path, issues, "`generate`");
  if (node === undefined) return;
  refuseUnknownKeys(node, GENERATE_KEYS, path, issues);
  const kind = member(node, "kind", path, issues);
  if (!isGenerateKind(kind)) {
    addIssue(
      issues,
      pointer(path, "kind"),
      "J004",
      `\`generate.kind\` must be one of ${renderKeys(Object.keys(GENERATE_KINDS))}`
    );
    return;
  }
  const declaration: GenerateDocument = { kind };
  const prefix = member(node, "prefix", path, issues);
  if (prefix !== undefined) {
    const text = asString(prefix, pointer(path, "prefix"), issues, "`prefix`");
    if (text !== undefined) declaration.prefix = text;
  }
  const length = member(node, "length", path, issues);
  if (length !== undefined) {
    const size = asNumber(length, pointer(path, "length"), issues, "`length`");
    if (size !== undefined) declaration.length = size;
  }
  return declaration;
}

// =============================================================================
// RELATION
// =============================================================================

function readRelationField(
  node: Record<string, unknown>,
  type: "toOne" | "toMany",
  path: string,
  issues: DocumentIssues
): RelationFieldDocument | undefined {
  const target = member(node, "target", path, issues);
  const variants = member(node, "variants", path, issues);
  if ((target === undefined) === (variants === undefined)) {
    addIssue(
      issues,
      path,
      "J004",
      "A relation names exactly one target domain: `target` for one model, or `variants` for named variants"
    );
    return;
  }
  const cardinality = type === "toOne" ? "one" : "many";
  refuseUnknownKeys(
    node,
    relationKeys({ cardinality, variants: variants !== undefined }),
    path,
    issues
  );
  const name = readName(node, path, issues);
  if (target === undefined) {
    return readVariantTargetArm(
      node,
      { type, variants },
      name,
      cardinality,
      path,
      issues
    );
  }
  const key = asString(target, pointer(path, "target"), issues, "`target`");
  if (key === undefined) return;
  return readModelTargetArm(
    node,
    { type, target: key },
    name,
    cardinality,
    path,
    issues
  );
}

function readName(
  node: Record<string, unknown>,
  path: string,
  issues: DocumentIssues
): string | undefined {
  const name = member(node, "name", path, issues);
  if (name === undefined) return;
  return asString(name, pointer(path, "name"), issues, "`name`");
}

function readModelTargetArm(
  node: Record<string, unknown>,
  relation: ModelTargetDocument,
  name: string | undefined,
  cardinality: "one" | "many",
  path: string,
  issues: DocumentIssues
): ModelTargetDocument {
  if (name !== undefined) relation.name = name;
  if (cardinality === "many") {
    const junction = member(node, "junction", path, issues);
    if (junction !== undefined) {
      const overrides = readJunctionNode(
        junction,
        pointer(path, "junction"),
        issues
      );
      if (overrides !== undefined) relation.junction = overrides;
    }
    return relation;
  }
  for (const key of ["fields", "references"] as const) {
    const raw = member(node, key, path, issues);
    if (raw === undefined) continue;
    const keys = asStringArray(raw, pointer(path, key), issues, `\`${key}\``);
    if (keys !== undefined) relation[key] = keys;
  }
  for (const key of ["onDelete", "onUpdate"] as const) {
    const raw = member(node, key, path, issues);
    if (raw === undefined) continue;
    if (isReferentialAction(raw)) {
      relation[key] = raw;
      continue;
    }
    addIssue(
      issues,
      pointer(path, key),
      "J004",
      `\`${key}\` must be one of ${renderKeys(Object.keys(REFERENTIAL_ACTIONS))}`
    );
  }
  return relation;
}

function readVariantTargetArm(
  node: Record<string, unknown>,
  relation: { type: "toOne" | "toMany"; variants: unknown },
  name: string | undefined,
  cardinality: "one" | "many",
  path: string,
  issues: DocumentIssues
): VariantTargetDocument | undefined {
  const map = readVariantMap(
    relation.variants,
    pointer(path, "variants"),
    issues
  );
  if (map === undefined) return;
  const declaration: VariantTargetDocument = {
    type: relation.type,
    variants: map,
  };
  if (name !== undefined) declaration.name = name;
  const values = member(node, "values", path, issues);
  if (values !== undefined) {
    const bag = readStringMap(
      values,
      pointer(path, "values"),
      issues,
      "`values`"
    );
    if (bag !== undefined) declaration.values = bag;
  }
  if (cardinality === "one") {
    const optional = member(node, "optional", path, issues);
    if (optional !== undefined) {
      const flag = asBoolean(
        optional,
        pointer(path, "optional"),
        issues,
        "`optional`"
      );
      if (flag !== undefined) declaration.optional = flag;
    }
    return declaration;
  }
  const through = member(node, "through", path, issues);
  if (through !== undefined) {
    const junctions = readThroughMap(through, pointer(path, "through"), issues);
    if (junctions !== undefined) declaration.through = junctions;
  }
  return declaration;
}

function readVariantMap(
  value: unknown,
  path: string,
  issues: DocumentIssues
): Record<string, string> | undefined {
  const record = asRecord(value, path, issues, "`variants`");
  if (record === undefined) return;
  const variants: Record<string, string> = {};
  for (const key of inspectKeys(record, path, issues, "J004")) {
    const entryPath = pointer(path, key);
    if (!refuseInvalidKey(key, entryPath, issues, "Variant key")) continue;
    const target = asString(
      member(record, key, path, issues),
      entryPath,
      issues,
      "A variant target"
    );
    if (target !== undefined) variants[key] = target;
  }
  return variants;
}

/**
 * A map keyed by variant, read into a fresh record.
 *
 * The identifier check is what stops a `__proto__` key from setting that
 * record's prototype instead of becoming an entry — the one thing the factory's
 * own exactness rule could then only report as a MISSING key.
 */
function readStringMap(
  value: unknown,
  path: string,
  issues: DocumentIssues,
  what: string
): Record<string, string> | undefined {
  const record = asRecord(value, path, issues, what);
  if (record === undefined) return;
  const map: Record<string, string> = {};
  for (const key of inspectKeys(record, path, issues, "J004")) {
    const entryPath = pointer(path, key);
    if (!refuseInvalidKey(key, entryPath, issues, "Variant key")) continue;
    const text = asString(
      member(record, key, path, issues),
      entryPath,
      issues,
      what
    );
    if (text !== undefined) map[key] = text;
  }
  return map;
}

function readThroughMap(
  value: unknown,
  path: string,
  issues: DocumentIssues
): Record<string, VariantJunctionDocument> | undefined {
  const record = asRecord(value, path, issues, "`through`");
  if (record === undefined) return;
  const map: Record<string, VariantJunctionDocument> = {};
  for (const key of inspectKeys(record, path, issues, "J004")) {
    const entryPath = pointer(path, key);
    if (!refuseInvalidKey(key, entryPath, issues, "Variant key")) continue;
    const override = readVariantJunctionNode(
      member(record, key, path, issues),
      entryPath,
      issues
    );
    if (override !== undefined) map[key] = override;
  }
  return map;
}

function readVariantJunctionNode(
  value: unknown,
  path: string,
  issues: DocumentIssues
): VariantJunctionDocument | undefined {
  const node = asRecord(value, path, issues, "A member junction");
  if (node === undefined) return;
  refuseUnknownKeys(node, VARIANT_JUNCTION_KEYS, path, issues);
  const table = asString(
    member(node, "table", path, issues),
    pointer(path, "table"),
    issues,
    "`table`"
  );
  const source = asString(
    member(node, "source", path, issues),
    pointer(path, "source"),
    issues,
    "`source`"
  );
  const target = asString(
    member(node, "target", path, issues),
    pointer(path, "target"),
    issues,
    "`target`"
  );
  if (table === undefined || source === undefined || target === undefined) {
    return;
  }
  return { table, source, target };
}

function readJunctionNode(
  value: unknown,
  path: string,
  issues: DocumentIssues
): JunctionDocument | undefined {
  const node = asRecord(value, path, issues, "`junction`");
  if (node === undefined) return;
  refuseUnknownKeys(node, JUNCTION_KEYS, path, issues);
  // Trusted junction state is `AtLeastOne`: it stores an override only when one
  // was declared, so `{}` becomes no builder call at all and nothing downstream
  // could refuse it. The DECLARED keys decide, not the ones that survived
  // reading — a rejected value is a different failure, already reported.
  if (inspectKeys(node, path, issues, "J004").length === 0) {
    addIssue(
      issues,
      path,
      "J004",
      "`junction` declares at least one of 'table', 'source', 'target', 'onDelete', 'onUpdate'; omit it to keep the derived defaults"
    );
    return;
  }
  const junction: JunctionDocument = {};
  for (const key of ["table", "source", "target"] as const) {
    const raw = member(node, key, path, issues);
    if (raw === undefined) continue;
    const text = asString(raw, pointer(path, key), issues, `\`${key}\``);
    if (text !== undefined) junction[key] = text;
  }
  for (const key of ["onDelete", "onUpdate"] as const) {
    const raw = member(node, key, path, issues);
    if (raw === undefined) continue;
    if (isJunctionAction(raw)) {
      junction[key] = raw;
      continue;
    }
    addIssue(
      issues,
      pointer(path, key),
      "J004",
      `A junction \`${key}\` must be one of ${renderKeys(Object.keys(JUNCTION_ACTIONS))}; 'setNull' cannot null a membership-key member`
    );
  }
  return junction;
}

// =============================================================================
// DOCUMENT-LOCAL REFERENCES
// =============================================================================

/**
 * The two references a document alone can resolve: a relation's target model
 * key, and an `omit` entry.
 *
 * A missing model key would otherwise reach the resolution gate as
 * `R006`/`P001` over a getter that answered `undefined`, with no document
 * location; an `omit` typo is refused only at the TYPE level in code, and a
 * machine-written document has no types — a silently ignored entry is a leaked
 * column. An `enums` reference belongs to the interpreter instead: that is the
 * first place that needs the definition, so nothing checks it twice.
 */
function resolveReferences(
  document: SchemaDocument,
  issues: DocumentIssues
): void {
  const modelsPath = pointer(documentRoot, "models");
  for (const [modelKey, model] of Object.entries(document.models)) {
    const modelPath = pointer(modelsPath, modelKey);
    const fieldsPath = pointer(modelPath, "fields");
    for (const [fieldKey, field] of Object.entries(model.fields)) {
      resolveTargetReferences(
        document,
        field,
        pointer(fieldsPath, fieldKey),
        issues
      );
    }
    resolveOmitReferences(model, modelPath, issues);
  }
}

function resolveTargetReferences(
  document: SchemaDocument,
  field: FieldDocument,
  path: string,
  issues: DocumentIssues
): void {
  if (!isRelationField(field)) return;
  if (field.target !== undefined) {
    refuseUnknownModel(document, field.target, pointer(path, "target"), issues);
  }
  for (const [variantKey, target] of Object.entries(field.variants ?? {})) {
    refuseUnknownModel(
      document,
      target,
      pointer(path, "variants", variantKey),
      issues
    );
  }
}

function refuseUnknownModel(
  document: SchemaDocument,
  target: string,
  path: string,
  issues: DocumentIssues
): void {
  if (Object.hasOwn(document.models, target)) return;
  addIssue(
    issues,
    path,
    "J006",
    `Model '${target}' is not declared in \`models\``
  );
}

function resolveOmitReferences(
  model: ModelDocument,
  modelPath: string,
  issues: DocumentIssues
): void {
  for (const [position, name] of (model.omit ?? []).entries()) {
    const field = model.fields[name];
    if (field !== undefined && !isRelationField(field)) continue;
    addIssue(
      issues,
      pointer(modelPath, "omit", String(position)),
      "J006",
      `\`omit\` names '${name}', which is not a scalar field of this model`
    );
  }
}

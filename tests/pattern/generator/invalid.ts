/**
 * Invalid-payload mutation strategies (unit B, the "invalid mode").
 *
 * Each strategy takes a VALID generated payload and returns one mutant the
 * operation schema must refuse, labelled with the refusal class and — where the
 * validator's sentence is fixed — the message it must carry. A strategy returns
 * `undefined` when the payload offers nothing to mutate (no to-one relation in
 * its data, no unique selector on its root, …); the corpus supplies the next
 * candidate.
 *
 * Relation facts (which keys of the root model are to-one, which update bags
 * publish no `disconnect`, which create keys are required) are read from the
 * same registry schemas the generator walked, never from a second model reading.
 */
import { type AnyModel, getModelKeyCatalog } from "@schema/model";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import { resolveSchemaOrThrow } from "@schema/validation/validator";
import {
  type ReferenceCells,
  referenceCells,
} from "@src/query-engine/pattern/cells";
import {
  type GeneratedPayload,
  operationSchema,
  type RegistryLike,
  type RootOperation,
  type SchemaMap,
} from "./generate";
import {
  classify,
  collectEntryKeys,
  isRecord,
  resolveSchema,
} from "./introspect";

/** Mutants the PARSE BOUNDARY refuses: the operation schema is the whole contract. */
export const VALIDATION_STRATEGIES = [
  "unknown-key",
  "wrong-scalar-type",
  "to-many-verb-on-to-one",
  "empty-where-unique",
  "set-under-create",
  "disconnect-on-required",
  "missing-required",
  "select-and-include",
] as const;

/**
 * Mutants the parse boundary ACCEPTS, whose verdict is semantic: a §19 admit,
 * OwnWrite legality, a packing refusal, an execution premise — or, for the ones
 * spelled `none`, a shape today deliberately does NOT refuse. These are what
 * make the fuzz dashboards reach below validation.
 */
export const SEMANTIC_STRATEGIES = [
  "bulk-membership-move-connect",
  "bulk-membership-move-set",
  "bulk-membership-move-disconnect",
  "bulk-member-to-many-verb",
  "null-relation-key",
  "primary-key-two-operations",
  "primary-key-arithmetic",
  "relation-key-non-literal",
  "shared-key-ambiguous-arm",
  "disconnect-then-connect",
  "create-then-update-same-row",
  "set-then-connect",
  "unknown-variant",
  "to-one-update-where-mismatch",
  "set-orphans-required-child",
] as const;

export const INVALID_STRATEGIES = [
  ...VALIDATION_STRATEGIES,
  ...SEMANTIC_STRATEGIES,
] as const;

export type ValidationStrategy = (typeof VALIDATION_STRATEGIES)[number];
export type SemanticStrategy = (typeof SEMANTIC_STRATEGIES)[number];
export type InvalidStrategy = (typeof INVALID_STRATEGIES)[number];

export type RefusalClass =
  | "unknown-key"
  | "type-mismatch"
  | "empty-selector"
  | "missing-required"
  | "exclusive-keys";

/**
 * WHERE today's engine reaches its verdict. `validation` is the parse boundary;
 * the four semantic stages are the write engine's own order (ATOM §19), and
 * `none` marks a shape that must reach a program.
 */
export type RefusalStage =
  | "validation"
  | "construction"
  | "legality"
  | "packing"
  | "premise"
  | "none";

export interface InvalidPayload {
  readonly strategy: InvalidStrategy;
  readonly payload: GeneratedPayload;
  readonly expect: {
    readonly stage: RefusalStage;
    /** The validator's refusal class; present for `validation` mutants only. */
    readonly class?: RefusalClass;
    /** Today's error class name for a semantic refusal. */
    readonly error?: string;
    /** The sentence when it is fixed; `undefined` when it depends on the slot. */
    readonly message: RegExp | undefined;
    /** The sentence when it names a fact only execution knows (the matched-row count). */
    readonly messageFor?: (recordCount: number) => string;
    /** The `DeferredRefusal.kind` construction records, where it records one. */
    readonly deferredKind?: string;
  };
}

// =============================================================================
// FACTS ABOUT THE ROOT MODEL, READ FROM THE REGISTRY
// =============================================================================

interface RootFacts {
  readonly toOne: readonly string[];
  readonly toMany: readonly string[];
  readonly toOneWithoutDisconnect: readonly string[];
  readonly requiredCreateKeys: readonly string[];
  readonly argsKeys: ReadonlySet<string>;
}

const relationCardinality = (model: AnyModel, key: string): string => {
  const relation = model["~"].state.relations[key];
  return relation ? relation["~"].state.cardinality : "";
};

function rootFacts(
  schema: SchemaMap,
  registry: RegistryLike,
  payload: GeneratedPayload
): RootFacts {
  const model = schema[payload.model];
  if (!model) throw new Error(`invalid: unknown model '${payload.model}'`);
  const schemas = registry.getModelSchemas(model);
  const toOne: string[] = [];
  const toMany: string[] = [];
  const toOneWithoutDisconnect: string[] = [];
  for (const key of Object.keys(model["~"].state.relations)) {
    const cardinality = relationCardinality(model, key);
    if (cardinality === "many") {
      toMany.push(key);
      continue;
    }
    if (cardinality !== "one") continue;
    toOne.push(key);
    const bag =
      Reflect.get(schemas.relations, key) ??
      Reflect.get(schemas.polymorphic, key);
    const update = isRecord(bag)
      ? resolveSchema(Reflect.get(bag, "update"))
      : undefined;
    if (update && !collectEntryKeys(update).has("disconnect")) {
      toOneWithoutDisconnect.push(key);
    }
  }
  const create = resolveSchema(Reflect.get(schemas.core, "create"));
  const createNode = create ? classify(create) : undefined;
  return {
    toOne,
    toMany,
    toOneWithoutDisconnect,
    requiredCreateKeys:
      createNode?.kind === "object" ? createNode.options.atLeast : [],
    argsKeys: collectEntryKeys(
      operationSchema(registry, schema, payload.model, payload.operation)
    ),
  };
}

// =============================================================================
// PAYLOAD SURGERY
// =============================================================================

const withArgs = (
  payload: GeneratedPayload,
  args: Record<string, unknown>
): GeneratedPayload => ({ ...payload, args });

const withArg = (
  payload: GeneratedPayload,
  key: string,
  value: unknown
): GeneratedPayload => withArgs(payload, { ...payload.args, [key]: value });

/** The arms of a root payload that carry a model create/update record. */
const createArms = (operation: RootOperation): readonly string[] =>
  operation === "create" ? ["data"] : operation === "upsert" ? ["create"] : [];

const updateArms = (operation: RootOperation): readonly string[] =>
  operation === "update" || operation === "updateMany"
    ? ["data"]
    : operation === "upsert"
      ? ["update"]
      : [];

const recordArms = (
  payload: GeneratedPayload,
  arms: readonly string[]
): readonly string[] => arms.filter((arm) => isRecord(payload.args[arm]));

const withRelationInArm = (
  payload: GeneratedPayload,
  arm: string,
  relation: string,
  value: unknown
): GeneratedPayload => {
  const record = payload.args[arm];
  if (!isRecord(record)) return payload;
  return withArg(payload, arm, { ...record, [relation]: value });
};

const UNIQUE_SELECTOR_OPERATIONS: ReadonlySet<RootOperation> = new Set([
  "findUnique",
  "update",
  "delete",
  "upsert",
]);

const isLeaf = (value: unknown): boolean =>
  !(Array.isArray(value) || isPlainRecord(value));

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** The first (declaration-order, depth-first) primitive leaf, as a path. */
function firstLeafPath(
  value: unknown,
  path: readonly (string | number)[] = []
): readonly (string | number)[] | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = firstLeafPath(value[index], [...path, index]);
      if (found) return found;
    }
    return undefined;
  }
  if (!isPlainRecord(value)) return path.length > 0 ? path : undefined;
  for (const key of Object.keys(value)) {
    const member = value[key];
    if (member === null || member === undefined) continue;
    const found = isLeaf(member)
      ? [...path, key]
      : firstLeafPath(member, [...path, key]);
    if (found) return found;
  }
  return undefined;
}

function replaceAt(
  value: unknown,
  path: readonly (string | number)[],
  replacement: unknown
): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return replacement;
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      index === head ? replaceAt(item, rest, replacement) : item
    );
  }
  if (!isPlainRecord(value) || typeof head !== "string") return value;
  return { ...value, [head]: replaceAt(value[head], rest, replacement) };
}

// =============================================================================
// STRATEGIES
// =============================================================================

type Strategy = (
  payload: GeneratedPayload,
  facts: RootFacts
) => InvalidPayload | undefined;

const UNKNOWN_UNEXPECTED = /Unknown key: __unexpected/;
const UNKNOWN_SET = /Unknown key: set/;
const UNKNOWN_DISCONNECT = /Unknown key: disconnect/;
const EMPTY_SELECTOR = /cannot be empty/;
const MISSING_REQUIRED = /Missing required field/;
const MUTUALLY_EXCLUSIVE = /Mutually exclusive/;
const SHARED_PRIMARY_KEY = /does not support a shared-primary-key/;
const UNION_MEMBER = /did not match any union member/;

const VALIDATION: Readonly<Record<ValidationStrategy, Strategy>> = {
  "unknown-key": (payload) => ({
    strategy: "unknown-key",
    payload: withArg(payload, "__unexpected", 1),
    expect: {
      stage: "validation",
      class: "unknown-key",
      message: UNKNOWN_UNEXPECTED,
    },
  }),

  // A value no scalar schema admits — a Symbol — at the first primitive leaf,
  // so the refusal is a type mismatch wherever the leaf sits (a number for a
  // string would still be a valid JSON document under a `json` field).
  "wrong-scalar-type": (payload) => {
    const path = firstLeafPath(payload.args);
    if (!path) return undefined;
    const args = replaceAt(payload.args, path, Symbol("wrong-scalar-type"));
    if (!isRecord(args)) return undefined;
    return {
      strategy: "wrong-scalar-type",
      payload: withArgs(payload, args),
      expect: {
        stage: "validation",
        class: "type-mismatch",
        message: undefined,
      },
    };
  },

  "to-many-verb-on-to-one": (payload, facts) => {
    const relation = facts.toOne[0];
    const arm = recordArms(payload, [
      ...createArms(payload.operation),
      ...updateArms(payload.operation),
    ])[0];
    if (relation === undefined || arm === undefined) return undefined;
    return {
      strategy: "to-many-verb-on-to-one",
      payload: withRelationInArm(payload, arm, relation, { set: [] }),
      expect: {
        stage: "validation",
        class: "unknown-key",
        message: UNKNOWN_SET,
      },
    };
  },

  "empty-where-unique": (payload) => {
    if (!UNIQUE_SELECTOR_OPERATIONS.has(payload.operation)) return undefined;
    return {
      strategy: "empty-where-unique",
      payload: withArg(payload, "where", {}),
      expect: {
        stage: "validation",
        class: "empty-selector",
        message: EMPTY_SELECTOR,
      },
    };
  },

  "set-under-create": (payload, facts) => {
    const relation = facts.toMany[0];
    const arm = recordArms(payload, createArms(payload.operation))[0];
    if (relation === undefined || arm === undefined) return undefined;
    return {
      strategy: "set-under-create",
      payload: withRelationInArm(payload, arm, relation, { set: [] }),
      expect: {
        stage: "validation",
        class: "unknown-key",
        message: UNKNOWN_SET,
      },
    };
  },

  "disconnect-on-required": (payload, facts) => {
    const relation = facts.toOneWithoutDisconnect[0];
    const arm = recordArms(payload, updateArms(payload.operation))[0];
    if (relation === undefined || arm === undefined) return undefined;
    return {
      strategy: "disconnect-on-required",
      payload: withRelationInArm(payload, arm, relation, { disconnect: true }),
      expect: {
        stage: "validation",
        class: "unknown-key",
        message: UNKNOWN_DISCONNECT,
      },
    };
  },

  "missing-required": (payload, facts) => {
    const arm = recordArms(payload, createArms(payload.operation))[0];
    if (arm === undefined) return undefined;
    const record = payload.args[arm];
    if (!isRecord(record)) return undefined;
    const key = facts.requiredCreateKeys.find((k) => record[k] !== undefined);
    if (key === undefined) return undefined;
    const rest: Record<string, unknown> = {};
    for (const member of Object.keys(record)) {
      if (member !== key) rest[member] = record[member];
    }
    return {
      strategy: "missing-required",
      payload: withArg(payload, arm, rest),
      expect: {
        stage: "validation",
        class: "missing-required",
        message: MISSING_REQUIRED,
      },
    };
  },

  "select-and-include": (payload, facts) => {
    if (!(facts.argsKeys.has("select") && facts.argsKeys.has("include"))) {
      return undefined;
    }
    return {
      strategy: "select-and-include",
      payload: withArgs(payload, { ...payload.args, select: {}, include: {} }),
      expect: {
        stage: "validation",
        class: "exclusive-keys",
        message: MUTUALLY_EXCLUSIVE,
      },
    };
  },
};

// =============================================================================
// SEMANTIC MODE — mutants the parse boundary ACCEPTS
// =============================================================================
//
// Topology comes from the cell map (`referenceCells`, K2) over the schema's
// resolved index: which row holds a reference, whether it lives in a reference
// row of its own, whether that row's slot is unique, whether the holder's cells
// may be cleared. That is a schema-layer view, so an invalid corpus built on it
// does not depend on the engine under test.

const indexCache = new WeakMap<object, ResolvedRelationIndex>();

function indexFor(schema: SchemaMap): ResolvedRelationIndex {
  const cached = indexCache.get(schema);
  if (cached) return cached;
  const index = resolveSchemaOrThrow(schema as Record<string, AnyModel>);
  indexCache.set(schema, index);
  return index;
}

interface EdgeFacts {
  readonly field: string;
  readonly cardinality: "one" | "many";
  readonly cells: ReferenceCells;
  /** The model on the other end. */
  readonly target: AnyModel;
  readonly targetName: string;
}

const modelName = (schema: SchemaMap, model: AnyModel): string | undefined =>
  Object.keys(schema).find((key) => schema[key] === model);

/** Every SINGLE-reference edge of a model, as cells. */
function edgesOf(schema: SchemaMap, model: AnyModel): EdgeFacts[] {
  const index = indexFor(schema);
  const edges: EdgeFacts[] = [];
  for (const field of Object.keys(model["~"].state.relations)) {
    const family = referenceCells(index, model, field);
    if (family.kind !== "single") continue;
    const { cells } = family;
    const target = cells.viaJunction
      ? cells.referenced.model
      : cells.holderIsSource
        ? cells.referenced.model
        : cells.holder.model;
    const targetName = modelName(schema, target);
    if (!targetName) continue;
    edges.push({
      field,
      cardinality: cells.cardinality,
      cells,
      target,
      targetName,
    });
  }
  return edges;
}

/** Every PAYLOAD-BOUND (variant) family of a model, with one member's cells. */
function variantEdgesOf(
  schema: SchemaMap,
  model: AnyModel
): {
  field: string;
  cardinality: "one" | "many";
  variant: string;
  target: AnyModel;
}[] {
  const index = indexFor(schema);
  const out: {
    field: string;
    cardinality: "one" | "many";
    variant: string;
    target: AnyModel;
  }[] = [];
  for (const field of Object.keys(model["~"].state.relations)) {
    const family = referenceCells(index, model, field);
    if (family.kind !== "variants") continue;
    const first = family.byVariant.entries().next().value;
    if (!first) continue;
    const [variant, cells] = first;
    out.push({
      field,
      cardinality: cells.cardinality,
      variant,
      target: cells.viaJunction
        ? cells.referenced.model
        : cells.referenced.model,
    });
  }
  return out;
}

const scalarType = (model: AnyModel, field: string): string | undefined =>
  model["~"].state.scalars[field]?.["~"].state.type;

const scalarNullable = (model: AnyModel, field: string): boolean =>
  model["~"].state.scalars[field]?.["~"].state.nullable === true;

const NUMERIC_TYPES: ReadonlySet<string> = new Set([
  "int",
  "number",
  "bigint",
  "decimal",
]);

/** A literal from the pool the generator draws from, by scalar type. */
function literalFor(model: AnyModel, field: string, n: number): unknown {
  const type = scalarType(model, field);
  if (type === "int" || type === "number") return n;
  if (type === "bigint") return BigInt(n);
  return `${field}_${n}`;
}

const rowKeyFields = (model: AnyModel): readonly string[] =>
  getModelKeyCatalog(model).rowKey?.fields ?? [];

/** A unique selector for a model's row key, spelled as the public grammar spells it. */
function selectorFor(
  model: AnyModel,
  n: number
): Record<string, unknown> | undefined {
  const rowKey = getModelKeyCatalog(model).rowKey;
  if (!rowKey || rowKey.fields.length === 0) return undefined;
  if (rowKey.fields.length === 1) {
    const field = rowKey.fields[0] as string;
    return { [field]: literalFor(model, field, n) };
  }
  const members: Record<string, unknown> = {};
  for (const field of rowKey.fields)
    members[field] = literalFor(model, field, n);
  return { [rowKey.name ?? rowKey.fields.join("_")]: members };
}

/** The first non-key string scalar, for an update payload that writes something. */
function updatableScalar(
  model: AnyModel,
  exclude: readonly string[] = []
): string | undefined {
  const off = new Set([...rowKeyFields(model), ...exclude]);
  return Object.keys(model["~"].state.scalars).find(
    (field) => !off.has(field) && scalarType(model, field) === "string"
  );
}

/** The columns the edge's own reference occupies; a nested payload omits them. */
const referenceColumnsOf = (edge: EdgeFacts): readonly string[] =>
  edge.cells.viaJunction ? [] : edge.cells.holder.fields;

/** Whether a relation bag publishes `disconnect` in its update context. */
function publishesDisconnect(
  registry: RegistryLike,
  model: AnyModel,
  field: string
): boolean {
  const schemas = registry.getModelSchemas(model);
  const bag =
    Reflect.get(schemas.relations, field) ??
    Reflect.get(schemas.polymorphic, field);
  const update = isRecord(bag)
    ? resolveSchema(Reflect.get(bag, "update"))
    : undefined;
  return update !== undefined && collectEntryKeys(update).has("disconnect");
}

/**
 * A minimal record for the NESTED create bag of `field`: every key that bag
 * requires, from the target model's own scalars. `undefined` when a required
 * key is not a scalar this can spell (a required relation, a compound member
 * the pool cannot fill).
 */
function nestedCreateRecord(
  registry: RegistryLike,
  model: AnyModel,
  edge: EdgeFacts,
  n: number
): Record<string, unknown> | undefined {
  const schemas = registry.getModelSchemas(model);
  const bag =
    Reflect.get(schemas.relations, edge.field) ??
    Reflect.get(schemas.polymorphic, edge.field);
  const create = isRecord(bag)
    ? resolveSchema(Reflect.get(bag, "create"))
    : undefined;
  if (!create) return undefined;
  const node = classify(create);
  const inner =
    node.kind === "object"
      ? resolveSchema(Reflect.get(node.entries, "create"))
      : undefined;
  const record = inner ? classify(unwrap(inner)) : undefined;
  if (!record || record.kind !== "object") return undefined;
  const out: Record<string, unknown> = {};
  const spell = (key: string): boolean => {
    if (scalarType(edge.target, key) === undefined) return false;
    out[key] = literalFor(edge.target, key, n);
    return true;
  };
  for (const key of record.options.atLeast) {
    if (!spell(key)) return undefined;
  }
  // A key-set group demands ONE of its alternatives — a foreign key OR the
  // relation that owns it. An alternative the PROJECTION omits is the enclosing
  // relation's own key: the engine derives it, so the group is already
  // satisfied and spelling it would be an unknown key. Otherwise spell the
  // first all-scalar alternative; when none is, this record cannot be built.
  const omitted = (key: string): boolean => record.options.omit.has(key);
  for (const group of record.options.requiresOneOfKeySets) {
    if (group.some((keys) => keys.every(omitted))) continue;
    const chosen = group.find((keys) =>
      keys.every(
        (key) => !omitted(key) && scalarType(edge.target, key) !== undefined
      )
    );
    if (!chosen) return undefined;
    for (const key of chosen) spell(key);
  }
  for (const keys of record.options.requiresOneOf) {
    if (keys.some((key) => out[key] !== undefined || omitted(key))) continue;
    const chosen = keys.find(
      (key) => scalarType(edge.target, key) !== undefined
    );
    if (chosen === undefined) return undefined;
    spell(chosen);
  }
  return out;
}

/** Peel array / optional / nullable / transform wrappers off a schema. */
function unwrap(schema: Parameters<typeof classify>[0]) {
  let current = schema;
  for (let depth = 0; depth < 8; depth++) {
    const node = classify(current);
    if (node.kind === "array") current = node.item;
    else if (node.kind === "optional" || node.kind === "nullable") {
      current = node.wrapped;
    } else if (node.kind === "wrapped") current = node.wrapped;
    else if (node.kind === "union") {
      const first = node.options[0];
      if (!first) return current;
      current = first;
    } else return current;
  }
  return current;
}

/** The edges a bulk root cannot move: stored on the target row, or a unique slot. */
const bulkMoveRefused = (edges: readonly EdgeFacts[]): EdgeFacts[] =>
  edges.filter(
    (edge) =>
      !(edge.cells.holderIsSource || edge.cells.viaJunction) ||
      (edge.cells.viaJunction !== undefined && edge.cells.unique)
  );

const bulkMoveMessage =
  (verb: string, edge: EdgeFacts) =>
  (recordCount: number): string => {
    const where =
      edge.cells.viaJunction === undefined
        ? "that membership is stored on the target row, which can belong to only one of them"
        : "that target's member-junction slot can belong to only one of them";
    return `updateMany matched ${recordCount} rows, so it cannot apply '${verb}' to relation '${edge.field}': ${where} — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call.`;
  };

const firstUpdateArm = (payload: GeneratedPayload): string | undefined =>
  recordArms(payload, updateArms(payload.operation))[0];

/** The single update arm of a NON-bulk root (`updateMany` is its own strategies). */
const singleUpdateArm = (payload: GeneratedPayload): string | undefined =>
  payload.operation === "updateMany" ? undefined : firstUpdateArm(payload);

type SemanticFn = (
  payload: GeneratedPayload,
  schema: SchemaMap,
  registry: RegistryLike
) => InvalidPayload | undefined;

/** `updateMany` + a verb that moves ONE target's stored membership. */
function bulkMove(
  strategy: SemanticStrategy,
  verb: "connect" | "set" | "disconnect",
  /** `disconnect` names no target, so today does NOT refuse it (§5.2). */
  refused: boolean
): SemanticFn {
  return (payload, schema, registry) => {
    if (payload.operation !== "updateMany") return undefined;
    const model = schema[payload.model];
    if (!(model && isRecord(payload.args.data))) return undefined;
    const edge = bulkMoveRefused(edgesOf(schema, model)).find(
      (candidate) =>
        (verb === "connect" || candidate.cardinality === "many") &&
        // `disconnect` is the one verb a bag may withhold (clearability).
        (verb !== "disconnect" ||
          publishesDisconnect(registry, model, candidate.field))
    );
    if (!edge) return undefined;
    const selector = selectorFor(edge.target, 1);
    if (!selector) return undefined;
    const spelled = edge.cardinality === "many" ? [selector] : selector;
    return {
      strategy,
      payload: isolate(payload, schema, "data", {
        [edge.field]: { [verb]: verb === "set" ? [selector] : spelled },
      }),
      expect: refused
        ? {
            stage: "construction",
            error: "UnsupportedOperationError",
            message: undefined,
            messageFor: bulkMoveMessage(verb, edge),
            deferredKind: "bulkRootMembershipMove",
          }
        : { stage: "none", message: undefined },
    };
  };
}

/**
 * ISOLATE the shape under test. A generated payload is rich, and its own verbs,
 * filters and projections would decide the cell before the mutation does — the
 * differential would then compare noise. So a semantic mutant drops the
 * projections (this corpus is about writes), reduces the root selector to the
 * row key (a bulk root matches every row), and puts exactly the tested shape in
 * `arm`. A SIBLING arm is left alone: an upsert's `create` arm can carry keys a
 * `requiresOneOfKeySets` group demands, and reducing it would make the mutant
 * invalid rather than isolated.
 */
function isolate(
  payload: GeneratedPayload,
  schema: SchemaMap,
  arm: string,
  patch: Record<string, unknown>
): GeneratedPayload {
  const model = schema[payload.model];
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload.args)) {
    if (key === "select" || key === "include" || key === "omit") continue;
    if (value !== undefined) args[key] = value;
  }
  // The root selector is reduced too: a generated `where` can carry relation
  // filters and nested shapes that decide the cell before the mutation does. A
  // unique root is addressed by its row key; a bulk root matches every row.
  if (model) {
    const selector = selectorFor(model, 1);
    if (UNIQUE_SELECTOR_OPERATIONS.has(payload.operation) && selector) {
      args.where = selector;
    } else if (payload.operation !== "createMany") {
      args.where = undefined;
    }
  }
  args[arm] = patch;
  return withArgs(payload, args);
}

/** One record's scalar keys; relation payloads are what makes a sibling arm noisy. */
function scalarsOnly(
  model: AnyModel,
  record: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (scalarType(model, key) !== undefined) out[key] = value;
  }
  return out;
}

const SEMANTIC: Readonly<Record<SemanticStrategy, SemanticFn>> = {
  "bulk-membership-move-connect": bulkMove(
    "bulk-membership-move-connect",
    "connect",
    true
  ),
  "bulk-membership-move-set": bulkMove("bulk-membership-move-set", "set", true),
  // A boolean/selector `disconnect` names no target to steal, so §5.2's refusal
  // does not reach it: this mutant must COMPILE.
  "bulk-membership-move-disconnect": bulkMove(
    "bulk-membership-move-disconnect",
    "disconnect",
    false
  ),

  /** A nested to-many verb under a BULK root: every member runs it (ATOM §17). */
  "bulk-member-to-many-verb": (payload, schema) => {
    if (payload.operation !== "updateMany") return undefined;
    const model = schema[payload.model];
    if (!(model && isRecord(payload.args.data))) return undefined;
    const edge = edgesOf(schema, model).find(
      (candidate) =>
        candidate.cardinality === "many" &&
        updatableScalar(candidate.target, referenceColumnsOf(candidate)) !==
          undefined
    );
    if (!edge) return undefined;
    const scalar = updatableScalar(
      edge.target,
      referenceColumnsOf(edge)
    ) as string;
    return {
      strategy: "bulk-member-to-many-verb",
      payload: isolate(payload, schema, "data", {
        [edge.field]: { updateMany: { data: { [scalar]: `${scalar}_9` } } },
      }),
      expect: { stage: "none", message: undefined },
    };
  },

  /** `{ fk: null, relation: { connect } }` — the key is nulled while its relation is written. */
  "null-relation-key": (payload, schema) => {
    const arm = singleUpdateArm(payload);
    const model = schema[payload.model];
    if (arm === undefined || !model) return undefined;
    const edge = edgesOf(schema, model).find(
      (candidate) =>
        candidate.cells.holderIsSource &&
        !candidate.cells.viaJunction &&
        candidate.cells.holder.fields.every((field) =>
          scalarNullable(model, field)
        )
    );
    if (!edge) return undefined;
    const selector = selectorFor(edge.target, 1);
    const keyField = edge.cells.holder.fields[0];
    if (!selector || keyField === undefined) return undefined;
    return {
      strategy: "null-relation-key",
      payload: isolate(payload, schema, arm, {
        [keyField]: null,
        [edge.field]: { connect: selector },
      }),
      expect: {
        // MEASURED: today reaches ATOM §20.1's final-assignment ledger first —
        // the payload's `null` and the relation's own derived value are two
        // contributions to one column — so the sentence is the ledger's, not
        // the null-key one construction defers (`deferredKind`). In the
        // `missing` world the connect's target premise can answer first.
        stage: "packing",
        error: "UnsupportedOperationError",
        message: new RegExp(
          `^query-engine-v2 update has conflicting final assignments for column '${keyField}'`
        ),
        deferredKind: "nullRelationKey",
      },
    };
  },

  /** Two operations on one primary-key member (§19's portable-primary-key admit). */
  "primary-key-two-operations": (payload, schema) => {
    const arm = firstUpdateArm(payload);
    const model = schema[payload.model];
    if (arm === undefined || !model) return undefined;
    const field = rowKeyFields(model).find(
      (name) => scalarType(model, name) === "int"
    );
    if (field === undefined) return undefined;
    return {
      strategy: "primary-key-two-operations",
      payload: isolate(payload, schema, arm, {
        [field]: { set: 7, increment: 1 },
      }),
      expect: {
        // Two owners, one shape: `assertPortablePrimaryKeyUpdateInput` answers
        // for `update`/`updateMany` (§19's admit), and an `upsert` reaches
        // `getUpdatedPrimaryKeyValue` first, which words it differently.
        stage: "construction",
        error: "QueryEngineError",
        message: new RegExp(
          `^(Primary key field '${field}' accepts exactly one update operation; received set, increment\\.|Cannot determine the updated primary key for model '[^']+' because field '${field}' uses an unsupported operation\\.)$`
        ),
        deferredKind: "portablePrimaryKey",
      },
    };
  },

  /** Arithmetic on a float/decimal primary key: not portable (§19). */
  "primary-key-arithmetic": (payload, schema) => {
    const arm = firstUpdateArm(payload);
    const model = schema[payload.model];
    if (arm === undefined || !model) return undefined;
    const field = rowKeyFields(model).find((name) => {
      const type = scalarType(model, name);
      return type === "number" || type === "decimal";
    });
    if (field === undefined) return undefined;
    const type = scalarType(model, field);
    return {
      strategy: "primary-key-arithmetic",
      payload: isolate(payload, schema, arm, { [field]: { increment: 1 } }),
      expect: {
        stage: "construction",
        error: "QueryEngineError",
        message: new RegExp(
          `^Arithmetic updates are not portable for ${type} primary key field '${field}'\\.`
        ),
        deferredKind: "portablePrimaryKey",
      },
    };
  },

  /** A relation key written with a non-literal operation while its relation is written. */
  "relation-key-non-literal": (payload, schema) => {
    const arm = singleUpdateArm(payload);
    const model = schema[payload.model];
    if (arm === undefined || !model) return undefined;
    for (const edge of edgesOf(schema, model)) {
      if (!edge.cells.holderIsSource || edge.cells.viaJunction) continue;
      const field = edge.cells.holder.fields.find((name) =>
        NUMERIC_TYPES.has(scalarType(model, name) ?? "")
      );
      const selector = selectorFor(edge.target, 1);
      if (field === undefined || !selector) continue;
      return {
        strategy: "relation-key-non-literal",
        payload: isolate(payload, schema, arm, {
          [field]: { increment: 1 },
          [edge.field]: { connect: selector },
        }),
        expect: {
          stage: "construction",
          error: "NestedWriteError",
          message: new RegExp(
            `^Cannot update relation key field '${field}' with a non-literal operation while mutating relation '${edge.field}'\\.`
          ),
          deferredKind: "relationKeyNonLiteral",
        },
      };
    }
    return undefined;
  },

  /** A merge supplying a reference whose columns ARE the record's own key. */
  "shared-key-ambiguous-arm": (payload, schema, registry) => {
    const arm = recordArms(payload, createArms(payload.operation))[0];
    const model = schema[payload.model];
    if (arm === undefined || !model) return undefined;
    const record = payload.args[arm];
    if (!isRecord(record)) return undefined;
    const key = new Set(rowKeyFields(model));
    const edge = edgesOf(schema, model).find(
      (candidate) =>
        candidate.cells.holderIsSource &&
        !candidate.cells.viaJunction &&
        candidate.cells.holder.fields.length === key.size &&
        candidate.cells.holder.fields.every((field) => key.has(field))
    );
    if (!edge) return undefined;
    const selector = selectorFor(edge.target, 1);
    const created = nestedCreateRecord(registry, model, edge, 1);
    if (!(selector && created)) return undefined;
    // A create arm keeps its own scalars: they are what the record needs.
    return {
      strategy: "shared-key-ambiguous-arm",
      payload: isolate(payload, schema, arm, {
        ...scalarsOnly(model, record),
        [edge.field]: { connectOrCreate: { where: selector, create: created } },
      }),
      expect: {
        stage: "packing",
        error: "UnsupportedOperationError",
        message: SHARED_PRIMARY_KEY,
        deferredKind: "sharedKeyAmbiguousArm",
      },
    };
  },

  /** The ACCEPTED to-one composition: vacate, then supply. Must not refuse. */
  "disconnect-then-connect": (payload, schema, registry) => {
    const arm = singleUpdateArm(payload);
    const model = schema[payload.model];
    if (arm === undefined || !model) return undefined;
    const edge = edgesOf(schema, model).find(
      (candidate) =>
        candidate.cardinality === "one" &&
        publishesDisconnect(registry, model, candidate.field)
    );
    if (!edge) return undefined;
    const selector = selectorFor(edge.target, 2);
    if (!selector) return undefined;
    return {
      strategy: "disconnect-then-connect",
      payload: isolate(payload, schema, arm, {
        [edge.field]: { disconnect: true, connect: selector },
      }),
      expect: { stage: "none", message: undefined },
    };
  },

  /** A reader naming the row an adder of the SAME nested write produces (OwnWrite). */
  "create-then-update-same-row": (payload, schema, registry) => {
    const arm = singleUpdateArm(payload);
    const model = schema[payload.model];
    if (arm === undefined || !model) return undefined;
    for (const edge of edgesOf(schema, model)) {
      if (edge.cardinality !== "many") continue;
      const keyFields = rowKeyFields(edge.target);
      const keyField = keyFields.length === 1 ? keyFields[0] : undefined;
      const scalar = updatableScalar(edge.target, referenceColumnsOf(edge));
      if (keyField === undefined || scalar === undefined) continue;
      const record = nestedCreateRecord(registry, model, edge, 1);
      if (!record || scalarType(edge.target, keyField) === undefined) continue;
      // The created row's key is SPELLED: a generated key would leave the
      // update naming some other row, and the conflict would be imaginary.
      const created = {
        ...record,
        [keyField]: literalFor(edge.target, keyField, 1),
      };
      return {
        strategy: "create-then-update-same-row",
        payload: isolate(payload, schema, arm, {
          [edge.field]: {
            create: [created],
            update: [
              {
                where: { [keyField]: created[keyField] },
                data: { [scalar]: `${scalar}_9` },
              },
            ],
          },
        }),
        expect: {
          // MEASURED on all three corpus schemas: today does NOT call this
          // feedback. The create writes a row the update then names by the key
          // the payload spelled, and OwnWrite's overlap treats a named target
          // read as disjoint from a fresh row's write. The shape stays here
          // because it is the closest legal neighbour of the refusal, and a
          // scheduler that refuses it is over-refusing.
          stage: "none",
          message: undefined,
        },
      };
    }
    return undefined;
  },

  /** `set` beside `connect` on one to-many: the adder reads what the set did not write. */
  "set-then-connect": (payload, schema) => {
    const arm = singleUpdateArm(payload);
    const model = schema[payload.model];
    if (arm === undefined || !model) return undefined;
    const edge = edgesOf(schema, model).find(
      (candidate) => candidate.cardinality === "many"
    );
    if (!edge) return undefined;
    const first = selectorFor(edge.target, 1);
    const second = selectorFor(edge.target, 2);
    if (!(first && second)) return undefined;
    return {
      strategy: "set-then-connect",
      payload: isolate(payload, schema, arm, {
        [edge.field]: { set: [first], connect: [second] },
      }),
      expect: { stage: "none", message: undefined },
    };
  },

  /**
   * A discriminator no variant of the family declares.
   *
   * MEASURED: the parse boundary refuses it — every direct variant verb spells
   * its `type` as a union of literals — so construction's `unknownVariant`
   * deferred refusal is DEFENSIVE and unreachable from the public grammar. The
   * strategy keeps its semantic shape and states the stage that is true.
   */
  "unknown-variant": (payload, schema) => {
    const arm =
      firstUpdateArm(payload) ??
      recordArms(payload, createArms(payload.operation))[0];
    const model = schema[payload.model];
    if (arm === undefined || !model) return undefined;
    const edge = variantEdgesOf(schema, model)[0];
    if (!edge) return undefined;
    const selector = selectorFor(edge.target, 1);
    if (!selector) return undefined;
    const item = { type: "__nope", where: selector };
    return {
      strategy: "unknown-variant",
      payload: isolate(payload, schema, arm, {
        [edge.field]: { connect: edge.cardinality === "many" ? [item] : item },
      }),
      expect: {
        stage: "validation",
        class: "type-mismatch",
        message: UNION_MEMBER,
      },
    };
  },

  /** A to-one nested `update` whose filter selects a row other than the member. */
  "to-one-update-where-mismatch": (payload, schema) => {
    const arm = singleUpdateArm(payload);
    const model = schema[payload.model];
    if (arm === undefined || !model) return undefined;
    const edge = edgesOf(schema, model).find(
      (candidate) =>
        candidate.cardinality === "one" &&
        updatableScalar(candidate.target, referenceColumnsOf(candidate)) !==
          undefined &&
        rowKeyFields(candidate.target).length === 1
    );
    if (!edge) return undefined;
    const keyField = rowKeyFields(edge.target)[0] as string;
    const scalar = updatableScalar(
      edge.target,
      referenceColumnsOf(edge)
    ) as string;
    return {
      strategy: "to-one-update-where-mismatch",
      payload: isolate(payload, schema, arm, {
        [edge.field]: {
          update: {
            where: { [keyField]: literalFor(edge.target, keyField, 9) },
            data: { [scalar]: `${scalar}_9` },
          },
        },
      }),
      expect: {
        stage: "premise",
        error: "NestedWriteError",
        message: new RegExp(
          `^Cannot update relation '${edge.field}': target record was not found for this parent\\.$`
        ),
      },
    };
  },

  /** `set` on a to-many whose members hold a REQUIRED reference: departures orphan. */
  "set-orphans-required-child": (payload, schema) => {
    const arm = singleUpdateArm(payload);
    const model = schema[payload.model];
    if (arm === undefined || !model) return undefined;
    const edge = edgesOf(schema, model).find(
      (candidate) =>
        candidate.cardinality === "many" &&
        !candidate.cells.holderIsSource &&
        !candidate.cells.viaJunction &&
        !candidate.cells.nullable
    );
    if (!edge) return undefined;
    const selector = selectorFor(edge.target, 1);
    if (!selector) return undefined;
    return {
      strategy: "set-orphans-required-child",
      payload: isolate(payload, schema, arm, {
        [edge.field]: { set: [selector] },
      }),
      expect: {
        stage: "premise",
        error: "NestedWriteError",
        message: new RegExp(
          `^Cannot set relation '${edge.field}' because foreign key field\\(s\\) ${edge.cells.holder.fields.join(", ")} are required`
        ),
      },
    };
  },
};

// =============================================================================
// DISPATCH
// =============================================================================

const isSemantic = (strategy: InvalidStrategy): strategy is SemanticStrategy =>
  (SEMANTIC_STRATEGIES as readonly string[]).includes(strategy);

/** Apply one strategy; `undefined` when it does not apply to this payload. */
export function mutate(
  strategy: InvalidStrategy,
  payload: GeneratedPayload,
  schema: SchemaMap,
  registry: RegistryLike
): InvalidPayload | undefined {
  if (isSemantic(strategy)) {
    return SEMANTIC[strategy](payload, schema, registry);
  }
  return VALIDATION[strategy](payload, rootFacts(schema, registry, payload));
}

/** Every applicable mutant of one payload, in strategy order. */
export function mutateAll(
  payload: GeneratedPayload,
  schema: SchemaMap,
  registry: RegistryLike
): InvalidPayload[] {
  const facts = rootFacts(schema, registry, payload);
  const mutants: InvalidPayload[] = [];
  for (const strategy of VALIDATION_STRATEGIES) {
    const mutant = VALIDATION[strategy](payload, facts);
    if (mutant) mutants.push(mutant);
  }
  for (const strategy of SEMANTIC_STRATEGIES) {
    const mutant = SEMANTIC[strategy](payload, schema, registry);
    if (mutant) mutants.push(mutant);
  }
  return mutants;
}

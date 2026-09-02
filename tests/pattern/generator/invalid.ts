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
import type { AnyModel } from "@schema/model";
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

export const INVALID_STRATEGIES = [
  "unknown-key",
  "wrong-scalar-type",
  "to-many-verb-on-to-one",
  "empty-where-unique",
  "set-under-create",
  "disconnect-on-required",
  "missing-required",
  "select-and-include",
] as const;

export type InvalidStrategy = (typeof INVALID_STRATEGIES)[number];

export type RefusalClass =
  | "unknown-key"
  | "type-mismatch"
  | "empty-selector"
  | "missing-required"
  | "exclusive-keys";

export interface InvalidPayload {
  readonly strategy: InvalidStrategy;
  readonly payload: GeneratedPayload;
  readonly expect: {
    readonly class: RefusalClass;
    /** The validator's sentence when it is fixed; `undefined` when it depends on the slot. */
    readonly message: RegExp | undefined;
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

const STRATEGIES: Readonly<Record<InvalidStrategy, Strategy>> = {
  "unknown-key": (payload) => ({
    strategy: "unknown-key",
    payload: withArg(payload, "__unexpected", 1),
    expect: { class: "unknown-key", message: UNKNOWN_UNEXPECTED },
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
      expect: { class: "type-mismatch", message: undefined },
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
      expect: { class: "unknown-key", message: UNKNOWN_SET },
    };
  },

  "empty-where-unique": (payload) => {
    if (!UNIQUE_SELECTOR_OPERATIONS.has(payload.operation)) return undefined;
    return {
      strategy: "empty-where-unique",
      payload: withArg(payload, "where", {}),
      expect: { class: "empty-selector", message: EMPTY_SELECTOR },
    };
  },

  "set-under-create": (payload, facts) => {
    const relation = facts.toMany[0];
    const arm = recordArms(payload, createArms(payload.operation))[0];
    if (relation === undefined || arm === undefined) return undefined;
    return {
      strategy: "set-under-create",
      payload: withRelationInArm(payload, arm, relation, { set: [] }),
      expect: { class: "unknown-key", message: UNKNOWN_SET },
    };
  },

  "disconnect-on-required": (payload, facts) => {
    const relation = facts.toOneWithoutDisconnect[0];
    const arm = recordArms(payload, updateArms(payload.operation))[0];
    if (relation === undefined || arm === undefined) return undefined;
    return {
      strategy: "disconnect-on-required",
      payload: withRelationInArm(payload, arm, relation, { disconnect: true }),
      expect: { class: "unknown-key", message: UNKNOWN_DISCONNECT },
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
      expect: { class: "missing-required", message: MISSING_REQUIRED },
    };
  },

  "select-and-include": (payload, facts) => {
    if (!(facts.argsKeys.has("select") && facts.argsKeys.has("include"))) {
      return undefined;
    }
    return {
      strategy: "select-and-include",
      payload: withArgs(payload, { ...payload.args, select: {}, include: {} }),
      expect: { class: "exclusive-keys", message: MUTUALLY_EXCLUSIVE },
    };
  },
};

/** Apply one strategy; `undefined` when it does not apply to this payload. */
export function mutate(
  strategy: InvalidStrategy,
  payload: GeneratedPayload,
  schema: SchemaMap,
  registry: RegistryLike
): InvalidPayload | undefined {
  return STRATEGIES[strategy](payload, rootFacts(schema, registry, payload));
}

/** Every applicable mutant of one payload, in strategy order. */
export function mutateAll(
  payload: GeneratedPayload,
  schema: SchemaMap,
  registry: RegistryLike
): InvalidPayload[] {
  const facts = rootFacts(schema, registry, payload);
  const mutants: InvalidPayload[] = [];
  for (const strategy of INVALID_STRATEGIES) {
    const mutant = STRATEGIES[strategy](payload, facts);
    if (mutant) mutants.push(mutant);
  }
  return mutants;
}

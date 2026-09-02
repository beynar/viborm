/**
 * Seeded payload generator (pattern-engine-ideal-state.md §13.3, unit B).
 *
 * Produces VALID operation payloads by walking the ACTUAL operation schema
 * objects a `createSchemaRegistry(schema)` builds — `args.<op>` on the root
 * model, and from there every nested relation schema the walk reaches through
 * `entries`/`options`/`item`/`wrapped`. Nothing here re-derives the operation
 * language from the model: which verbs a relation admits under create vs
 * update, which keys a nested payload owns, which selector keys are unique —
 * all of it is read off the schema graph, so the generator cannot drift from
 * the validator it feeds.
 *
 * Values come from a small seeded pool (`<field>_1..<field>_N`, `1..N`), so
 * `connect` targets and `where` selectors repeat across a corpus: duplicate
 * connectOrCreate, first-create-wins and the like are reachable by chance.
 */
import type { AnyModel } from "@schema/model";
import type { Operation } from "@src/query-engine/types";
import { parseValidated } from "@src/query-engine/write-engine/parse-boundary";
import type { SchemaRegistryLookup } from "@validation/types";
import {
  type AnySchema,
  acceptsUndefined,
  canGenerate,
  classify,
  collectEntryKeys,
  isLeafy,
  isRecord,
  isSchema,
  refuses,
  resolveSchema,
  type SchemaNode,
  usableEntryCount,
} from "./introspect";
import { deriveSeed, mulberry32, type Rng } from "./random";

// =============================================================================
// PUBLIC SURFACE
// =============================================================================

export const ROOT_OPERATIONS = [
  "findMany",
  "findFirst",
  "findUnique",
  "create",
  "update",
  "upsert",
  "delete",
  "createMany",
  "updateMany",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
] as const;

export type RootOperation = (typeof ROOT_OPERATIONS)[number];

export type SchemaMap = Readonly<Record<string, AnyModel>>;

/** The registry surface the generator reads: `createSchemaRegistry(schema)`. */
export type RegistryLike = Pick<SchemaRegistryLookup, "getModelSchemas">;

export interface GeneratorOptions {
  /** Relation nesting budget: relation keys are not opened past this depth. Default 3. */
  readonly maxDepth?: number;
  /** Hard cap on object nesting of any kind. Default 12. */
  readonly maxObjectNesting?: number;
  /**
   * How many times one schema object may re-enter itself on a path
   * (`where.AND[i]` is the same `where`; scalar `not` is the same filter). The
   * last admitted re-entry is leaf-only, so a self-recursive schema cannot grow
   * geometrically. Relation recursion is `maxDepth`'s business. Default 1.
   */
  readonly maxSelfRecursion?: number;
  /** Root operation weights; an absent operation keeps its default weight, 0 disables it. */
  readonly weights?: Partial<Record<RootOperation, number>>;
  /** Root models to draw from. Default: every model of the schema. */
  readonly models?: readonly string[];
  /** Size of the literal pool per field (`id_1..id_N`). Default 3. */
  readonly idPoolSize?: number;
  /** Probability of emitting an optional key. Default 0.35. */
  readonly optionalKeyProbability?: number;
  /** Probability of `null` where a slot is nullable. Default 0.15. */
  readonly nullProbability?: number;
  /** Longest generated array. Default 3. */
  readonly maxArrayLength?: number;
  /** Also emit the accepted two-verb to-one compositions (`disconnect`+`connect` …). Default true. */
  readonly composeToOne?: boolean;
  /** Leave `{}` where the schema allows it instead of adding one key. Default false. */
  readonly allowEmptyObjects?: boolean;
}

export type RelationKind = "toOne" | "toMany";

export type RelationContext =
  | "create"
  | "update"
  | "filter"
  | "select"
  | "orderBy"
  | "other";

/** One relation key the walk opened, and the verbs it spelled there. */
export interface TrailEntry {
  /** Dotted path from the root args, array items by index (`data.posts.create.0.author`). */
  readonly path: string;
  readonly kind: RelationKind;
  readonly context: RelationContext;
  readonly verbs: readonly string[];
}

export interface GeneratedPayload {
  readonly model: string;
  readonly operation: RootOperation;
  readonly args: Record<string, unknown>;
  /** Every relation verb emitted, as `<path>:<verb>`. */
  readonly path: readonly string[];
  readonly trail: readonly TrailEntry[];
  readonly seed: number;
}

const DEFAULT_WEIGHTS: Readonly<Record<RootOperation, number>> = {
  findMany: 2,
  findFirst: 1,
  findUnique: 1,
  create: 3,
  update: 3,
  upsert: 2,
  delete: 1,
  createMany: 1,
  updateMany: 1,
  deleteMany: 1,
  count: 1,
  aggregate: 1,
  groupBy: 1,
};

interface Settings {
  readonly maxDepth: number;
  readonly maxObjectNesting: number;
  readonly maxSelfRecursion: number;
  readonly weights: Readonly<Record<RootOperation, number>>;
  readonly models: readonly string[] | undefined;
  readonly idPoolSize: number;
  readonly optionalKeyProbability: number;
  readonly nullProbability: number;
  readonly maxArrayLength: number;
  readonly composeToOne: boolean;
  readonly allowEmptyObjects: boolean;
}

const settle = (options: GeneratorOptions | undefined): Settings => ({
  maxDepth: options?.maxDepth ?? 3,
  maxObjectNesting: options?.maxObjectNesting ?? 12,
  maxSelfRecursion: Math.max(0, options?.maxSelfRecursion ?? 1),
  weights: { ...DEFAULT_WEIGHTS, ...options?.weights },
  models: options?.models,
  idPoolSize: Math.max(1, Math.min(9, options?.idPoolSize ?? 3)),
  optionalKeyProbability: options?.optionalKeyProbability ?? 0.35,
  nullProbability: options?.nullProbability ?? 0.15,
  maxArrayLength: Math.max(1, options?.maxArrayLength ?? 3),
  composeToOne: options?.composeToOne ?? true,
  allowEmptyObjects: options?.allowEmptyObjects ?? false,
});

/** The operation schema the engine validates `operation` on `model` against. */
export function operationSchema(
  registry: RegistryLike,
  schema: SchemaMap,
  model: string,
  operation: RootOperation
): AnySchema {
  const target = schema[model];
  if (!target) throw new Error(`generator: unknown model '${model}'`);
  const args = Reflect.get(registry.getModelSchemas(target).args, operation);
  if (!isSchema(args)) {
    throw new Error(`generator: no args schema for ${model}.${operation}`);
  }
  return args;
}

/**
 * THE validation entry the write engine uses (`parse-boundary.ts`), applied to
 * a generated payload. Returns the parsed value; throws `ValidationError`.
 */
export function validatePayload(
  registry: RegistryLike,
  schema: SchemaMap,
  payload: Pick<GeneratedPayload, "model" | "operation" | "args">
): unknown {
  const operation: Operation = payload.operation;
  return parseValidated(
    operationSchema(registry, schema, payload.model, payload.operation),
    payload.args,
    operation,
    ""
  );
}

export function generatePayload(
  schema: SchemaMap,
  registry: RegistryLike,
  seed: number,
  options?: GeneratorOptions
): GeneratedPayload {
  const settings = settle(options);
  const rng = mulberry32(seed);
  const models = settings.models ?? Object.keys(schema);
  if (models.length === 0) throw new Error("generator: no models to draw from");
  const model = rng.pick(models);
  const operation = weightedOperation(rng, settings.weights);
  const walker = new Walker(rng, settings);
  const args = walker.root(operationSchema(registry, schema, model, operation));
  const trail = walker.trail;
  return {
    model,
    operation,
    args,
    path: trail.flatMap((entry) =>
      entry.verbs.map((verb) => `${entry.path}:${verb}`)
    ),
    trail,
    seed,
  };
}

export function generateCorpus(
  schema: SchemaMap,
  registry: RegistryLike,
  seed: number,
  count: number,
  options?: GeneratorOptions
): GeneratedPayload[] {
  const corpus: GeneratedPayload[] = [];
  for (let index = 0; index < count; index++) {
    corpus.push(
      generatePayload(schema, registry, deriveSeed(seed, index), options)
    );
  }
  return corpus;
}

// =============================================================================
// VOCABULARY
// =============================================================================

const TO_ONE_VERBS: ReadonlySet<string> = new Set([
  "create",
  "connect",
  "connectOrCreate",
  "update",
  "upsert",
  "disconnect",
  "delete",
]);

const TO_MANY_ONLY_VERBS: ReadonlySet<string> = new Set([
  "createMany",
  "set",
  "updateMany",
  "deleteMany",
]);

const VERB_KEYS: ReadonlySet<string> = new Set([
  ...TO_ONE_VERBS,
  ...TO_MANY_ONLY_VERBS,
]);

/** Keys whose presence marks a schema as a RELATION entry (verbs, relation filters, projections). */
const RELATION_MARKERS: ReadonlySet<string> = new Set([
  "connect",
  "create",
  "createMany",
  "some",
  "every",
  "none",
  "is",
  "isNot",
  "select",
  "include",
  "_count",
]);

const TO_MANY_MARKERS: ReadonlySet<string> = new Set([
  "some",
  "every",
  "none",
  "createMany",
  "set",
  "updateMany",
  "deleteMany",
  "take",
  "skip",
  "cursor",
  "distinct",
  "_count",
]);

const UPDATE_CONTEXT_MARKERS: ReadonlySet<string> = new Set([
  "update",
  "set",
  "disconnect",
  "delete",
  "updateMany",
  "deleteMany",
]);

const FILTER_MARKERS: ReadonlySet<string> = new Set([
  "some",
  "every",
  "none",
  "is",
  "isNot",
]);

const PROJECTION_KEYS: ReadonlySet<string> = new Set([
  "select",
  "include",
  "omit",
]);

/**
 * The accepted two-verb to-one compositions on EVERY direction (see
 * `to-one-mutation-schema.ts`): a vacate then a supplier, and `connect` then
 * `update`. The generator proposes one of these and lets the bag's own
 * validator decide (an `exactlyOne` surface refuses them all), falling back to
 * a single verb — so this list never has to know which rule a bag publishes.
 */
const TO_ONE_COMPOSITIONS: readonly (readonly [string, string])[] = [
  ["disconnect", "connect"],
  ["disconnect", "create"],
  ["disconnect", "connectOrCreate"],
  ["delete", "connect"],
  ["delete", "create"],
  ["connect", "update"],
];

/**
 * Keys that are part of the operation language rather than a field or
 * relation name. Entering one of them keeps the enclosing FIELD context, which
 * is what names the literal pool (`<field>_<k>`).
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  ...VERB_KEYS,
  "where",
  "data",
  "select",
  "include",
  "omit",
  "orderBy",
  "take",
  "skip",
  "cursor",
  "distinct",
  "by",
  "having",
  "limit",
  "skipDuplicates",
  "targetWhere",
  "setWhere",
  "type",
  "AND",
  "OR",
  "NOT",
  "is",
  "isNot",
  "some",
  "every",
  "none",
  "equals",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "endsWith",
  "mode",
  "not",
  "has",
  "hasEvery",
  "hasSome",
  "isEmpty",
  "path",
  "within",
  "increment",
  "decrement",
  "multiply",
  "divide",
  "push",
  "unshift",
  "sort",
  "nulls",
  "to",
  "metric",
  "_count",
  "_avg",
  "_sum",
  "_min",
  "_max",
  "_all",
  "_distance",
]);

const NONE: unique symbol = Symbol("generator.none");

interface Frame {
  readonly path: readonly (string | number)[];
  readonly field: string;
  readonly relationDepth: number;
  readonly nesting: number;
  /** The object schemas enclosing this position, root first (self-recursion budget). */
  readonly lineage: readonly AnySchema[];
  /** The enclosing object has spent its self-recursion budget: leaf keys only. */
  readonly leafOnly: boolean;
  readonly noNull: boolean;
}

type ObjectNode = Extract<SchemaNode, { kind: "object" }>;
type ScalarNode = Extract<SchemaNode, { kind: "scalar" }>;

const isToOneBag = (keys: readonly string[]): boolean =>
  keys.includes("connect") && keys.every((key) => TO_ONE_VERBS.has(key));

const isToManyBag = (keys: readonly string[]): boolean =>
  keys.some((key) => TO_MANY_ONLY_VERBS.has(key));

const isRelationEntry = (schema: AnySchema): boolean => {
  for (const key of collectEntryKeys(schema)) {
    if (RELATION_MARKERS.has(key)) return true;
  }
  return false;
};

const relationKind = (keys: ReadonlySet<string>): RelationKind => {
  for (const key of keys) {
    if (TO_MANY_MARKERS.has(key)) return "toMany";
  }
  return "toOne";
};

const relationContext = (keys: ReadonlySet<string>): RelationContext => {
  for (const key of keys) {
    if (FILTER_MARKERS.has(key)) return "filter";
  }
  if (keys.has("select") || keys.has("include")) return "select";
  for (const key of keys) {
    if (UPDATE_CONTEXT_MARKERS.has(key)) return "update";
  }
  if (keys.has("connect") || keys.has("create")) return "create";
  if (keys.has("_count")) return "orderBy";
  return "other";
};

const describeVerbs = (value: unknown): readonly string[] => {
  if (value === null) return ["null"];
  if (Array.isArray(value)) return ["array"];
  if (isRecord(value)) {
    const verbs = new Set<string>();
    for (const key of Object.keys(value)) {
      verbs.add(
        VERB_KEYS.has(key) || STRUCTURAL_KEYS.has(key) ? key : "shorthand"
      );
    }
    return [...verbs];
  }
  return [String(value)];
};

const weightedOperation = (
  rng: Rng,
  weights: Readonly<Record<RootOperation, number>>
): RootOperation => {
  const total = ROOT_OPERATIONS.reduce(
    (sum, operation) => sum + Math.max(0, weights[operation]),
    0
  );
  if (total <= 0) throw new Error("generator: every operation weight is 0");
  let cursor = rng.next() * total;
  for (const operation of ROOT_OPERATIONS) {
    cursor -= Math.max(0, weights[operation]);
    if (cursor < 0) return operation;
  }
  return ROOT_OPERATIONS.at(-1)!;
};

const pad2 = (k: number): string => String(k).padStart(2, "0");

// =============================================================================
// THE WALK
// =============================================================================

class Walker {
  readonly trail: TrailEntry[] = [];
  private readonly rng: Rng;
  private readonly settings: Settings;

  constructor(rng: Rng, settings: Settings) {
    this.rng = rng;
    this.settings = settings;
  }

  root(schema: AnySchema): Record<string, unknown> {
    const resolved = resolveSchema(schema);
    const node = resolved ? classify(resolved) : undefined;
    if (node?.kind !== "object") {
      throw new Error("generator: the operation schema is not an object");
    }
    const value = this.object(node, {
      path: [],
      field: "root",
      relationDepth: 0,
      nesting: 0,
      lineage: [],
      leafOnly: false,
      noNull: false,
    });
    if (value === NONE || !isRecord(value)) {
      throw new Error("generator: could not produce root args");
    }
    return value;
  }

  /** Every budget spent: prefer leaf alternatives, open no new relation. */
  private atCap(frame: Frame): boolean {
    return (
      frame.leafOnly ||
      frame.relationDepth >= this.settings.maxDepth ||
      frame.nesting >= this.settings.maxObjectNesting
    );
  }

  private value(schema: AnySchema, frame: Frame): unknown {
    const node = classify(schema);
    switch (node.kind) {
      case "scalar":
        return this.scalar(node, frame);
      case "optional":
        return this.value(node.wrapped, frame);
      case "nullable":
        return !frame.noNull && this.rng.chance(this.settings.nullProbability)
          ? null
          : this.value(node.wrapped, frame);
      case "wrapped":
        return this.value(
          node.wrapped,
          node.type === "json_write" ? { ...frame, noNull: true } : frame
        );
      case "union":
        return this.union(node.options, frame);
      case "array":
        return this.array(node.item, frame);
      case "object":
        return this.objectNode(node, frame);
      default:
        return NONE;
    }
  }

  private union(options: readonly AnySchema[], frame: Frame): unknown {
    const candidates = options.filter((option) => canGenerate(option));
    if (candidates.length === 0) return NONE;
    const leafy = this.atCap(frame) ? candidates.filter((c) => isLeafy(c)) : [];
    for (const option of this.rng.shuffle(
      leafy.length > 0 ? leafy : candidates
    )) {
      const value = this.value(option, frame);
      if (value !== NONE) return value;
    }
    return NONE;
  }

  private arrayLength(frame: Frame): number {
    if (this.atCap(frame)) return 1;
    return this.rng.chance(0.1)
      ? 0
      : 1 + this.rng.int(this.settings.maxArrayLength);
  }

  private array(item: AnySchema, frame: Frame): unknown {
    if (!canGenerate(item)) return NONE;
    const items: unknown[] = [];
    const length = this.arrayLength(frame);
    for (let index = 0; index < length; index++) {
      const value = this.value(item, {
        ...frame,
        path: [...frame.path, index],
      });
      if (value !== NONE) items.push(value);
    }
    return items;
  }

  private objectNode(node: ObjectNode, frame: Frame): unknown {
    if (
      node.options.nullable &&
      !frame.noNull &&
      this.rng.chance(this.settings.nullProbability)
    ) {
      return null;
    }
    if (node.options.array) {
      const items: unknown[] = [];
      const length = this.arrayLength(frame);
      for (let index = 0; index < length; index++) {
        const value = this.object(node, {
          ...frame,
          path: [...frame.path, index],
        });
        if (value !== NONE) items.push(value);
      }
      return items;
    }
    return this.object(node, frame);
  }

  private object(node: ObjectNode, frame: Frame): unknown {
    const nesting = frame.nesting + 1;
    if (nesting > this.settings.maxObjectNesting + 4) return NONE;
    let repeats = 0;
    for (const ancestor of frame.lineage) {
      if (ancestor === node.schema) repeats++;
    }
    if (repeats > this.settings.maxSelfRecursion + 1) return NONE;
    const resolved = new Map<string, AnySchema>();
    const keys: string[] = [];
    for (const key of Object.keys(node.entries)) {
      if (node.options.omit.has(key)) continue;
      const entry = resolveSchema(node.entries[key]);
      if (entry && canGenerate(entry)) {
        resolved.set(key, entry);
        keys.push(key);
      }
    }
    const inner: Frame = {
      ...frame,
      nesting,
      lineage: [...frame.lineage, node.schema],
      leafOnly:
        repeats >= this.settings.maxSelfRecursion ||
        nesting >= this.settings.maxObjectNesting,
    };
    const allKeys = Object.keys(node.entries).filter(
      (key) => !node.options.omit.has(key)
    );
    if (isToOneBag(allKeys)) return this.toOneBag(node, keys, resolved, inner);
    const chosen = new Set<string>();
    const required = new Set<string>();
    if (isToManyBag(allKeys)) {
      this.chooseToManyVerbs(keys, chosen);
    } else {
      this.chooseRequired(node, keys, resolved, inner, required);
      for (const key of required) chosen.add(key);
      this.chooseOptional(node, keys, resolved, inner, chosen);
    }
    return this.materialize(keys, resolved, chosen, required, inner);
  }

  private chooseToManyVerbs(
    keys: readonly string[],
    chosen: Set<string>
  ): void {
    if (keys.length === 0) return;
    const count = this.rng.chance(0.35) ? 2 : 1;
    for (const verb of this.rng.shuffle(keys).slice(0, count)) chosen.add(verb);
  }

  private preferLeafy(
    candidates: readonly string[],
    resolved: ReadonlyMap<string, AnySchema>,
    frame: Frame
  ): string {
    if (this.atCap(frame)) {
      const leafy = candidates.filter((key) => isLeafy(resolved.get(key)!));
      if (leafy.length > 0) return this.rng.pick(leafy);
    }
    return this.rng.pick(candidates);
  }

  private chooseRequired(
    node: ObjectNode,
    keys: readonly string[],
    resolved: ReadonlyMap<string, AnySchema>,
    frame: Frame,
    required: Set<string>
  ): void {
    if (!node.options.partial) {
      for (const key of keys) {
        if (!acceptsUndefined(resolved.get(key)!)) required.add(key);
      }
    }
    for (const key of node.options.atLeast) {
      if (resolved.has(key)) required.add(key);
    }
    for (const group of node.options.requiresOneOf) {
      if (group.some((key) => node.options.omit.has(key))) continue;
      if (group.some((key) => required.has(key))) continue;
      const candidates = group.filter((key) => resolved.has(key));
      if (candidates.length > 0) {
        required.add(this.preferLeafy(candidates, resolved, frame));
      }
    }
    for (const group of node.options.requiresOneOfKeySets) {
      if (group.some((set) => set.some((key) => node.options.omit.has(key)))) {
        continue;
      }
      if (group.some((set) => set.every((key) => required.has(key)))) continue;
      const candidates = group.filter((set) =>
        set.every((key) => resolved.has(key))
      );
      if (candidates.length === 0) continue;
      const leafy = this.atCap(frame)
        ? candidates.filter((set) =>
            set.every((key) => isLeafy(resolved.get(key)!))
          )
        : [];
      const picked = this.rng.pick(leafy.length > 0 ? leafy : candidates);
      for (const key of picked) required.add(key);
    }
  }

  private chooseOptional(
    node: ObjectNode,
    keys: readonly string[],
    resolved: ReadonlyMap<string, AnySchema>,
    frame: Frame,
    chosen: Set<string>
  ): void {
    // Alternatives of a `requiresOneOfKeySets` group are exclusive by intent
    // (a foreign key OR its relation bag): the untaken keys stay out.
    const alternatives = new Set<string>();
    for (const group of node.options.requiresOneOfKeySets) {
      for (const set of group) {
        if (set.every((key) => chosen.has(key))) continue;
        for (const key of set) alternatives.add(key);
      }
    }
    let projectionTaken = [...chosen].some((key) => PROJECTION_KEYS.has(key));
    const atRelationCap = frame.relationDepth >= this.settings.maxDepth;
    for (const key of keys) {
      if (chosen.has(key) || alternatives.has(key)) continue;
      const schema = resolved.get(key)!;
      if (PROJECTION_KEYS.has(key) && projectionTaken) continue;
      if (key === "omit" && usableEntryCount(schema) < 2) continue;
      const leafy = isLeafy(schema);
      if (frame.leafOnly && !leafy) continue;
      if (
        atRelationCap &&
        !STRUCTURAL_KEYS.has(key) &&
        isRelationEntry(schema)
      ) {
        continue;
      }
      if (!this.rng.chance(this.settings.optionalKeyProbability)) continue;
      chosen.add(key);
      if (PROJECTION_KEYS.has(key)) projectionTaken = true;
    }
    if (chosen.size > 0) return;
    if (!(node.options.nonEmpty || !this.settings.allowEmptyObjects)) return;
    const openable = keys.filter(
      (key) =>
        !(
          alternatives.has(key) ||
          (atRelationCap &&
            !STRUCTURAL_KEYS.has(key) &&
            isRelationEntry(resolved.get(key)!))
        )
    );
    const leafy = openable.filter((key) => isLeafy(resolved.get(key)!));
    const pool = leafy.length > 0 ? leafy : openable;
    if (pool.length > 0) chosen.add(this.rng.pick(pool));
  }

  private toOneBag(
    node: ObjectNode,
    keys: readonly string[],
    resolved: ReadonlyMap<string, AnySchema>,
    frame: Frame
  ): unknown {
    if (keys.length === 0) return NONE;
    const single = (): readonly string[] => [
      this.atCap(frame) && keys.includes("connect")
        ? "connect"
        : this.rng.pick(keys),
    ];
    let verbs = single();
    if (
      this.settings.composeToOne &&
      !this.atCap(frame) &&
      this.rng.chance(0.3)
    ) {
      const pairs = TO_ONE_COMPOSITIONS.filter((pair) =>
        pair.every((verb) => keys.includes(verb))
      );
      if (pairs.length > 0) verbs = this.rng.pick(pairs);
    }
    const build = (chosen: readonly string[]): unknown =>
      this.materialize(keys, resolved, new Set(chosen), new Set(chosen), frame);
    const composed = build(verbs);
    if (verbs.length === 1 || composed === NONE) return composed;
    // The bag's own validator is the one authority on its composition rule.
    return refuses(node.schema, composed) ? build(single()) : composed;
  }

  private materialize(
    keys: readonly string[],
    resolved: ReadonlyMap<string, AnySchema>,
    chosen: ReadonlySet<string>,
    required: ReadonlySet<string>,
    frame: Frame
  ): unknown {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (!chosen.has(key)) continue;
      const value = this.entry(key, resolved.get(key)!, frame);
      if (value === NONE) {
        if (required.has(key)) return NONE;
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  private entry(key: string, schema: AnySchema, frame: Frame): unknown {
    const structural = STRUCTURAL_KEYS.has(key);
    const relation = !structural && isRelationEntry(schema);
    const child: Frame = {
      ...frame,
      path: [...frame.path, key],
      field: structural ? frame.field : key,
      relationDepth: frame.relationDepth + (relation ? 1 : 0),
    };
    let value: unknown;
    if (key === "omit") {
      value = this.omitValue(schema);
    } else if (VERB_KEYS.has(key) && this.isBooleanVerb(schema)) {
      // `disconnect: false` / `delete: false` are inert; a verb is spelled active.
      value = true;
    } else {
      value = this.value(schema, child);
    }
    if (relation && value !== NONE) {
      const entryKeys = collectEntryKeys(schema);
      this.trail.push({
        path: child.path.join("."),
        kind: relationKind(entryKeys),
        context: relationContext(entryKeys),
        verbs: describeVerbs(value),
      });
    }
    return value;
  }

  private isBooleanVerb(schema: AnySchema): boolean {
    const node = classify(schema);
    return node.kind === "scalar" && node.type === "boolean";
  }

  /** `omit` names exactly one projectable field, so a projection always survives it. */
  private omitValue(schema: AnySchema): unknown {
    const node = classify(schema);
    if (node.kind !== "object") return NONE;
    const keys = Object.keys(node.entries).filter(
      (key) => !node.options.omit.has(key)
    );
    if (keys.length < 2) return NONE;
    return { [this.rng.pick(keys)]: true };
  }

  private scalar(node: ScalarNode, frame: Frame): unknown {
    const pool = this.settings.idPoolSize;
    const k = 1 + this.rng.int(pool);
    if (node.options.array) {
      const length = this.arrayLength(frame);
      const items: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const item = this.literal(
          node,
          frame.field,
          1 + ((k + index - 1) % pool)
        );
        if (item === NONE) return NONE;
        items.push(item);
      }
      return items;
    }
    if (
      node.options.nullable &&
      !frame.noNull &&
      node.type !== "json" &&
      this.rng.chance(this.settings.nullProbability)
    ) {
      return null;
    }
    return this.literal(node, frame.field, k);
  }

  private literal(node: ScalarNode, field: string, k: number): unknown {
    switch (node.type) {
      case "string":
        return `${field}_${k}`;
      case "integer":
        return k;
      case "number":
        return k + 0.5;
      case "boolean":
        return this.rng.chance(0.5);
      case "bigint":
        return BigInt(k);
      case "decimal": {
        const scale = node.options.decimal?.scale ?? 2;
        return scale > 0 ? `${k}.${"5".padEnd(scale, "0")}` : `${k}`;
      }
      case "enum":
        return node.values.length === 0
          ? NONE
          : node.values[(k - 1) % node.values.length];
      case "literal":
        return node.value;
      case "json":
        return { [field]: k };
      case "date":
        return new Date(Date.UTC(2026, 0, k));
      case "iso_timestamp":
        return `2026-01-${pad2(k)}T00:00:00.000Z`;
      case "iso_date":
        return `2026-01-${pad2(k)}`;
      case "iso_time":
        return `${pad2(k)}:00:00`;
      case "blob":
        return new Uint8Array([k]);
      case "vector":
        return Array.from({ length: node.dimensions ?? 3 }, () => k + 0.25);
      case "point":
        return { longitude: k, latitude: k };
      default:
        return NONE;
    }
  }
}

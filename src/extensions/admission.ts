/**
 * Each predicate of a rule admitted once, when its extension is applied,
 * through its model's `where` schema: a misspelt key fails here, never at
 * the first read, and the engine prepares what a caller's `where` would be
 * (K1(a)). The words are read as they are: `arg` and `now` are call values
 * (parameters), `row` an enclosing column, `when`, `unless` and `provided`
 * conditions folded per call, `exists` another model's rows.
 */
import type { Schema } from "@client/types";
import { ClientInitializationError } from "@errors";
import {
  Condition,
  type ConditionTest,
  Existence,
  type LazyRelations,
  OuterColumn,
  Parameter,
} from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
import type { ModelState } from "@schema/model";
import { isPlainRecord } from "@schema/relation/terminal";
import { createSchemaRegistry } from "@validation/builder";
import { validateSchema } from "@validation/primitives/helpers";
import {
  type AdmittedFilters,
  admittingDomainPredicate,
  type FilterWord,
} from "@validation/primitives/parameter";
import type { SchemaRegistryLookup } from "@validation/types";
import type { Judge } from "./judge";
import type { Projection } from "./projection";
import type { PreparedDomain } from "./row-domain";
import {
  ArgTestFilter,
  ArgValue,
  ExistsFilter,
  NowValue,
  RowValue,
} from "./rule-words";

/**
 * What predicates read of their call, as admission makes their parameters:
 * each argument they name, and `undefined` for the call's instant.
 */
export type References = Set<string | undefined>;

/**
 * One model's keys of one rule layer beyond its filters, as written (the
 * words' predicates raw) or as admitted: which rows a write may take
 * (`update`, `delete`, `writes`), what the rows it produces must hold
 * (`place`, `moves`, `acyclic`, with what judges them), and what a read
 * carries or hides (`evidence`, `reads`, with what projects them). `read`
 * is an entry given as a function's `read.where`: its filters are read
 * there, since what filters is bound before any entry is resolved.
 */
export interface VerbsDraft {
  read?: unknown;
  update?: unknown;
  delete?: unknown;
  writes?: Record<string, unknown>;
  place?: unknown;
  /** What the row an update leaves holds, where it writes a field this reads. */
  check?: unknown;
  moves?: Record<string, unknown>;
  reads?: Record<string, unknown>;
  evidence?: {
    readonly as: string;
    readonly names: readonly (readonly [string, unknown])[];
  };
  acyclic?: readonly string[] | (() => readonly string[]);
  /**
   * An entry given as a function's filters, as written, then as admitted
   * per value of the layer's mode argument (`""` without one): bound before
   * any entry is resolved, they are read with its other keys.
   */
  root?: readonly unknown[];
  related?: readonly unknown[];
  filters?: {
    readonly [mode: string]: {
      readonly root?: Input;
      readonly related?: Input;
    };
  };
  /** `acyclic` as admission checked it against the model's self relations. */
  cycles?: readonly string[] | LazyRelations;
  /** What judges the rows a write produces: brought by the word that asks it. */
  judge?: (domain: PreparedDomain) => Judge;
  /** What projects and hides fields: brought by the word that asks it. */
  project?: (domain: PreparedDomain) => Projection;
}

/** The argument a layer's filters are decided by, one domain per value. */
export interface LayerMode {
  readonly name: string;
  readonly values: readonly string[];
  readonly fallback: string;
}

/**
 * One extension's rule parts as written, per model: its filters by purpose
 * (each a list of `where`s and words), the argument they are decided by,
 * its other keys and its confinements. A function entry's keys are read
 * when its model is first read.
 */
export interface RuleLayer {
  readonly root: Record<string, unknown[]>;
  readonly related: Record<string, unknown[]>;
  mode?: LayerMode;
  readonly verbs: Record<string, VerbsDraft | (() => VerbsDraft)>;
  readonly confine: Record<string, unknown>;
}

/**
 * A rule layer as admission left it: per model, each value of its mode's
 * argument (`""` without one) and its filters by purpose; its other keys
 * per model (a function entry's admitted when first read); its
 * confinements; and the arguments its predicates read.
 */
export interface AdmittedLayer {
  readonly extension: string;
  readonly mode?: LayerMode;
  readonly models: {
    readonly [model: string]: {
      readonly [mode: string]: {
        readonly root?: Input;
        readonly related?: Input;
      };
    };
  };
  readonly verbs: {
    readonly [model: string]: VerbsDraft | (() => VerbsDraft);
  };
  readonly confine: { readonly [model: string]: Input };
  /** Per mode, its filters'; then its eager keys' and confinements'. */
  readonly references: {
    readonly modes: {
      readonly [mode: string]: readonly (string | undefined)[];
    };
    readonly verbs: readonly (string | undefined)[];
  };
}

/** What admits the predicates of one layer, for what reads a word's keys. */
export interface Admission {
  readonly schema: Schema;
  /**
   * `predicate`, one of model `name`'s, at `place` in the rule, admitted
   * through the model's `where` schema; what it reads of its call is added
   * to `references` as its parameters are made. A sub-predicate parsed
   * before under the same `of` is reused and adds nothing: predicates whose
   * references are told apart take their own `of`.
   */
  readonly admit: (
    name: string,
    place: string,
    predicate: unknown,
    references: References,
    of?: string
  ) => Input;
  readonly refuse: (name: string, place: string, reason: string) => never;
}

/**
 * The where schemas of a schema no client prepared (a definition read on its
 * own), built once; a client hands admission its own.
 */
const registries = new WeakMap<Schema, SchemaRegistryLookup<Schema>>();

/**
 * Each layer's admission, per schema registry: a registry is prepared once
 * per schema, and so is the layer an extension writes, so a client created
 * per request over the same schema applies the same layer without reading
 * its predicates again.
 */
const admitted = new WeakMap<
  SchemaRegistryLookup<Schema>,
  WeakMap<RuleLayer, AdmittedLayer>
>();

/** What a function entry's predicates read, recorded when it was first read. */
export const lazyReferences = new WeakMap<
  VerbsDraft,
  readonly (string | undefined)[]
>();

/** A condition's tests, the filter vocabulary's own words (OD-12). */
const TESTS = ["exists", "equals", "in", "has", "hasSome"];

/** A test of an argument, or why it is refused. */
function testOf(given: unknown): ConditionTest | string {
  const test = isPlainRecord(given) ? given : { equals: given };
  const [kind, ...others] = Object.keys(test);
  const operand = test[kind!];
  return !TESTS.includes(kind!) ||
    others.length > 0 ||
    (kind === "exists" && typeof operand !== "boolean") ||
    ((kind === "in" || kind === "hasSome") && !Array.isArray(operand))
    ? `a test is a value or exactly one of ${TESTS.join(", ")}`
    : // Exactly one known test, its operand checked above.
      (Object.freeze({ ...test }) as ConditionTest);
}

/**
 * The path at which `value` contains itself, `undefined` where it does not.
 * Only an object inside its own descendants is refused: a predicate may share
 * sub-objects freely.
 */
function cyclePath(
  value: unknown,
  acyclic: WeakSet<object>,
  ancestors = new Set<object>(),
  path: string[] = []
): string | undefined {
  if (typeof value !== "object" || value === null || acyclic.has(value))
    return undefined;
  // The root has no ancestor: a path is never empty here.
  if (ancestors.has(value)) return path.join(".");
  ancestors.add(value);
  for (const [key, item] of Object.entries(value)) {
    path.push(key);
    const found = cyclePath(item, acyclic, ancestors, path);
    if (found !== undefined) return found;
    path.pop();
  }
  ancestors.delete(value);
  // Every descendant was walked: no cycle passes through this object.
  acyclic.add(value);
  return undefined;
}

/**
 * What admits one schema's predicates: refusals are
 * `ClientInitializationError`s naming the extension, the model, the
 * predicate's place in the rule and the path inside it.
 */
export function admission(
  schema: Schema,
  extension: string,
  registry: SchemaRegistryLookup<Schema>
): Admission {
  const refuse = (name: string, place: string, reason: string): never => {
    throw new ClientInitializationError(
      `Extension "${extension}" rule.${place}: ${reason}.`,
      { meta: { extension, model: name } }
    );
  };
  const acyclic = new WeakSet<object>();
  /**
   * Shared sub-predicates are walked and parsed once per set of predicates
   * whose references are told apart: a reused parse makes no parameter, so
   * it records nothing.
   */
  const filtersOf = new Map<string, AdmittedFilters>();
  const admit = (
    name: string,
    place: string,
    predicate: unknown,
    references: References,
    of = ""
  ): Input => {
    const cycle = cyclePath(predicate, acyclic);
    if (cycle !== undefined)
      refuse(name, place, `at "${cycle}" contains itself`);
    const where = registry.getModelSchemas(schema[name]!).core.where;
    const value = (word: unknown): object | undefined => {
      if (word instanceof ArgValue) {
        references.add(word.name);
        return new Parameter(word.name, word.path);
      }
      if (word instanceof RowValue)
        return new OuterColumn(word.column, word.up);
      if (!(word instanceof NowValue)) return undefined;
      references.add(undefined);
      return new Parameter();
    };
    const filter = (word: object): FilterWord | undefined => {
      if (word instanceof ExistsFilter) {
        const models = Object.keys(word.spec);
        const [model] = models;
        const body = word.spec[model!];
        if (models.length !== 1 || !Object.hasOwn(schema, model!))
          return {
            message:
              "exists() names exactly one model of the schema and the `where` its rows must match",
            path: [],
          };
        const result = validateSchema(
          registry.getModelSchemas(schema[model!]!).core.where,
          body
        );
        if (result.issues) {
          const [issue] = result.issues;
          return {
            message: issue!.message,
            path: [model!, ...(issue!.path ?? [])],
          };
        }
        return { nodes: [new Existence(model!, result.value as Input)] };
      }
      if (!(word instanceof ArgTestFilter)) return undefined;
      const test = testOf(word.test);
      if (typeof test === "string") return { message: test, path: [] };
      const { arg, kind, then } = word;
      references.add(arg.name);
      const condition = new Condition(new Parameter(arg.name, arg.path), test);
      if (kind === "provided")
        return then === undefined
          ? { nodes: [condition] }
          : { nodes: [condition], where: { AND: [condition, then] } };
      return {
        nodes: [condition],
        where: { OR: [kind === "when" ? { NOT: condition } : condition, then] },
      };
    };
    let filters = filtersOf.get(of);
    if (filters === undefined) filtersOf.set(of, (filters = new WeakMap()));
    const result = admittingDomainPredicate(
      { value, filter },
      () => validateSchema(where, predicate),
      filters
    );
    if (!result.issues) return result.value as Input;
    const [issue] = result.issues;
    return refuse(
      name,
      place,
      `at "${issue!.path?.map(String).join(".") || "root"}": ${issue!.message}`
    );
  };
  return { schema, admit, refuse };
}

/** Whether every scalar of the schema reads its value with the engine's own schema. */
function nativeSchema(schema: Schema): boolean {
  return Object.values(schema).every((model) => {
    const state: ModelState = model["~"].state;
    return Object.values(state.scalars).every(
      (scalar) => scalar["~"].state.schema === undefined
    );
  });
}

/** The items of a filter list that hold in `mode`, as one `where`. */
function filterIn(
  items: readonly unknown[],
  layer: RuleLayer,
  mode: string | undefined
): unknown {
  const applied: unknown[] = [];
  for (const item of items) {
    const tested = modeTest(item, layer.mode);
    if (tested === undefined) applied.push(item);
    else if (holds(tested, mode!)) applied.push(tested.then);
  }
  if (applied.length === 0) return undefined;
  if (applied.length === 1) return applied[0];
  return { AND: applied };
}

/** A `when` or `unless` on the mode's argument: it decides per mode, not per call. */
export function modeTest(
  item: unknown,
  mode: LayerMode | undefined
): ArgTestFilter | undefined {
  return item instanceof ArgTestFilter &&
    item.kind !== "provided" &&
    item.arg.path === undefined &&
    item.arg.name === mode?.name
    ? item
    : undefined;
}

/** Whether a test of the mode's argument holds for one of its values. */
function holds(filter: ArgTestFilter, mode: string): boolean {
  const { test } = filter;
  const passed = isPlainRecord(test)
    ? "in" in test && Array.isArray(test.in)
      ? test.in.includes(mode)
      : "equals" in test
        ? test.equals === mode
        : "exists" in test && test.exists === true
    : test === mode;
  return filter.kind === "when" ? passed : !passed;
}

/** The keys of a draft that hold one predicate, each admitted as one. */
const SINGLE = ["read", "update", "delete", "place", "check"] as const;
/** The keys of a draft that hold one predicate per field. */
const PER_FIELD = ["writes", "moves", "reads"] as const;

/**
 * The self relations `acyclic` names, each checked to be one of `model`'s
 * to itself holding its key: only those can loop. Given as a function, they
 * are read and checked when an update first writes one of those keys.
 */
function cyclesOf(
  { schema, refuse }: Admission,
  name: string,
  declared: NonNullable<VerbsDraft["acyclic"]>
): readonly string[] | LazyRelations {
  const model = schema[name]!;
  const { relations } = model["~"].state;
  const keyed = Object.keys(relations).filter((relation) => {
    const held = relations[relation]!["~"];
    return held.state.foreignKey !== undefined && held.settleTarget() === model;
  });
  const checked = (listed: readonly string[]): readonly string[] => {
    for (const relation of listed)
      if (!keyed.includes(relation))
        refuse(
          name,
          `${name}.acyclic.${relation}`,
          "names no to-one relation of the model to itself holding its key"
        );
    return Object.freeze([...listed]);
  };
  if (typeof declared !== "function") return checked(declared);
  let resolved: readonly string[] | undefined;
  return Object.freeze({
    candidates: Object.freeze(keyed),
    resolve: () => (resolved ??= checked(declared())),
  });
}

/** One model's draft with every predicate admitted. */
export function admitDraft(
  admission: Admission,
  name: string,
  draft: VerbsDraft,
  references: References,
  of?: string
): VerbsDraft {
  const { admit } = admission;
  const out: VerbsDraft = { ...draft };
  if (draft.acyclic !== undefined)
    out.cycles = cyclesOf(admission, name, draft.acyclic);
  for (const key of SINGLE)
    if (draft[key] !== undefined)
      out[key] = admit(name, `${name}.${key}`, draft[key], references, of);
  for (const key of PER_FIELD)
    if (draft[key] !== undefined)
      out[key] = Object.fromEntries(
        Object.entries(draft[key]).map(([field, where]) => [
          field,
          admit(name, `${name}.${key}.${field}`, where, references, of),
        ])
      );
  if (draft.evidence !== undefined)
    out.evidence = {
      as: draft.evidence.as,
      names: draft.evidence.names.map(([fact, where]) => [
        fact,
        admit(name, `${name}.read.select.${fact}`, where, references, of),
      ]),
    };
  return Object.freeze(out);
}

/**
 * One extension's rule layer with every predicate admitted: each filter
 * once per value of its mode's argument, and each other key once. Admitted
 * once per schema registry, where the schema's scalars admit with the
 * engine's own schemas.
 */
export function admitLayer(
  layer: RuleLayer,
  schema: Schema,
  extension: string,
  given?: SchemaRegistryLookup<Schema>
): AdmittedLayer {
  let registry = given ?? registries.get(schema);
  if (registry === undefined) {
    registry = createSchemaRegistry(schema);
    registries.set(schema, registry);
  }
  // A field's own schema may read its value differently on another call.
  const native = nativeSchema(schema);
  let byLayer = admitted.get(registry);
  const known = native ? byLayer?.get(layer) : undefined;
  if (known) return known;
  const admitting = admission(schema, extension, registry);
  const { admit } = admitting;
  const modes = layer.mode?.values ?? [""];
  const modeReferences: Record<string, References> = {};
  const models: Record<string, Record<string, object>> = {};
  /** One model's filters, per mode, each purpose's admitted. */
  const filtersOf = (
    name: string,
    lists: {
      readonly root?: readonly unknown[];
      readonly related?: readonly unknown[];
    },
    referencesOf: (mode: string) => References,
    of: string
  ) => {
    const byMode: Record<string, { root?: Input; related?: Input }> = {};
    for (const mode of modes) {
      const out: { root?: Input; related?: Input } = {};
      for (const purpose of ["root", "related"] as const) {
        const predicate = filterIn(lists[purpose] ?? [], layer, mode);
        if (predicate !== undefined)
          out[purpose] = admit(
            name,
            `${name}.${purpose}`,
            predicate,
            referencesOf(mode),
            `${of} ${mode}`
          );
      }
      byMode[mode] = Object.freeze(out);
    }
    return Object.freeze(byMode);
  };
  for (const name of new Set([
    ...Object.keys(layer.root),
    ...Object.keys(layer.related),
  ]))
    models[name] = filtersOf(
      name,
      { root: layer.root[name], related: layer.related[name] },
      (mode) => (modeReferences[mode] ??= new Set()),
      "mode"
    );
  const verbsReferences: References = new Set();
  const verbs: Record<string, VerbsDraft | (() => VerbsDraft)> = {};
  for (const [name, draft] of Object.entries(layer.verbs)) {
    if (typeof draft !== "function") {
      verbs[name] = admitDraft(admitting, name, draft, verbsReferences);
      continue;
    }
    // Read and admitted once, the first time the model is read; its own
    // references are checked then, against the chain it is bound to.
    let resolved: VerbsDraft | undefined;
    const resolve = (): VerbsDraft => {
      if (resolved !== undefined) return resolved;
      const references: References = new Set();
      const { root, related, ...given } = draft();
      const own = admitDraft(
        admitting,
        name,
        given,
        references,
        `lazy ${name}`
      );
      resolved =
        root === undefined && related === undefined
          ? own
          : Object.freeze({
              ...own,
              filters: filtersOf(
                name,
                { root, related },
                () => references,
                `lazy ${name}`
              ),
            });
      lazyReferences.set(resolved, [...references]);
      return resolved;
    };
    verbs[name] = resolve;
  }
  const confine: Record<string, Input> = {};
  for (const [name, predicate] of Object.entries(layer.confine))
    confine[name] = admit(name, `${name}.confine`, predicate, verbsReferences);
  const out: AdmittedLayer = Object.freeze({
    extension,
    ...(layer.mode && { mode: layer.mode }),
    models: Object.freeze(models),
    verbs: Object.freeze(verbs),
    confine: Object.freeze(confine),
    references: Object.freeze({
      modes: Object.fromEntries(
        Object.entries(modeReferences).map(([mode, names]) => [
          mode,
          [...names],
        ])
      ),
      verbs: [...verbsReferences],
    }),
  });
  if (native) {
    if (byLayer === undefined)
      admitted.set(registry, (byLayer = new WeakMap()));
    byLayer.set(layer, out);
  }
  return out;
}

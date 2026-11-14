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
import type {
  CallRows,
  LazyRelations,
  RowDomain,
} from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
import type { ModelState } from "@schema/model";
import { createSchemaRegistry } from "@validation/builder";
import { validateSchema } from "@validation/primitives/helpers";
import {
  type AdmittedFilters,
  admittingDomainPredicate,
  type FilterWord,
} from "@validation/primitives/parameter";
import type { SchemaRegistryLookup } from "@validation/types";
import type { ResolvedExtensionChain } from "./chain-state";
import type { Judge } from "./judge";
import type { Projection } from "./projection";
import type { PreparedDomain } from "./row-domain";
import { type Admitting, PredicateWord } from "./rule-words";

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
  /**
   * An eager entry's `read.where`, where it carries or hides fields: what a
   * row a write returns must hold for its facts and gated fields to show.
   * Its filters are the layer's own, so it is never read as one again.
   */
  shown?: unknown;
  /**
   * An entry given as a function, once admitted: the arguments its
   * predicates name, checked against the chain it is bound to.
   */
  references?: readonly (string | undefined)[];
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
  filters?: ModeFilters;
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
  /**
   * What admits and binds `verbs`: set by the words that write them
   * (`verbs.ts`), so a rule that only filters holds none of that code.
   */
  host?: VerbsHost;
  /** What lowers its layer, set where an entry read later may read its call. */
  layered?: Layered;
  /** What judges and projects, set where an entry read later may ask either. */
  lazily?: Pick<VerbsDraft, "judge" | "project">;
}

/** What makes a layer's node of a predicate: `RowDomain.layered`. */
export type Layered = NonNullable<RowDomain["layered"]>;

/** One model's filters per value of its layer's mode argument (`""` without one). */
export interface ModeFilters {
  readonly [mode: string]: {
    readonly root?: Input;
    readonly related?: Input;
  };
}

/** What admits one model's filters, per mode, for what admits an entry read later. */
export type FiltersOf = (
  name: string,
  lists: {
    readonly root?: readonly unknown[];
    readonly related?: readonly unknown[];
  },
  references: References,
  of: string
) => ModeFilters;

/** What a layer's verbs bind to, for every mode combination of a chain. */
export interface VerbsBound {
  readonly verbs?: RowDomain["verbs"];
  readonly judge?: RowDomain["judge"];
  readonly project?: RowDomain["project"];
  /** An entry given lazily is read: its calls carry their values. */
  readonly lazy: boolean;
  /** A model's filters at one layer, held by an entry given lazily. */
  readonly filters: (model: string, layer: number) => ModeFilters | undefined;
  /** What prepares the call facts, with what the verbs judge. */
  readonly prepare: CallRows["prepare"];
}

/**
 * What the words that write verbs bring (`verbs.ts`): what admits a layer's
 * verbs once per schema, and what binds a chain's for its calls.
 */
export interface VerbsHost {
  admit(
    admission: Admission,
    layer: RuleLayer,
    filtersOf: FiltersOf,
    references: References
  ): AdmittedLayer["verbs"];
  bind(chain: ResolvedExtensionChain): VerbsBound;
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
  readonly models: { readonly [model: string]: ModeFilters };
  readonly verbs: {
    readonly [model: string]: VerbsDraft | (() => VerbsDraft);
  };
  /** What admitted `verbs`, and binds them. */
  readonly host?: VerbsHost;
  /** What lowers the layer, where some predicate of it reads its call. */
  readonly layered?: Layered;
  /** What judges and projects, where an entry read later may ask either. */
  readonly lazily?: RuleLayer["lazily"];
  readonly confine: { readonly [model: string]: Input };
  /** What its eager predicates read of their call (`References`). */
  readonly references: readonly (string | undefined)[];
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
  /** What lowers the layer, once a predicate admitted reads its call. */
  layered?: Layered;
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

/** A layer without verbs. */
const NO_VERBS: AdmittedLayer["verbs"] = Object.freeze({});

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
    const where = registry.getModelSchemas(schema[name]!).core.where;
    const at: Admitting = { references, schema, registry };
    const value = (word: unknown): object | undefined =>
      word instanceof PredicateWord ? word.value?.(at) : undefined;
    const filter = (word: object): FilterWord | undefined =>
      word instanceof PredicateWord ? word.filter?.(at) : undefined;
    let filters = filtersOf.get(of);
    if (filters === undefined) filtersOf.set(of, (filters = new WeakMap()));
    const result = admittingDomainPredicate(
      { value, filter },
      () => validateSchema(where, predicate),
      filters
    );
    admitting.layered ??= at.layered;
    if (!result.issues) return result.value as Input;
    const [issue] = result.issues;
    return refuse(
      name,
      place,
      `at "${issue!.path?.map(String).join(".") || "root"}": ${issue!.message}`
    );
  };
  const admitting: Admission = { schema, admit, refuse };
  return admitting;
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
    const kept =
      item instanceof PredicateWord && item.under
        ? item.under(layer.mode, mode!)
        : item;
    if (kept !== undefined) applied.push(kept);
  }
  if (applied.length === 0) return undefined;
  if (applied.length === 1) return applied[0];
  return { AND: applied };
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
  const references: References = new Set();
  const models: Record<string, ModeFilters> = {};
  /** One model's filters, per mode, each purpose's admitted. */
  const filtersOf: FiltersOf = (name, lists, read, of) => {
    const byMode: Record<string, { root?: Input; related?: Input }> = {};
    for (const mode of modes) {
      const out: { root?: Input; related?: Input } = {};
      for (const purpose of ["root", "related"] as const) {
        const predicate = filterIn(lists[purpose] ?? [], layer, mode);
        if (predicate !== undefined)
          out[purpose] = admit(name, `${name}.${purpose}`, predicate, read, of);
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
      references,
      ""
    );
  const { host } = layer;
  const verbs = host
    ? host.admit(admitting, layer, filtersOf, references)
    : NO_VERBS;
  const confine: Record<string, Input> = {};
  for (const [name, predicate] of Object.entries(layer.confine)) {
    // The model's own columns: a confinement reads no relation, so lowering
    // it never builds another set it would confine in turn.
    const { scalars } = schema[name]!["~"].state;
    for (const field of Object.keys(predicate ?? {}))
      if (!Object.hasOwn(scalars, field))
        throw new ClientInitializationError(
          `Extension "${extension}" rule.${name}.confine: names "${field}", which is not a scalar field: a confinement states the model's own columns.`,
          { meta: { extension, model: name } }
        );
    confine[name] = admit(name, `${name}.confine`, predicate, references);
  }
  const layered = layer.layered ?? admitting.layered;
  const out: AdmittedLayer = Object.freeze({
    extension,
    ...(layer.mode && { mode: layer.mode }),
    models: Object.freeze(models),
    verbs,
    ...(host && { host }),
    ...(layered && { layered }),
    ...(layer.lazily && { lazily: layer.lazily }),
    confine: Object.freeze(confine),
    references: Object.freeze([...references]),
  });
  if (native) {
    if (byLayer === undefined)
      admitted.set(registry, (byLayer = new WeakMap()));
    byLayer.set(layer, out);
  }
  return out;
}

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
  ModelVerbs,
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
 * words' predicates raw): which rows a write may take (`update`, `delete`,
 * `writes`), what the rows it produces must hold (`place`, `check`,
 * `moves`, `acyclic`, with what judges them), and what a read carries or
 * hides (`as` and `facts`, `reads`, with what projects them). `read` is an entry
 * given as a function's `read.where`: its filters are read there, since what
 * filters is bound before any entry is resolved. Admitted, it is the
 * layer's `ModelVerbs`.
 */
export interface VerbsDraft {
  /** A check was written on the entry: the rows its writes produce are judged. */
  judge?: ModelVerbs["judge"];
  read?: unknown;
  /**
   * An eager entry's `read.where`, where it carries or hides fields: what a
   * row a write returns must hold for its facts and gated fields to show.
   * Its filters are the layer's own, so it is never read as one again.
   */
  shown?: unknown;
  update?: unknown;
  delete?: unknown;
  writes?: Map<string, unknown>;
  place?: unknown;
  check?: unknown;
  moves?: Map<string, unknown>;
  reads?: Map<string, unknown>;
  as?: string;
  facts?: Map<string, unknown>;
  acyclic?: readonly string[] | (() => readonly string[]);
  /** An entry given as a function's filters, as written. */
  root?: readonly unknown[];
  related?: readonly unknown[];
}

/**
 * One model's admitted verbs, with an entry given lazily's filters and the
 * arguments its predicates name, checked against the chain it is bound to.
 */
export interface AdmittedVerbs extends ModelVerbs {
  readonly filters?: Filters;
  readonly references?: readonly (string | undefined)[];
}

/**
 * One extension's rule parts as written, per model: its filters by purpose
 * (each a list of `where`s and words), its other keys and its
 * confinements. A function entry's keys are read when its model is first
 * read.
 */
export interface RuleLayer {
  readonly root: Record<string, unknown[]>;
  readonly related: Record<string, unknown[]>;
  readonly verbs: Record<string, VerbsDraft | (() => VerbsDraft)>;
  readonly confine: Record<string, unknown>;
  /**
   * What admits and binds `verbs`: set by the words that write them
   * (`verbs.ts`), so a rule that only filters holds none of that code.
   */
  host?: VerbsHost;
  /** What lowers its layer, set where an entry read later may read its call. */
  layered?: Layered;
  /** What judges and projects, brought by the words that ask either. */
  brings?: {
    judge?: ModelVerbs["judge"];
    project?: (domain: PreparedDomain) => Projection;
    /** What prepares a call's domains where a layer takes rows by verb. */
    prepare?: CallRows["prepare"];
    /** What refuses one model's projection keys across the chain's layers. */
    keys?: (model: string, layers: readonly (ModelVerbs | undefined)[]) => void;
  };
}

/** What makes a layer's node of a predicate: `RowDomain.layered`. */
export type Layered = NonNullable<RowDomain["layered"]>;

/** One model's filters by purpose, as admitted. */
export interface Filters {
  readonly root?: Input;
  readonly related?: Input;
}

/** What admits one model's filters, for what admits an entry read later. */
export type FiltersOf = (
  name: string,
  lists: {
    readonly root?: readonly unknown[];
    readonly related?: readonly unknown[];
  },
  references: References,
  of: string
) => Filters;

/** What a layer's verbs bind to, for a chain. */
export interface VerbsBound {
  readonly verbs?: RowDomain["verbs"];
  readonly judge?: RowDomain["judge"];
  readonly project?: RowDomain["project"];
  /** An entry given lazily is read: its calls carry their values. */
  readonly lazy?: boolean;
  /** A model's filters at one layer, held by an entry given lazily. */
  readonly filters?: (model: string, layer: number) => Filters | undefined;
  /** What prepares the call facts, with what the verbs judge. */
  readonly prepare: CallRows["prepare"];
}

/**
 * What the words that write verbs bring (`verbs.ts`): what admits a layer's
 * verbs once per schema, and what binds a chain's for its calls.
 */
export interface VerbsHost {
  /** It admits and binds entries given lazily, beside eager ones. */
  readonly lazy?: true;
  admit(
    admission: Admission,
    layer: RuleLayer,
    filtersOf: FiltersOf,
    references: References
  ): AdmittedLayer["verbs"];
  bind(chain: ResolvedExtensionChain): VerbsBound;
}

/**
 * A rule layer as admission left it: per model, its filters by purpose; its
 * other keys per model (a function entry's admitted when first read); its
 * confinements; and the arguments its predicates read.
 */
export interface AdmittedLayer {
  readonly extension: string;
  readonly models: { readonly [model: string]: Filters };
  readonly verbs: {
    readonly [model: string]: AdmittedVerbs | (() => AdmittedVerbs);
  };
  /** What admitted `verbs`, and binds them. */
  readonly host?: VerbsHost;
  /** What lowers the layer, where some predicate of it reads its call. */
  readonly layered?: Layered;
  /** What judges and projects, brought by the words that ask either. */
  readonly brings?: RuleLayer["brings"];
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

/** A filter list as one `where`. */
const filterOf = (items: readonly unknown[]): unknown =>
  items.length < 2 ? items[0] : { AND: items };

/**
 * One extension's rule layer with every predicate admitted once, its tests
 * of an argument folded per call. Admitted once per schema registry, where
 * the schema's scalars admit with the engine's own schemas.
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
  const references: References = new Set();
  const models: Record<string, Filters> = {};
  /** One model's filters, each purpose's admitted. */
  const filtersOf: FiltersOf = (name, lists, read, of) => {
    const out: { root?: Input; related?: Input } = {};
    for (const purpose of ["root", "related"] as const) {
      const predicate = filterOf(lists[purpose] ?? []);
      if (predicate !== undefined)
        out[purpose] = admit(name, `${name}.${purpose}`, predicate, read, of);
    }
    return Object.freeze(out);
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
    models: Object.freeze(models),
    verbs,
    ...(host && { host }),
    ...(layered && { layered }),
    ...(layer.brings && { brings: layer.brings }),
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

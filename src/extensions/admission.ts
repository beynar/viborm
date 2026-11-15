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
import { memo } from "@query-engine/raptor3/shared/schema";
import type { ModelState } from "@schema/model";
import { createSchemaRegistry } from "@validation/builder";
import { validateSchema } from "@validation/primitives/helpers";
import {
  type AdmittedFilters,
  admittingDomainPredicate,
  type FilterWord,
} from "@validation/primitives/parameter";
import type { SchemaRegistryLookup } from "@validation/types";
import type { AdmittedArgs } from "./arguments";
import type { ResolvedExtensionChain } from "./chain-state";
import type { Projection } from "./projection";
import type { PreparedDomain } from "./row-domain";
import { type Admitting, PredicateWord } from "./rule-words";

/**
 * What predicates read of their call, as admission makes their parameters:
 * each argument they name, and `undefined` for the call's instant.
 */
export type References = Set<string | undefined>;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * One model's entry of one rule layer beyond its filters, as its words
 * wrote it (`ModelVerbs` with its predicates raw): admitted, it is the
 * layer's `ModelVerbs`. An entry given lazily holds its filters here too,
 * since what filters is bound before any entry is resolved.
 */
export type VerbsDraft = Mutable<Omit<ModelVerbs<unknown>, "cycles">> & {
  writes?: Map<string, unknown>;
  moves?: Map<string, unknown>;
  reads?: Map<string, unknown>;
  facts?: Map<string, unknown>;
  /** As written: a list or a function returning one, checked where it is admitted. */
  acyclic?: unknown;
  root?: readonly unknown[];
  related?: readonly unknown[];
};

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
  /** Per model, what its whole-table sets hold: written by `within`. */
  confine?: Record<string, unknown>;
  /**
   * What admits and binds `verbs`: set by the words that write them
   * (`verbs.ts`), so a rule that only filters holds none of that code.
   */
  host?: VerbsHost;
  /** What reads the call, set where an entry read later may read its call. */
  reads?: CallReads;
  /** What judges and projects, brought by the words that ask either. */
  brings?: {
    judge?: ModelVerbs["judge"];
    project?: (domain: PreparedDomain) => Projection;
    /** What prepares a call's domains where a layer takes rows by verb. */
    prepare?: CallRows["prepare"];
    /** What refuses one model's projection keys across the chain's layers. */
    keys?: (model: string, layers: readonly (ModelVerbs | undefined)[]) => void;
    /** What admits and reads an entry given lazily, brought by `lazy`. */
    lazy?: LazyEntries;
    /** What admits and binds the confinements, brought by `within`. */
    confines?: Confines;
  };
}

/** What `within` brings: its predicates admitted, and the chain's bound. */
export interface Confines {
  admit(
    admission: Admission,
    written: Readonly<Record<string, unknown>>,
    references: References
  ): Record<string, Input>;
  bind(layers: readonly AdmittedLayer[]): Partial<RowDomain>;
}

/** What `lazy` brings: its entries admitted when first read, then checked per chain. */
export interface LazyEntries {
  /** The entry, admitted the first time its model is read. */
  admit(
    admission: Admission,
    name: string,
    entry: () => VerbsDraft,
    filtersOf: FiltersOf
  ): () => AdmittedVerbs;
  /** The entry as `chain` reads it: the arguments it names checked against it. */
  read(
    chain: ResolvedExtensionChain,
    entry: () => AdmittedVerbs,
    extension: string
  ): AdmittedVerbs;
}

/**
 * What the words that read a call bring (`call-values.ts`): each layer's
 * node read per call, and every call's values carried beside the domain.
 */
export interface CallReads {
  bind(
    chain: ResolvedExtensionChain,
    lazy: boolean,
    domain: RowDomain
  ): {
    readonly domain: RowDomain;
    call(facts: CallRows, values: AdmittedArgs | undefined): CallRows;
  };
}

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
  /** What reads the call, where some predicate of it reads one. */
  readonly reads?: CallReads;
  /** What judges and projects, brought by the words that ask either. */
  readonly brings?: RuleLayer["brings"];
  readonly confine?: { readonly [model: string]: Input };
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
  /** What reads the call, once a predicate admitted reads one. */
  reads?: CallReads;
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
    const filters = memo(filtersOf, of, () => new WeakMap());
    const result = admittingDomainPredicate(
      { value, filter },
      () => validateSchema(where, predicate),
      filters
    );
    admitting.reads ??= at.reads;
    // The model's where schema admitted the predicate: an Input.
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
export function nativeSchema(schema: Schema): boolean {
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
  const registry = given ?? createSchemaRegistry(schema);
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
    return out;
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
  const verbs = host?.admit(admitting, layer, filtersOf, references) ?? {};
  const confine = layer.confine
    ? layer.brings!.confines!.admit(admitting, layer.confine, references)
    : undefined;
  const reads = layer.reads ?? admitting.reads;
  const out: AdmittedLayer = {
    extension,
    models,
    verbs,
    ...(host && { host }),
    ...(reads && { reads }),
    ...(layer.brings && { brings: layer.brings }),
    ...(confine && { confine }),
    references: [...references],
  };
  return out;
}

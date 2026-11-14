/**
 * A chain's rule keys beyond its filters, bound once per application: per
 * model and layer, which rows a write may take (`update`, `delete`,
 * `writes`), what the rows it produces must hold and what a read carries
 * or hides, as the engine reads them (`ModelVerbs`); and the layers'
 * confinements. What judges and what projects come with the words that ask
 * for them; for an entry given as a function, whose words are known only
 * once its model is read, a forwarder asks the model first.
 */
import { ClientInitializationError } from "@errors";
import {
  NO_RELATIONS,
  type PreparedSelector,
} from "@query-engine/raptor3/shared/query";
import type {
  ModelDomain,
  ModelVerbs,
  RowDomain,
} from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import type { AnyModel } from "@schema/model";
import { lazyReferences, type VerbsDraft } from "./admission";
import type { ResolvedExtensionChain } from "./chain-state";
import type { Judge } from "./judge";
import type { Projection } from "./projection";
import { ALL, type PreparedDomain } from "./row-domain";

/** What a chain's rule keys bind to, for every mode combination. */
export interface VerbsBound {
  readonly verbs?: RowDomain["verbs"];
  readonly confine?: ModelDomain;
  readonly judge?: RowDomain["judge"];
  readonly project?: RowDomain["project"];
  readonly bound?: RowDomain["bound"];
  /** Whether one of their predicates may read a call value. */
  readonly reads: boolean;
}

/** No restriction: what a key an entry leaves out takes. */


const fields = (
  map: Readonly<Record<string, unknown>> | undefined
): ReadonlyMap<string, Input> =>
  // Admission left every value an admitted predicate.
  new Map(Object.entries(map ?? {}) as [string, Input][]);

/** One layer's admitted draft for `model` as the engine reads it. */
function layerVerbs(draft: VerbsDraft): ModelVerbs {
  // Admission left every predicate of the draft admitted.
  const of = (where: unknown): Input => (where as Input | undefined) ?? ALL;
  return Object.freeze({
    read: of(draft.read),
    update: of(draft.update),
    delete: of(draft.delete),
    writes: fields(draft.writes),
    ...(draft.place !== undefined && { place: of(draft.place) }),
    ...(draft.check !== undefined && { check: of(draft.check) }),
    moves: fields(draft.moves),
    acyclic: draft.cycles ?? NO_RELATIONS,
    ...(draft.evidence && {
      evidence: Object.freeze({
        as: draft.evidence.as,
        names: Object.freeze(
          draft.evidence.names.map(([fact, where]) =>
            Object.freeze([fact, of(where)] as const)
          )
        ),
      }),
    }),
    reads: fields(draft.reads),
    ...(draft.judge && { judged: true }),
  });
}

/**
 * What judges for a chain with an entry given as a function: each question
 * asked of a model first reads the model's entries, then goes to what their
 * words brought, made once for the domain.
 */
class LazyJudge implements Judge {
  readonly #of: (model: AnyModel) => Judge | undefined;
  constructor(of: (model: AnyModel) => Judge | undefined) {
    this.#of = of;
  }
  binds(...args: Parameters<Judge["binds"]>) {
    return this.#of(args[1])?.binds(...args) ?? 0;
  }
  inserted(...args: Parameters<Judge["inserted"]>) {
    return this.#of(args[2])?.inserted(...args);
  }
  updated(...args: Parameters<Judge["updated"]>) {
    return this.#of(args[2].model)?.updated(...args);
  }
  located(model: AnyModel) {
    return this.#of(model)?.located(model);
  }
  produced(...args: Parameters<Judge["produced"]>) {
    return this.#of(args[0])?.produced(...args);
  }
  cycles(...args: Parameters<Judge["cycles"]>) {
    return this.#of(args[0])?.cycles(...args) ?? NO_RELATIONS;
  }
  refusal(...args: Parameters<Judge["refusal"]>) {
    return (
      this.#of(args[1])?.refusal(...args) ?? {
        kind: "forbidden",
        message: `${args[0]} produced a row that is not permitted.`,
        raceable: false,
      }
    );
  }
}

/** What projects for a chain with an entry given as a function, as {@link LazyJudge} judges. */
class LazyProjection implements Projection {
  readonly #of: (model: AnyModel) => Projection | undefined;
  /** What the first model read brought: what a question naming no model goes to. */
  #any: Projection | undefined;
  constructor(of: (model: AnyModel) => Projection | undefined) {
    this.#of = (model) => {
      const found = of(model);
      this.#any ??= found;
      return found;
    };
  }
  lower(...args: Parameters<Projection["lower"]>) {
    return this.#of(args[1])!.lower(...args);
  }
  window(...args: Parameters<Projection["window"]>) {
    return this.#of(args[1])?.window(...args);
  }
  gatedDocument(...args: Parameters<Projection["gatedDocument"]>) {
    // Asked only of a projection whose model said it gates a field.
    return this.#any!.gatedDocument(...args);
  }
  guarded(...args: Parameters<Projection["guarded"]>) {
    return this.#of(args[1])?.guarded(...args) ?? args[3];
  }
  admit(...args: Parameters<Projection["admit"]>) {
    const [schema, model, operation, raw] = args;
    return (
      this.#of(model)?.admit(...args) ?? schema.admit(model, operation, raw)
    );
  }
  refuseGatedLink(...args: Parameters<Projection["refuseGatedLink"]>) {
    this.#of(args[1])?.refuseGatedLink(...args);
  }
  refuseGatedRows(model: AnyModel) {
    this.#of(model)?.refuseGatedRows(model);
  }
  layered(...args: Parameters<Projection["layered"]>) {
    return this.#of(args[0])!.layered(...args);
  }
  projected(model: AnyModel) {
    return this.#of(model)?.projected(model);
  }
  preparing(...args: Parameters<Projection["preparing"]>) {
    return this.#of(args[0])?.preparing(...args);
  }
}

/**
 * What an `excluded` layer states its own whole-table sets of a model hold
 * (`confine`), for one prepared domain: inside its own predicates a layer
 * reads nothing of itself, but a set the statement computes over a whole
 * table (a shared body, a reaching set) still holds only what it bounds.
 * `undefined` where none states one.
 */
function bound(domain: PreparedDomain) {
  const bounds = new Map<string, PreparedSelector | null>();
  return (
    model: AnyModel,
    excluded: readonly number[]
  ): PreparedSelector | undefined => {
    const name = model["~"].names.ts!;
    const inputs = domain.rows.confine?.get(name);
    if (inputs === undefined) return undefined;
    // Every excluded layer's: each only narrows, and one left out would let
    // another's widen what it bounds.
    return (
      memo(bounds, `${name} ${excluded}`, () =>
        domain.conjunction(
          model,
          excluded.map((layer) => {
            const input = inputs[layer];
            return [layer, input === undefined ? [] : [input]] as const;
          })
        )
      ) ?? undefined
    );
  };
}

/**
 * Every layer's keys bound to `chain`. A model's verbs, each at its layer,
 * are built the first time the model is read: an entry given as a function
 * is read then, and the arguments it names checked against what the chain
 * declared up to its extension, as `$extends` checks an eager entry's.
 */
export function bindVerbs(chain: ResolvedExtensionChain): VerbsBound {
  const layers = chain.rows ?? [];
  const declaredUpTo = (extension: string): ReadonlySet<string> => {
    const at = chain.extensions.findIndex((own) => own.name === extension);
    const names = new Set(
      chain.extensions.slice(0, at + 1).map((own) => own.name)
    );
    return new Set(
      (chain.controls?.all ?? [])
        .filter((control) => names.has(control.extension))
        .map((control) => control.name)
    );
  };
  const drafts = (model: string): (VerbsDraft | undefined)[] =>
    layers.map(({ verbs, extension }) => {
      const entry = verbs[model];
      if (typeof entry !== "function") return entry;
      const draft = entry();
      const declared = declaredUpTo(extension);
      for (const name of lazyReferences.get(draft)!)
        if (name !== undefined && !declared.has(name))
          throw new ClientInitializationError(
            `Extension "${extension}" references undeclared control "${name}".`,
            { meta: { extension } }
          );
      return draft;
    });
  const declares = (model: string) =>
    layers.some((layer) => Object.hasOwn(layer.verbs, model));
  const built = new Map<string, readonly (ModelVerbs | undefined)[]>();
  const carried = new Map<string, readonly (VerbsDraft | undefined)[]>();
  const draftsOf = (model: string) => memo(carried, model, () => drafts(model));
  const verbs = layers.some((layer) => Object.keys(layer.verbs).length > 0)
    ? {
        has: declares,
        get: (model: string) =>
          declares(model)
            ? memo(built, model, () => {
                const keys = new Set<string>();
                const out: (ModelVerbs | undefined)[] = [];
                for (const [layer, draft] of draftsOf(model).entries()) {
                  if (draft === undefined) continue;
                  // One projection key, one layer: a second would hide the first.
                  const key = draft.evidence?.as;
                  if (key === "$through")
                    throw new ClientInitializationError(
                      `rule.${model}.read.select "$through" is reserved for a relation's link row.`,
                      { meta: { model } }
                    );
                  if (key !== undefined && keys.has(key))
                    throw new ClientInitializationError(
                      `rule.${model}.read.select "${key}" is declared by two extensions of the chain.`,
                      { meta: { model } }
                    );
                  if (key !== undefined) keys.add(key);
                  out[layer] = layerVerbs(draft);
                }
                return out;
              })
            : undefined,
      }
    : undefined;
  const lazy = layers.some((layer) =>
    Object.values(layer.verbs).some((entry) => typeof entry === "function")
  );
  // A model no layer gives as a function is built now: its refusals are the
  // application's, as they would be at admission.
  for (const layer of layers)
    for (const model of Object.keys(layer.verbs))
      if (layers.every((other) => typeof other.verbs[model] !== "function"))
        verbs!.get(model);
  /** What the words of the eager entries brought, of one kind. */
  const eager = <K extends "judge" | "project">(kind: K) => {
    for (const layer of layers)
      for (const entry of Object.values(layer.verbs))
        if (typeof entry !== "function" && entry[kind] !== undefined)
          return entry[kind];
    return undefined;
  };
  /** What a model's entries brought of one kind, made once per domain. */
  const forModel = <T>(kind: "judge" | "project", domain: PreparedDomain) => {
    const made = new Map<unknown, T>();
    return (model: AnyModel): T | undefined => {
      const name = model["~"].names.ts!;
      if (!declares(name)) return undefined;
      verbs!.get(name);
      const make = draftsOf(name).find((draft) => draft?.[kind])?.[kind] as
        | ((domain: PreparedDomain) => T)
        | undefined;
      return make && memo(made, make, () => make(domain));
    };
  };
  const judge =
    eager("judge") ??
    (lazy
      ? (domain: PreparedDomain) =>
          new LazyJudge(forModel<Judge>("judge", domain))
      : undefined);
  const project =
    eager("project") ??
    (lazy
      ? (domain: PreparedDomain) =>
          new LazyProjection(forModel<Projection>("project", domain))
      : undefined);
  const confine = new Map<string, Input[]>();
  for (const [layer, member] of layers.entries())
    for (const [model, where] of Object.entries(member.confine))
      memo(confine, model, () => [])[layer] = where;
  return {
    ...(verbs && { verbs }),
    ...(judge && { judge }),
    ...(project && { project }),
    ...(confine.size > 0 && { confine, bound }),
    // An entry given as a function's predicates are not known yet: its
    // calls carry their values.
    reads: lazy || layers.some((layer) => layer.references.verbs.length > 0),
  };
}

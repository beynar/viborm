/**
 * What a rule holds beyond its filters, brought by the words that write it
 * (`only`, `check`, `gate`, `facts`, `lazy`), so a rule that only filters
 * holds none of this code: per model and layer, which rows a write may take
 * (`update`, `delete`, `writes`), what the rows it produces must hold and
 * what a read carries or hides, admitted once per schema and bound once per
 * application as the engine reads them (`ModelVerbs`). What judges and what
 * projects come with the words that ask for them; for an entry given lazily,
 * whose words are known only once its model is read, a forwarder asks the
 * model first.
 */
import { ClientInitializationError } from "@errors";
import { NO_RELATIONS, type Queries } from "@query-engine/raptor3/shared/query";
import type {
  LazyRelations,
  ModelVerbs,
  RowJudgement,
} from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import type { AnyModel } from "@schema/model";
import type {
  Admission,
  AdmittedLayer,
  FiltersOf,
  References,
  RuleLayer,
  VerbsBound,
  VerbsDraft,
  VerbsHost,
} from "./admission";
import type { ResolvedExtensionChain } from "./chain-state";
import type { Judge } from "./judge";
import type { Projection } from "./projection";
import { FilterDomain, type PreparedDomain, preparer } from "./row-domain";
import type { Site } from "./rule-words";

/** No restriction: what a verb an entry leaves out takes, read as no predicate. */
export const ALL: Input = Object.freeze({});

/**
 * The predicates one layer's verbs give a write `judgement`, each once:
 * `delete`'s, or per field an update writes that field's own, else
 * `update`'s, or `update`'s when it writes none (R3).
 */
export function verbInputs(
  verbs: ModelVerbs,
  judgement: RowJudgement
): Input[] {
  if (judgement.verb === "delete") return [verbs.delete];
  if (judgement.writes.length === 0) return [verbs.update];
  return [
    ...new Set([
      ...judgement.writes.map(
        (field) => verbs.writes.get(field) ?? verbs.update
      ),
      ...(judgement.marks ? [verbs.delete] : []),
    ]),
  ];
}
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
  readonly #from: (model: AnyModel) => Projection | undefined;
  /** What the first model read brought: what a question naming no model goes to. */
  #any: Projection | undefined;
  constructor(of: (model: AnyModel) => Projection | undefined) {
    this.#from = of;
  }
  #of(model: AnyModel): Projection | undefined {
    const found = this.#from(model);
    this.#any ??= found;
    return found;
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
 * A domain whose layers hold verbs: under a `judgement`, a model's predicate
 * takes each layer's predicates of its verb beside its filters (R2, R3), and
 * an entry given lazily brings its `read.where` here.
 */
class JudgedDomain extends FilterDomain {
  protected override key(
    name: string,
    excluded: readonly number[],
    judgement?: RowJudgement
  ): string {
    const judged = this.rows.verbs?.get(name) && judgement;
    return judged
      ? `${name} ${excluded} ${judged.verb}${judged.marks ? "+" : ""} ${[...judged.writes].sort()}`
      : super.key(name, excluded);
  }
  protected override layers(
    name: string,
    inputs: readonly Input[] | undefined,
    excluded: readonly number[],
    judgement?: RowJudgement
  ): (readonly [number, readonly Input[]])[] {
    const verbs = this.rows.verbs?.get(name);
    if (verbs === undefined) return super.layers(name, inputs, excluded);
    const layers: (readonly [number, Input[]])[] = [];
    const count = Math.max(inputs?.length ?? 0, verbs.length);
    for (let layer = 0; layer < count; layer++) {
      if (excluded.includes(layer)) continue;
      const own = verbs[layer];
      const where = inputs?.[layer];
      layers.push([
        layer,
        [
          ...(own && own.read !== ALL ? [own.read] : []),
          ...(where === undefined ? [] : [where]),
          ...(own && judgement ? verbInputs(own, judgement) : []),
        ],
      ]);
    }
    return layers;
  }
  /** A model some layer holds verbs on is judged. */
  override restrictsLinkWrite(queries: Queries, model: AnyModel): boolean {
    return (
      super.restrictsLinkWrite(queries, model) ||
      this.rows.verbs
        ?.get(model["~"].names.ts!)
        ?.some((verbs) => verbs !== undefined) === true
    );
  }
}

/** What prepares the call facts of a chain whose layers hold verbs. */
const prepareJudged = /* @__PURE__ */ preparer(JudgedDomain);

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
function admitDraft(
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

/** What an entry given lazily's predicates read, recorded when it was first read. */
const lazyReferences = new WeakMap<
  VerbsDraft,
  readonly (string | undefined)[]
>();

/**
 * One layer's verbs with every predicate admitted: an eager entry's now, an
 * entry given lazily's once, the first time its model is read; its own
 * references are checked then, against the chain it is bound to.
 */
function admitVerbs(
  admitting: Admission,
  layer: RuleLayer,
  filtersOf: FiltersOf,
  references: References
): AdmittedLayer["verbs"] {
  const verbs: Record<string, VerbsDraft | (() => VerbsDraft)> = {};
  for (const [name, draft] of Object.entries(layer.verbs)) {
    if (typeof draft !== "function") {
      verbs[name] = admitDraft(admitting, name, draft, references);
      continue;
    }
    let resolved: VerbsDraft | undefined;
    const resolve = (): VerbsDraft => {
      if (resolved !== undefined) return resolved;
      const own: References = new Set();
      const { root, related, ...given } = draft();
      const admitted = admitDraft(admitting, name, given, own, `lazy ${name}`);
      resolved =
        root === undefined && related === undefined
          ? admitted
          : Object.freeze({
              ...admitted,
              filters: filtersOf(
                name,
                { root, related },
                () => own,
                `lazy ${name}`
              ),
            });
      lazyReferences.set(resolved, [...own]);
      return resolved;
    };
    verbs[name] = resolve;
  }
  return Object.freeze(verbs);
}

/**
 * Every layer's verbs bound to `chain`. A model's verbs, each at its layer,
 * are built the first time the model is read: an entry given lazily is read
 * then, and the arguments it names checked against what the chain
 * declared up to its extension, as `$extends` checks an eager entry's.
 */
function bindVerbs(chain: ResolvedExtensionChain): VerbsBound {
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
  return {
    ...(verbs && { verbs }),
    ...(judge && { judge }),
    ...(project && { project }),
    lazy,
    filters: (model, layer) =>
      typeof layers[layer]!.verbs[model] === "function"
        ? draftsOf(model)[layer]?.filters
        : undefined,
    prepare: prepareJudged,
  };
}

/** What the words that write verbs bring: their admission and their binding. */
export const VERBS: VerbsHost = { admit: admitVerbs, bind: bindVerbs };

/**
 * The verbs of the model a word is written on, made at the first word that
 * writes one, with what admits and binds them.
 */
export function verbsOf(site: Site): VerbsDraft {
  site.draft.rule!.host = VERBS;
  return site.verbs();
}

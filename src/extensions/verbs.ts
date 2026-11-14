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
import type { Queries } from "@query-engine/raptor3/shared/query";
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
  AdmittedVerbs,
  FiltersOf,
  References,
  RuleLayer,
  VerbsBound,
  VerbsDraft,
  VerbsHost,
} from "./admission";
import type { ResolvedExtensionChain } from "./chain-state";
import { FilterDomain, preparer } from "./row-domain";
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
  const { update = ALL, delete: removal = ALL } = verbs;
  if (judgement.verb === "delete") return [removal];
  if (judgement.writes.length === 0) return [update];
  return [
    ...new Set([
      ...judgement.writes.map((field) => verbs.writes?.get(field) ?? update),
      ...(judgement.marks ? [removal] : []),
    ]),
  ];
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
          ...(own?.read === undefined ? [] : [own.read]),
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

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

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
    return listed;
  };
  if (typeof declared !== "function") return checked(declared);
  let resolved: readonly string[] | undefined;
  return {
    candidates: keyed,
    resolve: () => (resolved ??= checked(declared())),
  };
}

/** One model's draft with every predicate admitted: the layer's verbs. */
function admitDraft(
  admission: Admission,
  name: string,
  draft: VerbsDraft,
  references: References,
  of?: string
): Mutable<AdmittedVerbs> {
  const admit = (place: string, where: unknown) =>
    admission.admit(name, `${name}.${place}`, where, references, of);
  const out: Mutable<AdmittedVerbs> = {
    judge: draft.judge,
    project: draft.project,
  };
  if (draft.acyclic !== undefined)
    out.cycles = cyclesOf(admission, name, draft.acyclic);
  for (const key of SINGLE)
    if (draft[key] !== undefined) out[key] = admit(key, draft[key]);
  for (const key of PER_FIELD) {
    const given = draft[key];
    if (given !== undefined)
      out[key] = new Map(
        [...given].map(([field, where]) => [
          field,
          admit(`${key}.${field}`, where),
        ])
      );
  }
  if (draft.evidence !== undefined)
    out.evidence = {
      as: draft.evidence.as,
      names: draft.evidence.names.map(([fact, where]) => [
        fact,
        admit(`read.select.${fact}`, where),
      ]),
    };
  return out;
}

/** What an entry given lazily's predicates read, recorded when it was first read. */
const lazyReferences = new WeakMap<
  AdmittedVerbs,
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
  const verbs: Record<string, AdmittedVerbs | (() => AdmittedVerbs)> = {};
  for (const [name, draft] of Object.entries(layer.verbs)) {
    if (typeof draft !== "function") {
      verbs[name] = admitDraft(admitting, name, draft, references);
      continue;
    }
    let resolved: AdmittedVerbs | undefined;
    verbs[name] = () => {
      if (resolved !== undefined) return resolved;
      const own: References = new Set();
      const { root, related, ...given } = draft();
      const admitted = admitDraft(admitting, name, given, own, `lazy ${name}`);
      if (root !== undefined || related !== undefined)
        admitted.filters = filtersOf(
          name,
          { root, related },
          own,
          `lazy ${name}`
        );
      lazyReferences.set(admitted, [...own]);
      resolved = admitted;
      return admitted;
    };
  }
  return verbs;
}

/**
 * Every layer's verbs bound to `chain`. A model's verbs, each at its layer,
 * are taken the first time the model is read: an entry given lazily is read
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
  const drafts = (model: string): (AdmittedVerbs | undefined)[] =>
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
  const built = new Map<string, readonly (AdmittedVerbs | undefined)[]>();
  const get = (model: string) =>
    declares(model)
      ? memo(built, model, () => {
          const out = drafts(model);
          const keys = new Set<string>();
          for (const draft of out) {
            // One projection key, one layer: a second would hide the first.
            const key = draft?.evidence?.as;
            if (key === undefined) continue;
            if (key === "$through" || keys.has(key))
              throw new ClientInitializationError(
                key === "$through"
                  ? `rule.${model}.read.select "$through" is reserved for a relation's link row.`
                  : `rule.${model}.read.select "${key}" is declared by two extensions of the chain.`,
                { meta: { model } }
              );
            keys.add(key);
          }
          return out;
        })
      : undefined;
  const lazy = layers.some((layer) =>
    Object.values(layer.verbs).some((entry) => typeof entry === "function")
  );
  // A model no layer gives as a function is taken now: its refusals are the
  // application's, as they would be at admission.
  for (const layer of layers)
    for (const model of Object.keys(layer.verbs))
      if (layers.every((other) => typeof other.verbs[model] !== "function"))
        get(model);
  /**
   * What the words brought, of one kind: an eager entry's, else what an
   * entry given lazily brings, since its words are known only once read.
   */
  const brought = <K extends "judge" | "project">(kind: K) => {
    for (const layer of layers) {
      for (const entry of Object.values(layer.verbs))
        if (typeof entry !== "function" && entry[kind] !== undefined)
          return entry[kind];
    }
    return layers.find((layer) => layer.lazily)?.lazily?.[kind];
  };
  const judge = brought("judge");
  const project = brought("project");
  return {
    verbs: { has: declares, get },
    ...(judge && { judge }),
    ...(project && { project }),
    lazy,
    filters: (model, layer) =>
      typeof layers[layer]!.verbs[model] === "function"
        ? get(model)?.[layer]?.filters
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

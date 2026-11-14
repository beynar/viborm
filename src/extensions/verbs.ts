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
  AdmittedVerbs,
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
 * A domain some of whose layers hold verbs: a model some layer holds verbs
 * on is judged, so a link to it is not written unjudged.
 */
class VerbsDomain extends FilterDomain {
  override restrictsLinkWrite(queries: Queries, model: AnyModel): boolean {
    return (
      super.restrictsLinkWrite(queries, model) ||
      this.rows.verbs
        ?.get(model["~"].names.ts!)
        ?.some((verbs) => verbs !== undefined) === true
    );
  }
}

/**
 * A domain whose layers say which rows a write may take (`only`) or hold an
 * entry given lazily: under a `judgement`, a model's predicate takes each
 * layer's predicates of its verb beside its filters (R2, R3), and an entry
 * given lazily brings its `read.where` here.
 */
class JudgedDomain extends VerbsDomain {
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
}

/** What prepares the call facts of a chain whose layers hold verbs. */
const prepareVerbs = /* @__PURE__ */ preparer(VerbsDomain);
/** What prepares them where a layer takes rows by verb: brought by `only` and `lazy`. */
export const prepareJudged = /* @__PURE__ */ preparer(JudgedDomain);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The keys of a draft that hold one predicate, each admitted as one. */
const SINGLE = ["read", "shown", "update", "delete", "place", "check"] as const;
/** The keys of a draft that hold one predicate per field, and where each is written. */
const PER_FIELD = [
  ["writes", "writes"],
  ["moves", "moves"],
  ["reads", "reads"],
  ["facts", "read.select"],
] as const;

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
  const out: Mutable<AdmittedVerbs> = { judge: draft.judge, as: draft.as };
  if (draft.acyclic !== undefined)
    out.cycles = cyclesOf(admission, name, draft.acyclic);
  for (const key of SINGLE)
    if (draft[key] !== undefined) out[key] = admit(key, draft[key]);
  for (const [key, place] of PER_FIELD) {
    const given = draft[key];
    if (given !== undefined)
      out[key] = new Map(
        [...given].map(([field, where]) => [
          field,
          admit(`${place}.${field}`, where),
        ])
      );
  }
  return out;
}

/**
 * Every layer's verbs bound to `chain`, each model's taken the first time
 * it is read; `read` reads an entry given lazily, where some layer holds
 * one (`LAZY_VERBS`). A model no layer gives as a function is taken now:
 * its refusals are the application's, as they would be at admission.
 */
function bindVerbs(
  chain: ResolvedExtensionChain,
  read?: (entry: () => AdmittedVerbs, extension: string) => AdmittedVerbs
) {
  const layers = chain.rows ?? [];
  const brought = <K extends keyof NonNullable<RuleLayer["brings"]>>(kind: K) =>
    layers.find((layer) => layer.brings?.[kind])?.brings?.[kind];
  const keys = brought("keys");
  const declares = (model: string) =>
    layers.some((layer) => Object.hasOwn(layer.verbs, model));
  const built = new Map<string, readonly (AdmittedVerbs | undefined)[]>();
  const get = (
    model: string
  ): readonly (AdmittedVerbs | undefined)[] | undefined =>
    declares(model)
      ? memo(built, model, () => {
          const out = layers.map(({ verbs, extension }) => {
            const entry = verbs[model];
            return typeof entry === "function"
              ? read!(entry, extension)
              : entry;
          });
          keys?.(model, out);
          return out;
        })
      : undefined;
  for (const layer of layers)
    for (const model of Object.keys(layer.verbs))
      if (layers.every((other) => typeof other.verbs[model] !== "function"))
        get(model);
  const judge = brought("judge");
  const project = brought("project");
  return {
    verbs: { has: declares, get },
    ...(judge && { judge }),
    ...(project && { project }),
    prepare: brought("prepare") ?? prepareVerbs,
  } satisfies VerbsBound;
}

/** What the words that write verbs bring: their admission and their binding. */
export const VERBS: VerbsHost = {
  admit: (admitting, layer, _filtersOf, references) =>
    Object.fromEntries(
      Object.entries(layer.verbs).map(([name, draft]) => [
        name,
        // Only `lazy` writes an entry as a function, and it brings LAZY_VERBS.
        admitDraft(admitting, name, draft as VerbsDraft, references),
      ])
    ),
  // The chain's first host binds every layer's: where a later layer holds
  // an entry given lazily, its host does.
  bind: (chain) =>
    chain.rows?.find((layer) => layer.host?.lazy)?.host?.bind(chain) ??
    bindVerbs(chain),
};

/**
 * What `lazy` brings: an entry given as a function admitted once, the first
 * time its model is read, with its own references, checked then against
 * what the chain declared up to its extension, as `$extends` checks an
 * eager entry's.
 */
export const LAZY_VERBS: VerbsHost = {
  lazy: true,
  admit(admitting, layer, filtersOf, references) {
    const verbs: Record<string, AdmittedVerbs | (() => AdmittedVerbs)> = {};
    for (const [name, draft] of Object.entries(layer.verbs)) {
      if (typeof draft !== "function") {
        verbs[name] = admitDraft(admitting, name, draft, references);
        continue;
      }
      let resolved: AdmittedVerbs | undefined;
      const resolve = (): AdmittedVerbs => {
        if (resolved !== undefined) return resolved;
        const own: References = new Set();
        const { root, related, ...given } = draft();
        const at = `lazy ${name}`;
        const admitted = admitDraft(admitting, name, given, own, at);
        if (root !== undefined || related !== undefined)
          admitted.filters = filtersOf(name, { root, related }, own, at);
        // Read after the filters: what they name is the entry's too.
        admitted.references = [...own];
        resolved = admitted;
        return admitted;
      };
      verbs[name] = resolve;
    }
    return verbs;
  },
  bind(chain) {
    const bound = bindVerbs(chain, (entry, extension) => {
      const draft = entry();
      const at = chain.extensions.findIndex((own) => own.name === extension);
      const names = new Set(
        chain.extensions.slice(0, at + 1).map((own) => own.name)
      );
      for (const name of draft.references!)
        if (
          name !== undefined &&
          !chain.controls?.all.some(
            (control) => control.name === name && names.has(control.extension)
          )
        )
          throw new ClientInitializationError(
            `Extension "${extension}" references undeclared argument "${name}".`,
            { meta: { extension } }
          );
      return draft;
    });
    return {
      ...bound,
      lazy: true,
      filters: (model, layer) => bound.verbs?.get(model)?.[layer]?.filters,
    };
  },
};

/**
 * The verbs of the model a word is written on, made at the first word that
 * writes one, with what admits and binds them.
 */
export function verbsOf(site: Site): VerbsDraft {
  site.draft.rule!.host ??= VERBS;
  return site.verbs();
}

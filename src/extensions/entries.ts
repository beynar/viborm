/**
 * What a rule holds beyond its filters, brought by the words that write it
 * (`only`, `check`, `gate`, `facts`, `lazy`), so a rule that only filters
 * holds none of this code: per model and layer, which rows a write may take
 * (`update`, `delete`, `writes`), what the rows it produces must hold and
 * what a read carries or hides, admitted once per schema and bound once per
 * application as the engine reads them (`RuleEntry`). What judges and what
 * projects come with the words that ask for them; for an entry given lazily,
 * whose words are known only once its model is read, a forwarder asks the
 * model first.
 */
import type { Queries } from "@query-engine/raptor3/shared/query";
import type {
  LazyRelations,
  RuleEntry,
  WriteJudgement,
} from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import type { AnyModel } from "@schema/model";
import type {
  Admission,
  AdmittedEntry,
  BoundEntries,
  EntryDraft,
  EntryHost,
  LazyEntries,
  References,
  RuleLayer,
} from "./admission";
import { extensionError } from "./chain";
import type { ResolvedExtensionChain } from "./chain-state";
import { FilterDomain, preparer } from "./row-domain";
import type { Site } from "./rule-words";

/** No restriction: what a key an entry leaves out takes, read as no predicate. */
export const ALL: Input = Object.freeze({});

/**
 * The predicates one layer's entry gives a write `judgement`, each once:
 * `delete`'s, or per field an update writes that field's own, else
 * `update`'s, or `update`'s when it writes none (R3).
 */
export function judgedInputs(
  entry: RuleEntry,
  judgement: WriteJudgement
): Input[] {
  const { update = ALL, delete: removal = ALL } = entry;
  if (judgement.kind === "delete") return [removal];
  if (judgement.writes.length === 0) return [update];
  return [
    ...new Set([
      ...judgement.writes.map((field) => entry.writes?.get(field) ?? update),
      ...(judgement.marks ? [removal] : []),
    ]),
  ];
}
/**
 * A domain some of whose layers hold entries: a model some layer holds an
 * entry on is judged, so a link to it is not written unjudged.
 */
class EntryDomain extends FilterDomain {
  override restrictsLinkWrite(queries: Queries, model: AnyModel): boolean {
    return (
      super.restrictsLinkWrite(queries, model) ||
      this.rows.rules
        ?.get(model["~"].names.ts!)
        ?.some((entry) => entry !== undefined) === true
    );
  }
}

/**
 * A domain whose layers say which rows a write may take (`only`) or hold an
 * entry given lazily: under a `judgement`, a model's predicate takes each
 * layer's predicates of the write it judges beside its filters (R2, R3), and an entry
 * given lazily brings its `read.where` here.
 */
class JudgedDomain extends EntryDomain {
  protected override key(
    name: string,
    excluded: readonly number[],
    judgement?: WriteJudgement
  ): string {
    const judged = this.rows.rules?.get(name) && judgement;
    return judged
      ? `${name} ${excluded} ${judged.kind}${judged.marks ? "+" : ""} ${[...judged.writes].sort()}`
      : super.key(name, excluded);
  }
  protected override layers(
    name: string,
    inputs: readonly Input[] | undefined,
    excluded: readonly number[],
    judgement?: WriteJudgement
  ): (readonly [number, readonly Input[]])[] {
    const entries = this.rows.rules?.get(name);
    if (entries === undefined) return super.layers(name, inputs, excluded);
    const layers: (readonly [number, Input[]])[] = [];
    const count = Math.max(inputs?.length ?? 0, entries.length);
    for (let layer = 0; layer < count; layer++) {
      if (excluded.includes(layer)) continue;
      const own = entries[layer];
      const where = inputs?.[layer];
      layers.push([
        layer,
        [
          ...(own?.read === undefined ? [] : [own.read]),
          ...(where === undefined ? [] : [where]),
          ...(own && judgement ? judgedInputs(own, judgement) : []),
        ],
      ]);
    }
    return layers;
  }
}

/** What prepares the call facts of a chain whose layers hold entries. */
const prepareEntries = /* @__PURE__ */ preparer(EntryDomain);
/** What prepares them where a layer takes rows by `only`: brought by `only` and `lazy`. */
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
  declared: unknown
): readonly string[] | LazyRelations {
  const model = schema[name]!;
  const { relations } = model["~"].state;
  const keyed = Object.keys(relations).filter((relation) => {
    const held = relations[relation]!["~"];
    return held.state.foreignKey !== undefined && held.settleTarget() === model;
  });
  const checked = (listed: unknown): readonly string[] => {
    if (!Array.isArray(listed))
      return refuse(
        name,
        `${name}.acyclic`,
        "lists relations, or is a function returning them"
      );
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

/** One model's draft with every predicate admitted: the layer's entry. */
function admitDraft(
  admission: Admission,
  name: string,
  draft: EntryDraft,
  references: References,
  of?: string
): Mutable<AdmittedEntry> {
  const admit = (place: string, where: unknown) =>
    admission.admit(name, `${name}.${place}`, where, references, of);
  const out: Mutable<AdmittedEntry> = { judge: draft.judge, as: draft.as };
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
 * Every layer's entries bound to `chain`, each model's taken the first time
 * it is read, an entry given lazily read then (`LAZY_ENTRIES`). A model no
 * layer gives as a function is taken now: its refusals are the
 * application's, as they would be at admission.
 */
function bindEntries(chain: ResolvedExtensionChain): BoundEntries {
  // A layer of the chain brought what binds the entries.
  const layers = chain.rules!;
  const brought = <K extends keyof NonNullable<RuleLayer["brings"]>>(kind: K) =>
    layers.find((layer) => layer.brings?.[kind])?.brings?.[kind];
  const keys = brought("keys");
  const lazy = brought("lazy");
  const declares = (model: string) =>
    layers.some((layer) => Object.hasOwn(layer.rules, model));
  const built = new Map<string, readonly (AdmittedEntry | undefined)[]>();
  const get = (
    model: string
  ): readonly (AdmittedEntry | undefined)[] | undefined =>
    declares(model)
      ? memo(built, model, () => {
          const out = layers.map(({ rules, extension }) => {
            const entry = rules[model];
            // Only `lazy` writes an entry as a function, and it brings its reader.
            return typeof entry === "function"
              ? lazy!.read(chain, entry, extension)
              : entry;
          });
          keys?.(model, out);
          return out;
        })
      : undefined;
  for (const layer of layers)
    for (const model of Object.keys(layer.rules))
      if (layers.every((other) => typeof other.rules[model] !== "function"))
        get(model);
  const judge = brought("judge");
  const project = brought("project");
  return {
    rules: { has: declares, get },
    ...(judge && { judge }),
    ...(project && { project }),
    // An entry given lazily is read later: its calls carry their values.
    ...(lazy && {
      lazy: true,
      filters: (model: string, layer: number) => get(model)?.[layer]?.filters,
    }),
    prepare: brought("prepare") ?? prepareEntries,
  };
}

/** What the words that write entries bring: their admission and their binding. */
export const ENTRIES: EntryHost = {
  admit: (admitting, layer, filtersOf, references) =>
    Object.fromEntries(
      Object.entries(layer.rules).map(([name, draft]) => [
        name,
        typeof draft === "function"
          ? layer.brings!.lazy!.admit(admitting, name, draft, filtersOf)
          : admitDraft(admitting, name, draft, references),
      ])
    ),
  bind: bindEntries,
};

/**
 * What `lazy` brings: an entry given as a function admitted once, the first
 * time its model is read, with its own references, checked then against
 * what the chain declared up to its extension, as `$extends` checks an
 * eager entry's.
 */
export const LAZY_ENTRIES: LazyEntries = {
  admit(admitting, name, draft, filtersOf) {
    let resolved: AdmittedEntry | undefined;
    return () => {
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
  },
  read(chain, entry, extension) {
    const draft = entry();
    const at = chain.extensions.findIndex((own) => own.name === extension);
    const names = new Set(
      chain.extensions.slice(0, at + 1).map((own) => own.name)
    );
    for (const name of draft.references!)
      if (
        name !== undefined &&
        !chain.args?.all.some(
          (argument) => argument.name === name && names.has(argument.extension)
        )
      )
        extensionError(
          `Extension "${extension}" references undeclared argument "${name}".`,
          extension
        );
    return draft;
  },
};

/**
 * The entry of the model a word is written on, made at the first word that
 * writes one, with what admits and binds them.
 */
export function entryOf(site: Site): EntryDraft {
  // Asked first: where nothing takes an entry (a default's field), it refuses.
  const entry = site.entry();
  site.layer!.host ??= ENTRIES;
  return entry;
}

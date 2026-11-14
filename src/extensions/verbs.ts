/**
 * What reads a `rows` member's `verbs` and `confine`: their admission, their
 * binding to a chain, and what a prepared domain asks of them (`judge.ts`,
 * `projection.ts`). Brought by `withVerbs()`: a program whose extensions only
 * filter rows does not hold it, and the filters reach it only through what
 * its admission leaves in the admitted declaration (`bind`).
 */
import { ClientInitializationError } from "@errors";
import { NO_RELATIONS } from "@query-engine/raptor3/shared/query";
import type {
  LazyRelations,
  ModelVerbs,
} from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import type { ModelState } from "@schema/model";
import { isPlainRecord } from "@schema/relation/terminal";
import type { PredicateAdmission, References, VerbsBinder } from "./admission";
import type { RowsContribution, RowsVerbs } from "./controls";
import { Judge } from "./judge";
import { Projection } from "./projection";

type Verbs = NonNullable<RowsContribution["verbs"]>;

/** A model's `rows.verbs` entry, key by key. */
const VERBS_KEYS: Record<keyof RowsVerbs, true> = {
  predicates: true,
  read: true,
  update: true,
  delete: true,
  writes: true,
  place: true,
  moves: true,
  acyclic: true,
  evidence: true,
  reads: true,
};

/**
 * A declared projection key's spelling: `$` and an identifier. No model
 * member and no engine carrier is spelled so, so a key never hides either,
 * whatever the schema later adds.
 */
const PROJECTION_KEY = /^\$[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * A model's key, unique and foreign-key fields: what identity and every join
 * read, and what a unique constraint answers for on a write, so none of them
 * is ever read-gated.
 */
function keyFields(state: ModelState): ReadonlySet<string> {
  return new Set([
    ...Object.entries(state.scalars)
      .filter(([, scalar]) => scalar["~"].state.isId === true)
      .map(([field]) => field),
    // A write of a guessed value fails on the constraint exactly when some
    // row holds it: a gate on a unique field would be confirmed by it.
    ...Object.keys(state.uniques),
    ...[
      ...Object.values(state.compoundId ?? {}),
      ...Object.values(state.compoundUniques ?? {}),
    ].flatMap(({ entries }) => Object.keys(entries)),
    ...Object.values(state.relations).flatMap(
      (relation) => relation["~"].state.foreignKey?.fields ?? []
    ),
  ]);
}

/**
 * The controls an admitted entry's predicates name, recorded as admission
 * made their parameters: a lazy entry's are checked against each chain when
 * it is resolved there.
 */
const entryReferences = new WeakMap<
  RowsVerbs,
  readonly (string | undefined)[]
>();

/** One model's `verbs` entry, every predicate admitted and every name checked. */
function admitEntry(
  { schema, admit, refuse }: PredicateAdmission,
  name: string,
  entry: RowsVerbs
): RowsVerbs {
  const place = `verbs.${name}`;
  if (!isPlainRecord(entry))
    refuse(name, place, "root", "is not an object or a function");
  // Policies may be data built at runtime: a misspelt `writes` would leave
  // its field judged at `update`, which widens the write.
  for (const key of Object.keys(entry))
    if (!Object.hasOwn(VERBS_KEYS, key))
      refuse(
        name,
        place,
        key,
        `is not one of ${Object.keys(VERBS_KEYS).join(", ")}`
      );
  const { state } = schema[name]!["~"];
  // An entry admitted before is made of nodes, which admit as themselves
  // and make no parameter: what its admission recorded stands.
  const references: References = new Set(entryReferences.get(entry));
  const predicates = Object.fromEntries(
    Object.entries(entry.predicates).map(([key, predicate]) => [
      key,
      admit(name, `${place}.predicates.${key}`, predicate, references),
    ])
  );
  const known = (at: string, predicate: string | undefined) => {
    if (predicate !== undefined && !Object.hasOwn(predicates, predicate))
      refuse(name, place, at, `names unknown predicate "${predicate}"`);
  };
  known("read", entry.read);
  known("update", entry.update);
  known("delete", entry.delete);
  known("place", entry.place);
  for (const key of ["writes", "moves"] as const)
    for (const [field, predicate] of Object.entries(entry[key] ?? {})) {
      if (
        !(
          Object.hasOwn(state.scalars, field) ||
          Object.hasOwn(state.relations, field)
        )
      )
        refuse(name, place, `${key}.${field}`, "names an unknown field");
      known(`${key}.${field}`, predicate);
    }
  /** The self relations of the model holding its key: what `acyclic` may name. */
  const selfKeys = Object.keys(state.relations).filter((relation) => {
    const held = state.relations[relation]!["~"];
    return (
      held.state.foreignKey !== undefined &&
      held.settleTarget() === schema[name]
    );
  });
  const acyclicOf = (relations: readonly string[]): readonly string[] => {
    for (const relation of relations)
      if (!selfKeys.includes(relation))
        refuse(
          name,
          place,
          `acyclic.${relation}`,
          "names no to-one relation of the model to itself holding its key"
        );
    return relations;
  };
  let cycles: readonly string[] | LazyRelations | undefined;
  const declared = entry.acyclic;
  if (typeof declared === "function") {
    let resolved: readonly string[] | undefined;
    cycles = Object.freeze({
      candidates: Object.freeze(selfKeys),
      resolve: () => (resolved ??= Object.freeze([...acyclicOf(declared())])),
    });
  } else if (declared !== undefined) cycles = acyclicOf(declared);
  const { evidence } = entry;
  if (evidence !== undefined) {
    if (!PROJECTION_KEY.test(evidence.as))
      refuse(name, place, "evidence.as", "is not `$` and an identifier");
    for (const [index, predicate] of evidence.names.entries())
      known(`evidence.names.${index}`, predicate);
  }
  const keys = entry.reads === undefined ? undefined : keyFields(state);
  for (const [field, predicate] of Object.entries(entry.reads ?? {})) {
    if (!Object.hasOwn(state.scalars, field))
      refuse(name, place, `reads.${field}`, "names no scalar of the model");
    // Masked in a caller's operands while identity and joins read it raw,
    // a key would answer through a relation what a filter hides.
    if (keys!.has(field))
      refuse(
        name,
        place,
        `reads.${field}`,
        "names a key, a unique or a foreign key field"
      );
    known(`reads.${field}`, predicate);
  }
  const admitted: RowsVerbs = Object.freeze({
    ...entry,
    predicates: Object.freeze(predicates),
    // Admission leaves a lazy `acyclic` as its candidates and resolver, read
    // back as such by the binding: the declared type has no name for it.
    ...(cycles !== undefined && { acyclic: cycles as RowsVerbs["acyclic"] }),
  });
  entryReferences.set(admitted, [...references]);
  return admitted;
}

/**
 * Every model's `verbs` entry admitted, the controls the eager ones name
 * added to `references`. An entry given as a function is admitted the first
 * time it is resolved, then kept: once for the admitted declaration, so
 * once per schema where its declaration is admitted once.
 */
function admitVerbs(
  verbs: Verbs,
  admission: PredicateAdmission,
  references: References
): Verbs {
  const admitted: Record<string, RowsVerbs | (() => RowsVerbs)> = {};
  for (const [name, entry] of Object.entries(verbs)) {
    if (!Object.hasOwn(admission.schema, name))
      admission.refuse(name, `verbs.${name}`, "root", "names an unknown model");
    if (typeof entry === "function") {
      let resolved: RowsVerbs | undefined;
      const lazily = () => (resolved ??= admitEntry(admission, name, entry()));
      admitted[name] = lazily;
      continue;
    }
    const own = admitEntry(admission, name, entry);
    for (const control of entryReferences.get(own)!) references.add(control);
    admitted[name] = own;
  }
  return Object.freeze(admitted);
}

/**
 * The predicate a mode names among its model's `verbs` entry: at once, or,
 * for an entry given as a function, when the model is first read.
 */
function named(
  entry: RowsVerbs | (() => RowsVerbs) | undefined,
  predicate: string,
  refuse: () => never
): Input | (() => Input) {
  const of = (own: RowsVerbs | undefined): Input =>
    own && Object.hasOwn(own.predicates, predicate)
      ? own.predicates[predicate]!
      : refuse();
  return typeof entry === "function" ? () => of(entry()) : of(entry);
}

/** `confine`: per model, a `where` over its own columns. */
function admitConfine(
  confine: NonNullable<RowsContribution["confine"]>,
  { schema, admit, refuse }: PredicateAdmission,
  references: References
): Record<string, Input> {
  const admitted: Record<string, Input> = {};
  for (const [name, predicate] of Object.entries(confine)) {
    const place = `confine.${name}`;
    if (!Object.hasOwn(schema, name))
      refuse(name, place, "root", "names an unknown model");
    // The model's own columns: a confinement reads no relation, so lowering
    // it never builds another set it would confine in turn.
    const scalars = schema[name]!["~"].state.scalars;
    for (const field of Object.keys(predicate ?? {}))
      if (!Object.hasOwn(scalars, field))
        refuse(
          name,
          place,
          "root",
          `names "${field}", which is not a scalar field: a confinement states the model's own columns`
        );
    admitted[name] = admit(name, place, predicate, references);
  }
  return Object.freeze(admitted);
}

/** `{ OR: [] }`, false: what a verb a model's `verbs` leaves out takes. */
const NOTHING: Input = Object.freeze({ OR: Object.freeze([]) });

/** One layer's admitted entry as the engine reads it. */
function layerVerbs(entry: RowsVerbs): ModelVerbs {
  const of = (name: string | undefined): Input =>
    name === undefined ? NOTHING : entry.predicates[name]!;
  const fields = (
    map: { readonly [field: string]: string } | undefined
  ): ReadonlyMap<string, Input> =>
    new Map(
      Object.entries(map ?? {}).map(([field, name]) => [field, of(name)])
    );
  // Admission leaves a lazy `acyclic` as its candidates and resolver.
  const acyclic = entry.acyclic as
    | readonly string[]
    | LazyRelations
    | undefined;
  return Object.freeze({
    read: of(entry.read),
    update: of(entry.update),
    delete: of(entry.delete),
    writes: fields(entry.writes),
    ...(entry.place !== undefined && { place: of(entry.place) }),
    moves: fields(entry.moves),
    acyclic: Array.isArray(acyclic)
      ? Object.freeze([...acyclic])
      : ((acyclic as LazyRelations | undefined) ?? NO_RELATIONS),
    ...(entry.evidence && {
      evidence: Object.freeze({
        as: entry.evidence.as,
        names: Object.freeze(
          entry.evidence.names.map((name) =>
            Object.freeze([name, of(name)] as const)
          )
        ),
        ordered: entry.evidence.ordered === true,
      }),
    }),
    reads: fields(entry.reads),
  });
}

/**
 * Every member's `verbs` and `confine` bound to a chain whose controls are
 * `controls`. A model's verbs, each at its member's layer, are built the
 * first time the model is read: an entry given as a function is resolved
 * then, and the controls it names checked against what the chain declared
 * where its member was applied, as `$extends` checks an eager entry's.
 */
const bindVerbs: VerbsBinder = (members, controls) => {
  /**
   * What the chain declared where `member` was applied: every control up to
   * its own `rows` control, which that application placed after its others.
   */
  const declaredAt = (member: RowsContribution) => {
    const all = controls!.all;
    const at = all.findIndex((control) => control.name === member.control);
    return { names: all.slice(0, at + 1), extension: all[at]!.extension };
  };
  const resolved = (layer: number, model: string): RowsVerbs | undefined => {
    const member = members[layer]!;
    const entry = member.verbs?.[model];
    if (typeof entry !== "function") return entry;
    const admitted = entry();
    const { names, extension } = declaredAt(member);
    for (const control of entryReferences.get(admitted)!)
      if (
        control !== undefined &&
        !names.some((declared) => declared.name === control)
      )
        throw new ClientInitializationError(
          `Extension "${extension}" references undeclared control "${control}".`,
          { meta: { extension } }
        );
    return admitted;
  };
  const declares = (model: string) =>
    members.some(
      (member) =>
        member.verbs !== undefined && Object.hasOwn(member.verbs, model)
    );
  const built = new Map<string, readonly (ModelVerbs | undefined)[]>();
  const verbs = members.some((member) => member.verbs !== undefined)
    ? {
        has: declares,
        get: (model: string) =>
          declares(model)
            ? memo(built, model, () => {
                const entries = members.map((_, layer) =>
                  resolved(layer, model)
                );
                const keys = new Set<string>();
                const layers: (ModelVerbs | undefined)[] = [];
                for (const [layer, entry] of entries.entries()) {
                  if (entry === undefined) continue;
                  // One projection key, one layer: a second would hide the first.
                  const key = entry.evidence?.as;
                  if (key === "$through")
                    throw new ClientInitializationError(
                      `rows.verbs.${model}.evidence.as "$through" is reserved for a relation's link row.`,
                      { meta: { model } }
                    );
                  if (key !== undefined && keys.has(key))
                    throw new ClientInitializationError(
                      `rows.verbs.${model}.evidence.as "${key}" is declared by two extensions of the chain.`,
                      { meta: { model } }
                    );
                  if (key !== undefined) keys.add(key);
                  layers[layer] = layerVerbs(entry);
                }
                return layers;
              })
            : undefined,
      }
    : undefined;
  // A model no member declares lazily is built now: its refusals are the
  // application's, as they would be at admission.
  for (const member of members)
    for (const model of Object.keys(member.verbs ?? {}))
      if (members.every((other) => typeof other.verbs?.[model] !== "function"))
        verbs!.get(model);
  const confine = new Map<string, Input[]>();
  for (const [layer, member] of members.entries())
    for (const [model, where] of Object.entries(member.confine ?? {}))
      memo(confine, model, () => [])[layer] = where;
  const entries = members.flatMap((member) =>
    Object.values(member.verbs ?? {})
  );
  return {
    ...(verbs && { verbs, judge: (domain) => new Judge(domain) }),
    ...(confine.size > 0 && { confine }),
    // Whether a model may project: a lazy entry may, until it is read.
    ...(entries.some(
      (entry) =>
        typeof entry === "function" ||
        entry.evidence !== undefined ||
        Object.keys(entry.reads ?? {}).length > 0
    ) && { project: (domain) => new Projection(domain) }),
    // A lazy entry's predicates are not known yet: its calls carry their values.
    reads: members.some(
      (member) =>
        (member.references?.verbs.length ?? 0) > 0 ||
        Object.values(member.verbs ?? {}).some(
          (entry) => typeof entry === "function"
        )
    ),
  };
};

/** What admits and binds `verbs` and `confine`: brought by `withVerbs()`. */
export const VERBS = Object.freeze({
  verbs: admitVerbs,
  named,
  confine: admitConfine,
  bind: bindVerbs,
});

/**
 * The words of a rule that judge or project rows: `only` (which rows a
 * write may take), `check` (the row a write leaves must hold a predicate),
 * `gate` (a field is present only where a predicate holds), `facts` (per
 * row, which named predicates hold, under a projection key), `keep` (a
 * delete updates the row instead) and `lazy` (an entry read when its model
 * is first read). Each carries what applies it, so a rule that only filters
 * holds none of it.
 */
import type { ModelState } from "@schema/model";
import { isPlainRecord } from "@schema/relation/terminal";
import type { VerbsDraft } from "./admission";
import type {
  CheckWord,
  FactsWord,
  GateWord,
  KeepWord,
  LazyWord,
  OnlyWord,
} from "./contract";
import { judgeOf } from "./judge";
import { keptRowsPart } from "./kept";
import { layerOf } from "./layers";
import { projectionOf } from "./projection";
import { draftOf, listOf } from "./rule";
import { CarriedValue, PredicateWord, type Site } from "./rule-words";
import { NOW } from "./stamps";
import { LAZY_VERBS, prepareJudged, verbsOf } from "./verbs";

/** What the layer of a word's site brings beside its filters. */
const brings = (site: Site) => (site.draft.rule!.brings ??= {});

const UPDATE_FIELD = /^update\.fields\.[^.]+\.check$/;
const FIELD_WHERE = /^update\.fields\.[^.]+\.where$/;

/** `only(where)`'s value: the rows a write may take. */
class Only extends CarriedValue {
  readonly where: object;
  constructor(where: object) {
    super();
    this.where = where;
  }
  join(site: Site): void {
    const { key, field, refuse } = site;
    const own = verbsOf(site);
    brings(site).prepare = prepareJudged;
    if (key === "update.where") own.update = this.where;
    else if (key === "delete.where") own.delete = this.where;
    // An update writing the field takes this instead of `update.where`.
    else if (FIELD_WHERE.test(key))
      (own.writes ??= new Map()).set(field!, this.where);
    else refuse(`${key} does not take only()`);
  }
}

/** A write takes only the rows that hold `where`. */
export function only<W>(where: NoInfer<W>): OnlyWord<W>;
export function only(where: object): unknown {
  return new Only(where);
}

/** `check(where)`'s value: what the row a write produces must hold. */
class Checked extends CarriedValue {
  readonly where: object;
  constructor(where: object) {
    super();
    this.where = where;
  }
  join(site: Site): void {
    const { key, field, refuse } = site;
    const own = verbsOf(site);
    own.judge = judgeOf;
    brings(site).judge = judgeOf;
    if (key === "create.check") own.place = this.where;
    // The row an update leaves is judged again where the update writes a
    // field the predicate reads (`update.check`), or the field named.
    else if (key === "update.check") own.check = this.where;
    else if (UPDATE_FIELD.test(key)) {
      (own.moves ??= new Map()).set(field!, this.where);
    } else refuse(`${key} does not take check()`);
  }
}

/** The row a write leaves (or creates) must hold `where`. */
export function check<W>(where: NoInfer<W>): CheckWord<W>;
export function check(where: object): unknown {
  return new Checked(where);
}

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

/** `gate(where)`'s value: where a field is present. */
class Gated extends CarriedValue {
  readonly where: object;
  constructor(where: object) {
    super();
    this.where = where;
  }
  join(site: Site): void {
    const { key, field, model, schema, refuse } = site;
    if (key !== `read.fields.${field}`) refuse(`${key} does not take gate()`);
    const { state } = schema[model]!["~"];
    if (!Object.hasOwn(state.scalars, field!))
      refuse(`${key} names no scalar of the model`);
    // Masked in a caller's operands while identity and joins read it raw,
    // a key would answer through a relation what a filter hides.
    if (keyFields(state).has(field!))
      refuse(`${key} names a key, a unique or a foreign key field`);
    const own = verbsOf(site);
    brings(site).project = projectionOf;
    (own.reads ??= new Map()).set(field!, this.where);
  }
}

/**
 * The field is present where `where` holds, absent elsewhere, and read as
 * `NULL` by every operand a call writes over it.
 */
export function gate<W>(where: NoInfer<W>): GateWord<W>;
export function gate(where: object): unknown {
  return new Gated(where);
}

/**
 * A declared projection key's spelling: `$` and an identifier. No model
 * member and no engine carrier is spelled so, so a key never hides either,
 * whatever the schema later adds.
 */
const PROJECTION_KEY = /^\$[a-zA-Z_][a-zA-Z0-9_]*$/;

/** `facts({ … })`'s value: per row, which named predicates hold. */
class Facts extends CarriedValue {
  readonly predicates: Readonly<Record<string, object>>;
  constructor(predicates: Readonly<Record<string, object>>) {
    super();
    this.predicates = predicates;
  }
  join(site: Site): void {
    const { key, field, refuse } = site;
    if (key !== `read.select.${field}`) refuse(`${key} does not take facts()`);
    if (!PROJECTION_KEY.test(field!))
      refuse(`${key} is not \`$\` and an identifier`);
    const own = verbsOf(site);
    if (own.as !== undefined) refuse("read.select holds one projection key");
    brings(site).project = projectionOf;
    own.as = field;
    own.facts = new Map(Object.entries(this.predicates));
  }
}

/**
 * Per row, whether each named predicate holds: a `select` or `include`
 * naming the key reads them.
 */
export function facts<const Names extends string>(
  predicates: Readonly<Record<Names, object>>
): FactsWord<Names, false>;
export function facts(predicates: Readonly<Record<string, object>>): unknown {
  return new Facts(predicates);
}

/** `keep(data)`'s value: what a delete of the model writes instead. */
class Kept extends CarriedValue {
  readonly data: unknown;
  constructor(data: unknown) {
    super();
    this.data = data;
  }
  join({ key, model, schema, draft, lazy, refuse: given }: Site): void {
    // Typed where it is declared, so a refusal narrows what follows it.
    const refuse: (problem: string) => never = given;
    if (key !== "delete.instead") refuse(`${key} does not take keep()`);
    if (lazy)
      refuse("keep() is written in an entry, not one given as a function");
    let data = this.data;
    let removeWhen: Record<string, string | number | boolean> | undefined;
    const tested = data instanceof PredicateWord ? data.tested?.() : undefined;
    if (tested !== undefined) {
      const { arg, test } = tested;
      const spec = draft.controls?.[arg.name];
      const values =
        spec !== undefined && "oneOf" in spec ? spec.oneOf : undefined;
      const removes =
        tested.kind === "unless"
          ? test
          : values?.length === 2
            ? values.find((value) => value !== test)
            : undefined;
      if (
        arg.path !== undefined ||
        (typeof removes !== "string" &&
          typeof removes !== "number" &&
          typeof removes !== "boolean")
      )
        refuse("keep() takes data, or unless(arg(name), value, data)");
      removeWhen = { [arg.name]: removes };
      data = tested.then;
    }
    if (!isPlainRecord(data))
      refuse("keep() takes the data the row is updated with");
    const { state } = schema[model]!["~"];
    let at: string | undefined;
    const assign: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(data)) {
      if (!Object.hasOwn(state.scalars, field))
        refuse(`keep() names unknown field "${field}"`);
      if (!(value instanceof PredicateWord)) assign[field] = value;
      else if (value.stamp?.() !== NOW)
        refuse("keep() writes constants and now");
      else if (at !== undefined) refuse("keep() writes now in one field");
      else at = field;
    }
    const deletion = (draft.deletion ??= { models: {} });
    if (removeWhen !== undefined) {
      if (
        deletion.removeWhen !== undefined &&
        JSON.stringify(deletion.removeWhen) !== JSON.stringify(removeWhen)
      )
        refuse("one extension's keep() parts name the same physical delete");
      deletion.removeWhen = removeWhen;
    }
    deletion.models[model] = at === undefined ? { assign } : { at, assign };
    (draft.parts ??= []).push(keptRowsPart);
  }
}

/** The delete updates the row with `data` instead of removing it. */
export function keep<D>(data: D): KeepWord<D>;
export function keep(data: object): unknown {
  return new Kept(data);
}

/** `lazy(() => entry)`'s value: an entry read when its model is first read. */
class Lazy extends CarriedValue {
  readonly read: () => unknown;
  constructor(read: () => unknown) {
    super();
    this.read = read;
  }
  join({ key, model, schema, draft, lazy, refuse }: Site): void {
    if (key !== "the entry" || lazy) refuse(`${key} does not take lazy()`);
    const layer = draft.rule!;
    if (Object.hasOwn(layer.verbs, model))
      refuse("two rule parts of one extension judge the model");
    layer.host = LAZY_VERBS;
    // What the entry reads of its call, and whether its words judge or
    // project, are known once it is read.
    layer.layered = layerOf;
    layer.brings = {
      judge: judgeOf,
      project: projectionOf,
      prepare: prepareJudged,
    };
    const read = (): VerbsDraft => {
      const given: unknown = Reflect.apply(this.read, undefined, []);
      const written: Readonly<Record<string, unknown>> = isPlainRecord(given)
        ? given
        : {};
      if (written.confine !== undefined)
        refuse("an entry given lazily holds no confine");
      const verbs = draftOf(given, model, schema, draft, refuse, true) ?? {};
      const root = listOf(written.root);
      const related = listOf(written.related);
      return root.length + related.length === 0
        ? verbs
        : { ...verbs, root, related };
    };
    layer.verbs[model] = read;
    // Once every part wrote, where no eager filter of the extension decided
    // its filters by an argument: the entry is read later, so they are
    // decided by the first argument of the extension a value of which picks
    // a mode.
    draft.finish.push(() => {
      if (layer.mode !== undefined) return;
      for (const [name, spec] of Object.entries(draft.controls ?? {}))
        if ("oneOf" in spec && spec.default !== undefined) {
          layer.mode = {
            name,
            values: spec.oneOf.map(String),
            fallback: String(spec.default),
          };
          return;
        }
    });
  }
}

/**
 * The entry is read the first time a call needs its model, a filter that
 * reads the model through a relation included; its refusals fail that call.
 */
export function lazy<E>(read: () => NoInfer<E>): LazyWord<E>;
export function lazy(read: () => unknown): unknown {
  return new Lazy(read);
}

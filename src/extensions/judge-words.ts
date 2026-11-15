/**
 * The words of a rule that judge or project rows: `only` (which rows a
 * write may take), `check` (the row a write leaves must hold a predicate),
 * `gate` (a field is present only where a predicate holds), `facts` (per
 * row, which named predicates hold, under a projection key), `keep` (a
 * delete updates the row instead) and `lazy` (an entry read when its model
 * is first read). Each carries what applies it, so a rule that only filters
 * holds none of it.
 */
import { Condition } from "@query-engine/raptor3/shared/row-scope";
import type { ModelState } from "@schema/model";
import { isPlainRecord } from "@schema/relation/terminal";
import type { VerbsDraft } from "./admission";
import { CALL_READS } from "./call-values";
import type {
  CheckWord,
  FactsWord,
  GateWord,
  HeldOperand,
  IsHeld,
  KeepWord,
  LazyWord,
  OnlyWord,
} from "./contract";
import { judgeOf } from "./judge";
import { keptPart } from "./kept";
import { projectionOf, refuseSharedKeys } from "./projection";
import { draftOf, listOf } from "./rule";
import { CarriedValue, PredicateWord, type Site, testOf } from "./rule-words";
import { NOW } from "./stamps";
import { LAZY_ENTRIES, prepareJudged, VERBS, verbsOf } from "./verbs";

/** A word written with one value, which its `join` reads. */
export abstract class Held<T> extends CarriedValue {
  readonly held: T;
  constructor(held: T) {
    super();
    this.held = held;
  }
}

/** What the layer of a word's site brings beside its filters. */
const brings = (site: Site) => (site.layer!.brings ??= {});

/** The field `update.fields` names, refused where the model has none so named. */
function fieldOf({ schema, model, field, refuse }: Site): string {
  const { state } = schema[model]!["~"];
  if (
    !(
      Object.hasOwn(state.scalars, field!) ||
      Object.hasOwn(state.relations, field!)
    )
  )
    refuse(`update.fields names unknown field "${field}"`);
  return field!;
}

/** What a word that carries or hides fields of a read writes beside itself. */
function shown(site: Site) {
  const own = verbsOf(site);
  if (site.shows !== undefined) own.shown = site.shows;
  return own;
}

const UPDATE_FIELD = /^update\.fields\.[^.]+\.check$/;
const FIELD_WHERE = /^update\.fields\.[^.]+\.where$/;

/** `only(where)`'s value: the rows a write may take. */
class Only extends Held<object> {
  join(site: Site): void {
    const { key, refuse } = site;
    const own = verbsOf(site);
    brings(site).prepare = prepareJudged;
    if (key === "update.where") own.update = this.held;
    else if (key === "delete.where") own.delete = this.held;
    // An update writing the field takes this instead of `update.where`.
    else if (FIELD_WHERE.test(key))
      (own.writes ??= new Map()).set(fieldOf(site), this.held);
    else refuse(`${key} does not take only()`);
  }
}

/**
 * A write takes only the rows that hold `where`. Written apart from a rule
 * (a shared constant), nothing types its operand: any filter, which the
 * rule's model admits where it is applied (as for `check`).
 */
export function only<W>(
  where: HeldOperand<W>
): IsHeld<W> extends true ? OnlyWord<never> : OnlyWord<W>;
export function only(where: object): unknown {
  return new Only(where);
}

/** `check(where)`'s value: what the row a write produces must hold. */
class Checked extends Held<object> {
  join(site: Site): void {
    const { key, refuse } = site;
    const own = verbsOf(site);
    own.judge = judgeOf;
    brings(site).judge = judgeOf;
    if (key === "create.check") own.place = this.held;
    // The row an update leaves is judged again where the update writes a
    // field the predicate reads (`update.check`), or the field named.
    else if (key === "update.check") own.check = this.held;
    else if (UPDATE_FIELD.test(key))
      (own.moves ??= new Map()).set(fieldOf(site), this.held);
    else refuse(`${key} does not take check()`);
  }
}

/**
 * The row a write leaves (or creates) must hold `where`. Written apart from
 * a rule (a shared constant), nothing types its operand: it is a check of
 * any filter, which the rule's model admits where it is applied.
 */
export function check<W>(
  where: HeldOperand<W>
): IsHeld<W> extends true ? CheckWord<never> : CheckWord<W>;
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
class Gated extends Held<object> {
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
    const own = shown(site);
    brings(site).project = projectionOf;
    (own.reads ??= new Map()).set(field!, this.held);
  }
}

/**
 * The field is present where `where` holds, absent elsewhere, and read as
 * `NULL` by every operand a call writes over it.
 */
export function gate<W>(
  where: HeldOperand<W>
): IsHeld<W> extends true ? GateWord<never> : GateWord<W>;
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
class Facts extends Held<Readonly<Record<string, object>>> {
  join(site: Site): void {
    const { key, field, refuse } = site;
    if (key !== `read.select.${field}`) refuse(`${key} does not take facts()`);
    if (!PROJECTION_KEY.test(field!))
      refuse(`${key} is not \`$\` and an identifier`);
    const own = shown(site);
    if (own.as !== undefined) refuse("read.select holds one projection key");
    Object.assign(brings(site), {
      project: projectionOf,
      keys: refuseSharedKeys,
    });
    own.as = field;
    own.facts = new Map(Object.entries(this.held));
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
// Not a `Held`: written alone (`viborm/soft-delete`), its own field weighs less.
class Kept extends CarriedValue {
  readonly data: unknown;
  constructor(data: unknown) {
    super();
    this.data = data;
  }
  join({ key, model, schema, lazy, bring, refuse: given }: Site): void {
    // Typed where it is declared, so a refusal narrows what follows it.
    const refuse: (problem: string) => never = given;
    if (key !== "delete.instead") refuse(`${key} does not take keep()`);
    if (lazy)
      refuse("keep() is written in an entry, not one given as a function");
    let data = this.data;
    // `keep(when(…))`, `keep(unless(…))`: kept where its test says, per call.
    const chosen =
      data instanceof PredicateWord && data.kind !== "provided"
        ? data
        : undefined;
    let test: Condition | undefined;
    if (chosen?.arg !== undefined) {
      const tested = testOf(chosen.test);
      if (typeof tested === "string") refuse(tested);
      test = new Condition(chosen.arg.stamp(), tested);
      data = chosen.then;
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
    bring(
      keptPart(model, {
        ...(at !== undefined && { at }),
        assign,
        ...(test && { test, keeps: chosen!.kind === "when" }),
      })
    );
  }
}

/** The delete updates the row with `data` instead of removing it. */
export function keep<D>(data: D): KeepWord<D>;
export function keep(data: object): unknown {
  return new Kept(data);
}

/** `lazy(() => entry)`'s value: an entry read when its model is first read. */
class Lazy extends Held<() => unknown> {
  join(site: Site): void {
    const { key, model, schema, lazy, refuse } = site;
    if (key !== "the entry" || lazy) refuse(`${key} does not take lazy()`);
    const layer = site.layer!;
    if (Object.hasOwn(layer.verbs, model))
      refuse("two rule parts of one extension judge the model");
    layer.host = VERBS;
    // What the entry reads of its call, and whether its words judge or
    // project, are known once it is read.
    layer.reads = CALL_READS;
    layer.brings = {
      judge: judgeOf,
      project: projectionOf,
      prepare: prepareJudged,
      keys: refuseSharedKeys,
      lazy: LAZY_ENTRIES,
    };
    const read = (): VerbsDraft => {
      const given: unknown = Reflect.apply(this.held, undefined, []);
      const written: Readonly<Record<string, unknown>> = isPlainRecord(given)
        ? given
        : {};
      const verbs = draftOf(given, model, schema, site, refuse, true) ?? {};
      const root = listOf(written.root);
      const related = listOf(written.related);
      return root.length + related.length === 0
        ? verbs
        : { ...verbs, root, related };
    };
    layer.verbs[model] = read;
  }
}

/**
 * The entry is read the first time a call needs its model, a filter that
 * reads the model through a relation included; its refusals fail that call.
 * Written apart from a rule, its entry is held, as `check`'s operand is.
 */
export function lazy<E>(
  read: () => HeldOperand<E>
): IsHeld<E> extends true ? LazyWord<never> : LazyWord<E>;
export function lazy(read: () => unknown): unknown {
  return new Lazy(read);
}

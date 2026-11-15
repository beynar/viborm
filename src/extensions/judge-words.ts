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
import type {
  AdmittedEntry,
  EntryDraft,
  LazyDraft,
  References,
} from "./admission";
import { CALL_READS } from "./call-values";
import { extensionError } from "./chain";
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
import { admitDraft, ENTRIES, entryOf, prepareJudged } from "./entries";
import { judgeOf } from "./judge";
import { keptPart } from "./kept";
import { projectionOf, refuseSharedKeys } from "./projection";
import { draftOf, listOf } from "./rule";
import { CarriedValue, PredicateWord, type Site, testOf } from "./rule-words";
import { NOW } from "./stamps";

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

/**
 * Where `only` or `check` writes its predicate in `own`, the entry of its
 * site: the entry key `places` gives the site's key, or, at
 * `update.fields.f.<…>` (`perField`), field `f` of the map `fields`,
 * refused where the model has no field so named.
 */
function placed(
  { schema, model, key, field, refuse }: Site,
  own: EntryDraft,
  held: object,
  word: string,
  places: Readonly<Record<string, "update" | "delete" | "place" | "check">>,
  perField: RegExp,
  fields: "writes" | "moves"
): void {
  const { state } = schema[model]!["~"];
  const at = places[key];
  if (at !== undefined) own[at] = held;
  else if (!perField.test(key)) refuse(`${key} does not take ${word}()`);
  else if (
    Object.hasOwn(state.scalars, field!) ||
    Object.hasOwn(state.relations, field!)
  )
    (own[fields] ??= new Map()).set(field!, held);
  else refuse(`update.fields names unknown field "${field}"`);
}

/**
 * The entry of a word that carries or hides fields of a read, with what
 * projects them.
 */
function shown(site: Site) {
  const own = entryOf(site);
  if (site.shows !== undefined) own.shown = site.shows;
  brings(site).project = projectionOf;
  return own;
}

const FIELD_WHERE = /^update\.fields\.[^.]+\.where$/;
const FIELD_CHECK = /^update\.fields\.[^.]+\.check$/;

/** `only(where)`'s value: the rows a write may take. */
class Only extends Held<object> {
  join(site: Site): void {
    const own = entryOf(site);
    brings(site).prepare = prepareJudged;
    // An update writing the field takes its own instead of `update.where`.
    placed(
      site,
      own,
      this.held,
      "only",
      { "update.where": "update", "delete.where": "delete" },
      FIELD_WHERE,
      "writes"
    );
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
    const own = entryOf(site);
    own.judge = judgeOf;
    brings(site).judge = judgeOf;
    // The row an update leaves is judged again where the update writes a
    // field the predicate reads (`update.check`), or the field named.
    placed(
      site,
      own,
      this.held,
      "check",
      { "create.check": "place", "update.check": "check" },
      FIELD_CHECK,
      "moves"
    );
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
 * Whether `field`, a scalar of the model, is one of its key, unique or
 * foreign-key fields: what identity and every join read, and what a unique
 * constraint answers for on a write, so none of them is ever read-gated.
 */
const isKeyField = (state: ModelState, field: string): boolean =>
  state.scalars[field]!["~"].state.isId === true ||
  // A write of a guessed value fails on the constraint exactly when some
  // row holds it: a gate on a unique field would be confirmed by it.
  Object.hasOwn(state.uniques, field) ||
  [
    ...Object.values(state.compoundId ?? {}),
    ...Object.values(state.compoundUniques ?? {}),
  ].some(({ entries }) => Object.hasOwn(entries, field)) ||
  Object.values(state.relations).some(
    (relation) =>
      relation["~"].state.foreignKey?.fields.includes(field) === true
  );

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
    if (isKeyField(state, field!))
      refuse(`${key} names a key, a unique or a foreign key field`);
    (shown(site).reads ??= new Map()).set(field!, this.held);
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
    brings(site).keys = refuseSharedKeys;
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
    // What a delete keeps is bound with the chain, before a lazy entry is read.
    if (key !== "delete.instead" || lazy)
      refuse(`${lazy ? "a lazy entry" : key} does not take keep()`);
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
      else if (value.stamp?.() !== NOW || at !== undefined)
        refuse("keep() writes constants, and now in one field");
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
    if (Object.hasOwn(layer.rules, model))
      refuse("two rule parts of one extension judge the model");
    layer.host = ENTRIES;
    // What the entry reads of its call, and whether its words judge or
    // project, are known once it is read.
    layer.reads = CALL_READS;
    layer.brings = {
      judge: judgeOf,
      project: projectionOf,
      prepare: prepareJudged,
      keys: refuseSharedKeys,
      lazy: true,
    };
    // Admitted once, the first time its model is read, with its own
    // references, checked then against what each chain declared up to its
    // extension, as `$extends` checks an eager entry's.
    const read: LazyDraft = (admission, filtersOf) => {
      let admitted: AdmittedEntry | undefined;
      return (chain, extension) => {
        if (admitted === undefined) {
          const given: unknown = Reflect.apply(this.held, undefined, []);
          const written: Readonly<Record<string, unknown>> = isPlainRecord(
            given
          )
            ? given
            : {};
          const own: References = new Set();
          const at = `lazy ${model}`;
          const draft = draftOf(given, model, schema, site, refuse, true);
          const entry = admitDraft(admission, model, draft ?? {}, own, at);
          entry.filters = filtersOf(
            model,
            { root: listOf(written.root), related: listOf(written.related) },
            own,
            at
          );
          // Read after the filters: what they name is the entry's too.
          entry.references = [...own];
          admitted = entry;
        }
        // Declared by its own extension or one applied before it.
        const at = (name: string) =>
          chain.extensions.findIndex((member) => member.name === name);
        for (const name of admitted.references!)
          if (
            name !== undefined &&
            !chain.args?.all.some(
              (argument) =>
                argument.name === name &&
                at(argument.extension) <= at(extension)
            )
          )
            extensionError(
              `Extension "${extension}" references undeclared argument "${name}".`,
              extension
            );
        return admitted;
      };
    };
    layer.rules[model] = read;
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

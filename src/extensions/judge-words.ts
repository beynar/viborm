/**
 * The words of a rule that judge or project rows: `check` (the row a write
 * leaves must hold a predicate), `gate` (a field is present only where a
 * predicate holds), `facts` (per row, which named predicates hold, under a
 * projection key) and `keep` (a delete updates the row instead). Each
 * carries what applies it, so a rule that only filters holds none of it.
 */
import type { ModelState } from "@schema/model";
import { isPlainRecord } from "@schema/relation/terminal";
import type { CheckWord, FactsWord, GateWord, KeepWord } from "./contract";
import { judgeOf } from "./judge";
import { keptRowsPart } from "./kept";
import { projectionOf } from "./projection";
import {
  ArgTestFilter,
  ArgValue,
  CarriedValue,
  NowValue,
  RowValue,
  type Site,
} from "./rule-words";

const UPDATE_FIELD = /^update\.fields\.[^.]+\.check$/;

/** `check(where)`'s value: what the row a write produces must hold. */
class Checked extends CarriedValue {
  readonly where: object;
  constructor(where: object) {
    super();
    this.where = where;
  }
  join({ key, field, model, schema, verbs, refuse }: Site): void {
    const own = verbs();
    own.judge = judgeOf;
    if (key === "create.check") own.place = this.where;
    else if (key === "update.check") {
      // Whatever field an update writes, the row it leaves holds it.
      const moves: Record<string, unknown> = { ...own.moves };
      for (const scalar of Object.keys(schema[model]!["~"].state.scalars))
        moves[scalar] = this.where;
      own.moves = moves;
    } else if (UPDATE_FIELD.test(key)) {
      const moves = { ...own.moves };
      const prior = moves[field!];
      moves[field!] =
        prior === undefined ? this.where : { AND: [prior, this.where] };
      own.moves = moves;
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
  join({ key, field, model, schema, verbs, refuse }: Site): void {
    if (key !== `read.fields.${field}`) refuse(`${key} does not take gate()`);
    const { state } = schema[model]!["~"];
    if (!Object.hasOwn(state.scalars, field!))
      refuse(`${key} names no scalar of the model`);
    // Masked in a caller's operands while identity and joins read it raw,
    // a key would answer through a relation what a filter hides.
    if (keyFields(state).has(field!))
      refuse(`${key} names a key, a unique or a foreign key field`);
    const own = verbs();
    own.project = projectionOf;
    own.reads = { ...own.reads, [field!]: this.where };
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
  join({ key, field, verbs, refuse }: Site): void {
    if (key !== `read.select.${field}`) refuse(`${key} does not take facts()`);
    if (!PROJECTION_KEY.test(field!))
      refuse(`${key} is not \`$\` and an identifier`);
    const own = verbs();
    if (own.evidence !== undefined)
      refuse("read.select holds one projection key");
    own.project = projectionOf;
    own.evidence = { as: field!, names: Object.entries(this.predicates) };
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
  join({ key, model, schema, draft, lazy, refuse }: Site): void {
    if (key !== "delete.instead") refuse(`${key} does not take keep()`);
    if (lazy) refuse("keep() is written in an entry, not one given as a function");
    let data = this.data;
    let removeWhen: Record<string, string | number | boolean> | undefined;
    if (data instanceof ArgTestFilter && data.kind !== "provided") {
      const { arg, test } = data;
      const spec = draft.args?.[arg.name];
      const values =
        spec !== undefined && "oneOf" in spec ? spec.oneOf : undefined;
      const removes =
        data.kind === "unless"
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
        return refuse("keep() takes data, or unless(arg(name), value, data)");
      removeWhen = { [arg.name]: removes };
      data = data.then;
    }
    if (!isPlainRecord(data))
      return refuse("keep() takes the data the row is updated with");
    const { state } = schema[model]!["~"];
    let at: string | undefined;
    const assign: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(data)) {
      if (!Object.hasOwn(state.scalars, field))
        refuse(`keep() names unknown field "${field}"`);
      if (value instanceof NowValue) {
        if (at !== undefined) refuse("keep() writes now in one field");
        at = field;
      } else if (value instanceof ArgValue || value instanceof RowValue)
        refuse("keep() writes constants and now");
      else assign[field] = value;
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

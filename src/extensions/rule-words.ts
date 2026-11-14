/**
 * The words a rule and a default write where a value or a filter goes:
 * `arg`, `now`, `row`, `exists`, `when`, `unless`, `provided`. Each is plain
 * data the rule's admission reads where the extension is applied. And what
 * every other word of a rule or a default is: a value that carries what
 * applies it ({@link CarriedValue}).
 */
import type { Schema } from "@client/types";
import {
  Condition,
  type ConditionTest,
  Existence,
  OuterColumn,
  Parameter,
} from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
import { isPlainRecord } from "@schema/relation/terminal";
import { validateSchema } from "@validation/primitives/helpers";
import type { FilterWord } from "@validation/primitives/parameter";
import type { SchemaRegistryLookup } from "@validation/types";
import type { LayerMode, References, RuleLayer, VerbsDraft } from "./admission";
import type {
  ArgTest,
  ArgWord,
  ExistsWord,
  HeldArg,
  NowWord,
  ProvidedWord,
  RowWord,
  WhenWord,
} from "./contract";
import type { DefinitionDraft } from "./extension";

/**
 * Where one carried word is written: its model, its place (`create.check`,
 * `read.fields.notes`, …) and the field that place names, with what it may
 * write: the model's other keys, the extension's members.
 */
export interface Site {
  readonly model: string;
  readonly key: string;
  readonly field?: string;
  readonly schema: Schema;
  readonly draft: DefinitionDraft;
  /** Inside an entry given as a function, read when its model is first read. */
  readonly lazy: boolean;
  /** The model's keys beyond its filters, made at the first word that writes one. */
  verbs(): VerbsDraft;
  refuse(problem: string): never;
}

/**
 * A word that carries what applies it (`check`, `gate`, `facts`, `keep`,
 * `omitted`): the part that reads a rule or a default calls it where it is
 * written and never names it, so a program that writes none holds none of
 * their code.
 */
export abstract class CarriedValue {
  abstract join(site: Site): void;
}

/**
 * A word written inside a predicate: what the rule's admission makes of it
 * where it stands (`value` where a value goes, `filter` where a filter
 * goes), and, for a test of an argument, what decides a layer's mode. Each
 * word carries its own, so a program holds the code of the words it writes.
 */
export abstract class PredicateWord {
  /** What admission puts where the word stands as a value. */
  value?(at: Admitting): object;
  /** What admission puts where the word stands as a filter. */
  filter?(at: Admitting): FilterWord;
  /** Where the word heads a filter list: its layer's mode, once known. */
  place?(layer: RuleLayer, draft: DefinitionDraft): void;
  /**
   * The word in a list read under one value of its layer's mode: itself,
   * what it applies there, or `undefined` where it applies nothing.
   */
  under?(mode: LayerMode | undefined, value: string): unknown;
}

/** What admission hands a word: what records its call values, and the schema. */
export interface Admitting {
  readonly references: References;
  readonly schema: Schema;
  readonly registry: SchemaRegistryLookup<Schema>;
}

/** `arg(name, path?)`'s value: the call's value for one argument, or a field of it. */
export class ArgValue extends PredicateWord {
  readonly name: string;
  readonly path: string | undefined;
  constructor(name: string, path: string | undefined) {
    super();
    this.name = name;
    this.path = path;
  }
  override value({ references }: Admitting): object {
    references.add(this.name);
    return new Parameter(this.name, this.path);
  }
}

/** `now`'s value: the call's one instant. */
export class NowValue extends PredicateWord {
  override value({ references }: Admitting): object {
    references.add(undefined);
    return new Parameter();
  }
}

/** `row(column, up?)`'s value: a column of the row `up` relation bodies above. */
export class RowValue extends PredicateWord {
  readonly column: string;
  readonly up: number;
  constructor(column: string, up: number) {
    super();
    this.column = column;
    this.up = up;
  }
  override value(): object {
    return new OuterColumn(this.column, this.up);
  }
}

/** `exists({ model: where })`'s filter. */
export class ExistsFilter extends PredicateWord {
  readonly spec: Readonly<Record<string, object>>;
  constructor(spec: Readonly<Record<string, object>>) {
    super();
    this.spec = spec;
  }
  override filter({ schema, registry }: Admitting): FilterWord {
    const models = Object.keys(this.spec);
    const [model] = models;
    if (models.length !== 1 || !Object.hasOwn(schema, model!))
      return {
        message:
          "exists() names exactly one model of the schema and the `where` its rows must match",
        path: [],
      };
    const result = validateSchema(
      registry.getModelSchemas(schema[model!]!).core.where,
      this.spec[model!]
    );
    if (result.issues) {
      const [issue] = result.issues;
      return {
        message: issue!.message,
        path: [model!, ...(issue!.path ?? [])],
      };
    }
    return { nodes: [new Existence(model!, result.value as Input)] };
  }
}

/** A condition's tests, the filter vocabulary's own words (OD-12). */
const TESTS = ["exists", "equals", "in", "has", "hasSome"];

/** A test of an argument, or why it is refused. */
function testOf(given: unknown): ConditionTest | string {
  const test = isPlainRecord(given) ? given : { equals: given };
  const [kind, ...others] = Object.keys(test);
  const operand = test[kind!];
  return !TESTS.includes(kind!) ||
    others.length > 0 ||
    (kind === "exists" && typeof operand !== "boolean") ||
    ((kind === "in" || kind === "hasSome") && !Array.isArray(operand))
    ? `a test is a value or exactly one of ${TESTS.join(", ")}`
    : // Exactly one known test, its operand checked above.
      (Object.freeze({ ...test }) as ConditionTest);
}

/**
 * `when`, `unless` and `provided`: a test of an argument's value. `when`
 * applies `then` where the test holds and nothing elsewhere; `unless` the
 * reverse; `provided` holds only where the test holds (and `then`, if any).
 * A `when` or `unless` heading a filter list, on an argument of the
 * extension with closed values and a default, decides its layer's mode: it
 * is read per mode, not per call.
 */
export class ArgTestFilter extends PredicateWord {
  readonly kind: "when" | "unless" | "provided";
  readonly arg: ArgValue;
  readonly test: ArgTest;
  readonly then: unknown;
  constructor(
    kind: "when" | "unless" | "provided",
    tested: ArgValue,
    test: ArgTest,
    then: unknown
  ) {
    super();
    this.kind = kind;
    this.arg = tested;
    this.test = test;
    this.then = then;
  }
  override filter({ references }: Admitting): FilterWord {
    const test = testOf(this.test);
    if (typeof test === "string") return { message: test, path: [] };
    const { arg, kind, then } = this;
    references.add(arg.name);
    const condition = new Condition(new Parameter(arg.name, arg.path), test);
    if (kind === "provided")
      return then === undefined
        ? { nodes: [condition] }
        : { nodes: [condition], where: { AND: [condition, then] } };
    return {
      nodes: [condition],
      where: { OR: [kind === "when" ? { NOT: condition } : condition, then] },
    };
  }
  override place(layer: RuleLayer, draft: DefinitionDraft): void {
    // Once every part wrote, before what decides from the mode: the
    // argument is the extension's, declared by its `args` part wherever it
    // stands. The first such test decides, root lists before related ones.
    draft.finish.unshift(() => {
      if (layer.mode !== undefined) return;
      for (const item of [
        ...Object.values(layer.root),
        ...Object.values(layer.related),
      ].flat()) {
        if (
          !(item instanceof ArgTestFilter) ||
          item.kind === "provided" ||
          item.arg.path !== undefined
        )
          continue;
        const spec = draft.args?.[item.arg.name];
        if (
          spec === undefined ||
          !("oneOf" in spec) ||
          spec.default === undefined
        )
          continue;
        layer.mode = {
          name: item.arg.name,
          values: spec.oneOf.map(String),
          fallback: String(spec.default),
        };
        return;
      }
    });
  }
  override under(mode: LayerMode | undefined, value: string): unknown {
    const { arg, kind, test } = this;
    if (
      kind === "provided" ||
      arg.path !== undefined ||
      arg.name !== mode?.name
    )
      return this;
    const passed = isPlainRecord(test)
      ? "in" in test && Array.isArray(test.in)
        ? test.in.includes(value)
        : "equals" in test
          ? test.equals === value
          : "exists" in test && test.exists === true
      : test === value;
    return passed === (kind === "when") ? this.then : undefined;
  }
}

function argValueOf(word: unknown, role: string): ArgValue {
  if (word instanceof ArgValue) return word;
  throw new TypeError(`${role}() tests an argument written arg(name)`);
}

/**
 * The value the call passed for argument `name` (a field of it at `path`).
 * An absent value, `null` included, removes the filter that reads it, unless
 * the argument is required.
 */
export function arg<N extends string>(
  name: [N] extends [never] ? string : NoInfer<N>,
  path?: string
): [N] extends [never] ? HeldArg : string extends N ? HeldArg : ArgWord<N>;
export function arg(name: string, path?: string): unknown {
  return new ArgValue(name, path);
}

/**
 * A filter no row holds: what a rule writes for a write it never allows
 * (`update: { where: nothing }`).
 */
export const nothing: { readonly OR: readonly never[] } = Object.freeze({
  OR: Object.freeze([]),
});

/** The call's one instant: the same for every row it writes. */
export const now: NowWord = /* @__PURE__ */ nowValue();
function nowValue(): NowWord;
function nowValue(): unknown {
  return Object.freeze(new NowValue());
}

/** A column of the row `up` relation bodies above (0: the row itself). */
export function row(column: string, up?: number): RowWord;
export function row(column: string, up = 0): unknown {
  return new RowValue(column, up);
}

/** A row of `model` holds `where`, read under the other extensions' rules. */
export function exists(spec: Readonly<Record<string, object>>): ExistsWord;
export function exists(spec: Readonly<Record<string, object>>): unknown {
  return new ExistsFilter(spec);
}

/** `then` applies where the argument passes the test; elsewhere, nothing. */
export function when<N extends string, W>(
  tested: ArgWord<NoInfer<N>> | HeldArg,
  test: ArgTest,
  then: NoInfer<W>
): WhenWord<N, W>;
export function when(tested: unknown, test: ArgTest, then: unknown): unknown {
  return new ArgTestFilter("when", argValueOf(tested, "when"), test, then);
}

/** `then` applies where the argument fails the test; elsewhere, nothing. */
export function unless<N extends string, W>(
  tested: ArgWord<NoInfer<N>> | HeldArg,
  test: ArgTest,
  then: NoInfer<W>
): WhenWord<N, W>;
export function unless(tested: unknown, test: ArgTest, then: unknown): unknown {
  return new ArgTestFilter("unless", argValueOf(tested, "unless"), test, then);
}

/** Holds only where the argument passes the test, and `then` with it. */
export function provided<N extends string>(
  tested: ArgWord<NoInfer<N>> | HeldArg,
  test: ArgTest,
  then?: object
): ProvidedWord<N>;
export function provided(
  tested: unknown,
  test: ArgTest,
  then?: object
): unknown {
  return new ArgTestFilter(
    "provided",
    argValueOf(tested, "provided"),
    test,
    then
  );
}

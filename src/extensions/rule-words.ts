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
import type { CallReads, EntryDraft, References, RuleLayer } from "./admission";
import { CALL_READS } from "./call-values";
import type { ExtensionPart } from "./chain";
import type {
  ArgTest,
  ArgWord,
  ExistsWord,
  HeldArg,
  HeldOperand,
  IsHeld,
  NowWord,
  ProvidedWord,
  RowWord,
  WhenWord,
} from "./contract";
import { Choice } from "./layers";
import { NOW } from "./stamps";

/**
 * Where one carried word is written: its model, its place (`create.check`,
 * `read.fields.notes`, …) and the field that place names, with what it may
 * write: the model's other keys, its rule's layer, the parts it brings.
 */
export interface Site {
  readonly model: string;
  readonly key: string;
  readonly field?: string;
  readonly schema: Schema;
  /** The layer of the rule it is written in; none in `defaults`. */
  readonly layer?: RuleLayer;
  /** What runs `part` with the extension's parts where it is applied. */
  readonly bring: (part: ExtensionPart) => void;
  /** Inside an entry given as a function, read when its model is first read. */
  readonly lazy: boolean;
  /**
   * An eager entry's `read.where`: what a row a write returns holds for what
   * a read carries or hides of it to show (`gate`, `facts`).
   */
  readonly shows?: unknown;
  /** The model's keys beyond its filters, made at the first word that writes one. */
  entry(): EntryDraft;
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
 * goes). Each word carries its own, so a program holds the code of the words
 * it writes.
 */
export abstract class PredicateWord {
  /** What admission puts where the word stands as a value. */
  value?(at: Admitting): object;
  /** What admission puts where the word stands as a filter. */
  filter?(at: Admitting): FilterWord;
  /** What a field of default or kept data writes for the word. */
  stamp?(): unknown;
  /** A `when`, an `unless` or a `provided`: which, its argument, its test and what it applies. */
  declare readonly kind?: "when" | "unless" | "provided";
  declare readonly arg?: ArgValue;
  declare readonly test?: ArgTest;
  declare readonly then?: unknown;
}

/** What admission hands a word: what records its call values, and the schema. */
export interface Admitting {
  readonly references: References;
  readonly schema: Schema;
  readonly registry: SchemaRegistryLookup<Schema>;
  /** What reads the call: set by the words that read it. */
  reads?: CallReads;
}

/**
 * `arg(name, path?)`'s value: the call's value for one argument, or a field
 * of it; without a name, `now`'s: the call's one instant.
 */
export class ArgValue extends PredicateWord {
  readonly name: string | undefined;
  readonly path: string | undefined;
  constructor(name?: string, path?: string) {
    super();
    this.name = name;
    this.path = path;
  }
  override value(at: Admitting): Parameter {
    at.references.add(this.name);
    at.reads = CALL_READS;
    return this.stamp();
  }
  override stamp(): Parameter {
    return this.name === undefined ? NOW : new Parameter(this.name, this.path);
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
    // The model's where schema admitted the filter: an Input.
    return { nodes: [new Existence(model!, result.value as Input)] };
  }
}

/** A condition's tests, the filter vocabulary's own words (OD-12). */
const TESTS = ["exists", "equals", "in", "has", "hasSome"];

/** A test of an argument, or why it is refused. */
export function testOf(given: unknown): ConditionTest | string {
  const test = isPlainRecord(given) ? given : { equals: given };
  const [kind, ...others] = Object.keys(test);
  const operand = test[kind!];
  return !TESTS.includes(kind!) ||
    others.length > 0 ||
    (kind === "exists" && typeof operand !== "boolean") ||
    ((kind === "in" || kind === "hasSome") && !Array.isArray(operand))
    ? `a test is a value or exactly one of ${TESTS.join(", ")}`
    : // Exactly one known test, its operand checked above.
      ({ ...test } as ConditionTest);
}

/**
 * `when`, `unless` and `provided`: a test of an argument's value, folded per
 * call. `when` applies `then` where the test holds and nothing elsewhere;
 * `unless` the reverse; `provided` holds only where the test holds (and
 * `then`, if any).
 */
export class ArgTestFilter extends PredicateWord {
  readonly kind: "when" | "unless" | "provided";
  readonly arg: ArgValue;
  readonly test: ArgTest;
  readonly then: unknown;
  constructor(
    kind: "when" | "unless" | "provided",
    tested: unknown,
    test: ArgTest,
    then: unknown
  ) {
    super();
    if (!(tested instanceof ArgValue && tested.name !== undefined))
      throw new TypeError(`${kind}() tests an argument written arg(name)`);
    this.kind = kind;
    this.arg = tested;
    this.test = test;
    this.then = then;
  }
  override filter(at: Admitting): FilterWord {
    const test = testOf(this.test);
    if (typeof test === "string") return { message: test, path: [] };
    const { kind, then } = this;
    const condition = new (kind === "provided" ? Condition : Choice)(
      this.arg.value(at),
      test
    );
    if (kind === "provided")
      return then === undefined
        ? { nodes: [condition] }
        : { nodes: [condition], where: { AND: [condition, then] } };
    return {
      nodes: [condition],
      where: { OR: [kind === "when" ? { NOT: condition } : condition, then] },
    };
  }
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
export const nothing: { readonly OR: readonly never[] } =
  /* @__PURE__ */ Object.freeze({ OR: /* @__PURE__ */ Object.freeze([]) });

/** The call's one instant: the same for every row it writes. */
export const now: NowWord = /* @__PURE__ */ nowValue();
function nowValue(): NowWord;
function nowValue(): unknown {
  return new ArgValue();
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

/**
 * A `when` or `unless` written apart from a rule (a shared constant, a
 * per-model callback): nothing types its filter, so it fits any filter's
 * place, and the rule's model admits it where it is applied.
 */
type HeldWhen<N extends string, W> = IsHeld<W> extends true
  ? WhenWord<never, never>
  : WhenWord<N, W>;

/** `then` applies where the argument passes the test; elsewhere, nothing. */
export function when<N extends string, W>(
  tested: ArgWord<NoInfer<N>> | HeldArg,
  test: ArgTest,
  then: HeldOperand<W>
): HeldWhen<N, W>;
export function when(tested: unknown, test: ArgTest, then: unknown): unknown {
  return new ArgTestFilter("when", tested, test, then);
}

/** `then` applies where the argument fails the test; elsewhere, nothing. */
export function unless<N extends string, W>(
  tested: ArgWord<NoInfer<N>> | HeldArg,
  test: ArgTest,
  then: HeldOperand<W>
): HeldWhen<N, W>;
export function unless(tested: unknown, test: ArgTest, then: unknown): unknown {
  return new ArgTestFilter("unless", tested, test, then);
}

/** Holds only where the argument passes the test, and `then` with it. */
export function provided<N extends string>(
  tested: ArgWord<NoInfer<N>> | HeldArg,
  test: ArgTest,
  then?: object
): string extends N ? ProvidedWord<never> : ProvidedWord<N>;
export function provided(
  tested: unknown,
  test: ArgTest,
  then?: object
): unknown {
  return new ArgTestFilter("provided", tested, test, then);
}

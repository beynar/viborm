/**
 * The words a rule and a default write where a value or a filter goes:
 * `arg`, `now`, `row`, `exists`, `when`, `unless`, `provided`. Each is plain
 * data the rule's part reads where the extension is applied.
 */
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

/** `arg(name, path?)`'s value: the call's value for one argument, or a field of it. */
export class ArgValue {
  readonly name: string;
  readonly path: string | undefined;
  constructor(name: string, path: string | undefined) {
    this.name = name;
    this.path = path;
  }
}

/** `now`'s value: the call's one instant. */
export class NowValue {}

/** `row(column, up?)`'s value: a column of the row `up` relation bodies above. */
export class RowValue {
  readonly column: string;
  readonly up: number;
  constructor(column: string, up: number) {
    this.column = column;
    this.up = up;
  }
}

/** `exists({ model: where })`'s filter. */
export class ExistsFilter {
  readonly spec: Readonly<Record<string, object>>;
  constructor(spec: Readonly<Record<string, object>>) {
    this.spec = spec;
  }
}

/**
 * `when`, `unless` and `provided`: a test of an argument's value. `when`
 * applies `then` where the test holds and nothing elsewhere; `unless` the
 * reverse; `provided` holds only where the test holds (and `then`, if any).
 */
export class ArgTestFilter {
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
    this.kind = kind;
    this.arg = tested;
    this.test = test;
    this.then = then;
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

/**
 * A `when` or `unless` written apart from a rule (a shared constant, a
 * per-model callback): nothing types its filter, so it fits any filter's
 * place, and the rule's model admits it where it is applied.
 */
type HeldWhen<N extends string, W> = unknown extends W
  ? WhenWord<never, never>
  : WhenWord<N, W>;

/** `then` applies where the argument passes the test; elsewhere, nothing. */
export function when<N extends string, W>(
  tested: ArgWord<NoInfer<N>> | HeldArg,
  test: ArgTest,
  then: NoInfer<W>
): HeldWhen<N, W>;
export function when(tested: unknown, test: ArgTest, then: unknown): unknown {
  return new ArgTestFilter("when", argValueOf(tested, "when"), test, then);
}

/** `then` applies where the argument fails the test; elsewhere, nothing. */
export function unless<N extends string, W>(
  tested: ArgWord<NoInfer<N>> | HeldArg,
  test: ArgTest,
  then: NoInfer<W>
): HeldWhen<N, W>;
export function unless(tested: unknown, test: ArgTest, then: unknown): unknown {
  return new ArgTestFilter("unless", argValueOf(tested, "unless"), test, then);
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
  return new ArgTestFilter(
    "provided",
    argValueOf(tested, "provided"),
    test,
    then
  );
}

// biome-ignore-all lint/suspicious/noBitwiseOperators: the name hash (cyrb53) is defined on 32-bit integer operations.
/**
 * Which statements a PostgreSQL driver sends as named, server-side prepared
 * statements, and under which name.
 *
 * A named statement is parsed and planned once per connection, then only
 * bound: the server skips the parse and the plan a short query mostly pays
 * for. Each connection keeps every statement it was asked to name until it
 * closes (node-postgres and postgres.js evict none), and VibORM writes one SQL
 * text per query shape, so the names are bounded here: a text is named the
 * second time it is sent, while fewer than `max` texts have a name. A text seen
 * once (a one-off shape, a `createMany` of an unusual row count) never takes a
 * place, and a connection holds at most `max` statements of this driver.
 *
 * The name is derived from the text, so two clients sharing one pool give the
 * same text the same name.
 */

import { ClientInitializationError } from "@errors";

/**
 * Statements a driver names, by default. Measured on PostgreSQL 18, a named
 * statement holds 11 kB (a `findUnique`) to 42 kB (a `findMany` with a
 * relation as JSON) of server memory per connection: 100 is at most about
 * 4 MB a connection, and under PgBouncer's default `max_prepared_statements`
 * (200).
 */
export const NAMED_STATEMENTS_MAX = 100;
/** Texts remembered as seen once; past it, counting starts over. */
const SEEN_MAX = 256;

/** The public option: `true`, or the most statements one connection holds. */
export type NamedStatementsOption = boolean | { readonly max: number };

/** A 53-bit hash of the text (cyrb53), in base 36: about eleven characters. */
const hash = (text: string): string => {
  let h1 = 0xde_ad_be_ef;
  let h2 = 0x41_c6_ce_57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2_654_435_761);
    h2 = Math.imul(h2 ^ code, 1_597_334_677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
  return (4_294_967_296 * (2_097_151 & h2) + (h1 >>> 0)).toString(36);
};

export class NamedStatements {
  readonly #max: number;
  /** Each named text's name. */
  readonly #names = new Map<string, string>();
  #seen = new Set<string>();
  /** Texts never named again (`drop`): at most `max`, as each had a name. */
  readonly #dropped = new Set<string>();
  /** Names given, retired ones included: what a connection may hold. */
  #given = 0;

  constructor(option: Exclude<NamedStatementsOption, false>) {
    this.#max = option === true ? NAMED_STATEMENTS_MAX : option.max;
  }

  /** The name to send this text under, or `undefined` to send it unnamed. */
  name(text: string): string | undefined {
    const named = this.#names.get(text);
    if (named !== undefined || this.#given >= this.#max) return named;
    if (this.#dropped.has(text)) return;
    if (this.#seen.delete(text)) return this.#give(text, "");
    if (this.#seen.size >= SEEN_MAX) this.#seen = new Set();
    this.#seen.add(text);
    return;
  }

  /**
   * The server no longer answers this text's name (a `DEALLOCATE`, a
   * `DISCARD ALL`, a pooler that moved the session) or its plan no longer
   * fits the table: the text takes a new name, which every connection parses
   * again, or none once `max` names were given. A retired name still counts:
   * the connections that did not lose it keep it, so at the bound the text is
   * sent unnamed for the client's life.
   */
  retire(text: string): void {
    if (this.#names.delete(text) && this.#given < this.#max)
      this.#give(text, `_${this.#given}`);
  }

  /**
   * A driver whose client keys prepared statements by text (postgres.js)
   * cannot name a stale text anew: the same text meets the same stale entry.
   * The text is sent unprepared for the driver's life.
   */
  drop(text: string): void {
    if (this.#names.delete(text)) this.#dropped.add(text);
  }

  /** A 53-bit hash leaves two texts one name with a chance far below one in a billion. */
  #give(text: string, suffix: string): string {
    const name = `v${hash(text)}${suffix}`;
    this.#given++;
    this.#names.set(text, name);
    return name;
  }
}

/** The routine of a parameter whose type was replaced: postgres.js does not retry it. */
export const REPLACED_TYPE = "getTypeInputInfo";

/**
 * The server routines that say a name is stale rather than the statement
 * wrong, each raised before the statement does anything: the server no longer
 * has the name (`DEALLOCATE`, `DISCARD ALL`, a pooler that moved the session),
 * the plan's result type changed under it, or a parameter's type was replaced
 * (a migration that replaces an enum: the name keeps the old type's oid).
 */
const STALE_ROUTINES = new Set([
  "FetchPreparedStatement",
  "RevalidateCachedQuery",
  REPLACED_TYPE,
]);

/** Whether a statement's failure says its name is stale, not that the statement is wrong. */
export const isStaleStatement = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  STALE_ROUTINES.has((error as { routine?: unknown }).routine as string);

/** The driver's registry for the option, or none when it is absent or `false`. */
export const namedStatements = (
  driver: string,
  option: NamedStatementsOption | undefined
): NamedStatements | undefined => {
  if (!option) return;
  if (option !== true && !(Number.isInteger(option.max) && option.max > 0)) {
    throw new ClientInitializationError(
      `Driver "${driver}": namedStatements.max must be a positive integer.`,
      { meta: { driver, operation: "configuration" } }
    );
  }
  return new NamedStatements(option);
};

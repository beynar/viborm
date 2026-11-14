/**
 * `codec(run)`: what stores the core's answer to one prepared read, and
 * restores it. What it stores is what the driver returned for the read's one
 * statement, its rows, as JSON data; what it restores is the answer the
 * engine's own decoder makes of those rows, exactly as if the driver had just
 * returned them. So a restored answer is a fresh graph, its values pass the
 * checks a driver's values pass, and nothing here knows the answer's shape.
 *
 * A row holds what a driver returns: JSON values, and the few values JSON
 * cannot carry (a bigint, a `Date`, bytes, a non-finite number or `-0`).
 * Those are written as a tagged array, and every array is tagged, so no
 * document a JSON column holds can spell one. A value of any other kind
 * cannot be stored: the read simply runs.
 */
import { UnsupportedOperationError } from "@errors";
import type { Run } from "./contract";
import { callOf } from "./origin";

/** What stores one prepared read's answer, and restores it. */
export interface Codec<R = unknown> {
  /** `run()`, keeping the rows the driver returns for the read's statement. */
  run(): Promise<R>;
  /**
   * The rows the last `run()` kept, as detached JSON data. A `TypeError`
   * where it kept none (the answer came from elsewhere) or a row holds a
   * value this form cannot carry.
   */
  snapshot(): unknown;
  /**
   * The answer stored rows decode to, a fresh graph on every call. Throws
   * where `stored` is not such rows or the engine refuses to decode them.
   */
  materialize(stored: unknown): R;
}

/**
 * The codec of the read `run` prepares. A call that is not a model's read (a
 * raw statement, a write) has none, and is refused.
 */
export function codec<R>(run: Run<unknown, R>): Codec<R> {
  const of = callOf(run)?.of;
  const prepared = of?.prepared();
  if (prepared?.read === undefined)
    throw new UnsupportedOperationError(
      "codec() takes the run of a model's read."
    );
  let kept: readonly unknown[] | undefined;
  const keep = (rows: readonly unknown[]): void => {
    kept = rows;
  };
  return {
    run() {
      kept = undefined;
      prepared.seen = keep;
      return run();
    },
    snapshot() {
      if (kept === undefined)
        throw new TypeError("The answer came from no rows of its statement.");
      return kept.map((row) => record(new Object(row), stored));
    },
    materialize(entry) {
      if (!Array.isArray(entry)) refuse();
      const rows = entry.map((row) =>
        typeof row === "object" && row !== null && isDocument(row)
          ? record(row, restore)
          : refuse()
      );
      // The read's own parser, the decoder a driver's answer goes through,
      // answers what `run` resolves to: its type is the run's.
      return prepared
        .prepareSingle(of?.context)!
        .parseResult([{ rows, rowCount: rows.length }]) as R;
    },
  };
}

function refuse(): never {
  throw new TypeError("The stored rows are malformed.");
}

/** A document, not a class instance: what a driver's JSON is. */
const isDocument = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * A row or a document, each value through `each`. `fromEntries` defines its
 * keys, so a `__proto__` key stays data; an absent value is left out, as
 * JSON leaves it.
 */
const record = (value: object, each: (member: unknown) => unknown) =>
  Object.fromEntries(
    Object.keys(value).flatMap((name) => {
      const member: unknown = Reflect.get(value, name);
      return member === undefined ? [] : [[name, each(member)]];
    })
  );

/** One driver value as JSON data. */
function stored(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) && !Object.is(value, -0)
      ? value
      : ["f", Object.is(value, -0) ? "-0" : String(value)];
  if (typeof value === "bigint") return ["n", String(value)];
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      // `includes` reads a hole as `undefined`: neither has a JSON form.
      if (!value.includes(undefined)) return ["a", ...value.map(stored)];
    } else if (value instanceof Date) return ["d", value.getTime()];
    else if (value instanceof Uint8Array) return ["b", base64(value)];
    else if (value instanceof ArrayBuffer)
      return ["B", base64(new Uint8Array(value))];
    else if (isDocument(value)) return record(value, stored);
  }
  throw new TypeError("A row holds a value the cache cannot store.");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  // biome-ignore lint/style/useForOf: indexed reads take any byte view as it is.
  for (let index = 0; index < bytes.length; index++)
    binary += String.fromCharCode(bytes[index]!);
  return btoa(binary);
}

function bytes(text: unknown): Uint8Array {
  if (typeof text !== "string") refuse();
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** The driver value `stored` wrote; anything it never writes is refused. */
function restore(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    Number.isFinite(value)
  )
    return value;
  if (typeof value !== "object") refuse();
  if (isDocument(value)) return record(value, restore);
  if (!Array.isArray(value)) refuse();
  const [tag, body] = value;
  // `from` reads a hole as `undefined`, which is refused.
  if (tag === "a") return Array.from(value.slice(1), restore);
  if (value.length === 2) {
    if (tag === "d" && (body === null || typeof body === "number"))
      return new Date(body ?? Number.NaN);
    if (tag === "b") return bytes(body);
    if (tag === "B") return bytes(body).buffer;
    if (tag === "f" && NUMBERS.includes(body)) return Number(body);
    if (
      tag === "n" &&
      typeof body === "string" &&
      String(BigInt(body)) === body
    )
      return BigInt(body);
  }
  refuse();
}

const NUMBERS: readonly unknown[] = ["NaN", "Infinity", "-Infinity", "-0"];

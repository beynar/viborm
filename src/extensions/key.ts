/**
 * `key(run)`: the canonical key of a prepared call. Two calls have the same
 * key if and only if they would send the same statement for the same
 * validated arguments: it serializes the model, the operation asked for, the
 * validated arguments and the statement the engine will send (text and
 * parameters). Reading it prepares the call; `run()` then sends exactly that
 * preparation, so a value its caller changes later changes neither.
 *
 * A rule enters the key through the statement it produces, an extension's
 * argument through the rule that reads it: no part exposes a share of it.
 */
import { CacheInvalidKeyError } from "@errors";
import { fieldRefPayload, isFieldRef } from "@schema/field-ref";
import { isJsonNullSentinel } from "@schema/json-null";
import { isSql } from "@sql";
import { JsonParameter } from "../sql/json-parameter";
import { base64 } from "./codec";
import type { Run } from "./contract";
import { callOf } from "./origin";

/**
 * The key of the call `run` prepares, or `undefined` when it has none: a raw
 * statement, a chain with a unit that rewrites statements, a call holding a
 * value of a `.volatile()` argument, or an operation that is not one
 * statement.
 */
export function key(run: Run<unknown, unknown>): string | undefined {
  const call = callOf(run);
  const of = call?.of;
  if (of === undefined) return undefined;
  const chain = of.engine.extensionChain;
  if (chain?.rewrites !== undefined) return undefined;
  const admitted = call?.values;
  if (
    admitted !== undefined &&
    chain?.args?.all.some(
      (argument) =>
        argument.volatile === true && admitted[argument.name] !== undefined
    )
  )
    return undefined;
  const { requested, args, read } = of.prepared();
  if (read === undefined) return undefined;
  return stableStringify([
    requested.model,
    requested.operation,
    args,
    read.statement,
  ]);
}

/**
 * The two bytes that open and close a NON-JSON value's serialization: U+001F
 * (unit separator) and U+001E (record separator).
 *
 * They are what makes the token below UNFORGEABLE, and the reason is
 * mechanical: every string this serializer emits — operand values AND object
 * keys — goes through `JSON.stringify`, and JSON escapes every code point below
 * U+0020 into a printable six-character escape. A raw separator byte can
 * therefore never appear in the output by any route except the one deliberately
 * taken here, so a user document may spell the LETTERS of a token but never the
 * token. (Verified across the whole C0/C1 range, and for lone surrogates, by
 * the "no JSON value can forge a brand token" test.)
 */
const BRAND_OPEN = "\u001F";
const BRAND_CLOSE = "\u001E";

/**
 * Serialize a value that is not a JSON value — one of the branded operand
 * tokens, or a scalar JSON cannot carry — into the reserved namespace.
 *
 * `namespace` names the KIND and `body` distinguishes two values of that kind;
 * the delimiters are balanced, so a token nested inside another token's body
 * (an `Sql` whose bound values hold a `Date`) stays unambiguous.
 */
function brandToken(namespace: string, body: string): string {
  return `${BRAND_OPEN}viborm.${namespace}:${body}${BRAND_CLOSE}`;
}

/**
 * Stable JSON stringify that handles:
 * - Sorted object keys (deterministic)
 * - Date objects (ISO string)
 * - BigInt
 * - Uint8Array (base64)
 * - SQL fragments (statement text + bound values)
 * - Field references (the model and field they name)
 * - JSON null sentinels (`DbNull` / `JsonNull` / `AnyNull`)
 * - undefined values (omitted)
 * - Circular references (throws)
 *
 * It is only ever handed a VALIDATED payload and the statement prepared from
 * it (see {@link key}), so the non-JSON values it can meet are the ones
 * validation deliberately admits (a field reference, an SQL fragment, a JSON
 * null sentinel) and the parameters a statement binds (a JSON parameter, a
 * date, bytes, a bigint).
 *
 * EVERY ONE OF THEM KEYS IN THE RESERVED NAMESPACE, because a user document is
 * allowed to look exactly like any of them. A JSON column takes an arbitrary
 * object, so `{ kind: "DbNull" }` is ordinary user data — and while the sentinel
 * carries `kind` as an own enumerable key precisely so a structural serializer
 * could tell the three apart, that only moved the collision one shape over:
 * walking `Object.keys` made `equals: DbNull` and `equals: { kind: "DbNull" }`
 * the same cache entry, and a cached client served one query's rows for the
 * other, in both directions, for the whole TTL.
 *
 * The sentinel is the one that collided in production spelling — a JSON filter
 * operand admits both a sentinel and an arbitrary document. The other two
 * cannot meet their look-alike at one position TODAY, and only because
 * validation holds those doors shut (`v.noFieldRef` refuses a reference
 * wherever arbitrary data is legal; `v.json` refuses a real `Sql` as
 * non-JSON-compatible) — while the fragment's look-alike still reached the
 * fragment branch and crashed there, see the note on it below. A key builder
 * that is correct only because a schema elsewhere is holding a door is one
 * refactor from being wrong again, so the rule here is structural instead:
 * what is not a JSON value does not serialize like one.
 */
export function stableStringify(
  value: unknown,
  seen = new WeakSet<object>()
): string {
  if (value === null) return "null";
  if (value === undefined) return "";

  const type = typeof value;

  if (type === "boolean" || type === "number") return String(value);
  if (type === "string") return JSON.stringify(value);
  if (type === "bigint") return brandToken("bigint", String(value));
  // Functions and symbols are not cacheable.
  if (type !== "object")
    throw new CacheInvalidKeyError(`Uncacheable value type: ${type}`);

  // A fragment is identified by what it will EMIT, not by its instance fields:
  // an `Sql` memoizes its flattened text on first read, so enumerating its own
  // properties would key the same fragment differently depending on whether
  // anything had compiled it yet.
  //
  // THE METHOD IS PART OF THE TEST because `isSql` is a duck-type probe
  // (`strings` and `values`, both arrays), and a JSON column may legally hold
  // `{ strings: [], values: [] }` — validation says so in as many words
  // (`v.noFieldRef`: such a document "is honest user data and must stay
  // accepted"). That document reached here as a fragment and threw a bare
  // `TypeError: value.toStatement is not a function` out of cache key
  // generation. A real fragment carries the method that flattens it and a
  // document cannot, because `v.json` refuses a function; so the look-alike
  // falls through to the object branch below and keys as the data it is.
  if (isSql(value) && typeof value.toStatement === "function") {
    return brandToken(
      "sql",
      `${JSON.stringify(value.toStatement("?"))}:${stableStringify(value.values, seen)}`
    );
  }

  // A reference names a COLUMN: the model and field are its identity, and its
  // `type`/`list` are derived from them by `createModelFieldRefs`.
  if (isFieldRef(value)) {
    const payload = fieldRefPayload(value);
    return brandToken(
      "field-ref",
      `${JSON.stringify(payload.model)}:${JSON.stringify(payload.field)}`
    );
  }

  if (isJsonNullSentinel(value)) {
    return brandToken("json-null", value.kind);
  }

  // A JSON parameter binds its canonical text: a plain object that spells
  // the same fields is a different value.
  if (value instanceof JsonParameter) {
    return brandToken("json", JSON.stringify(value.json));
  }

  if (value instanceof Date) {
    return brandToken("date", value.toISOString());
  }

  if (value instanceof Uint8Array) return brandToken("bytes", base64(value));

  // `seen` holds the objects on the current PATH only: one object reached
  // twice through different keys (`{ a: ids, b: ids }`) is data, not a cycle.
  if (seen.has(value as object))
    throw new CacheInvalidKeyError("Circular reference in cache key args");
  seen.add(value as object);
  let serialized: string;
  if (Array.isArray(value)) {
    serialized = `[${value.map((v) => stableStringify(v, seen)).join(",")}]`;
  } else {
    // Neither null nor an array: an object, whose own keys are read.
    const obj = value as Record<string, unknown>;
    const pairs = Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], seen)}`);
    serialized = `{${pairs.join(",")}}`;
  }
  seen.delete(value as object);
  return serialized;
}

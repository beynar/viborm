// The default codec: the one conversion between a declaration's default value
// and the JSON that states it, in both directions.
//
// A default is the only place a document holds a value from a domain the FIELD
// chose rather than the format. `.default(...)` takes the scalar's own input
// domain, and three members of those domains have no JSON spelling — `bigint`,
// `Date`, `Uint8Array` — while a `json` field's domain is an arbitrarily deep
// structure that may contain them at any position.
//
// Hence one RECURSIVE codec rather than a table of top-level envelopes, and
// four properties it owns end to end:
//
//  - TAGGED, not positional. `{"$date": "..."}` is a `Date`; a bare ISO string
//    is a string. The distinction is observable — DDL emits a string default as
//    a SQL `DEFAULT` clause and leaves a `Date` to the application — so a codec
//    that inferred the type from the FIELD would round-trip one declaration
//    into a different table.
//  - DETACHED. Both directions build new structures. A document is a value the
//    caller owns and edits; declaration state is not.
//  - `__proto__`-SAFE. Every record is constructed key by key, because
//    `record["__proto__"] = value` sets a prototype and creates no own key —
//    losing the entry silently, which is the one failure mode a walk cannot
//    report afterwards.
//  - TOTAL. A cycle is a refusal with a pointer, never a `RangeError`; a value
//    the document cannot state is named, never dropped.
//
// The `$`-prefixed one-key object is a RESERVED namespace: an unknown one is
// refused rather than read as a literal, so a later version can add a tag
// without changing what an existing document means. `$raw` is how a literal
// whose own shape collides with a tag says which it is.

import { emptyRecord, put } from "@schema/record";
import type { JsonValue } from "@validation/primitives/json";
import { isDate, isFunction, isUint8Array } from "@validation/value-guards";
import {
  addIssue,
  type DocumentIssues,
  guardedValue,
  inspectKeys,
  inspectPlainRecord,
  member,
  pointer,
  refuseDocument,
} from "./issues";

const BIGINT_TAG = "$bigint";
const DATE_TAG = "$date";
const BYTES_TAG = "$bytes";
const RAW_TAG = "$raw";

/** The reserved namespace this format defines; anything else `$`-prefixed is refused. */
const KNOWN_TAGS = new Set([BIGINT_TAG, DATE_TAG, BYTES_TAG, RAW_TAG]);

const RESERVED_PREFIX = "$";
const DECIMAL_INTEGER = /^-?\d+$/;

const TAGS = `'${BIGINT_TAG}' (a decimal integer string), '${DATE_TAG}' (an ISO timestamp), '${BYTES_TAG}' (base64), '${RAW_TAG}' (the literal it wraps)`;

/**
 * The tag a record spells, if it spells one.
 *
 * Exactly one own key, beginning with `$`. Two keys is an ordinary object that
 * merely mentions a tag name, and is left alone in both directions.
 */
function reservedKey(keys: readonly string[]): string | undefined {
  const only = keys.length === 1 ? keys[0] : undefined;
  return only?.startsWith(RESERVED_PREFIX) === true ? only : undefined;
}

// =============================================================================
// READING A DOCUMENT'S DEFAULT
// =============================================================================

/**
 * A JSON value, read out of caller-controlled input.
 *
 * A caller-built object may hold a function, a symbol, a `bigint` or a `Date`
 * where JSON text cannot; refusing them here is what keeps a document and its
 * serialization the same artifact. What comes back is a fresh structure — the
 * caller keeps no reference into the schema that is about to be built.
 */
export function readDefaultValue(
  value: unknown,
  path: string,
  issues: DocumentIssues
): JsonValue | undefined {
  return readValue(value, path, issues, new Set());
}

function readValue(
  value: unknown,
  path: string,
  issues: DocumentIssues,
  seen: Set<object>
): JsonValue | undefined {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    addIssue(issues, path, "J004", "A default must be a finite number");
    return;
  }
  if (Array.isArray(value)) return readArray(value, path, issues, seen);
  if (inspectPlainRecord(value, path, issues, "J004")) {
    return readRecord(value, path, issues, seen);
  }
  addIssue(
    issues,
    path,
    "J004",
    isFunction(value)
      ? "A function default has no document spelling — use `generate`, a literal, or a database default through `native`"
      : `A default must be a JSON value; a value outside JSON takes a tag — ${TAGS}`
  );
  return;
}

function readArray(
  value: readonly unknown[],
  path: string,
  issues: DocumentIssues,
  seen: Set<object>
): JsonValue[] | undefined {
  if (enterCycle(value, path, issues, seen, "J004")) return;
  const items: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entryPath = pointer(path, String(index));
    const item = readValue(
      member(value, String(index), path, issues),
      entryPath,
      issues,
      seen
    );
    if (item === undefined) return;
    items.push(item);
  }
  seen.delete(value);
  return items;
}

function readRecord(
  value: Record<string, unknown>,
  path: string,
  issues: DocumentIssues,
  seen: Set<object>
): Record<string, JsonValue> | undefined {
  if (enterCycle(value, path, issues, seen, "J004")) return;
  const keys = inspectKeys(value, path, issues, "J004");
  const tag = reservedKey(keys);
  if (tag !== undefined && !KNOWN_TAGS.has(tag)) {
    // An unknown `$`-tag is a DOCUMENT-shape fact, caught HERE during the
    // accumulating walk — so two bad tags in two fields both surface — rather
    // than at decode time, which is fail-fast. Payload well-formedness for a
    // KNOWN tag stays the decoder's, where a single default is being built.
    addIssue(
      issues,
      path,
      "J008",
      `'${tag}' is not a tag this format defines. The tags are ${TAGS}`
    );
    return;
  }
  const record = emptyRecord<JsonValue>();
  for (const key of keys) {
    const entry = readValue(
      member(value, key, path, issues),
      pointer(path, key),
      issues,
      seen
    );
    if (entry === undefined) return;
    put(record, key, entry);
  }
  seen.delete(value);
  return record;
}

/**
 * Whether this value is already on the path being walked.
 *
 * A default is the one node whose depth the format does not bound, so it is the
 * one walk a caller-built object can make non-terminating. Membership is
 * released on the way back up: the same object twice in different branches is a
 * shared subtree, which copies fine.
 */
function enterCycle(
  value: object,
  path: string,
  issues: DocumentIssues,
  seen: Set<object>,
  code: "J004" | "J009"
): boolean {
  if (!seen.has(value)) {
    seen.add(value);
    return false;
  }
  addIssue(
    issues,
    path,
    code,
    "This default contains a cycle; a document holds a finite value"
  );
  return true;
}

// =============================================================================
// DOCUMENT → DECLARATION
// =============================================================================

/**
 * The value a document's `default` denotes.
 *
 * Every tag is decoded here and nowhere else, and the result is a fresh
 * structure. What comes back still has to satisfy the field's own base schema —
 * that check has one owner in the interpreter, and this codec never duplicates
 * it: `{"$date": ...}` on a `json` field decodes to a real `Date` and is
 * refused there, by the domain that says so.
 */
export function decodeDefault(value: JsonValue, path: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      decodeDefault(entry, pointer(path, String(index)))
    );
  }
  if (value === null || typeof value !== "object") return value;
  const tag = reservedKey(Object.keys(value));
  if (tag === undefined) return decodeBody(value, path);
  const payload = value[tag];
  // `readDefaultValue` already refused every reserved-key envelope whose tag is
  // not one of these four, during the accumulating walk — so an unknown tag
  // never reaches decoding and this dispatch is total, `$bytes` being the last.
  // One guard per invariant: the unknown-tag refusal lives in the reader alone.
  if (tag === RAW_TAG) return decodeRaw(payload, path);
  if (tag === BIGINT_TAG) return decodeBigInt(payload, path);
  if (tag === DATE_TAG) return decodeDate(payload, path);
  return decodeBytes(payload, path);
}

/** Each value decoded; the record's OWN tag shape deliberately not read. */
function decodeBody(
  value: Record<string, JsonValue>,
  path: string
): Record<string, unknown> {
  const record = emptyRecord<unknown>();
  for (const key of Object.keys(value)) {
    put(record, key, decodeDefault(value[key] ?? null, pointer(path, key)));
  }
  return record;
}

/**
 * The escape. `$raw` suppresses tag reading at ITS OWN level only, which is the
 * one level the encoder had to escape; everything inside is an ordinary value.
 */
function decodeRaw(payload: JsonValue | undefined, path: string): unknown {
  if (payload === null || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return decodeDefault(payload, path);
  return decodeBody(payload, path);
}

function decodeBigInt(payload: JsonValue | undefined, path: string): bigint {
  if (typeof payload === "string" && DECIMAL_INTEGER.test(payload)) {
    return BigInt(payload);
  }
  throw refuseTag(path, `'${BIGINT_TAG}' takes a decimal integer string`);
}

function decodeDate(payload: JsonValue | undefined, path: string): Date {
  if (typeof payload === "string") {
    const date = new Date(payload);
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw refuseTag(path, `'${DATE_TAG}' takes a string naming an instant`);
}

function decodeBytes(payload: JsonValue | undefined, path: string): Uint8Array {
  if (typeof payload === "string") {
    try {
      return decodeBase64(payload);
    } catch {
      // Fall through to the one refusal below.
    }
  }
  throw refuseTag(path, `'${BYTES_TAG}' takes a base64 string`);
}

function refuseTag(path: string, reason: string): Error {
  const issues: DocumentIssues = [];
  addIssue(issues, path, "J008", `${reason}. The tags are ${TAGS}`);
  return refuseDocument(issues);
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// =============================================================================
// DECLARATION → DOCUMENT
// =============================================================================

/**
 * The JSON a declaration's default value denotes.
 *
 * Every value outside JSON is tagged, every structure is copied, and anything
 * the document cannot state is named with its own pointer rather than dropped —
 * a dropped default parses back into a field that has none.
 */
export function encodeDefault(
  value: unknown,
  path: string,
  issues: DocumentIssues
): JsonValue | undefined {
  return encodeValue(value, path, issues, new Set());
}

function encodeValue(
  value: unknown,
  path: string,
  issues: DocumentIssues,
  seen: Set<object>
): JsonValue | undefined {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    return refuseValue(
      issues,
      path,
      "A non-finite number has no JSON spelling; `JSON.stringify` would write it as `null`"
    );
  }
  if (typeof value === "bigint") return tagged(BIGINT_TAG, value.toString(10));
  if (isUint8Array(value)) {
    try {
      return tagged(BYTES_TAG, encodeBase64(value));
    } catch {
      return refuseValue(
        issues,
        path,
        "This byte string has a detached buffer and cannot be serialized"
      );
    }
  }
  if (isDate(value)) {
    if (Number.isNaN(Date.prototype.getTime.call(value))) {
      return refuseValue(issues, path, "An invalid Date names no instant");
    }
    return tagged(DATE_TAG, Date.prototype.toISOString.call(value));
  }
  if (Array.isArray(value)) return encodeArray(value, path, issues, seen);
  if (inspectPlainRecord(value, path, issues, "J009")) {
    return encodeRecord(value, path, issues, seen);
  }
  return refuseValue(
    issues,
    path,
    "This default holds a value the document cannot state — a JSON value, a bigint, a Date or a byte string is what a default may be"
  );
}

function tagged(tag: string, payload: string): Record<string, JsonValue> {
  const record = emptyRecord<JsonValue>();
  put(record, tag, payload);
  return record;
}

function encodeArray(
  value: readonly unknown[],
  path: string,
  issues: DocumentIssues,
  seen: Set<object>
): JsonValue[] | undefined {
  if (enterCycle(value, path, issues, seen, "J009")) return;
  const items: JsonValue[] = [];
  // An array INDEX is an ordinary property, so a coded default's element is read
  // through the same guarded accessor an inbound one is — a throwing index
  // accessor becomes the serializer's refusal, never a raw escape.
  for (let index = 0; index < value.length; index += 1) {
    const at = String(index);
    const item = encodeValue(
      guardedValue(value, at, path, issues, "J009"),
      pointer(path, at),
      issues,
      seen
    );
    if (item === undefined) return;
    items.push(item);
  }
  seen.delete(value);
  return items;
}

/**
 * A record, then the escape decision.
 *
 * The encoded record is what a reader will see, so it is the encoded shape that
 * decides: one own key beginning with `$` would be read back as a tag, and
 * `$raw` says it is not one.
 */
function encodeRecord(
  value: Record<string, unknown>,
  path: string,
  issues: DocumentIssues,
  seen: Set<object>
): Record<string, JsonValue> | undefined {
  if (enterCycle(value, path, issues, seen, "J009")) return;
  const record = emptyRecord<JsonValue>();
  // A coded default's own keys and values are read through the same guarded
  // owner an inbound record is: a hostile `ownKeys` trap or a throwing accessor
  // becomes the serializer's refusal rather than escaping `serializeSchema`.
  for (const key of inspectKeys(value, path, issues, "J009")) {
    const entry = encodeValue(
      guardedValue(value, key, path, issues, "J009"),
      pointer(path, key),
      issues,
      seen
    );
    if (entry === undefined) return;
    put(record, key, entry);
  }
  seen.delete(value);
  if (reservedKey(Object.keys(record)) === undefined) return record;
  const escaped = emptyRecord<JsonValue>();
  put(escaped, RAW_TAG, record);
  return escaped;
}

function refuseValue(
  issues: DocumentIssues,
  path: string,
  reason: string
): undefined {
  addIssue(issues, path, "J009", reason);
  return;
}

function encodeBase64(bytes: Uint8Array): string {
  // One character at a time: spreading a large byte array into
  // `String.fromCharCode` overflows the stack.
  let binary = "";
  const values = Uint8Array.prototype.values.call(bytes);
  for (const byte of values) binary += String.fromCharCode(byte);
  return btoa(binary);
}

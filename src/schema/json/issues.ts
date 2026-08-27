// The document refusal vocabulary: the `J0xx` code family, JSON-pointer paths,
// the one aggregate throw, and the one guarded read that turns caller code into
// a member of that vocabulary.
//
// A document failure is never confused with a topology failure: the schema
// resolver's `M0xx`/`R0xx`/`P0xx` codes describe a graph, these describe the
// artifact the author wrote. Paths are JSON pointers INTO THE DOCUMENT for the
// same reason.

import { ValidationError, type ValidationIssue } from "@errors";
import { declaredKeys, isPlainRecord } from "@schema/relation/terminal";

/**
 * Why a document was refused.
 *
 * - `J001` the input is not a JSON document at all
 * - `J002` the `version` is not one this parser reads
 * - `J003` a node carries a key the format does not define
 * - `J004` a node is missing a required key, or a value has the wrong shape
 * - `J005` a key that must be a schema identifier is not one
 * - `J006` a reference names something the document does not declare
 * - `J007` the scalar type has no such modifier
 * - `J008` a default is outside the field's own domain
 * - `J009` the document spells a surface v1 refuses
 * - `J010` a builder refused the declaration this node denotes
 * - `J011` a native type is not in the declared dialect's catalog
 */
export type DocumentIssueCode =
  | "J001"
  | "J002"
  | "J003"
  | "J004"
  | "J005"
  | "J006"
  | "J007"
  | "J008"
  | "J009"
  | "J010"
  | "J011";

/** The document root pointer, and the source path every refusal carries. */
const DOCUMENT_ROOT = "";

const POINTER_TILDE = /~/g;
const POINTER_SLASH = /\//g;

/** One document location, spelled as an RFC 6901 JSON pointer. */
export function pointer(parent: string, ...keys: readonly string[]): string {
  let path = parent;
  for (const key of keys) {
    path += `/${key.replace(POINTER_TILDE, "~0").replace(POINTER_SLASH, "~1")}`;
  }
  return path;
}

export const documentRoot = DOCUMENT_ROOT;

/**
 * The accumulator every reader threads.
 *
 * `v.object` is strict but fail-fast — one issue per validate — so a document
 * walk that wants to tell an author everything wrong with their artifact at
 * once collects its own list, exactly as the schema validator and the relation
 * resolver do.
 */
export type DocumentIssues = ValidationIssue[];

export function addIssue(
  issues: DocumentIssues,
  path: string,
  code: DocumentIssueCode,
  message: string
): void {
  issues.push({ path, message: `[${code}] ${message}` });
}

/**
 * The one aggregate refusal. `V4002` with a `schema-builder` source names this
 * boundary in the message; the issue list carries every pointer.
 */
export function refuseDocument(
  issues: DocumentIssues,
  cause?: Error
): ValidationError {
  return new ValidationError(
    { kind: "schema-builder", builder: "schema-json", path: DOCUMENT_ROOT },
    issues,
    cause === undefined ? undefined : { cause }
  );
}

/** Throw the accumulated issues, if the walk found any. */
export function throwIfRefused(issues: DocumentIssues): void {
  if (issues.length > 0) {
    throw refuseDocument(issues);
  }
}

/**
 * Read one property of a caller-supplied object exactly once.
 *
 * Every value this module reads from outside — a document node, an array
 * element by index, a default, the options bag — is reached through here, and
 * for one reason: `parseSchema` and `serializeSchema` accept objects the caller
 * built, so a property read is EXECUTABLE input. A throwing accessor becomes
 * this boundary's own issue instead of escaping as the caller's value, and what
 * it threw survives as the refusal's cause.
 *
 * It also ENDS the walk. A document that runs code while being read is not one
 * to keep collecting shape issues from, so everything found so far is carried
 * out with it.
 *
 * `key` is a property name; an array element is read by its index spelled as
 * one. Array `length` is not read through here: on a value `Array.isArray`
 * accepts it is a non-configurable own data property, which no accessor can
 * replace.
 */
export function member(
  record: object,
  key: string,
  path: string,
  issues: DocumentIssues
): unknown {
  return guardedValue(record, key, path, issues, "J004");
}

// =============================================================================
// GUARDED INSPECTION — the JSON boundary's total owner (external review 3)
// =============================================================================
//
// `isPlainRecord` and `declaredKeys` in relation/terminal stay the RULE OWNERS:
// they decide what a plain record IS and what its declaration keys ARE. The
// three wrappers here add only the boundary adaptation the JSON entry points
// need — the hostile-trap guarding (a proxy's `getPrototypeOf` or `ownKeys`
// trap is executable input, exactly as a property accessor is) and the
// conversion of a caught throw into this family's J-code. They restate none of
// the predicates' logic; the `code` argument is the one direction-dependent
// fact (`J004` inbound, `J009` for the serializer's own read of a coded value).

/**
 * Read one caller-owned property, converting a throwing accessor into a coded
 * refusal that carries what it threw. `member` is this at `J004`.
 */
export function guardedValue(
  record: object,
  key: string,
  path: string,
  issues: DocumentIssues,
  code: DocumentIssueCode
): unknown {
  try {
    return Reflect.get(record, key);
  } catch (thrown) {
    addIssue(issues, pointer(path, key), code, "Reading this value threw");
    throw refuseDocument(issues, toError(thrown));
  }
}

/** `isPlainRecord`, with a throwing `getPrototypeOf` trap owned as a refusal. */
export function inspectPlainRecord(
  value: unknown,
  path: string,
  issues: DocumentIssues,
  code: DocumentIssueCode
): value is Record<string, unknown> {
  try {
    return isPlainRecord(value);
  } catch (thrown) {
    addIssue(issues, path, code, "Inspecting this value's prototype threw");
    throw refuseDocument(issues, toError(thrown));
  }
}

/** `declaredKeys`, with a throwing `ownKeys` trap owned as a refusal. */
export function inspectKeys(
  record: Record<string, unknown>,
  path: string,
  issues: DocumentIssues,
  code: DocumentIssueCode
): string[] {
  try {
    return declaredKeys(record);
  } catch (thrown) {
    addIssue(issues, path, code, "Enumerating this value's keys threw");
    throw refuseDocument(issues, toError(thrown));
  }
}

/**
 * A caller VALUE of unknown type, rendered into an issue message without running
 * caller code. `JSON.stringify` throws on a `bigint`, and coercing an object
 * would run its own `toString`; this does neither. Keys and tags are already
 * strings and interpolate directly — this is for the values, like a `version`,
 * that are not.
 */
export function renderValue(value: unknown): string {
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (typeof value === "object") {
    // `typeof null === "object"` too; both render by type, never coerced.
    return `[${typeof value}]`;
  }
  return String(value);
}

/**
 * Totality only, in one place. Every refusal this module re-throws IS an
 * `Error` — except what caller code throws: a document accessor, a
 * caller-supplied Standard Schema whose accessor is read at build time. Either
 * may throw a value of any type at all, so the account of what happened is
 * normalized here and never dropped.
 *
 * Describing a non-Error means converting it to text, and `toString` on a
 * caller's object is caller code too: a conversion that throws leaves the type
 * as the only thing that can be said, and the value itself stays the `cause`.
 */
export function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  return new Error(describeThrown(thrown), { cause: thrown });
}

function describeThrown(thrown: unknown): string {
  try {
    return String(thrown);
  } catch {
    return `a thrown ${typeof thrown} whose own string conversion threw`;
  }
}

/**
 * Re-throw a builder's refusal with the document location that produced it.
 *
 * The builders own every semantic refusal in the declaration surface; this
 * boundary owns only the fact that the author wrote it HERE. The original error
 * stays attached as the cause, so its own message and type survive.
 *
 * The refusal is always an `Error`: the relation factories throw
 * `ValidationError`, blob throws `Error`, and every caller-supplied value that
 * could throw anything else was already read through the document reader's own
 * guarded accessor, which never reaches a builder.
 */
export function refuseFromBuilder(path: string, thrown: Error): never {
  const issues: DocumentIssues = [];
  addIssue(issues, path, "J010", thrown.message);
  throw refuseDocument(issues, thrown);
}

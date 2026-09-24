/**
 * The definition boundary for `s.decimal({ precision, scale })`.
 *
 * A scale cannot be inferred from storage, a value, a driver, or an operation:
 * SQLite ignores the numbers in `DECIMAL(10,5)` and may put a fractional value
 * in a binary64 double. So the domain is DECLARED once, here, and every later
 * consumer — validation, DDL, binding, decoding, comparison, arithmetic,
 * migration — reads that one frozen fact off the resolved scalar.
 *
 * The descriptor is the developer's own argument, or two numbers a schema
 * document carried verbatim; neither is a hostile object, so it is read like
 * any other argument — no read-once snapshot, no key enumeration. What this
 * module owns is whether the two numbers name a domain at all.
 */

import { ValidationError } from "@errors";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";
import { validateSchema } from "@validation/primitives/helpers";
import { isRecord } from "@validation/value-guards";

/** The one construction-time refusal of a decimal declaration. */
function refuse(path: string, message: string): never {
  throw new ValidationError(
    { kind: "schema-builder", builder: "s.decimal", path },
    [{ path, message }]
  );
}

/**
 * The frozen fixed-decimal domain the two numbers name: `precision` an integer
 * from 1 to the maximum safe integer, `scale` an integer from 0 to `precision`,
 * so "at most `precision` total digits and at most `scale` fractional digits"
 * is a domain with values in it.
 *
 * Its unique coverage is the schema document and an untyped JavaScript caller:
 * `read.ts` hands the numbers over as they were written, so `10.5`, `1e300` and
 * `-0` (which `JSON.parse` keeps and `JSON.stringify` loses) reach this check
 * and nothing earlier. The argument is `unknown` because the document seam
 * passes it untyped; it is read as an ordinary object, not a hostile one.
 * Whether a given PROVIDER can store the domain is a different question with a
 * different owner: the adapter answers it once when the schema is bound.
 */
export function readDecimalDescriptor(source: unknown): DecimalDescriptor {
  const precision = isRecord(source) ? source.precision : undefined;
  const scale = isRecord(source) ? source.scale : undefined;
  if (
    !(
      typeof precision === "number" &&
      Number.isSafeInteger(precision) &&
      precision >= 1
    )
  ) {
    refuse(
      "descriptor.precision",
      "'precision' must be an integer between 1 and the maximum safe integer"
    );
  }
  if (
    !(
      typeof scale === "number" &&
      Number.isSafeInteger(scale) &&
      scale >= 0 &&
      scale <= precision &&
      !Object.is(scale, -0)
    )
  ) {
    refuse(
      "descriptor.scale",
      "'scale' must be an integer between 0 and precision"
    );
  }
  return Object.freeze({ precision, scale });
}

/**
 * A fixed-decimal LIST is not a key, and this is where a chain that tries to
 * make one into a key stops (plan 2.1).
 *
 * Both directions are refused because the chain has two of them:
 * `.array().id()` names a list and then a key, `.id().array()` names a key and
 * then a list, and only refusing the one that comes second would leave the
 * other spelling admitted. The exclusion is the DECLARATION's, not the
 * database's: a decimal list is stored as one container value on two of three
 * providers, so a key over it would be a key over a JSON document whose
 * identity is its spelling rather than its members — and there is no member
 * arrangement that could make it addressable.
 *
 * The whole-schema rule F007 ("an ID cannot be an array") is untouched and
 * still owns every OTHER scalar type. This refuses earlier, at the call that
 * writes the illegal chain, and it also owns `.unique()`, which no rule in the
 * repository refuses on a list of any type.
 */
export function refuseDecimalListKey(
  position: "id" | "unique" | "array"
): never {
  const explanation =
    "a fixed-decimal list cannot be an ID, a unique field, an index member, a foreign-key member, or a relation identity member";
  refuse(
    position,
    position === "array"
      ? `A decimal key cannot become a list: ${explanation}`
      : `A decimal list cannot be declared '.${position}()': ${explanation}`
  );
}

/**
 * A literal default, normalized through the field's complete current schema at
 * DEFINITION time, so model metadata holds the canonical logical value the DDL
 * renderer, the schema-document serializer and the create schema's trusted
 * default all read. A value outside the declared domain fails at the call that
 * wrote it, not at the first write.
 *
 * A function default keeps its closure, exactly as every other scalar's does:
 * a closure has no canonical spelling to retain, and the create schema runs the
 * field codec on each value it returns.
 */
export function normalizeDecimalDefault(
  value: unknown,
  schema: StandardSchemaV1<unknown, unknown>
): unknown {
  if (typeof value === "function") return value;
  const result = validateSchema(schema, value);
  if (result.issues !== undefined) {
    refuse("default", "The decimal default did not satisfy its field schema");
  }
  return result.value;
}

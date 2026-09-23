/**
 * The field-aware decimal codec: the descriptor type, the two physical
 * vocabularies a column crosses through, the provider decode grammars and
 * their domain limits, the two DDL renderings, the widened-sum decode and the
 * JSON list container. The value and its arithmetic are `decimal-value.ts`'s;
 * a value whose `canonicalDecimalText` answers was built by its constructor,
 * so there is nothing here to snapshot or defend against.
 */

import { isString } from "../value-guards";
import {
  admitDecimal,
  canonicalDecimalText,
  type Decimal,
  fixedText,
  fromCanonical,
  fromCoefficient,
  toCoefficient,
} from "./decimal-value";

// =============================================================================
// THE DOMAIN
// =============================================================================

/**
 * The fixed-decimal domain: multiples of `10^-scale` whose unscaled coefficient
 * has at most `precision` digits. Frozen once by `s.decimal` and carried by
 * reference through every modifier.
 */
export interface DecimalDescriptor {
  readonly precision: number;
  readonly scale: number;
}

/** Whether two optional descriptor references declare the same value domain. */
export function sameDecimalDescriptor(
  left: DecimalDescriptor | undefined,
  right: DecimalDescriptor | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.precision === right.precision && left.scale === right.scale;
}

/**
 * The two exact physical vocabularies a decimal field can cross through.
 *
 * The active adapter selects one; this codec alone interprets it. The value
 * cannot select its own vocabulary because `"120"` is logical 120 as native
 * decimal text and logical 1.2 as a scale-2 coefficient.
 */
export type DecimalPhysicalRepresentation = "text" | "coefficient";

/**
 * The codec's names for four value-module seams, kept because the engine's
 * binders and result cache reach them by these names: the admission rule
 * (`admitDecimal`), the brand reader (`canonicalDecimalText`), the
 * grammar-skipping decode seam (`fromCanonical`) and the coefficient at a
 * scale (`toCoefficient`). Each is the same function, not a wrapper around it.
 */
export const canonicalizeDecimal = admitDecimal;
export const canonicalizeMaterializedDecimal = canonicalDecimalText;
export const toDecimal = fromCanonical;
export const logicalToCoefficient = toCoefficient;

// =============================================================================
// THE COEFFICIENT VOCABULARY
// =============================================================================

/**
 * The one physical coefficient spelling: `0`, or an optional minus and digits
 * with no leading zero. `BigInt` alone would also read `" 1 "`, `"0x10"` and
 * `""`, so a provider value crosses this before it becomes a number.
 */
const COEFFICIENT_REGEX = /^(?:0|-?[1-9]\d*)$/;

/**
 * Decode one untrusted unscaled coefficient at `scale`, or `undefined` when it
 * is outside the vocabulary or wider than `precision` digits. The length is
 * bounded before the `BigInt` is built.
 */
function decodeCoefficient(
  value: unknown,
  scale: number,
  precision?: number
): Decimal | undefined {
  if (!(isString(value) && COEFFICIENT_REGEX.test(value))) return undefined;
  const digits = value.startsWith("-") ? value.length - 1 : value.length;
  if (precision !== undefined && digits > precision) return undefined;
  return fromCoefficient(BigInt(value), scale);
}

/** The canonical text of a decoded coefficient, or `undefined`. */
function decodeCoefficientText(
  value: unknown,
  scale: number,
  precision?: number
): string | undefined {
  const decoded = decodeCoefficient(value, scale, precision);
  return decoded === undefined ? undefined : canonicalDecimalText(decoded);
}

// =============================================================================
// PROVIDER TEXT DECODE
// =============================================================================

/** Whether one UTF-16 code unit is an ASCII decimal digit. */
function isDecimalDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/**
 * Validate and locate canonical physical decimal TEXT in one scan: an optional
 * minus, an integer part with no leading zero, and a fraction padded to the
 * column's scale — the spelling an adapter emits for `NUMERIC(p,s)` /
 * `DECIMAL(p,s)`. Narrower than the application grammar on purpose: a
 * spelling no adapter emits is a malformed row, not a number to guess at.
 *
 * Returns the canonical end offset (zero for normalized zero). The scan owns
 * scale and optional precision admission, so the field and SUM decoders never
 * reinterpret the spelling afterward.
 */
function scanProviderText(
  value: string,
  scale: number,
  precision?: number
): number | undefined {
  const length = value.length;
  if (length === 0) return undefined;

  const negative = value.charCodeAt(0) === 45;
  const integerStart = negative ? 1 : 0;
  if (integerStart === length) return undefined;

  let index = integerStart;
  const first = value.charCodeAt(index);
  const integerIsZero = first === 48;
  if (integerIsZero) {
    index++;
    if (index < length && isDecimalDigit(value.charCodeAt(index))) {
      return undefined;
    }
  } else {
    if (first < 49 || first > 57) return undefined;
    index++;
    while (index < length && isDecimalDigit(value.charCodeAt(index))) index++;
  }
  const integerEnd = index;

  let fractionStart = length;
  let firstNonZeroFraction = -1;
  let lastNonZeroFractionEnd = -1;
  if (index < length) {
    if (value.charCodeAt(index) !== 46) return undefined;
    fractionStart = ++index;
    if (index === length) return undefined;
    for (; index < length; index++) {
      const code = value.charCodeAt(index);
      if (!isDecimalDigit(code)) return undefined;
      if (code !== 48) {
        if (firstNonZeroFraction < 0) {
          firstNonZeroFraction = index - fractionStart;
        }
        lastNonZeroFractionEnd = index + 1;
      }
    }
  }

  const isZero = integerIsZero && firstNonZeroFraction < 0;
  const fractionalDigits =
    lastNonZeroFractionEnd < 0 ? 0 : lastNonZeroFractionEnd - fractionStart;
  const coefficientDigits = integerIsZero
    ? firstNonZeroFraction < 0
      ? 0
      : scale - firstNonZeroFraction
    : integerEnd - integerStart + scale;
  if (
    fractionalDigits > scale ||
    (precision !== undefined && coefficientDigits > precision)
  ) {
    return undefined;
  }
  if (isZero) return 0;
  return fractionalDigits === 0 ? integerEnd : lastNonZeroFractionEnd;
}

/** Render one validated provider TEXT value as canonical private text. */
function renderProviderText(text: string, end: number): string {
  if (end === 0) return "0";
  return end === text.length ? text : text.slice(0, end);
}

/**
 * Decode one scalar field value read back as native decimal text, or
 * `undefined` when the provider returned something outside the field's declared
 * domain or outside the physical vocabulary the adapter promised.
 *
 * The PostgreSQL/MySQL scalar-read half of the codec: a column declared
 * `NUMERIC(p,s)` cannot answer with more than `s` fractional digits or more
 * than `p` coefficient digits, so a value that does is a column the schema no
 * longer describes rather than a number to widen the field for.
 */
export function decodeFieldScalar(
  text: unknown,
  descriptor: DecimalDescriptor
): string | undefined {
  if (!isString(text)) return undefined;
  const canonicalEnd = scanProviderText(
    text,
    descriptor.scale,
    descriptor.precision
  );
  return canonicalEnd === undefined
    ? undefined
    : renderProviderText(text, canonicalEnd);
}

/**
 * Decode an aggregate SUM, which keeps the field's SCALE but is deliberately
 * NOT held to its precision: adding a million `precision: 10` rows produces a
 * legitimate answer wider than any single column. `undefined` means the
 * provider returned something that is not an exact decimal at this scale.
 */
export function decodeWidenedSum(
  value: unknown,
  scale: number
): string | undefined {
  if (!isString(value)) return undefined;
  const canonicalEnd = scanProviderText(value, scale);
  return canonicalEnd === undefined
    ? undefined
    : renderProviderText(value, canonicalEnd);
}

// =============================================================================
// PROVIDER PHYSICAL REPRESENTATION
// =============================================================================

function encodePhysicalDecimalAtScale(
  canonical: string,
  scale: number,
  representation: DecimalPhysicalRepresentation
): string {
  return representation === "coefficient"
    ? toCoefficient(canonical, scale)
    : canonical;
}

/**
 * Encode one trusted canonical logical value in the vocabulary selected by the
 * active adapter. SQL construction remains with that adapter.
 */
export function encodePhysicalDecimal(
  canonical: string,
  descriptor: DecimalDescriptor,
  representation: DecimalPhysicalRepresentation
): string {
  return encodePhysicalDecimalAtScale(
    canonical,
    descriptor.scale,
    representation
  );
}

/** Construct one provider TEXT value after the shared grammar and domain scan. */
function materializeProviderText(
  value: unknown,
  scale: number,
  precision?: number
): Decimal | undefined {
  if (!isString(value)) return undefined;
  const canonicalEnd = scanProviderText(value, scale, precision);
  if (canonicalEnd === undefined) return undefined;
  return fromCanonical(renderProviderText(value, canonicalEnd));
}

/**
 * Decode one untrusted provider scalar into canonical private logical text.
 */
export function decodePhysicalDecimal(
  value: unknown,
  descriptor: DecimalDescriptor,
  representation: DecimalPhysicalRepresentation
): string | undefined {
  return representation === "text"
    ? decodeFieldScalar(value, descriptor)
    : decodeCoefficientText(value, descriptor.scale, descriptor.precision);
}

/**
 * Decode one ordinary scalar directly into its one fresh public Decimal: a
 * native decimal spelling through `renderProviderText` and the text seam, an
 * unscaled integer through the coefficient seam. Neither builds an
 * intermediate Decimal.
 */
export function materializePhysicalDecimal(
  value: unknown,
  descriptor: DecimalDescriptor,
  representation: DecimalPhysicalRepresentation
): Decimal | undefined {
  return representation === "text"
    ? materializeProviderText(value, descriptor.scale, descriptor.precision)
    : decodeCoefficient(value, descriptor.scale, descriptor.precision);
}

/**
 * Encode the ordered input members that the adapter will place in its native
 * array or JSON-backed coefficient container. Canonicalization stays inside
 * the codec so the caller does not need a second list pass or conversion owner.
 */
export function encodePhysicalDecimalListMembers(
  values: readonly unknown[],
  descriptor: DecimalDescriptor,
  representation: DecimalPhysicalRepresentation
): string[] | undefined {
  const members = new Array<string>(values.length);
  for (const [index, value] of values.entries()) {
    const canonical = admitDecimal(value);
    if (canonical === undefined) return undefined;
    members[index] = encodePhysicalDecimalAtScale(
      canonical,
      descriptor.scale,
      representation
    );
  }
  return members;
}

/**
 * Decode one provider list into canonical private logical members. Text means
 * a native array of exact decimal strings; coefficient means one JSON text
 * container of coefficient strings.
 */
export function decodePhysicalDecimalList(
  value: unknown,
  descriptor: DecimalDescriptor,
  representation: DecimalPhysicalRepresentation
): string[] | undefined {
  let members: string[];
  if (representation === "coefficient") {
    const decoded = decodeDecimalListContainerAtPrecision(
      value,
      descriptor.scale,
      descriptor.precision
    );
    if (decoded === undefined) return undefined;
    members = decoded;
  } else {
    // A supplied driver or result middleware can return a proxy rather than a
    // provider's ordinary native array. Reflection over that value is the
    // untrusted provider boundary: a revoked proxy, a hostile length getter, or
    // an indexed trap is a malformed list, never an exception that escapes the
    // result parser without its typed operation context.
    try {
      if (!Array.isArray(value)) return undefined;
      const length = value.length;
      if (!Number.isSafeInteger(length) || length < 0) return undefined;
      members = new Array<string>(length);
      for (let index = 0; index < length; index++) {
        if (!Object.hasOwn(value, index)) return undefined;
        const canonical = decodeFieldScalar(value[index], descriptor);
        if (canonical === undefined) return undefined;
        members[index] = canonical;
      }
    } catch {
      return undefined;
    }
    return members;
  }

  return members;
}

/**
 * Decode an exact SUM while retaining only the declared scale. The field
 * precision is deliberately not applied because sums widen.
 */
export function decodePhysicalWidenedSum(
  value: unknown,
  descriptor: DecimalDescriptor,
  representation: DecimalPhysicalRepresentation
): string | undefined {
  return representation === "text"
    ? decodeWidenedSum(value, descriptor.scale)
    : decodeCoefficientText(value, descriptor.scale);
}

/** Decode one widened SUM directly into its one fresh public Decimal. */
export function materializePhysicalWidenedSum(
  value: unknown,
  descriptor: DecimalDescriptor,
  representation: DecimalPhysicalRepresentation
): Decimal | undefined {
  return representation === "text"
    ? materializeProviderText(value, descriptor.scale)
    : decodeCoefficient(value, descriptor.scale);
}

// =============================================================================
// THE TWO DDL RENDERINGS
// =============================================================================

/** The dialects that spell a fixed decimal, in `NativeType["db"]` vocabulary. */
export type DecimalDialect = "pg" | "mysql" | "sqlite";

// =============================================================================
// PROVIDER PHYSICAL LIMITS
// =============================================================================

/**
 * What each provider can physically store, as one table (plan 3.1).
 *
 * PostgreSQL's `NUMERIC(p,s)` tops out at 1000 digits. MySQL's `DECIMAL(p,s)`
 * tops out at 65 digits with at most 30 after the point, and exact coefficient
 * arithmetic additionally needs `precision + scale <= 65`. SQLite's bound is not
 * a storage limit at all — it stores the unscaled coefficient in an int64 — but
 * the requirement of the one-statement multiply/divide: `precision + scale <=
 * 18` is what makes every in-range rounded result computable without
 * overflowing the intermediate, and 18 digits is also the widest literal
 * SQLite's own parser reads as an integer rather than as a REAL, which is what
 * the descriptor's range CHECK is written in.
 *
 * A descriptor is syntactically valid at model construction regardless: a
 * schema valid for PostgreSQL stays a valid model graph, and only BINDING it to
 * a provider that cannot store it fails.
 */
const PROVIDER_LIMITS: Record<
  DecimalDialect,
  { readonly precision: number; readonly scale: number; readonly sum?: number }
> = {
  pg: { precision: 1000, scale: 1000 },
  mysql: { precision: 65, scale: 30, sum: 65 },
  sqlite: { precision: 18, scale: 18, sum: 18 },
};

/**
 * Why this provider cannot store this descriptor, or `undefined` when it can:
 * one sentence per failing bound, naming the descriptor, the provider and the
 * limit — the caller adds the field. Read by the schema bind boundary
 * (`provider-limits.ts`) before any provider I/O, and by the migration layer.
 */
export function describeProviderLimitRefusal(
  dialect: DecimalDialect,
  descriptor: DecimalDescriptor
): string | undefined {
  const limit = PROVIDER_LIMITS[dialect];
  const { precision, scale } = descriptor;
  const named = `precision ${precision}, scale ${scale}`;
  if (precision > limit.precision) {
    return `${named} exceeds this provider's maximum precision of ${limit.precision}`;
  }
  if (scale > limit.scale) {
    return `${named} exceeds this provider's maximum scale of ${limit.scale}`;
  }
  if (limit.sum !== undefined && precision + scale > limit.sum) {
    return `${named} needs precision + scale <= ${limit.sum} on this provider, which is what makes its one-statement exact multiply and divide representable`;
  }
  return undefined;
}

/**
 * The physical column type for this descriptor.
 *
 * SQLite has no exact decimal type — `DECIMAL(10,5)` is only a NUMERIC-affinity
 * spelling whose numbers it ignores — so it stores the signed integer
 * coefficient and the migration driver adds the range check that makes the
 * declared precision real.
 *
 * No space after the comma, on every dialect: the emitted text is compared by
 * the differ, so one descriptor has one spelling.
 */
export function decimalColumnType(
  dialect: DecimalDialect,
  descriptor: DecimalDescriptor
): string {
  const { precision, scale } = descriptor;
  if (dialect === "pg") return `NUMERIC(${precision},${scale})`;
  if (dialect === "mysql") return `DECIMAL(${precision},${scale})`;
  return "INTEGER";
}

/**
 * The DDL literal for a default. PostgreSQL and MySQL take the value at EXACTLY
 * `scale` fraction digits, because that is what MySQL reads back from
 * `information_schema`: canonical `1.2` on a scale-5 column would read back as
 * `1.20000` and the differ would see a change on every push. SQLite takes the
 * coefficient, the same integer the column stores.
 */
export function decimalDefaultText(
  dialect: DecimalDialect,
  canonical: string,
  descriptor: DecimalDescriptor
): string {
  return dialect === "sqlite"
    ? toCoefficient(canonical, descriptor.scale)
    : fixedText(canonical, descriptor.scale);
}

/**
 * The physical value of one trusted literal decimal-list default.
 *
 * PostgreSQL owns a native numeric array, so every logical member is padded to
 * the declared scale just like a scalar DDL default. MySQL and the SQLite
 * family own coefficient-string JSON containers, exactly like their runtime
 * list writes. This codec renders the VALUE only; migration drivers still own
 * string quoting and provider expression syntax.
 */
export function decimalListDefaultText(
  dialect: DecimalDialect,
  canonicals: readonly string[],
  descriptor: DecimalDescriptor
): string {
  if (dialect !== "pg") {
    return encodeDecimalListContainer(canonicals, descriptor.scale);
  }
  const members = new Array<string>(canonicals.length);
  for (const [index, canonical] of canonicals.entries()) {
    members[index] = decimalDefaultText("pg", canonical, descriptor);
  }
  return `{${members.join(",")}}`;
}

// =============================================================================
// THE JSON LIST CONTAINER
// =============================================================================

/**
 * The physical container for a decimal list on the JSON-backed providers:
 * a JSON array of unscaled coefficient STRINGS.
 *
 * Strings, never JSON numeric tokens — JavaScript and D1 both round integers
 * above 2^53, so a numeric token is a silently wrong member rather than a
 * bigger one.
 */
export function encodeDecimalListContainer(
  canonicals: readonly string[],
  scale: number
): string {
  const members = new Array<string>(canonicals.length);
  for (const [index, canonical] of canonicals.entries()) {
    members[index] = encodePhysicalDecimalAtScale(
      canonical,
      scale,
      "coefficient"
    );
  }
  return JSON.stringify(members);
}

/**
 * The canonical logical members of a physical list container, or `undefined`
 * when the container is not one this codec wrote: malformed JSON, a non-array
 * top level, a numeric token, `null`, or a member outside the coefficient
 * grammar. Order and multiplicity are preserved exactly.
 */
export function decodeDecimalListContainer(
  container: unknown,
  scale: number
): string[] | undefined {
  return decodeDecimalListContainerAtPrecision(container, scale);
}

function decodeDecimalListContainerAtPrecision(
  container: unknown,
  scale: number,
  precision?: number
): string[] | undefined {
  if (!isString(container)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(container);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const members = new Array<string>(parsed.length);
  for (const [index, member] of parsed.entries()) {
    const canonical = decodeCoefficientText(member, scale, precision);
    if (canonical === undefined) return undefined;
    members[index] = canonical;
  }
  return members;
}

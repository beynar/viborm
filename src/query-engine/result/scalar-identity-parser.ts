import type { Scalar } from "@schema/scalars";

/**
 * A cheap per-value runtime check: `true` when the raw driver value is ALREADY
 * the field's exact target JS type, so the full typed scalar parser would return
 * it unchanged. A `false` result (null, wrong type, unsafe integer, non-finite
 * number) means the caller must delegate to the full parser — the two paths are
 * byte-identical, so the guard only ever shortcuts the provably-unchanged case.
 */
export type IdentityGuard = (value: unknown) => boolean;

const stringGuard: IdentityGuard = (value) => typeof value === "string";
const booleanGuard: IdentityGuard = (value) => typeof value === "boolean";
// An `int` is returned unchanged only when it is a safe integer (the full parser
// rejects a non-integer or out-of-range number — the guard defers to it there).
const intGuard: IdentityGuard = (value) =>
  typeof value === "number" && Number.isSafeInteger(value);
// A `number` is returned unchanged only when it is finite (NaN/±Infinity are
// malformed in the full parser, so a non-finite number falls through the guard).
const numberGuard: IdentityGuard = (value) =>
  typeof value === "number" && Number.isFinite(value);

/**
 * The read fast path: a plain scalar whose native driver value — on a
 * passthrough provider (see {@link ResultParser.nativeScalarPassthrough}) — is
 * returned UNCHANGED by the full typed parser. Returns a guard deciding, per
 * value, whether the identity shortcut is exact; any non-matching value defers
 * to the full parser so the result is byte-identical either way.
 *
 * Only `string`, `boolean`, `int` and `number` are eligible. List, enum, json,
 * vector, point, blob, date, time, datetime, bigint and decimal fields always
 * coerce (decimal/bigint arrive as strings, dates as Date/strings, enums need a
 * membership check) and return `undefined` — the full parser owns them.
 */
export function identityGuardFor(scalar: Scalar): IdentityGuard | undefined {
  const state = scalar["~"].state;
  if (state.array === true) {
    return undefined;
  }
  switch (state.type) {
    case "string":
      return stringGuard;
    case "boolean":
      return booleanGuard;
    case "int":
      return intGuard;
    case "number":
      return numberGuard;
    default:
      return undefined;
  }
}

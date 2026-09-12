# Changelog

All notable changes to VibORM are recorded here. Releases follow Semantic
Versioning.

## Unreleased

- Prepare the V1 release and publication system.
- Generate every string identifier natively: `@paralleldrive/cuid2`, `nanoid`
  and `ulidx` leave the dependency graph and `@noble/hashes` joins it for
  SHA3-512. CUID2 output is byte-identical to the package it replaces.
- Add `s.string().uuidv7()` and `s.string().ksuid()`, and the matching
  `generate` kinds in the JSON schema document.
- `s.string().id()` now sets `hasDefault`, so a generated primary key is
  optional in the create type as it already was at runtime. `.id()` no longer
  overrides a generator declared before it, and `.id(prefix)` after a generator
  is refused (`.id("")` names no prefix, so it stays a plain key declaration).
- A nanoid length outside the range a nanoid can have — not a whole number, or
  outside 1 to 65536, the entropy source's own per-call quota — is refused at
  declaration instead of silently producing empty identifiers or throwing a
  platform error on every row.
- PostgreSQL emits `DEFAULT gen_random_uuid()` only for an unprefixed `.uuid()`
  field.

### Decimal API change (breaking)

The exact decimal value type is now [big.js](https://github.com/MikeMcl/big.js)
`7.0.1` instead of decimal.js. `Decimal` is still exported from `viborm`, still
constructed once per selected leaf, and still satisfies `instanceof Decimal` —
but it is now the `Big` constructor, so the value surface it carries is
big.js's, not decimal.js's. Nothing VibORM owns changed: `s.decimal({
precision, scale })`, the frozen descriptor, exact admission, canonical
identity, provider representations, DDL, filters, updates, aggregates and
migrations all behave exactly as before, and the accepted input grammar
(`"+1.5"`, `".5"`, `"1."` accepted; `"1e3"` refused) is unchanged.

What changes for application code that does arithmetic on returned values:

- **27 prototype members instead of ~130**, carrying 23 distinct operations.
  Kept: `abs`, `add`, `cmp`, `div`, `eq`, `gt`, `gte`, `lt`, `lte`, `minus`,
  `mod`, `mul`, `neg`, `plus`, `pow`, `prec`, `round`, `sqrt`, `sub`, `times`,
  `toExponential`, `toFixed`, `toJSON`, `toNumber`, `toPrecision`, `toString`,
  `valueOf`. Four of those are aliases: `add`, `sub` and `mul` are `plus`,
  `minus` and `times`, and `toJSON` is `toString`.
- **Gone:** `isZero`, `isNeg`, `isNaN`, `isFinite`, `floor`, `ceil`, `trunc`,
  `toDP`, `toSD`, `dp`, `sd`, `ln`, `log`, `exp`, the trigonometric methods,
  `toFraction`, `toNearest`, `clamp`, and the radix conversions.
  `x.isZero()` becomes `x.eq(0)`; `x.isNeg()` becomes `x.s < 0` (or `x.lt(0)`,
  which answers `false` for a negative zero).
- **No NaN and no Infinity.** `new Decimal("abc")` and `new Decimal(NaN)`
  throw where they used to produce a NaN value, `div(0)` throws "Division by
  zero", `sqrt()` of a negative throws, and `pow` accepts integer exponents in
  `±1e6` only.
- **Configuration is static properties, not a setter.** `Decimal.set({...})` is
  gone; use `Decimal.DP` (decimal places for `div`/`sqrt`/negative `pow`, not
  significant digits), `Decimal.RM`, `Decimal.NE`, `Decimal.PE` and
  `Decimal.strict`. `Decimal.DP = 20` is not `Decimal.precision = 20`: the
  first counts places after the point, the second counted significant digits,
  and they coincide only by accident.
- **`toString()` can emit exponent notation**, following `NE` (-7) and `PE`
  (21), as decimal.js's `toExpNeg`/`toExpPos` did. Zero-argument `toFixed()`
  ignores both and never rounds.
- **`@types/big.js` is a runtime dependency**, because big.js ships no
  declarations and VibORM's published `.d.mts` names the module. Nothing to do
  on your side; it installs with `viborm`.

There is no compatibility shim, and a decimal.js instance is not accepted as
input. Convert one at the boundary:

```ts
import { Decimal } from "viborm";

const converted = new Decimal(oldDecimalJsValue.toFixed());
```

Use `toFixed()` with no argument rather than `toString()`: it is decimal.js's
complete value in plain notation, so it cannot hand big.js an exponent form
shaped by the old constructor's `toExpNeg`/`toExpPos`.

## 0.1.0 - 2026-01-24

- Published the initial development package.

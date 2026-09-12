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
  field, and only where the column can hold one.

### Identifier storage (breaking for new schemas)

Naming an identifier format is now a promise about every value of the field, and
VibORM both holds you to it and takes advantage of it. `.uuid()`, `.uuidv7()`,
`.ulid()`, `.ksuid()`, `.nanoid()` and `.cuid()` declare a **domain**; a bare
`.id()` still declares a **key** and is unchanged in every respect — its values
are whatever a string column holds, and it is still stored as text.

- **Values are validated.** A declared or derived domain admits only its own
  values, everywhere one can appear: `create`, `update`, `where`, unique
  selectors, cursors, and every `connect` / `connectOrCreate` / `upsert` key. A
  prefix is matched whole, and aliases normalize once — an uppercase UUID and a
  lowercase ULID address the same row their canonical spelling does. Previously
  `s.string().uuid()` refused nothing.
- **Storage changes for new schemas.** `uuid`/`uuidv7` become `uuid` on
  PostgreSQL and `BINARY(16)`/`BLOB` elsewhere; `ulid` becomes
  `bytea`/`BINARY(16)`/`BLOB`; `ksuid` becomes `bytea(20)`/`BINARY(20)`/`BLOB`.
  A declared prefix is no longer stored — it is identical in every row and is
  re-applied on read. `nanoid` and `cuid` keep text storage.
- **Four operators are gone from the compact formats.** `contains`,
  `startsWith`, `endsWith` and `mode` are removed from a compactly stored
  field's filter TYPE and refused by the engine: sixteen bytes are not the text
  you wrote them as. `equals`, `not`, `in`, `notIn`, `lt`, `lte`, `gt`, `gte`,
  `orderBy` and cursor pagination are exact and unchanged — the byte order of
  all four formats IS their canonical text order.
- **Foreign keys derive.** A column that references a key is admitted,
  normalized and stored exactly as that key is, with no declaration of its own.
  Declaring a DIFFERENT domain on a foreign key than its target has, or reaching
  one column through references whose keys disagree, is a schema error (FK012).
- **Existing databases.** A table whose identifier column already holds text
  keeps working if you say so: a text-family native type
  (`s.string(PG.STRING.VARCHAR(40)).uuid()`, `TEXT`, `citext`, `CHAR(n)`, …)
  opts out of compact storage while keeping the domain validated. Otherwise the
  column type changes and the differ plans a destructive `alterColumn`; the
  conversion of existing rows is not yet automated. A native type the domain
  cannot live in is refused where it is declared (F013), with a message naming
  the spellings that format does accept.

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

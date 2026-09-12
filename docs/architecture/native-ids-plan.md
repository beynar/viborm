# Native IDs, big.js decimals, and automatic ID storage

Normative plan and public contracts for the program that removes
`@paralleldrive/cuid2`, `nanoid`, `ulidx` and `decimal.js` from VibORM's runtime
dependency graph, adds UUIDv7 and KSUID, and lets a declared ID format choose
its own physical column representation.

Principle: **declare necessary facts once; derive everything else.** One
definition of each ID format, one owner per invariant, shared reversible
representations, database spelling only at the database boundary, no parallel
ID systems.

Baseline evidence (commit fc69297b, all green: 499 files / 10,067 tests) is in
`docs/architecture/native-ids-evidence/baseline.json`, produced by
`node scripts/measure-bundle.mjs` after `pnpm package:build`. The fixtures under
`scripts/bundle-fixtures/` are frozen measurement instruments: never edit them
without re-baselining both sides.

## Stages

| Stage | Deliverable | Verified by |
|---|---|---|
| A | Baseline + this contract | `baseline.json`, `pnpm test:core` green |
| B | Native ULID / NanoID / CUID2 / UUIDv7 / KSUID; three packages removed | vectors, differential CUID2 test, `layer-scalars`, `layer-schema-json` |
| C | `decimal.js` → `big.js`; public `Decimal` is `Big` | `layer-validation`, decimal contracts, packed consumer typecheck |
| D | One ID domain owner; UUID storage end to end on pg / mysql / sqlite | provider-backed round trips |
| E | ULID and KSUID through the same mechanism | same harness, no fork |
| F | Migrations, FK derivation edge cases, docs, package verification | `pnpm test:core`, `pnpm test:package`, measured after-numbers |

B and C are independent and run in parallel worktrees. D depends on the contract
below, not on C.

## 1. ID generation contract (Stage B)

Methods on `s.string()`; every one keeps the field a plain `string` in public:

| Method | Format | Default installed | Notes |
|---|---|---|---|
| `.uuid(prefix?)` | UUIDv4 | yes | RFC 9562 §5.4; `crypto.randomUUID()` when present, else built from secure bytes |
| `.uuidv7(prefix?)` | UUIDv7 | yes | RFC 9562 §5.7: 48-bit unix ms, `ver=7`, 12 random bits, variant `10`, 62 random bits. Time-sortable; **no** same-millisecond monotonic promise |
| `.ulid(prefix?)` | ULID | yes | Crockford base32, 26 chars, 48-bit ms + 80 random bits; monotonic within a process (see below) |
| `.ksuid(prefix?)` | KSUID | yes | 4-byte big-endian seconds since 2014-05-13T16:53:20Z (epoch 1400000000) + 16 random bytes; 27-char base62 (`0-9A-Za-z`), zero-padded |
| `.nanoid(length?, prefix?)` | NanoID | yes | alphabet `useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict`, default 21, `byte & 63` selection |
| `.cuid(prefix?)` | CUID2 | yes | upstream algorithm preserved (below), 24 chars, `/^[a-z][0-9a-z]{23}$/` |
| `.id(prefix?)` | — | ULID only if no generator declared yet | marks primary key + unique; sets `hasDefault: true` (bug fix: today the create *type* demands the id the runtime generates) |

Rules:

- **Prefix**: the public value is `${prefix}-${payload}` when a non-empty prefix
  is declared, otherwise the bare payload. An empty string is no prefix. The
  hyphen is part of the contract. A prefix is matched exactly at admission;
  nothing splits generically on `-`.
- **Modifier order**: state is last-writer-wins for generators (`.uuid().ulid()`
  is a ULID field). `.id()` never overrides a generator that was already
  declared; `.id(prefix)` after a generator is refused at declaration
  (ambiguous prefix). `.id().uuid("a")` and `.uuid("a").id()` are the same
  field: uuid, prefix `a`, primary key.
- **Custom default**: `.default(fn)` after a generator replaces only the
  closure; the declared format stays and `fn`'s output must satisfy it (the
  value crosses the same validator as an explicit input, as today).
- **Randomness**: `crypto.getRandomValues` only. No `Math.random()` fallback,
  ever. Entropy is drawn lazily at generation time; importing VibORM or
  declaring a schema draws none. If secure randomness is unavailable the
  generator throws a VibORM error naming the field.
- **ULID monotonicity** (preserved from ulidx): one process-wide monotonic
  state shared by every ULID field; same-millisecond calls increment the
  80-bit random part; a clock that moves backwards keeps emitting the last
  timestamp (never a smaller ULID); overflow of the random part throws a
  VibORM error instead of ulidx's "Incorrectly encoded string". Random bits
  are unbiased (10 secure bytes encoded exactly), unlike ulidx's PRNG path.
- **NanoID length**: must be a positive integer; `.nanoid(0)`, `NaN`, negative
  and fractional lengths are refused at declaration (today `0`/`NaN` silently
  produce empty ids and `-1` throws at row-create time).
- **CUID2**: keep upstream's construction exactly: `firstLetter` (random
  a–z) + `sha3_512(time36 + salt + count36 + fingerprint)` rendered in base36
  with the first char dropped, sliced to `length`; per-process counter seeded
  `floor(random * 476782367)`; fingerprint = `hash(Object.keys(globalThis) +
  entropy(32)).slice(0, 32)`. Base conversion uses native `BigInt` instead of
  bignumber.js. SHA3-512 comes from `@noble/hashes/sha3.js` (narrow subpath,
  declared runtime dependency; ~4.6 KB). Upstream MIT notice retained in the
  source file. A differential test injects `random`/`counter`/`fingerprint`
  into the pinned upstream (dev dependency only) and asserts identical output.
- **Fixed widths**: every binary/text conversion preserves leading zeros and
  emits exact widths (ULID 26, KSUID 27, UUID 36). Out-of-range inputs
  (ULID time > 2^48-1, KSUID time outside [0, 2^32-1] seconds after epoch,
  non-canonical lengths) are refused, never wrapped.
- **Canonical spelling and aliases**: UUID canonical is lowercase hyphenated
  (uppercase accepted and normalized at the validation boundary). ULID
  canonical is uppercase Crockford (lowercase accepted and normalized; `I L O`
  are not accepted; first char must be `0–7`). KSUID and NanoID and CUID2 are
  case-sensitive with no aliases. Normalization happens once, in the field's
  validation schema, before any identity-sensitive work (cache keys, row keys).

`AutoGenerateType` gains `"uuidv7"` and `"ksuid"`. The schema document
(`generate.kind`) admits the two new tokens; `SCHEMA_DOCUMENT_VERSION` stays 1
(widening a closed union is additive; older readers refuse the new kinds with
J004 as they refuse any unknown kind).

Migration DDL defaults: PostgreSQL emits `DEFAULT gen_random_uuid()` **only**
for an unprefixed UUIDv4 field stored natively as `uuid` or text; no DDL
default for any other format (uuidv7 needs PG18, and a prefixed value cannot be
produced by the database).

## 2. Decimal contract (Stage C)

- `big.js@7.0.1` (pinned exactly, like decimal.js was) replaces `decimal.js`.
  `export { default as Decimal } from "big.js"` — the public `Decimal` **is**
  the `Big` constructor. This is an intentional API change: `Big` has 25
  prototype methods (`plus/minus/times/div/mod/pow/sqrt/abs/cmp/eq/gt/gte/lt/
  lte/round/prec/toFixed/toPrecision/toExponential/toNumber/toString/valueOf/
  toJSON`), `div(0)` and `sqrt(-1)` throw, `pow` takes integer exponents only,
  `Big.DP` is decimal places (not significant digits), and there is no NaN or
  Infinity: `new Decimal("abc")` throws instead of producing a NaN value.
  No compatibility shim; old decimal.js instances are not accepted (callers
  convert with `new Decimal(old.toString())`).
- `@types/big.js@7.0.0` is a **runtime** dependency: big.js ships no
  declarations and VibORM's `.d.mts` references `"big.js"`, so a consumer
  without the types would silently see `any` under `skipLibCheck`.
- Everything VibORM owns is unchanged: `s.decimal({ precision, scale })`, the
  frozen descriptor, exact admission, canonical private text (identity, cache,
  SQL parameters), coefficient conversion, provider representations and
  limits, DDL, filters, updates, aggregates, fresh public instances at the
  result boundary, custom `.schema()` seeing a real `Decimal`.
- Configuration independence: construction from a string reads no `Big`
  static (`DP/RM/NE/PE`); only `Big.strict` affects *number* input, and VibORM
  constructs from strings only. Canonical text is rendered from the `s/e/c`
  snapshot (digits, not base-1e7 words), never through `toString`/`toJSON`
  (which honor `NE/PE` and emit exponent notation). The `MAX_RENDER_EXPONENT`
  ceiling stays and is now the only bound (big.js clamps nothing).
- Deleted: exponent-range widening (`minE/maxE` + `Decimal.config` capture),
  the base-1e7 `digitsToString` port, `DIGIT_WORD_BASE`, word-count bound.
- Accepted string/number inputs are unchanged (`+1.5`, `.5`, `1.` still
  accepted by VibORM's own grammar; `1e3` still refused).

## 3. ID domain and storage contract (Stages D–F)

### The one owner

A field's **ID domain** is `{ format, prefix?, length? }` — the same facts the
generator methods already record in `ScalarState.autoGenerate`. There is no
second copy: `autoGenerate` *is* the domain declaration for the six string
formats (`increment/now/updatedAt` are not ID domains). Generation, admission,
encoding, decoding, schema serialization and physical storage read it through
one lookup, never re-derive it.

A **foreign-key member** without a generator derives its domain from the key it
references, once, in L5 (`relation-resolution.ts` / its FK sub-owner). The FK
scalar's state is not mutated; the derived domain is published beside the
resolved reference and read through the same lookup. No default generator is
installed on an FK. When one field participates in several references
(polymorphic variants, shared columns), every referenced key must carry the
same domain or schema validation fails (no first-target fallback). Explicitly
declaring a *different* domain on an FK member than its target is a schema
error (FK003-style). Self-relations, compound keys and junction columns derive
member-for-member.

### Admission

A declared or derived domain is a **validated** domain: explicit values on
create, update, where, unique selectors, cursors, connect/connectOrCreate/
upsert and nested writes must belong to it (prefix exact, payload canonical
after alias normalization). This is a public narrowing: `s.string().uuid()`
refused nothing before. Rationale: compact storage is impossible without it,
and one policy for all six formats is simpler than two.

Operators on compact-stored formats (uuid, uuidv7, ulid, ksuid): `equals`,
`not`, `in`, `notIn`, `lt`, `lte`, `gt`, `gte`, cursors, `orderBy` (byte order,
which equals canonical text order for all four formats, and time order for
uuidv7/ulid/ksuid). `contains`, `startsWith`, `endsWith` and `mode` are
removed from those fields' filter types and refused at the engine boundary.
Text-stored formats (nanoid, cuid) keep every string operator; their
`equals/in/notIn` operands are domain values.

### Physical storage

| Format | PostgreSQL | MySQL | SQLite |
|---|---|---|---|
| uuid / uuidv7 | `uuid` (text on the wire) | `BINARY(16)` | `BLOB` (16 bytes) |
| ulid | `bytea` (16 bytes) | `BINARY(16)` | `BLOB` (16 bytes) |
| ksuid | `bytea` (20 bytes) | `BINARY(20)` | `BLOB` (20 bytes) |
| nanoid, cuid | `text` (unchanged) | unchanged | unchanged |

A ULID is never spelled as a `uuid`. UUIDv7 bytes keep RFC order (no MySQL
UUIDv1 swapping). With a fixed prefix only the payload is stored; the prefix is
re-applied on read. Compact storage is automatic for a declared/derived domain.

Deliberately not emitted: length `CHECK` constraints on `bytea`/`BLOB`. The
codec always writes exact widths; carrying the width in the migration snapshot
would add a `ColumnDef` key, a SQLite carrier and introspection recovery for a
guard against out-of-band writers only.

Native type override on a domain field: a text-family override (`text`,
`varchar(n)`, `char(n)`, `citext`, MySQL `VARCHAR/CHAR/TEXT`, SQLite `TEXT`)
keeps **text storage** with the domain still validated (this is the opt-out for
existing text columns); a binary override of the right width (`bytea`,
`BINARY(16|20)`, `BLOB`) or `uuid` for uuid formats is accepted; anything else
is refused at the schema boundary and by the schema-document reader.

### Engine seams (no format switch in the execution tree)

Exactly five attachment points, each already single-owned:

1. Declaration: `ScalarState.autoGenerate` + the derived FK view; one lookup
   `idDomainOf(model, field)` beside `decimalDescriptorOf`.
2. Codec: `src/validation/primitives/id-codec.ts` — grammar, canonical text,
   `encodePhysicalId`, `decodePhysicalId` (reusing the blob parser's provider
   shape normalization), refusal messages. Pure; no dialect knowledge.
3. Parameter encoding: `buildScalarSqlValueForScalar`, `scalarValueLiteral`,
   `referenceScalarSql` (concrete and deferred `Ref`, replacing the `text`
   cast). One adapter member per dialect spells the literal.
4. Read projection: `projectScalarForTransport` (flat and JSON carriers agree;
   binary in JSON travels as lowercase hex via `blobToHex`).
5. Result decode: compiled once per scalar in `ResultParser.createFieldChain`;
   the adapter declares the physical promise (`idRepresentation`); the identity
   fast path is disabled for domain fields whose physical value differs from
   the public one.

Raw SQL stays physical. Cache keys use validated (normalized) args; snapshots
hold public strings, so the snapshot revision does not move.

### Migrations

- New schemas get the table above automatically.
- Existing text columns: the differ plans `text → native` as a destructive
  `alterColumn` needing consent (existing machinery). The generated program
  executes the conversion only where the database can do it losslessly in SQL
  (PostgreSQL unprefixed uuid via `USING col::uuid`, guarded by a row-format
  pre-check); every other text→binary conversion is **refused** with a
  message naming the manual route and the text-override opt-out. A blind
  `USING col::bytea` would re-encode text bytes, so it is never emitted.
- Pre-check queries (invalid rows, prefix mismatch, normalization collisions,
  FK-set agreement) are provided as `trusted-read` checks for manual
  transitions.
- An unchanged declaration produces no diff. Introspection recovers the
  physical type; the logical format lives in the schema document
  (`generate`), never guessed from `uuid`/`BINARY` alone.
- D1 (batch-only SQLite) inherits the existing refusal of relation-bearing
  rebuilds.

## 4. Verification and reporting

Use the project's runners: `pnpm test:core`, per-layer `pnpm test:layer:*`,
`pnpm test:package`, provider lanes with
`PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm`
and `MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm`.
Re-run `node scripts/measure-bundle.mjs` after `pnpm package:build` for the
after-numbers; report isolated-library savings separately from integrated
bundle deltas (compressed sizes are not additive). Final report: Outcome,
Validation, Risks.

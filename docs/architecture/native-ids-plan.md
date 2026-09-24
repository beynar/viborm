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

| Stage | Deliverable | Verified by | Shipped |
|---|---|---|---|
| A | Baseline + this contract | `baseline.json`, `pnpm test:core` green | `native-ids-evidence/baseline.json` at fc69297b: 499 files / 10,067 tests |
| B | Native ULID / NanoID / CUID2 / UUIDv7 / KSUID; three packages removed | vectors, differential CUID2 test, `layer-scalars`, `layer-schema-json` | all six formats, `.uuidv7()` and `.ksuid()` added, `@paralleldrive/cuid2` + `nanoid` + `ulidx` out, `@noble/hashes` in; CUID2 byte-identical to upstream |
| C | `decimal.js` → `big.js`; public `Decimal` is `Big` | `layer-validation`, decimal contracts, packed consumer typecheck | `big.js@7.0.1` pinned, `@types/big.js` a runtime dependency, exponent-widening and the base-1e7 port deleted |
| D | One ID domain owner; UUID storage end to end on pg / mysql / sqlite | provider-backed round trips | `idDomainOf` + `idStorageOf` + the codec; SIX engine seams, not five; `.id()` amended to declare a KEY, not a domain (see §3) |
| E | ULID and KSUID through the same mechanism | same harness, no fork | shipped inside D — one mechanism, no per-format branch above the codec |
| F | Migrations, FK derivation edge cases, docs, package verification | `pnpm test:core`, `pnpm test:package`, measured after-numbers | `identifierConversionChecks` + the PostgreSQL `text`→`uuid` guard, the conversion guide, docs and CHANGELOG consolidation, package + workerd + bun verification, `final.json` |

The measured after-numbers and every lane Stage F executed are in
[`native-ids-report.md`](./native-ids-report.md).

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
  the `Big` constructor. This is an intentional API change: `Big` has 27
  prototype members (`plus/minus/times/div/mod/pow/sqrt/abs/neg/cmp/eq/gt/gte/
  lt/lte/round/prec/toFixed/toPrecision/toExponential/toNumber/toString/valueOf`
  plus the aliases `add/sub/mul` of `plus/minus/times` and `toJSON` of
  `toString`: 23 distinct operations), `div(0)` and `sqrt(-1)` throw, `pow`
  takes integer exponents only, `Big.DP` is decimal places (not significant
  digits), and there is no NaN or Infinity: `new Decimal("abc")` throws
  instead of producing a NaN value.
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
formats (`increment/now/updatedAt` are not ID domains).

> **AMENDED IN STAGE D (executed).** A NAMED format declares a domain; a bare
> `.id()` does not. `.id()` installs a ULID so a caller need not supply one, but
> a convenience default is not an assertion about every value the field will
> hold — so a `.id()` key admits what a string column admits and is still stored
> as text, while `.ulid().id()` is a ULID key with admission and compact
> storage. `AutoGenerate.implicit`, written only by `.id()` and read only by
> `idDomainOfState`, is the whole record of the difference; the schema document
> restates it so a round trip cannot promote a key into a domain.
>
> The amendment is a MEASUREMENT, not a preference. With `.id()` read as a named
> ULID, 723 tests across 77 files refuse VibORM's own estate — 2,241 `.id()`
> declarations across 442 test files, whose identifiers are readable strings —
> and every one of those failures is the narrowing working as specified. The
> same would be true of every shipped schema: `.id()` is how a string primary
> key is spelled, and silently changing its column to `BLOB` and its admission
> to "ULIDs only" is a larger break than this program set out to make. Stage F
> inherits the distinction: only a named format needs a text→native conversion. Generation, admission,
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

> **AMENDED IN STAGE D (executed), twice.**
>
> The four predicates go by the FORMAT, not by the storage: a compact format
> that takes the text-family override still loses them. The validation schema is
> built before any adapter exists, so it cannot read `idStorageOf` without
> threading a dialect into a layer that has none, and one filter type per field
> rather than one per deployment is what keeps the type and the runtime saying
> the same thing.
>
> A DERIVED domain narrows at RUN TIME only. A field's filter type is computed
> from the field's own declaration and a foreign key has none; deriving it would
> mean resolving the relation's `.references(...)` target at the type level and
> threading whole-schema context into every per-model schema type, which is the
> shape that collapses this estate's mutually-recursive model instantiations.
> `tests/types/client/identifier-filter-narrowing.core.types.ts` pins both
> halves — the declared key drops the four, the derived foreign key keeps them
> in the type and is refused at run time.

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
A foreign key holds its key's values in the key's own physical form: storage is
read off each column's own override, so a foreign key whose storage differs from
its key's on a dialect either override names (a key kept text by `varchar(40)`
beside a foreign key with no override, which would be `uuid`) is refused as
`FK012` rather than created as a `uuid` column referencing a text one.

### Engine seams (no format switch in the execution tree)

Exactly six attachment points, each already single-owned:

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
6. Aggregate: `builders/aggregate-utils.ts` `aggregateOperandExpression` — what
   `MIN`/`MAX` run OVER, for the select list and for `having` alike. The
   TRANSPORTED spelling, because PostgreSQL has neither `min(uuid)` nor
   `max(bytea)` and JSON cannot hold binary; the answer is the same either way,
   since every compact format's canonical text is fixed-width and lowercase and
   its text order IS its byte order. The null guard travels inside it: SQLite's
   `hex(NULL)` is the empty string and would win every `MIN`.

   > **ADDED IN STAGE D (executed).** The stage found this seam by measurement
   > and the plan is amended to name it rather than leave the contract and
   > `src/query-engine/AGENTS.md` disagreeing.

A PRIVATE column — a junction side, a polymorphic row carrier's id column —
crosses seams 3, 4 and 5 like any other, and it NAMES the key it stands in for
(`idColumnOfPrivate`) rather than reading its own scalar: those columns hold
some model key's values, and that key's domain may be derived.

> **AMENDED FOR THE RAPTOR 3 PORT (2026-09-23).** The engine that owns every
> operation since the C-01 cutover is `src/query-engine/raptor3/`; the old
> engine's seam owners named above are deleted, and seams 3–6 attach there:
>
> | Seam | Raptor 3 owner |
> | --- | --- |
> | resolution (1, engine side) | `raptor3/shared/identifier.ts` `identifierColumn` → `Leaf.id`, once per (adapter, model, field); a carrier column resolves through `PhysicalField.reference` |
> | 3, parameter | `Queries.scalarValue` (`literals.id(encodePhysicalId(…))`), reached by `fieldValue` and a column target's operand (`targetValue`) |
> | 4, projection | `identifier.ts` `transportedIdentifier` in `projectedColumn`, the junction probe and `recursiveIdentity`; the JSON carrier takes the flat spelling unchanged |
> | 5, decode | `Queries.decodeScalar`'s identifier arm; an internal read of a text-stored domain keeps the stored spelling |
> | 6, aggregate | `identifier.ts` `aggregatedIdentifier` in `Queries.aggregateExpression` |
>
> Two parts of the contract have no Raptor 3 counterpart. The DEFERRED arm of
> seam 3 (`idLiteral` → `expressions.idCast`) is not ported: a located key is a
> raw column sub-select, already physical, so `idCast` has no engine caller
> and stays a pinned adapter member. The engine-side text-predicate narrowing
> is not ported: admission is its one owner. The identity fast path of seam 5
> does not exist in Raptor 3, whose decoder already runs every leaf.

Raw SQL stays physical. Cache keys use validated (normalized) args; snapshots
hold public strings, so the snapshot revision does not move.

### Migrations

- New schemas get the table above automatically.
- Existing text columns: the differ plans `text → native` as a destructive
  `alterColumn` needing consent (existing machinery). The generated program
  executes the conversion only where the database can do it losslessly in SQL
  (PostgreSQL unprefixed uuid via `USING col::uuid`); every other text→binary
  conversion is **refused** with a message naming the manual route and the
  text-override opt-out. A blind `USING col::bytea` would re-encode text bytes,
  so it is never emitted.

  > **AMENDED IN STAGE D (executed).** The refusal is stated in COLUMN TYPES,
  > not in identifier domains: `migrations/binary-conversion.ts`, reached from
  > the one `alterColumn` dispatch, refuses any alteration whose target is this
  > dialect's raw-bytes column and whose source is not. A snapshot carries no
  > logical marker saying "this BLOB decodes identifiers" and needs none — a
  > verbatim copy into a binary column is unreadable whatever the column holds,
  > and one refusal at the dispatch is what kept the three conversion routes
  > (PostgreSQL cast, SQLite rebuild, MySQL MODIFY) from being wrong three
  > different ways. The PostgreSQL `uuid` leg carries no row-format PRE-CHECK:
  > `col::uuid` is a real per-value conversion that succeeds for an estate of
  > canonical uuids and aborts the whole transaction for one that is not,
  > leaving the column as it was — a pre-check would buy a better message, not
  > a different outcome, and Stage F may add it.
- Pre-check queries (invalid rows, prefix mismatch, normalization collisions,
  FK-set agreement) are provided as `trusted-read` checks for manual
  transitions.

  > **SHIPPED IN STAGE F.** `migrations/identifier-conversion.ts`
  > (`identifierConversionChecks`, public from `viborm/migrations` alongside the
  > `MigrationCheckInput` type) renders them for one `(schema, model, field,
  > dialect)`. Four questions, not three: the key column's rows, the key
  > column's alias collisions, and — per referencing foreign key — that column's
  > own rows and its set agreement AFTER normalization. Junction and
  > polymorphic-carrier columns are out of scope by name, not by omission: they
  > have no `(model, field)`, and the migration guide lists them instead.
  >
  > The PostgreSQL `text` → `uuid` leg now runs a `DO` block first, which counts
  > the rows the cast would abort on and names both routes. It changes no
  > outcome and owns nothing but the message; the plan's earlier wording
  > ("guarded by a row-format pre-check") is satisfied in that sense only.
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

# Native identifiers on the new engine: dry-run merge and the one port left

Branch `native-ids-on-engine` = `native-ids-bigjs` (PR #43, 9a2bbb989) merged
with `pattern-engine` (bcb364491), 2026-09-23. A dry run, not a landing: it
measures what the PR needs from the new engine before the engine merges.

## What merged cleanly

- 35 old-engine files the PR had modified were deleted by the engine and are
  gone here too: the PR's six identifier seams lived in them.
- 9 content conflicts resolved: the three dialect adapters keep the PR's
  `idRepresentation` member and take the engine's pass-through `parseResult`;
  scripts and AGENTS take the engine's side; `geopoint-sql.core.test.ts` takes
  the engine's side (the D2 reachability witnesses written against the old
  engine's SQL are to be re-spelled against `engine.build` of raptor3).
- Typecheck (native tsc, whole project): 11 errors, all in
  `src/query-engine/builders/id-field.ts` and the old-engine SQL test
  `identifier-storage-sql.core.test.ts` that imports it. Both are replaced by
  the port below, not fixed.
- `pnpm test:core`: 8,727 of 8,729 tests pass. The two failures are the
  dead-symbol gate flagging `builders/id-field.ts`, resolved by the same port.
- Decimal: the new engine's `raptor3/shared/decimal.ts` consumes the codec by
  names the PR kept (`canonicalizeMaterializedDecimal`, the physical
  encode/decode seams), so VibORM's own `Decimal` needed no engine change.
  Three raptor3 tests imported `decimal.js`; they now import `Decimal` from
  `@src/index`.

## The port: compact identifier storage has no seam in raptor3

Measured on this branch:

| Lane | Result | Meaning |
|---|---|---|
| sqlite3 `identifier-storage` (31) | 28 pass, 3 fail | the row holds the PUBLIC text, prefix included (`HEX(id)` is the ASCII of `usr-a0eebc99-…`, 80 hex chars, not the 32 of a 16-byte payload); reads pass only because SQLite returns what it was given |
| pg `identifier-storage` (31) | suite fails in setup | `QueryEngineError: Driver "pg" returned a malformed string scalar for operation "create": the value is not a string` — the read side receives a `Buffer`/`uuid` from the compact column and raptor3's string decode refuses it |
| mysql2 `identifier-storage` (31) | suite fails in setup | `ValueTooLongError` (errno 1406, sqlState 22001): the 40-character public text bound into the `BINARY(16)` column the migration created |

The migrations still create the compact columns (`idStorageOf`), the adapters
still declare `idRepresentation`, and the validation layer still admits and
normalizes the domain. What is missing is the engine's half of the contract in
[`native-ids-plan.md` §"Engine seams"](native-ids-plan.md): seams 3 to 6.

Where they attach in raptor3 (`src/query-engine/raptor3/shared/query.ts`):

- **Seam 3, parameter encoding**: `Queries.scalarValue(scalar, value, field)`
  (~:799) binds every scalar for writes and filters. An identifier whose
  storage is not `text` binds `encodePhysicalId(value, storage)` (payload bytes,
  prefix stripped; `id-codec.ts`), and the deferred `Ref`/literal spellings
  follow `idLiteral`. Cursor, unique selector, `in`/`notIn`, and the private
  junction / polymorphic carrier columns cross the same call and NAME the key
  they stand in for (`idColumnOfPrivate`).
- **Seam 4, read projection**: `Leaf` (~:89) already carries `decimal` and
  `dateTime`; it gains the identifier storage. The JSON-carrier projection
  (~:941) already routes `blob` through `adapter.expressions.blobToHex`; a
  binary identifier takes the same route.
- **Seam 5, result decode**: `Queries.decodeScalar` (~:4919) gains the arm that
  turns the physical value (`Buffer`, `Uint8Array`, hex text, or `uuid` text)
  back into the public canonical text with its prefix, `decodePhysicalId`.
  The identity fast path is off for a domain field whose physical value
  differs from the public one.
- **Seam 6, aggregate operand**: `MIN`/`MAX` over a compact column run over the
  transported spelling (PostgreSQL has no `min(uuid)`/`max(bytea)`), with the
  `hex(NULL)` guard for SQLite.

The logic exists, tested, in the PR's `src/query-engine/builders/id-field.ts`
(`idColumnOf`, `idColumnOfPrivate`, `encodeIdValue`, `decodeIdValue`,
`idLiteral`, `isConcreteIdValue`); it moves into raptor3 and the old file and
its `builders/` directory are deleted, which also satisfies the dead-symbol
gate. Witnesses to make green: the three provider identifier lanes above (93
tests), `tests/contracts/adapters/identifier-storage.core.test.ts` (green
already), and a re-spelling of `identifier-storage-sql.core.test.ts` (43 SQL
pins) against `engine.build`.

Estimated size: a few hundred lines inside a 5,400-line file the engine team
is still changing. Owner's call whether the engine team adds the identifier
leaf before the merge, or the port lands on this branch after it.

## Closed on branch `port-ids` (2026-09-23)

The port landed as `raptor3/shared/identifier.ts` and its four consumers in
`raptor3/shared/query.ts` (see `native-ids-plan.md` §"Engine seams", amended);
`src/query-engine/builders/` is deleted and the dead-symbol gate is green.
Measured after the port: sqlite3, pg and mysql2 `identifier-storage` 31/31
each; `identifier-storage-sql.core.test.ts` re-spelled against `engine.build`
(47 tests); text-stored identifiers build byte-identical SQL to the engine
before the port (a 148-case dump over three dialects).

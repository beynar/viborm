# L12 Migrations — Migration V1

**Location:** `src/migrations/`
**Canonical design:** [`docs/architecture/migration-v1-plan.md`](../../docs/architecture/migration-v1-plan.md)

## 30-second summary

Migration V1 is one authenticated state graph plus one separate, history-free
live synchronization path.

```text
immutable estate descriptor
  + content-addressed schema snapshots
  + content-addressed plain-SQL blobs
  + immutable state manifests and parent transitions
  + database current-state marker
  + append-only database ledger
```

A state is a graph node, not a numbered file. Each state authenticates its
target snapshot and one complete transition from every parent. Branches can
diverge and converge without renaming files or inventing lexical order. Human
names are metadata only.

Production never evaluates migration TypeScript and never reparses display SQL.
It executes only authenticated UTF-8 slices from an authenticated SQL blob,
with the exact closed typed-parameter tuples authenticated by each dispatch ID.

`push` is not history. It plans from the live schema, replans under the target
lock, executes the accepted in-memory program, and proves the destination. It
never reads or writes estate storage and never changes the marker or ledger.

GeoPoint changes only dialect-owned physical schema decisions. PostgreSQL uses
`geography(Point,4326)` plus GiST and proves the exact PostGIS extension-owned
types/functions before the first live-command effect; it never installs the
extension. MySQL uses `POINT SRID 4326` and one-field non-null spatial indexes.
SQLite uses the reserved `VIBORM_GEO_TEXT` type plus its exact canonical JSON
CHECK and refuses spatial indexes. Its physical CHECK reader/writer, fixed-decimal
carrier, and quote-aware column parser live in the adapter-owned
`src/adapters/databases/sqlite/storage/` leaf modules so `viborm check --db` and
migration introspection consume the same rule without importing migration
execution. A GeoPoint `geoPointEncoding` annotation authenticates the legacy
15-digit versus binary64 CHECK; upgrading reconstructs its stored doubles once,
without claiming to recover precision already lost. Introspection recognizes only those exact
forms. Offline artifacts carry the logical snapshot requirement; they never
infer it by parsing SQL.

List storage is selected before a scalar native type. PostgreSQL has native
arrays and composes an admitted member type with `[]`. MySQL stores every list
in JSON. SQLite stores lists in JSON except for its reserved fixed-decimal TEXT
container. A MySQL or SQLite native declaration describes one scalar member and
must never replace the list container in migration DDL.

## Domain model

Use these terms exactly:

| Term | Meaning |
| --- | --- |
| **Estate** | One storage root containing an immutable target descriptor, snapshots, SQL blobs, and committed state manifests. |
| **Schema snapshot** | One strict canonical description of the VibORM-managed logical and physical schema. |
| **SQL blob** | Plain review SQL containing every referenced check, forward dispatch, postcheck, and rollback dispatch. |
| **State** | One exact point in history, identified by its canonical manifest rather than its name or position. |
| **Transition** | One parent-specific forward program and rollback policy leading into a state. |
| **State manifest** | The one committed record for a target state, its snapshot, metadata, destination checks, and all incoming transitions. |
| **Marker** | The database's last confirmed state, authenticated arrival path, snapshot, estate, path hash, and revision. |
| **Ledger** | Append-only database evidence for attempts, confirmed steps, outcomes, baselines, re-anchors, recovery, and reset progress. |
| **Push plan** | An ephemeral baseline-specific live transition. It is never inserted into the estate. |

Schema identity and state identity are intentionally distinct. A data-only
transition can produce a new state while retaining the same schema snapshot.
Equal snapshots therefore never prove equal migration state.

The marker and ledger answer different questions:

- the marker says which state and arrival path are last confirmed;
- the ledger says what was attempted and what happened;
- an unfinished ledger attempt means the live database may be between states
  and blocks ordinary work;
- neither representation is reconstructed from the other.

## Estate format

```text
migrations/
├── estate.json
├── snapshots/
│   └── <snapshot-hash>.json
├── sql/
│   └── <sql-hash>.sql
└── states/
    └── <state-id>.json
```

`estate.json` is created once and is immutable. It contains format `"1"`, hash
algorithm `"sha256"`, and the exact `MigrationTarget`. PostgreSQL estates are
schema-bound; MySQL artifacts remain database-relative; SQLite retains its
dialect target. There is no mutable head or state list.

Snapshots, SQL blobs, and state manifests are immutable content-addressed
objects. Snapshot and manifest JSON is canonical RFC 8785 UTF-8 without a BOM.
A snapshot artifact is either a full schema document or a structured delta.
`snapshotHash` always identifies the reconstructed full canonical schema. A
delta's exact bytes have their own `snapshot-delta` hash domain and physical
address in `snapshots/`; a state authenticates that address with the optional
`snapshotArtifactHash`. Without that field it refers to a full document.
`snapshot-artifacts.ts` alone owns delta admission, literal JSON-path changes,
iterative reconstruction, representation selection, and dependency depth. A
delta is storage, never an execution program or a second DDL differ. Resolve
every distinct physical reference and verify its logical hash against every
referencing state before effects; do not deduplicate admission by schema hash.
Patch only independently owned documents. A full document has depth zero;
at most 32 delta links are admitted, including cached bases. Generation reuses
authenticated representations in ascending physical-hash order, otherwise
chooses a smaller delta from actual manifest parents, or a full checkpoint.
Authored history checkpoints always remain full. The existing `ArtifactCache`
shares only exact-byte parsed full/delta documents and manifests; every command
still reads all dependencies from its own storage before reusing a reconstructed
schema. Retained reconstructions charge their full canonical size to the same
bounded cache, alongside the delta bytes. Frozen delta values must be
detached before applying edits, and graph snapshots remain frozen. Low-lock
generation includes candidate-owned artifacts in the same selection scope and
seals every intermediate snapshot reference before publication. `prune` copies
the retained states' physical dependency closure in base-first order and
revalidates copied bytes against the graph's authenticated view.
It materializes the canonical virtual empty snapshot when an implicit empty
schema has no stored object; explicit artifact dependencies must remain present.
Fresh estate-descriptor and state-manifest reads must also equal the graph's
authenticated canonical bytes before publication into the destination.
Offline check accounts for the committed-state transitive dependency closure
separately from artifacts visited while validating orphans. Storage interfaces
and immutable conditional publication are unchanged.
A state becomes visible only when its manifest is conditionally created after
all referenced snapshot and SQL bytes are durable.

The virtual `null` origin maps to the canonical empty managed snapshot. It is
not a stored state and cannot be redefined.

## Identity and trust boundaries

### Hash rule

`identity.ts` is the one hash owner. Every digest is:

```text
frozen ASCII domain label + 0x00 + exact authenticated bytes
```

The result is lowercase 64-hex SHA-256. Estate, snapshot, SQL, dispatch,
transition, state, path, push-plan, reset-plan, and ledger-event identities
use distinct frozen domains. No locale, insertion order, display formatter, line-ending
conversion, or self-referential checksum participates.

The authenticated chain is:

1. estate hash over exact canonical `estate.json` bytes;
2. snapshot hash over exact canonical snapshot bytes;
3. SQL hash over exact SQL blob bytes;
4. dispatch ID over SQL hash, UTF-8 byte offset, byte length, and canonical
   typed parameters;
5. transition hash over the complete parent transition without its own hash;
6. state ID over the complete state manifest without its own ID.

Every read revalidates the chain. A filename is not proof merely because it
looks like a digest.

Logical snapshot identity (`encodeSnapshot` / `hashSnapshot`) is the exact
canonical full-schema bytes, independently of full or delta representation.
Stored delta identity authenticates the exact canonical delta bytes in its
separate frozen hash domain. Live physical comparison uses `fingerprintLive` in
`push-fingerprint.ts`. That path is the dialect canonicalization owner: it
projects partial-index predicates through the live database, drops constraint
names when `introspectionReadsConstraintNames` is false, keeps PostgreSQL
primary-key names (an omitted name is `{table}_pkey`, the catalog default),
normalizes types and
defaults, and excludes logical-only history such as `polymorphicStorage`.
Apply, baseline, reanchor, verify, down, resolve, reset, and push compare live schema
through that function. Do not compare an introspected snapshot with
`encodeSnapshot`. A SQL `DEFAULT NULL` and an omitted default are the same
physical fact. Catalog aliases (`int4[]` / `integer[]`, `NOW()` / `now()`)
are the same physical fact; `normalizeType` and `normalizeDefault` in
`push-fingerprint.ts` are the one owner, including the differ. SQLite
primary-key columns are not nullable even when `PRAGMA table_info` reports
`notnull = 0`. SQLite `autoIncrement` is the `AUTOINCREMENT` keyword, not
every `INTEGER PRIMARY KEY`. SQLite enum types keep the `CHECK (... IN ...)`
suffix the driver writes; introspection reconstructs it from table SQL because
`PRAGMA table_info` returns only `TEXT`. Transactional wrap uses the live producer's
`supportsTransactions`; a dialect that can be transactional still executes
sequentially when that producer cannot open a callback transaction. Catalog
probes bind the resolved namespace and never fall back to `'public'` or
`DATABASE()`. A generated statement with no bound namespace emits no probe
(offline MySQL generate); it does not invent a default. PostgreSQL
introspection reads foreign keys from `pg_constraint`
and keeps a unique index that an FK targets as an index — `information_schema`
drops that pair (`unique_constraint_name` is null; `conindid` also names the
referenced unique index).

`MigrationDriver.projectNativeRename` owns the physical rename projection used
by resolution, enum retargeting, generation, and inverse snapshots. Its default
retains the shared native table/column replay. The base driver owns the
derived-rename rule, for a dialect that opts in by implementing
`renameDerivedNames`: names derived from columns (indexes, uniques, foreign keys,
the default primary key, per-column enums) and, on a table rename, the
table-prefix tail of an index, unique or foreign key named `<table>_…_idx`,
`_key` or `_fkey` (both names unhashed). PostgreSQL and MySQL render it through
their rename DDL (MySQL as `RENAME INDEX` plus a dropped and re-added foreign
key in one `ALTER TABLE`); SQLite does not opt in. A name without the derived
shape stays untouched. `generatedPrimaryKeyName` supplies the
exact CREATE/ADD spelling and automatic inverse name. Rename compilation reads preceding
table and primary-key operations so its source key is the one present at that
step. Serializer `finalizeTable` is not a rename projection: its type, index,
and declaration-admission changes must not run on a live renamed snapshot.
The sorter retains numeric priorities and inserts accepted native rename
prerequisites before their consumers, including enum dependent columns; cyclic
prerequisites refuse. PostgreSQL enum DDL reads the same projected prefix for
array/default metadata and replacement updates.

**MySQL addendum (R2a, 2026-09-21).** MySQL hands back its own vocabulary, so
its introspection — not `normalizeType` / `normalizeDefault` — is where the two
snapshots are made comparable. An ENUM's values ARE its type and MySQL has no
standalone enum object, so `mysqlEnumType` (`drivers/type-mapping.ts`) is the
ONE spelling: `getEnumColumnType` writes it, `drivers/mysql/introspect.ts`
re-spells the catalog's `enum('a','b')` through it, and that same text is the
enum's identity in `snapshot.enums` on both sides — a name derived only on the
live side never equalled the desired one. The MySQL literal writer and its
escape inverse share `drivers/type-mapping.ts`; catalog introspection and inline
enum diffing consume those logical members before rendering an ALTER. SQLite's
inline CHECK carrier keeps ordinary backslashes and decodes doubled quotes only.
A default is reported in two
vocabularies and neither is the estate's: a LITERAL default comes back as the
bare value with its quotes gone, an EXPRESSION default as MySQL's deparse,
escaped TWICE — once by MySQL printing the string literal, once by the catalog
printing that expression, so a declared `it's` arrives as the characters
`_utf8mb4\'it\\\'s\'` — and `cleanDefault` undoes both layers into the DDL
spelling. It undoes `\'` and `\\` and nothing else, and that leaves TWO
distinct mechanisms, not one. FIRST: a body carrying an escape this inverse
does not own — `\n` for a newline, measured — is not translated at all, so the
column keeps the CATALOG's own text, a printed backslash sequence, which can
never equal what the desired side spells. That one is witnessed
provider-free, by `tests/unit/migrations/mysql-provider-free-catalog.core.test.ts`'s
"undoes both layers of MySQL's deparse, and keeps what it cannot", whose
`multiline` column asserts the catalog text comes back unchanged. SECOND: a
backslash in the DECLARED value never reaches the catalog as an escape at all —
`escapeValue` leaves `\` alone and MySQL's DDL reads it as an escape
introducer, so `DEFAULT ('a\b')` stores a BACKSPACE (measured) — and the
inverse then succeeds on that body while reconstructing a value that is not
the declared one. That one is witnessed live, by
`tests/providers/docker/mysql2-schema-attestation.test.ts`'s "a default MySQL's
DDL does not read back is refused, not accepted". Both end the same way, and
that end is the fail-closed direction: the column is re-planned and the push
then FAILS at the final attestation with `MIGRATION_DRIFT`. It is explicit —
such a default cannot be pushed to MySQL at all, rather than being accepted as
a value nobody proved equal — and the round-tripping side is pinned beside the
second, by the same file's "an apostrophe survives MySQL's deparse of an
expression default". MySQL refuses a literal
`DEFAULT` on TEXT, BLOB, JSON and GEOMETRY (errno 1101), so `finalizeTable` —
the one owner of how a MySQL column is spelled, beside the keyed-TEXT →
`VARCHAR(191)` rewrite — carries such a default as MySQL's expression default
`DEFAULT ('value')`. The emitter writes what the snapshot says and suppresses
nothing: a declared default silently dropped is a column the schema did not
declare, and the final push attestation refuses it. A MySQL push runs its
sequential program even when the plan is EMPTY, because the
interrupted-decimal-conversion recovery belongs to the LOCKED COMMAND: a
conversion interrupted after its MODIFY leaves the column already carrying the
target domain, so the differ sees no change and the remnant CHECK — which no
snapshot vocabulary describes — would otherwise survive every later push.

**Addendum (repair prompt §4, 2026-09-21).** The two mechanisms the paragraph
above calls fail-closed were two DEFECTS, and both are repaired at their
owners. The DDL spelling of a string value is now `mysqlStringLiteral`
(`drivers/type-mapping.ts`), beside `mysqlEnumType` and for the same reason:
ONE spelling, both snapshot producers. It escapes `\` — MySQL reads a
backslash inside a string literal as an escape introducer, so doubling `'`
alone silently changed the value (`DEFAULT ('a\b')` stored a BACKSPACE) and
could not spell a trailing one at all (`('end\')` did not parse) — and `\n`,
`\r`, `\0`, `\Z`, because a generated statement is also the review blob,
which is UTF-8/LF without carriage returns (`sql-blob.ts`). `cleanDefault`
undoes that SAME table (`MYSQL_PRINTED_CHARACTERS`, the write table inverted
plus the `\'` MySQL prints), so a default carrying any of them round-trips
into the spelling the desired side wrote. The fail-closed direction is
unchanged for what remains outside the table: an escape MySQL's printer does
not write, and an expression that is not a string literal at all, keep the
catalog's own text, read as a difference, and fail the final attestation with
`MIGRATION_DRIFT` rather than being called equal. The SQL-mode assumption the
spelling makes is that `NO_BACKSLASH_ESCAPES` is NOT set, and that assumption
is asserted, not enforced: the session owner (`proveMySQLExactValueSession`,
`drivers/mysql/pinned-session.ts`, run through the MySQL driver's
`proveSession` hook) refuses a session carrying neither `STRICT_TRANS_TABLES`
nor `STRICT_ALL_TABLES` and ADMITS a strict session that also carries
`NO_BACKSLASH_ESCAPES`, and nothing else under `src/migrations/` reads the
mode. On such a server this repair is a measured REGRESSION rather than a
no-op: the base spelling `'a\b'` stored the declared `a\b` there, so the
column CONVERGED, while the repaired spelling `'a\\b'` stores TWO characters
(measured on a probe's own `SET SESSION sql_mode`; the global mode is never
changed), the inverse then re-spells the live value as `'a\\\\b'`, and the
push fails at the final attestation with an unattributed `MIGRATION_DRIFT`
after the DDL has already committed. The assumption is stated beside the mode
the pinned session does prove, in
`tests/unit/migrations/mysql-strict-mode-docker.test.ts` — a measurement of
the container that lane runs against, not a guard. Separately,
`.dateTime().now()` is spelled from the RESOLVED column type
(`mysqlNowExpression`): MySQL requires the expression's fractional-seconds
precision to agree with the column's, so `DATETIME(3) DEFAULT
CURRENT_TIMESTAMP` is errno 1067 and the generator hook — which is handed the
declaration only — cannot answer it; a resolved type that takes no
`CURRENT_TIMESTAMP` (DATE, TIME) carries no database default instead. The live
matrix for both is
`tests/unit/migrations/mysql-defaults-docker.test.ts` (initial push,
unchanged repush, a declared change, and a RAW INSERT omitting the column as
the oracle). TWO neighbours are NOT covered by this repair and stay
fail-closed, and for the first of them the refusal MOVED.
`mysqlEnumType` still spells its values with quote doubling only while the
default beside them now goes through `mysqlStringLiteral`, so the two no
longer agree: a backslash-bearing enum value that is ALSO the column's default
is refused by MySQL at the CREATE/MODIFY statement itself, errno 1067
ER_INVALID_DEFAULT (measured: the member of `ENUM('a\b')` is the BACKSPACE
MySQL's DDL makes of it, and `DEFAULT 'a\\b'` is the literal backslash, which
is not that member) — mid-push, as a driver error rather than as the
attestation's `MIGRATION_DRIFT`. Only such a value WITHOUT a default still
reaches the attestation, and is refused there as this paragraph's predecessor
describes; the spelling itself is pinned provider-free
(`mysql-provider-free-catalog.core`'s `back\slash` enum member), the refusal
point is measured, not pinned. The second neighbour, which IS pinned:
`information_schema` hands an EXPRESSION default's UTF-8 bytes back one
codepoint per byte (measured), so a non-ASCII default on TEXT, BLOB, JSON or
GEOMETRY is refused while the same value in a LITERAL default (`VARCHAR(191)`,
the keyed rewrite) round-trips. Re-decoding those bytes would
be a guess on a read path other MySQL transports share, so it is reported, not
repaired here.

**Addendum (repair prompt §3, 2026-09-21).** The TWO neighbours the paragraph
above leaves fail-closed were the same boundary seen twice, and both are now
closed at it. FIRST, `mysqlEnumType` no longer carries a spelling of its own:
an ENUM's member IS a MySQL string literal, so it is spelled by
`mysqlStringLiteral` like every other one, and the rule the two owners
disagreed about is gone rather than reconciled. The consequences are the
literal's, exactly: `ENUM('a\b')` declared a member holding a BACKSPACE and
`ENUM('end\')` did not parse, and a backslash-bearing member that was also the
column's default made MySQL refuse the CREATE/MODIFY with errno 1067 — all of
that is repaired by the one spelling. An estate CREATED under the old one is
re-planned into the declared members like any other changed column, and
converges — unless a row still holds the corrupted member, in which case MySQL
refuses the `MODIFY` itself under the strict mode the pinned session proves
(errno 1265 WARN_DATA_TRUNCATED, measured), leaving the column as it was: the
push fails, and no row is silently re-valued. The catalog inverse is the same
table read backwards: `parseEnumValues` undoes the
escapes MySQL's `COLUMN_TYPE` printer writes through `MYSQL_PRINTED_CHARACTERS`
(the enum printer writes a strict SUBSET — `\\`, `\n`, `\r`, `\0`; it doubles
`'` and prints ctrl-Z raw, measured on 8.4.11), where reading `\x` as a bare
`x` had turned a declared NEWLINE into the letter `n`. An escape outside that
table is still unowned: the `COLUMN_TYPE` is kept exactly as read, no enum
identity is registered for it, and the push fails at the attestation.

SECOND, a non-ASCII default. `information_schema.COLUMNS.COLUMN_DEFAULT` hands
an EXPRESSION default's text back one codepoint per BYTE, and the boundary
where that is corrected is `deparsedStringValue` — the place that already
parses MySQL's `_charset\'…\'` deparse and, until now, DISCARDED the
introducer. The introducer names the encoding of those bytes, so they are read
back with it. The measurement that locates the loss, hypothesis by hypothesis
(`closure-repair-2/t3/receipts/measurements.md`): the connection's character
set is not it (identical under an explicit `charset: "utf8mb4"`), the catalog
column's own charset is not it (the same utf8mb3 column carries a LITERAL
default's value decoded, `HEX()` and all), the DDL spelling is not it
(`SHOW CREATE TABLE` prints the true bytes for the very same column) — the
server's own `HEX(COLUMN_DEFAULT)` carries the expansion, so what arrives is
MySQL's rendering of a stored expression and the ORM's only choice is how to
read it. Nothing global was re-decoded: the bytes go through ONE table of
charset → how that charset's bytes are read (the UTF-8 family decodes, and
`ascii` and `binary` ARE their bytes — each the codepoint of the same number —
and `latin1` is MySQL's Windows-1252, where 0x93 is U+201C and the five bytes
cp1252 leaves undefined map to the same-numbered control). A charset outside
that table (`cp1251`, where those same bytes are two Cyrillic letters), an
out-of-byte-range codepoint (the provider-free `2615` pin), or bytes invalid in
their charset keep the catalog's own text and fail closed. That is not a proof
for every already-decoded transport value: the measured mysql2 byte-expanded
spelling of `é` and already-decoded text whose literal characters are `Ã©`
both present `c3 a9`, a valid UTF-8 sequence, so content alone cannot distinguish
them. The measured mysql2 representation remains supported; other transport
representations are unverified, and valid UTF-8-shaped already-decoded text can
be transformed rather than fail closed. No heuristic is added to guess missing
provenance. A schema whose defaults were written under a charset this table does
not name now fails the final attestation with `MIGRATION_DRIFT` where it could
converge before. That path needs no caller-supplied `charset`: MySQL
freezes the introducer in the stored expression at CREATE time, so a column
another session created under `latin1` reports `_latin1` — pure-ASCII defaults
included — to an ordinary utf8mb4 connection (measured,
`closure-repair-2/t3/receipts/probe-frozen-introducer.log`), which is why the
table reads the single-byte ASCII-compatible charsets instead of refusing them.
A LITERAL default arrives decoded and is untouched. The shared UTF-8 decoder
(`identity.ts`) reads a leading U+FEFF as part of the value rather than as a
mark, so a default beginning with one is reported as declared; a caller that
refuses a BOM refuses it as a byte, before the decode.
The SQL-mode assumption is unchanged and now covers enum members too, because
they are the same rule — `mysql-strict-mode-docker.test.ts` states it on
`escapeValue`, and `NO_BACKSLASH_ESCAPES` remains an admitted mode this
spelling regresses on, as the paragraph above says. The live matrix for both
halves is `mysql-defaults-docker.test.ts` and `mysql2-schema-attestation.test.ts`
(initial push, unchanged repush, a declared change, and a RAW INSERT omitting
the column as the oracle). One limit is measured and NOT repairable at this
boundary: `COLUMN_TYPE` is utf8mb3, so an enum member outside the BMP comes
back as `?` and such a schema cannot converge — an EXPRESSION default carrying
the same character does round-trip, because its bytes survive the expansion.

### Closed parsing

Hostile estate and control bytes become trusted V1 values only through the
parse modules: `v1-parse-snapshot.ts`, `v1-parse-dispatch.ts`,
`v1-parse-control.ts`, and `v1-parse.ts` for estate, state, and transition
records. `v1-parse.ts` re-exports the sibling owners so callers keep one
import path. The boundary rejects unknown versions, unknown keys, malformed
nested values, non-canonical JSON, invalid order, duplicate parents, and
identity mismatches. Do not cast `JSON.parse()` output to a snapshot,
manifest, marker, or ledger event.

`canonical-json.ts` alone produces and checks canonical JSON bytes.
`v1-types.ts` defines the closed persisted and operation-input shapes; it does
not admit open `unknown` payload bags. `public-view.ts` is the sole projection
from a trusted graph to frozen, non-executable `list`, `show`, and `graph`
metadata.

### Exact SQL framing

`sql-blob.ts` owns SQL framing. A dispatch references one SQL blob by hash plus
a UTF-8 byte offset and length. Before the first effect, the complete range
table is checked for matching blob hashes, valid bounds, order, non-overlap,
and exact `\n\n` display gaps. The complete blob is fatal-decoded as UTF-8
before any slice is executed, so a later check cannot fail after stepwise
effects. Execution slices those exact bytes.

Generated DDL already has provider statement boundaries. One manual `Sql` value
is one opaque provider dispatch, even if its text contains internal semicolons.
PostgreSQL dollar-quoted bodies, MySQL routines, and SQLite triggers therefore
do not create fake progress boundaries. MySQL `DELIMITER` is refused because it
is a client command. `compile.ts` refuses a declared manual forward or rollback
program with no dispatches and refuses each rendered dispatch whose text is
only whitespace. Accepted text stays byte-exact; comments and semicolons remain
opaque. Keep this invariant manual-only: generated logical-only transitions may
have no SQL effects.

Typed parameters are canonical tagged values. `compile.ts` encodes them once;
application decodes those tags through the same SQL boundary. Production does
not derive values from display text.

## One graph

`graph.ts` loads one immutable `MigrationGraph` from committed state manifests.
For one command, every graph-aware operation consumes that same instance. No
consumer rescans storage, orders by filename, or discovers parents independently.

The graph owner validates:

- the estate target and every referenced artifact and hash;
- one manifest per state ID and one transition per parent;
- present parents, snapshots, and SQL blobs;
- roots only from the virtual `null` origin;
- no dangling edge, duplicate edge, cycle, or unreachable history;
- valid leaves, selectors, and real adjacent edges;
- SQL ranges before any dispatch can become executable.

A normal state has one parent. A convergence state has one complete transition
from each parent:

```text
      B
     / \
A ──    ──> D
     \ /
      C
```

A database at B executes only B-to-D; a database at C executes only C-to-D.
The system never guesses that every missing branch should run.

An **authored checkpoint** is the one second root a populated estate admits:
`generate({ from: null })` whose transition creates, from empty, exactly the
schema of the estate's single leaf (field and model order aside), checked at
generation. It is authored by name, never inferred from a final snapshot.
`prune` copies the checkpoint, every state after it, and every parent those
name into a fresh storage (`graph.ts` `statesFrom`); the source is never
changed, so storage stays append-only. A marker naming a dropped state moves
onto the checkpoint through `reanchor`, with baseline's live-equality proof.

The default target is the unique leaf. Multiple leaves require an explicit
target. State selectors use a full ID, unambiguous prefix, or unambiguous name.
Multiple routes require an explicit `via`; no timestamp, filename, equal
snapshot, or destructive-cost heuristic breaks the tie. `down` follows the
marker's actual arrival path and cannot cross a baseline boundary.

## Storage

`storage/contract.ts` owns the semantic storage contract:

- readers expose estate, state, snapshot, and SQL inventories and raw-byte
  reads;
- writers conditionally publish immutable estate, snapshot, SQL, and state
  bytes;
- reads and inventories are strongly consistent;
- identical bytes at an existing identity are idempotent;
- different bytes at an existing identity are corruption.

Parsers, not storage drivers, turn bytes into trusted domain values. An
unreferenced blob can be reported by `check`, but can never become executable
merely because an inventory listed it.

`storage/fs-estate.ts` owns filesystem publication:

```text
unique sibling temp
  → write and fsync
  → fresh-read verification
  → hard-link no-replace publication
  → exact-byte verification on EEXIST
  → temp unlink
  → parent-directory fsync
```

Check-then-rename is not an atomic no-replace publication. A filesystem that
cannot provide the required primitive is not a writable V1 estate.
`storage/memory.ts` is the in-memory implementation.
`storage/conformance.ts` is the reusable contract proof for writable drivers.

Eventually consistent, last-writer-wins storage is not directly writable under
this contract. It requires an external single-writer/conditional-publication
owner; the migration layer does not weaken its guarantees.

## Compilation and generation

There is one schema serializer (`serializer.ts`), one structural differ
(`differ.ts`), and one ambiguity/destructive resolver (`resolver.ts`). Migration
V1 reuses them. It does not fork schema comparison for estates or for `push`.

`compile.ts` is the one transition compiler. It turns resolved
`DiffOperation` values or complete manual `Sql` fragments into ordered
operations, checks, exact dispatches, rollback policy, typed parameters, and one
authenticated SQL blob. Dialect SQL, probes, and transactional classification
remain the bound `MigrationDriver`'s responsibility.

Literal DateTime SQL defaults are rendered by the bound migration driver from
the scalar declaration. SQLite routes INTEGER and REAL defaults through the
same physical codec as query literals; Date-object literals cross the existing ISO
admission and physical encoder too. Function defaults remain application-only.
Literal lists/JSON/bigint carry their ordinary provider representation into DDL.
A required column without a physical default cannot backfill populated rows; push
refuses before effects with a manual-backfill recipe and generated estates prove
the table empty before adding it. TEXT keeps the ISO timestamp spelling. Every admitted
public instant is writable in REAL form; a valid literal default is not refused
because a Julian-day double is not an exact binary representation.

For a scalar SQLite DateTime, `ColumnDef.dateTime` carries the declared `text`,
`epochMillis`, or `julianDay` vocabulary in authenticated generated snapshots.
The physical type alone is never logical proof, and live introspection cannot
recover this marker. V1 generation compares it between authenticated snapshots;
live push does not, because doing so would make every unchanged DateTime column
drift forever. When live push is already recreating a column whose target
declares DateTime, it treats an unmarked TEXT, INTEGER, or REAL source only as a
candidate vocabulary and validates every non-null row, including a same-form
adoption, before the source becomes trusted DateTime. It does not infer or
persist a declaration from the physical type. A fixed-decimal marker is proof
that an INTEGER is not an unmarked epoch-millisecond candidate, so adoption from
that domain is refused rather than reinterpreting its coefficient.

SQLite table recreation keeps `copySourceExpression` as the one copy-conversion
composition owner and delegates the six directed DateTime SQL spellings to
`drivers/sqlite/datetime.ts`. A copied value must prove that it is an exact
member of the source vocabulary and that the target decodes to the same
millisecond; null remains null, and malformed, out-of-range, or inexact data
aborts the recreation instead of being rounded or reinterpreted. TEXT parsing
uses the stored-text grammar (`ISO_TIMESTAMP_SHAPES`): the public timestamp
grammar — a real proleptic-Gregorian date, hour `00` through `23`, minute and
second `00` through `59`, and `Z` or a signed offset through `±23:59` — plus
SQLite's own zone-less `YYYY-MM-DD HH:MM:SS[.f{1,3}]`, read as UTC (decision
4). The client's input grammar (`validateIsoTimestamp`) does not admit the
zone-less form. A same-form unmarked TEXT adoption validates against this
grammar and keeps the spelling; `check --db` counts it. It imports the exact inclusive epoch bounds for
`0000-01-01T00:00:00.000Z` through `9999-12-31T23:59:59.999Z` from
`datetime-values.ts`; do not hand-copy those numbers. Offset arithmetic stays
integer-owned here rather than delegated to SQLite's `julianday`, whose accepted
offset range is narrower. Fractional seconds consume only their one to three
digits before the `Z` or signed-offset suffix, or the end of a zone-less value;
offset digits are never part of
the millisecond. A TEXT target must fit the same domain.

LibSQL's native `ALTER COLUMN` does not convert stored values, so every
transition into a DateTime target with a new form or logical marker bypasses
that native path and uses the same guarded recreation. Removing a DateTime
marker does not pretend to be a DateTime conversion. D1 is the shipped
batch-only SQLite substrate: when a DateTime target transition would recreate a
relation-bearing table, preflight refuses it before rendering because its
native batch cannot lift `PRAGMA foreign_keys=OFF` outside the transaction. A
relation-free D1 table can still use the guarded recreation.

`generate-v1.ts` owns candidate construction and publication:

1. hydrate and validate the schema, retaining the exact resolved relation index;
2. load and validate one graph;
3. serialize the desired snapshot;
4. resolve the selected parent or all leaves to converge branches;
5. use the existing differ and resolver for each parent, then
   `prepareSchemaProgram` so generate and push compile the same operation order;
6. compile every parent-specific transition completely;
7. compute all hashes and return the complete candidate for `dryRun`;
8. otherwise publish snapshot and SQL bytes first, then publish the state
   manifest as the sole visibility boundary. A `lowLock` generate (PostgreSQL,
   T5b) seals its step states together with the final state before anything
   publishes, then publishes them in parent order, each manifest after its own
   snapshot and SQL. Only a storage failure between two manifests can leave a
   published prefix, each a complete state, and
   `generate({ lowLock: true, from: <origin> })` completes it with identical
   state ids.

Manual work enters only through `GenerateOptions.manualMigration`. It supplies
complete parent transitions and destination checks before generation. The
estate stores final SQL and closed manifests, not a durable TypeScript migration
language. A state is wholly generated or wholly manual; custom text is not
spliced into generated operations.

## Live control and execution

`control.ts` owns the two target-qualified control tables:

```text
_viborm_migration_state  — one current marker row
_viborm_migration_log    — append-only ledger events
```

It also owns their validated naming, qualification, marker compare-and-swap,
and ledger append boundary; every row is delegated to `v1-parse.ts` for the
sole strict admission. An attempt is unfinished only when a start event has
no terminal event for the same attempt id — membership, not row or
timestamp order. Started and applied often share one millisecond, so a
sort by `startedAt` then `eventId` can put the closer first. Read-only
commands never bootstrap missing control tables or translate arbitrary
provider failures into an empty history. Bootstrap creates the state table
before the log table. An empty state-only table is therefore the one recognized
interrupted-bootstrap shape only after the dialect introspector and the native
CHECK catalog prove its exact definition and the attachment probe proves that
no trigger, rule, policy, or row-security behavior can alter recovery. This
state remains distinct from total absence. Only the bootstrap owner may drop
and recreate it; push and every other command refuse it. A colliding or
malformed empty table, a state table with a marker, or a log-only shape remains
corrupt partial history. `readControlState` is the one reader: it authenticates
a present pair once before returning marker and ledger truth. It returns every
event by default (`log()`); a command that needs only the open attempts and the
latest `failed` event passes `{ ledger: "open" }` (plan D5), and without a
marker every event is read regardless. Events come back in causal order: by
time, then within one millisecond attempt by attempt (the earliest opened, then
along the state chain, then attempt id), and within an attempt its start,
steps, close. On PostgreSQL the pair is authenticated by one catalog read of
the two control tables (columns, constraints, index count, triggers, rules,
policies, row security), never by introspecting the namespace. Apply,
baseline, and reset perform a required bootstrap under their lock before their
first effect or publication (baseline: before its live proof). On PostgreSQL it
commits on its own (`commitLockedTransaction`): PlanetScale's Neki plans a
statement against the schema committed before its transaction, so the marker
and ledger writes could not see tables made in theirs. The lock is let go
between the two transactions, so what follows re-reads the marker
(`assertLockedSinceDecision`) and proves the destination as always. `down`
commits the same way before it asks its `resolve` callback: no migration
transaction waits on the caller's work, which would idle past `idleTimeout`.
On SQLite the bootstrap shares the first transaction. A failed first apply
leaves only the control tables and its `failed` ledger event, written in a
transaction of its own after the rollback (plan S3). Stepwise providers retain the recoverable
bootstrap protocol.

`apply-v1.ts` owns forward application. Before effects it authenticates the
complete selected graph, path, state manifests, snapshots, SQL blobs, ranges,
dispatches, and parameters. Under one pinned target lock it then:

1. admits the concrete provider and proves the exact target;
2. reads marker and unfinished ledger state;
3. selects from the actual marker;
4. proves the live schema matches the marker's authenticated snapshot;
5. executes only authenticated SQL slices with typed parameters;
6. proves operation postconditions and the final target fingerprint; inside a
   real transaction a group proves only its authored checks per edge and its
   final fingerprint once;
7. compare-and-swaps the marker and appends ledger evidence;
8. releases the lock on the same physical producer.

On PostgreSQL a no-op `apply` is proven before the lock (plan D5, decision 7):
the control catalog read, then one statement that reads the marker, the open
attempts and the catalog digest in one snapshot, provided
`pg_try_advisory_xact_lock` on the migration key succeeds (released with the
statement). A marker at the target with nothing open answers `noop` when its
digest equals `fingerprintDeparsed` of the marked snapshot. That digest reads
partial-index predicates as the server deparses them (`pg_get_expr`, `$6`).
`fingerprintDeparsed` is `fingerprintSnapshot` with each partial-index
predicate replaced by the text recorded beside the marker. The record is
written only by a forward `apply` on PostgreSQL: `assertFingerprint` returns
the predicates its destination-proof introspection read, and `casMarker`
stores them in the marker row as `predicates`. `readPostgresDecision` is its
only reader. Every other command writes a marker without it, and a marker
without the record, or missing one predicate, is decided under the lock.
Anything else, including another command holding the lock or an abstaining
digest, is decided again under the lock.

On SQLite, every program that runs manual SQL — a forward transition with a
manual operation, a `manual` rollback, and `resolve` completing a manual
transition — calls `canonicalizeSqliteStorage` (`sqlite-storage-audit.ts`)
inside its transaction after the SQL and before checks, fingerprint and marker
compare-and-swap. It rewrites text DateTime/Time columns (scalar and JSON list)
into canonical text and checks decimal-list members. A row it cannot rewrite
aborts with V11014. Scalar DateTime and decimal lists come from the destination
snapshot; Time columns and DateTime lists come from the client's models,
matched by table, column and physical type.

Transactional providers keep effects, final proof, marker, and success evidence
inside the real transaction when the complete transition permits it. Inside a
real transaction a group runs its dispatches unprobed and writes no `started`
or `step-confirmed` rows; its rollback is the proof. Its last state is proven
once, the marker moves once (one revision per edge), and one statement appends
every edge's `applied` event. A failure is recorded as one `failed` event
against the edge that was running.

**PlanetScale's Neki (1.2.2).** Neki plans a statement against the schema
committed before its transaction, so a statement that resolves something the
transaction changed fails or reads the old schema, and a relation created or
renamed in it admits no column type change, rename, drop or schema move
(`NK316`).
`statement-safety.ts` `catalogCommitBoundaries` is the one rule for where a
commit must come, read from each statement's structure over the dispatches
and the authored checks in run order; the PostgreSQL driver's `serverIsNeki`
is the one owner of the Neki fact for migrations (`version()` names Neki), read once per
command by the lock protocol (`holdsSessionLock`, 1.2.3) and reused by the
preflight, which asks it only of a program that would need a commit. (Application
statements take Neki's relation bound from the connection's startup instead,
`src/drivers/shared/relation-bound.ts`: it states no lock or commit fact.) With `splits` (only `apply`, over a session)
it answers that fact and refuses only two statements of one dispatch that
need a commit between them; every other command is refused any such program
before effects (V11021). On Neki, `apply` refines plan D5's groups: an edge
joins its group while none of its statements needs a commit; one that needs
one because of the group starts the next group; one that needs one because
of its own changes runs alone as committed parts, each a locked transaction.
The first part runs the origin checks and appends `started`; every part
records its steps as `step-confirmed` in the transaction they ran in (the
`atomic` executor reports progress only when asked); the last runs the
destination checks, proves, moves the marker and appends `applied`. Each part
after the first proves the marker unmoved and the attempt the only one open
with exactly the steps this command confirmed. A failure in the first part
is the atomic group's (one `failed` event, nothing open); a later one leaves
the attempt open at its last committed part. `apply` resumes exactly that
attempt: one forward `started` attempt from the marker, on the first edge of
its route, of a transactional PostgreSQL transition, from its confirmed
prefix (`resume.ts` `remainingSteps`, shared with `down`), without the drift
proof its committed parts already moved past. On any PostgreSQL `apply` also
resumes, the same way, the attempt of a stepwise edge whose next step the
server refused whole (its announcement answered `none` with the refusal,
`execute-dispatch.ts`): it re-runs that step and the rest, never a confirmed
one, after the same marker and attempt-ownership proof, without the origin
checks (they passed against the origin before the first step; the confirmed
prefix has moved past them), and closes with the destination checks, the
destination proof and the marker. A stepwise attempt that recorded no such
refusal for its next step (a lost connection, `CALL`/`DO`/`EXECUTE`/
`CONCURRENTLY`, a failed check or proven step) still blocks (V11016), and an
announcement never answered is V11020; any other open attempt still blocks. On PostgreSQL, groups, statements and ledger events are unchanged. Stepwise and MySQL work keeps per-step
probes and progress rows. Stepwise
providers record durable progress and honest `partial` or
`may-have-committed` outcomes. An ambiguous opaque dispatch blocks later work;
the system never claims rollback merely because code opened a nominal
transaction.

**Neki's lock (1.2.3, amends plan D1 on Neki).** Neki refuses a session
advisory lock and a transaction advisory lock in one session, in either
order (`NK013 [61]`). On Neki (`holdsSessionLock`, asked on the pinned
session before anything else) a command takes the session lock once, in
autocommit, before its first read (`LockedTransactions.hold`, bounded by
`lockWait` with the same backoff), imposes the session limits after it, and
never takes the transaction lock: each group is a plain `BEGIN`, its `SET
LOCAL` limits and its work; `escalate` and `CONCURRENTLY` find the lock held.
The pre-lock no-op proof (plan D5) is not asked, its condition being the
transaction lock. Each committed group still ends `continuous`, so every
later group re-reads the marker (`assertLockedSinceDecision`) and a split
state's parts prove their attempt exactly as under transaction locks. The
lock is released at the end and on every failure, as MySQL's, and before the
caller's own work (`letLockGo`: `down`'s loss-approval callback): the session
limits are reset first, so no idle limit ends the session while the callback
runs, then the lock is released; the next statement takes both again (`hold`,
bounded by `lockWait`), and the lock is no longer continuous, so the next
group re-reads the marker (V11015 if it moved). Standard PostgreSQL and PGlite
are unchanged.

**Session limits (plan S1, amended 1.2.3).** Every setting the limits touch is
named by a constant: Neki refuses `set_config` with a computed name in a
routine body (`42501`) and over `pg_settings` rows (`NK013 [101]`). Which
optional settings the server has (`idle_in_transaction_session_timeout`,
`idle_session_timeout`, `client_connection_check_interval`; none on PGlite)
is read first; the session is reset with one `RESET` per setting set. A
refused enter or reset is `V11005` carrying the provider's SQLSTATE, never
the catalog read it preceded (`throwIfCatalogRefusal` passes a migration
error through); a session whose reset failed is abandoned, never released
to the pool. `idleTimeout` defaults to 30 s: it bounds the client's own
pauses between statements as well as a dead client's hold on the lock.
Migration errors that wrap a provider refusal carry `providerSqlState` and
`providerCode` (`providerFacts`, `execute-dispatch.ts`).

**Neon HTTP (plan D7).** A PostgreSQL driver that cannot pin a session, but
whose native batch acknowledges its commit (`runsMigrationBatches`,
`pinned-session.ts`; Neon HTTP), is admitted for `apply` only (admission
requirement `batch`); every other effectful command stays V8002. The command
reads its decision without a lock: the pre-lock no-op proof, then the marker,
the unfinished attempts, the namespace and the drift proof, each as an
ordinary request; the drift proof's predicate canonicalization sends each pass
(create, read, drop its scratch views) as one request, since separate requests
may land on separate sessions. A stepwise transition is refused while the path
is prepared (V11021). A missing control-table pair is created before the first
request, as plain statements. Each transactional group is then ONE request,
recorded by `openMigrationBatch` and sent with `_executeBatch`: the `SET LOCAL`
limits; the bounded `pg_try_advisory_xact_lock` loop (V11005);
`markerUnmovedCondition`, the SQL form of `assertLockedSinceDecision` (V11015);
the group's dispatches, with each authored check as `checkCondition` (V11014;
a check of other than one column fails the request, V11001); the catalog
digest IS NOT NULL (V11021, an abstention such as a partial index) and equal
to `fingerprintSnapshot` of the destination (V11014); `markerWrite`; one ledger
INSERT. An assertion leaves a `P0Vxx` SQLSTATE in a transaction-local setting,
and a parameterless DO block raises it; `send` maps that SQLSTATE back to the
refusal, because the message does not survive diagnostics redaction. A reply
lost before the commit was acknowledged is decided by `commitLanded`, which on
this transport reads the marker through `readPostgresDecision(…,
migrationLockFree(command))`: at the target the outcome is `applied`; a held lock or
an unreadable marker is V11020; otherwise a `failed` event (one INSERT) is
written and the transport failure returned.

`operators.ts` owns the operator workflows. `status`, `verify`, and `log` are
read-only. `baseline` requires exact live equality and a provable structural
root path; it publishes the marker and `baselined` event in one transaction
when the producer can. `reanchor` reuses that proof and publish when a restore
left the marker on a state the history lacks: it moves the marker, at revision
+ 1, onto the one history state the live schema matches, with a `reanchored`
event, and refuses a target on the old marker's own path (the lost suffix only
moved data). `prune` is offline: it copies a checkpoint's kept states into
fresh storage and touches no database. `down` preflights every reverse program, appends
`started` before the first rollback dispatch, records step progress, and uses
the same transaction wrap as apply. An unfinished rollback can only be resumed
by `down()`; an unfinished forward attempt only by `resolve`, except the
attempt of an edge `apply` split at Neki's commit boundaries and that of a
stepwise edge stopped at a step the server refused whole, which `apply`
resumes. `resolve` accepts only outcomes established by origin/destination
proof; generated structural opacity may complete from a fingerprint, while
manual opaque work still needs state checks. `resolve('rolled-back')` refuses
while a manual opaque step of the attempt committed or may have committed
(each announcement answered only by its own refusal, `countUnanswered`, the
count resume reads: a resumed retry whose reply was lost may have committed);
`apply` starts again when no marker exists and every attempt is closed by
failed, rolled-back or resolved. `down` asks before a generated destructive
rollback touches a table that holds rows (an absent table holds none); manual
rollbacks are not asked again. `reset` preloads and authenticates
the complete clear-and-replay program before the first drop, classifies every
replay transition before clearing, and executes contiguous transactional replay
groups in real transactions without letting one stepwise edge flatten the whole
path. Resume accepts only an exact contiguous confirmed-dispatch prefix. It
never replays a committed opaque dispatch, and an announced stepwise opaque
dispatch without committed evidence is an ambiguous outcome, unless each of
its announcements was answered by its recorded refusal (it left nothing). If the marker
already names the target after a crashed CAS, reset closes the exact sole reset
attempt only when the marker revision and arrival path prove that reset's CAS
advanced. An unchanged same-target source marker is not success and still runs
clear-and-replay.

## Shared live infrastructure — no second engine

Migration V1 extends the established migration infrastructure:

| Invariant | Existing owner reused by every V1 path |
| --- | --- |
| Exact durable estate target and namespace binding | `target.ts` |
| Command-local namespace spelling | `resolveCommandDriver` in `pinned-session.ts` |
| Artifact-relative versus live-qualified SQL | the dialect `MigrationDriver`, selected by required `DDLContext.destination` |
| Concrete-provider capability admission | `admission.ts` |
| One pinned producer, target selection, lock, and unlock proof | `pinned-session.ts` |
| Dependency-safe contained namespace clear | `live-reset.ts` |
| Model graph to snapshot | `serializer.ts` with the exact resolved relation index |
| Structural difference | `differ.ts` |
| Rename/destructive resolution | `resolver.ts` |
| Dialect DDL, probes, and atomicity facts | the bound `MigrationDriver` |

Do not wrap these owners in a V1-specific namespace engine, qualifier, lock,
resetter, admission registry, differ, resolver, or executor. Lock, marker CAS,
and artifact authentication protect different failure modes; none replaces
another.

## `push` is history-free

`push-v1.ts` owns V1 push identity, inert consent, marker interlock, and final
result shape. `push/index.ts` remains the dialect-aware live planning/execution
path. It is deliberately history-free and **must never receive or read estate
storage**.

The push flow is:

1. validate and serialize the desired schema;
2. introspect the exact live target and use the one differ/resolver;
3. compile one immutable internal baseline-specific program and hash every fact
   that can affect execution;
4. return an effect-free `dryRun` result and inert consent when requested;
5. reacquire the target lock, re-introspect, and reproduce the program;
6. require exact consent for destructive or force-reset work;
7. execute only that locked in-memory program;
8. re-introspect and prove live equals `fingerprintLive` of the desired
   snapshot after effects. Plan-time `desiredFingerprint` is a consent
   digest; it is not the attest target, because partial-index predicates
   cannot be canonicalized against tables that do not exist yet.

Consent is not authority and the preview is not an executable public plan. A
forged or stale value can only cause refusal. Resolution callbacks run outside
the lock; their normalized decisions are closed into consent and checked
against the locked replan.

`input-boundary.ts` is the one hostile JavaScript snapshot owner for migration
option records and arrays. Generate, down, push planning, and push consent read
each caller-owned property once, reject unknown keys, detach arrays, and
translate unreadable values to the command's `MigrationError` code before
trusted planning begins. Do not add command-local record or array readers.

Push may inspect the database control plane only to prevent history from being
made false. A non-empty push against a valid migration marker is refused. A
no-op is allowed only after the marker, unfinished-attempt state, desired
snapshot, live fingerprint, and empty authoritative diff all agree. This does
not verify estate storage; `verify` owns that operation.

Force-reset is a plan kind, not generic authorization. `dryRun` has zero
database and storage effects. The complete empty-to-target program and
dependency-safe clear are compiled before anything is dropped.

## Single owners

| Invariant or action | One owner |
| --- | --- |
| Domain-separated SHA-256 identity | `identity.ts` |
| Live physical fingerprint | `push-fingerprint.ts` `fingerprintLive`; on PostgreSQL `drivers/postgres/catalog-digest.ts` computes the same hash in one statement from introspection's own catalog sources and abstains where SQL cannot reproduce a fact exactly (some literal defaults, and partial-index predicates unless asked for them as deparsed, `$6`; only the pre-lock no-op asks, and compares with `fingerprintDeparsed`). A change to `fingerprintSnapshot`, `normalizeType`, `normalizeDefault`, `cleanDefault`, `selectManagedSnapshot` or the introspection sources must change the digest with it; `postgres-catalog-digest*.test.ts` prove equality, and a live divergence surfaces as V9001 from `assertFingerprint`. |
| Where PlanetScale's Neki needs a commit inside a PostgreSQL transaction | `statement-safety.ts` `catalogCommitBoundaries`; whether the server is Neki: the PostgreSQL driver's `preflightSchemaRequirements` |
| Operation execution order | `utils.ts` `sortOperations` |
| Generated schema compile order | `utils.ts` `prepareSchemaProgram` |
| Table drop order, its delete-action rule and the refusal of drops no order satisfies | `drop-order.ts` `orderTableDrops`; namespace reset shares only its `childrenBeforeParents` rule |
| A generated program's inverse, including which keys a recreated table restores inline (none the program dropped by itself: their own inverse restores them after every table exists) | `invert.ts` `invertOperations` |
| RFC 8785 canonical JSON bytes | `canonical-json.ts` |
| Closed V1 persisted and operation-input shapes | `v1-types.ts` |
| Frozen non-executable graph views | `public-view.ts` |
| Hostile artifact, marker, and ledger admission; derived hashes | `v1-parse.ts` |
| Stored snapshot delta admission, reconstruction, representation choice and bounded dependencies | `snapshot-artifacts.ts`, reusing the full snapshot parser |
| SQL blob framing, range validation, and exact slicing | `sql-blob.ts` |
| Semantic estate storage promises | `storage/contract.ts` |
| Atomic filesystem publication | `storage/fs-estate.ts` |
| In-memory estate behavior | `storage/memory.ts` |
| Writable-storage acceptance proof | `storage/conformance.ts` |
| Graph construction, selector resolution, and route selection | `graph.ts` |
| Structured operation, dispatch, rollback, and parameter compilation | `compile.ts` |
| Candidate generation and manifest-last publication | `generate-v1.ts` |
| Marker, ledger, control naming, qualification, and CAS | `control.ts` |
| Live transaction wrap predicate | `pinned-session.ts` `mayWrapTransaction` |
| Authenticated forward execution | `apply-v1.ts` |
| Offline estate integrity findings | `check.ts` |
| Status, verification, history display, rollback, baseline, re-anchor, prune, recovery, and history-aware reset | `operators.ts` |
| Push consent identity and history interlock | `push-v1.ts` |
| History-free dialect-aware live planning/execution | `push/index.ts` |
| Capability-sensitive migration client composition | `client.ts` |
| Package export boundary | `index.ts` |
| Identifier column type and physical form | `@schema/scalars/string/id-domain` `idStorageOf` — the three `mapScalarType`s derive from it |
| Which native type a scalar selects on this dialect (shorthand or per-dialect map) | `@schema/scalars/native-types` `nativeTypeFor` — each driver asks for its own dialect; a snapshot records only that answer |
| Refusal of an alteration INTO a binary column | `binary-conversion.ts` `refuseBinaryReencoding`, from the one `alterColumn` dispatch |
| Text→identifier conversion pre-checks, and the message PostgreSQL's `col::uuid` does not give | `identifier-conversion.ts` |

If a new check cannot be assigned to exactly one row, fix the ownership before
adding it. Consumers use trusted projections; they do not re-derive the fact.

An identifier column is the clearest case of that last sentence. A declared
format's column type is NOT a migration decision: `idStorageOf` is the same
function the adapter's read promise and the engine's parameter binding derive
from, so a column cannot be created as one thing and written as another. A
foreign key's domain is derived — the serializer reads it from the resolved
index it is already built over — and so is a junction column's and a
polymorphic carrier's, because those hold the referenced KEY's values and that
key may derive its own domain (the one-to-one child whose primary key is its
parent foreign key). They are read through the same `idDomainOf(model, field,
index)` every other column is, against the key each names; the scalar's own
declaration answers "no domain" for a derived key and would emit a `text`
column beside the `uuid` it references, which PostgreSQL refuses to key at all. A native
type override is interpreted by the same function, and one the domain cannot
live in is refused at the schema gate (F013), never mapped to a guess.
`gen_random_uuid()` narrows accordingly: it produces a `uuid`, so a `.uuid()`
field whose override makes it `bytea` gets no DDL default.

An EXISTING text column is the other half of that. Nothing converts it
automatically except PostgreSQL's `text` → `uuid`, and that one is a per-value
cast: `identifier-conversion.ts` renders the three questions a conversion has to
answer first (every row in the domain, no two rows folding together, every
foreign key still finding its parent after the fold) as `trusted-read`
`MigrationCheckInput`s the author runs, and emits one `DO` block before the
generated cast so its failure names the count and the two routes instead of one
offending row. The guard changes no outcome and owns nothing but the message;
the refusal that does change an outcome is `binary-conversion.ts`.

Two rules govern what that module renders. The fold question is asked of every
column that carries a UNIQUENESS constraint through the fold — the key, and a
referencing column that is by itself a complete key of its own model — and never
of a plain many-side foreign key, whose repeats are the relation. And every
IDENTITY comparison is asked of bytes: on MySQL each one is wrapped in
`CAST(… AS BINARY)`, because the default `utf8mb4_0900_ai_ci` answers `=` with a
case fold the `BINARY(n)` column will not, which certified an estate whose
foreign key named no parent after the conversion. The grammar match stays
uncast — MySQL's `REGEXP` refuses a binary operand, and every pattern already
spells both cases.

## Public operation surface

The migration client exposes only these operation nouns:

```text
generate
check
list
show
graph
status
verify
log
apply
down
baseline
reanchor
prune
resolve
reset
push
```

`client.ts` is the one execution composition root. `index.ts` exports no direct
operation functions. Without storage the client exposes only `push` and `log`;
a `MigrationStorageReader` adds inspection and stored-history operations; a
`MigrationStorageWriter` also adds `generate` and `reset`. The runtime object
omits operations its inspected storage cannot perform, and the static type
never promises an operation outside the storage capability the caller supplied.
`apply` targets a full state ID, unambiguous prefix, or unambiguous name;
numeric positions have no meaning. `dryRun` is an option on the relevant
operation, not a second execution API. Resolver functions and storage
constructors are utilities, not alternate execution roots.

## Forbidden architecture

The following concepts are removed and must not return under aliases:

- a **journal**, mutable global manifest, mutable head, or timestamp order;
- **squash** or inferred history compaction (an authored checkpoint is
  neither: see One graph);
- a public or internal orchestration class named **`MigrationContext`**;
- path-level storage **`get` / `put` / `delete`**;
- **`parseStatements`**, breakpoint/comment parsing, or any SQL parser service;
- **`split(";\n")` as execution framing** or any delimiter-derived boundary;
- one **latest snapshot** used as history;
- **numeric apply indexes** or filename order;
- a **migration manager**;
- an **event bus**;
- a **second differ** or resolver;
- a **public execution plan** or caller-executable operation program;
- a second migration executor, provider wrapper, generic storage transaction,
  or control-plane registry.

In particular, do not “temporarily” read legacy files to ease a transition.
VibORM is unreleased: V1 has no compatibility reader, alias, repair path, or
journal migrator.

## Navigation

| I want to… | Start here | Also inspect |
| --- | --- | --- |
| Change a hash domain or identity rule | `identity.ts` | `v1-parse.ts`, golden identity vectors |
| Change canonical JSON behavior | `canonical-json.ts` | `v1-parse.ts` |
| Change a V1 persisted shape | `v1-types.ts` | `v1-parse.ts`, `identity.ts` |
| Change strict artifact/control parsing | `v1-parse.ts` | `v1-types.ts`, `canonical-json.ts` |
| Change SQL range framing or slicing | `sql-blob.ts` | `compile.ts`, `apply-v1.ts` |
| Add a storage implementation | `storage/contract.ts` | `storage/conformance.ts`; copy neither parser nor graph logic |
| Change filesystem durability | `storage/fs-estate.ts` | `storage/contract.ts`, `storage/conformance.ts` |
| Change graph validity, selectors, or route ambiguity | `graph.ts` | `v1-parse.ts` |
| Change snapshot serialization | `serializer.ts` | schema relation resolution and bound migration drivers |
| Change structural diff behavior | `differ.ts` | `resolver.ts`; do not add an estate-specific differ |
| Change dialect statements, probes, or atomicity | the dialect `MigrationDriver` | `compile.ts`, `DDLContext.destination` |
| Change generated/manual transition compilation | `compile.ts` | `sql-blob.ts`, `v1-types.ts` |
| Change state generation or publication order | `generate-v1.ts` | `graph.ts`, storage contract |
| Change marker, ledger, control tables, or CAS | `control.ts` | `v1-parse.ts`, `pinned-session.ts` |
| Change forward application | `apply-v1.ts` | `graph.ts`, `control.ts`, `compile.ts` |
| Change offline integrity reporting | `check.ts` | `graph.ts`, storage inventories |
| Change rollback, baseline, re-anchor, prune, recovery, or reset workflow | `operators.ts` | `control.ts`, `live-reset.ts`, `apply-v1.ts` |
| Change push consent or migration-marker coexistence | `push-v1.ts` | `control.ts`, `identity.ts` |
| Change live push planning | `push/index.ts` | `push/planner.ts`, `differ.ts`; never estate storage |
| Change target admission, qualification, locking, or clear behavior | `admission.ts`, `target.ts`, `pinned-session.ts`, or `live-reset.ts` respectively | bound migration drivers |
| Change the programmatic operation surface | `client.ts` | `index.ts`, `public-view.ts`; keep the noun list and capability partition exact |

## Non-negotiable review questions

Before accepting an L12 change, answer all of these:

1. Which single owner now answers the changed invariant?
2. Are the exact bytes and typed parameters production executes authenticated?
3. Can every artifact and the full selected path fail before the first effect?
4. Does branch convergence use one explicit transition per parent?
5. Are marker truth and ledger evidence still separate?
6. Does the command use the existing target, qualification, admission, lock,
   reset, serializer, differ, resolver, compiler, and driver owners?
7. Is a stepwise failure reported without pretending it rolled back?
8. Does `push` remain fully independent of estate storage and history mutation?
9. Did any forbidden concept or unofficial public noun reappear?

The design goal is not the largest migration framework. It is the smallest one
whose estate bytes, graph, database state, execution, and operator claims cannot
contradict each other.

## Coverage Gate

`pnpm test:coverage:migrations` is the exact migration-subsystem report. It
passes the deterministic core and selected local extended groups from
`scripts/migration-test-manifest.mjs` to bounded `coverage-migrations`
invocations and writes `coverage/migrations/index.html`.

Its enforced floors are 97% statements, 98% functions and 97% lines, with
branches at 97.3%. The statement/line exception covers the PostgreSQL-only Neki
commit-boundary paths (approved 2026-10-13); live PGlite cannot fit this lane's
1536 MiB coverage ceiling. The branch-floor exception has recorded evidence in
`scripts/coverage-policy.mjs`. Its 30 documented residual arms are unreachable defensive
guards, each with a named upstream invariant: all 18 in `serializer.ts`
(hydration always assigns `names.sql`; `EnumScalar.enumValues` returns `[]`, never
`undefined`) and all 12 in `graph.ts` (a cycle there would need a SHA-256 preimage
cycle). `scripts/merge-coverage.mjs` prints each measured metric beside the floor
it enforces, so the exception is visible rather than inferred, and the floor is
still a ratchet.

Its policy check rejects omitted eligible tests and resource-owning PGlite
imports. Live DDL and external-provider behavior remain in provider projects.

## Core Estate Exception

`layer-migrations` runs every `.core.test.ts` under `tests/unit/migrations`,
and core doctrine keeps that lane free of live provider processes. A few core
contracts hold a named exception because what they assert is a property of a
real database rather than of rendered SQL; `scripts/coverage-policy.test.mjs`
holds the complete list, and these are the main ones:

| File | Live evidence it owns |
|---|---|
| `control-bootstrap.core.test.ts` | Real catalog readback of the control pair: collisions, triggers, missing primary keys, and a constraint the catalog does not report as text |
| `read-only-tracking.core.test.ts` | Control presence read by `status` before and after `apply` |
| `v1-apply.core.test.ts` | Marker arrival, committed state, and control-bootstrap recovery and rollback after an applied transition |
| `v1-operators.core.test.ts` | `down`, `reset`, `status`, and `baseline` against real applied state |
| `marker-predicates.core.test.ts` | The `predicates` record `casMarker` writes beside the marker, read back by `readControlState`, and its refusals |
| `v1-reanchor.core.test.ts` | `reanchor` after a restore left the history older than the marker, and each of its refusals |
| `v1-checkpoint.core.test.ts` | A 200-state history checkpointed, pruned and re-anchored against real applied state, and the checkpoint's refusals |
| `v1-push.core.test.ts` | Consent staleness after an external change, cross-driver consent, transactionless apply, and SQLite introspection readback |

The exception is exactly one engine: an in-process `better-sqlite3` database,
always `:memory:`, so it leaves nothing behind the worker process. No PGlite,
MySQL, PostgreSQL, LibSQL, D1, or hosted transport; no file-backed `dataDir`;
no filesystem, network, or subprocess module. Two further core contracts,
`decimal-provider-limits.core.test.ts` and `v1-provider-admission.core.test.ts`,
name a provider module to read a declared limit or capability and open no
database at all.

`scripts/coverage-policy.test.mjs` holds both lists and is the enforcement: a
core contract that reaches a provider resource without being named fails, a
named contract that no longer reaches one fails, and a named SQLite contract
that adds a second engine, a file-backed database, or a host resource fails.
Every other migration core contract drives a recording driver from
`tests/unit/migrations/_estate.ts`. A new contract joins the exception only
when its evidence cannot exist without a database; otherwise it belongs on a
recording driver or in the extended or provider estate.

## V1 remediation contracts

An optional exact physical `tables` list is normalized once at `target.ts`,
frozen into the estate identity, and selects desired/catalog inventories.
All authored user tables must fit the list; cross-boundary foreign keys and
shared PostgreSQL enums refuse before effects. Control-table proofs remain
visible. Live clients accept `{ tables }` without requiring a storage writer.
A rename needs both names in the initial immutable scope.

Generation uses the strict resolver for every parent, including merges. Missing
rename or enum-removal decisions refuse; nullable does not imply NULL consent.
Every parent's operations, rollback warnings, and labelled review SQL are
returned. Raw authenticated blob bytes and dispatch slices remain execution
owners; review text is never reparsed. Lost required columns without defaults
are irreversible unless a manual author supplies the real data transition.

PostgreSQL default DateTime/Time precision is three decimal places. Naive
`.now()` stores UTC explicitly, and temporal literals use the shared BC codec.
Generated full-schema enum changes replace the type transactionally, including
arrays and dependent defaults; enum preflight requires PostgreSQL 12 or later.
The bounded recursive advisory try-lock acquires only once and refuses after
10 seconds. The differ owns the sole destructive classification.

CLI migrations use `migrations.resolve` and `migrations.tables` from the typed
config. `--yes` skips additive prompts; destructive push requires explicit
TTY confirmation or `--accept-data-loss`. Clients finish disconnect before
failure reporting. JSON failures go to stderr with their typed code and exit
status. A TS custom author is evaluated only during generation, then closed
into the existing manual transition format.


### Unsupported physical artifact admission

Effectful planning derives `refuseConstraintNameChurn` from the migration driver's
readable-name capability. Equivalent unreadable SQLite constraint names match by
shape; readable PK/FK/unique names which cannot be adopted refuse before effects.
Generic diagnostic diffs retain differences instead of replacing a drift error
with planning admission. No physical key-name option is shipped: compound key
`name` remains a selector.

PostgreSQL catalog index proof refuses unrepresentable expressions/order/INCLUDE/
opclass/collation/methods in selected tables. SQLite `index_xinfo` proves key
members, BINARY collation and ascending order, including PK/unique backing indexes.
Unsupported artifacts in unselected tables do not widen owned scope. The refusal
preserves artifacts; it is not a native index DSL or importer.

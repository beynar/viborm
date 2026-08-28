# Migration V1 Systems Research

> Research cutoff: **2026-08-27** (Europe/Paris). This note uses only
> first-party documentation, release notes, and source code. Product claims are
> pinned to exact releases because both systems have active pre-release lines.

## Scope and source hierarchy

This note answers four questions:

1. What does the current Prisma migration system persist on disk and in the
   database?
2. What did Prisma 8 change, especially in its migration filesystem and storage
   model?
3. What do current Drizzle Kit `generate`, `migrate`, and `push` actually
   guarantee?
4. Which lessons follow for a VibORM V1 migration and push system?

The version boundary matters:

- **Prisma ORM 7.10.0** is the current generally available Prisma 7 release,
  published on **2026-08-25**. The release explicitly supports installing its
  `prisma7` CLI beside Prisma 8. [Prisma 7.10.0 release]
- **Prisma ORM 8.0.0-rc.8** is the newest Prisma 8 release found at the cutoff,
  published on **2026-08-26** and still marked **Pre-release**. [Prisma
  8.0.0-rc.8 release]
- **Drizzle ORM/Kit 1.0.0-rc.4** is the newest V1 release candidate, published
  on **2026-06-27** and marked **Pre-release**. [Drizzle 1.0.0-rc.4 release]
- **Drizzle 0.45.2**, published on **2026-03-27**, is the latest stable release
  shown by the first-party repository. The V3 filesystem findings below target
  the V1 RC line, not the older stable line. [Drizzle releases]

When current documentation and tagged implementation disagree, this note
reports the disagreement and treats the tagged release/source as the owner of
exact behavior. That rule is important for Prisma 8: some current migration
pages still show the pre-0.17 snapshot layout and `sha256:`-prefixed hashes,
while the newer release and `rc.8` source have already removed both.

## Executive finding

### Observed facts

Prisma 8 is not a cosmetic refresh of Prisma Migrate. It replaces a linear
“run this numbered SQL file once” history with authenticated transitions between
content-addressed schema states:

```text
editable TypeScript intent
        ↓ compile
authenticated operations + from/to state hashes
        ↓ apply under database coordination
current-state marker + append-only execution ledger
```

The strongest parts are the separation between authoring and production
execution, a hash over the exact executable operations, state-based path
selection, per-operation prechecks/postchecks, and PostgreSQL apply under one
transaction and advisory lock. The newest filesystem change deduplicates schema
snapshots in a content-addressed store. [Prisma migration model] [Prisma 0.17.0
release] [Prisma migration hashing source] [Prisma PostgreSQL runner source]

Drizzle V1 takes a leaner route. Each generated migration directory owns a SQL
file and a schema snapshot, and there is no shared journal file to become a Git
merge hotspot. Snapshots carry graph parents, and `drizzle-kit check` detects
some non-commutative branches. Runtime apply is still a lexicographically sorted
SQL list, however. The database decides pending work by migration directory
name; although it stores a SQL hash, current selection code does not validate
that hash for an already applied name. [Drizzle V3 release] [Drizzle generator
source] [Drizzle migrator source] [Drizzle pending-selection source]

Both current authoring paths publish multi-file migration directories
non-atomically. Prisma atomically publishes content-addressed snapshots, but not
the migration package itself. Drizzle writes `snapshot.json` before
`migration.sql`; its generator discovers snapshots while its migrator discovers
SQL files. An interruption between those writes can therefore make generation
observe history that execution does not. This crash state is inferred directly
from the two first-party readers and the write order; neither vendor documents
it as a guarantee. [Prisma package I/O source] [Prisma snapshot-store source]
[Drizzle generator source] [Drizzle migrator source]

### Inferred direction for VibORM

VibORM should combine the good ideas, not copy either product wholesale:

- preserve plain, reviewable SQL as the dialect-specific execution artifact;
- pair it with a strict manifest that authenticates the SQL, parent state, end
  state, dialect, and tool/storage format version;
- publish immutable content first and make one state manifest the atomic
  visibility boundary;
- use a live state marker for path correctness and an append-only ledger for
  audit, never one table ambiguously serving both jobs;
- serialize runners and use compare-and-swap in addition to the lock;
- use transactional DDL only where the dialect can honor it, with an explicit
  partial-apply/recovery model everywhere else;
- keep `push` as a separate direct-reconciliation workflow with a mandatory
  plan, precise destructive consent, and post-apply verification;
- provide first-class `status`, `verify`, `baseline`, and recovery commands.

Those are design lessons, not observed VibORM requirements. The evidence for
each is developed below.

## Observed facts: Prisma 7, the current GA system

### Filesystem and source of truth

Prisma 7 represents history as:

```text
prisma/migrations/
├── migration_lock.toml
├── 20260101120000_init/
│   └── migration.sql
└── 20260102130000_add_posts/
    └── migration.sql
```

The documentation calls the whole `prisma/migrations` directory the source of
truth and requires committing it, including `migration_lock.toml`. Production
`migrate deploy` consumes migration files, not the Prisma schema. The database
table `_prisma_migrations` records whether migrations ran and enough checksum
state to identify edits. [Prisma 7 migration histories]

This is a linear, provider-specific SQL history. Prisma 7 refuses an automatic
provider switch because PostgreSQL, MySQL, SQLite, and SQL Server histories are
not interchangeable. [Prisma 7 limitations]

### Development and production guarantees differ

`migrate dev` replays the disk history in a shadow database, detects edited or
deleted files and live-schema drift, applies pending work to the shadow, creates
a new migration, then applies pending work to the development database. It may
ask to reset the development database when drift or history conflict exists.
[Prisma 7 development workflow]

`migrate deploy` is deliberately narrower:

- it warns when an applied migration was modified;
- it applies pending migrations;
- it does **not** warn when an applied migration is missing from disk;
- it does **not** detect live production drift;
- it does not use a shadow database or reset the target. [Prisma 7 production
  workflow]

The production commands use provider advisory locks with a fixed ten-second
timeout; the lock can be disabled by an environment variable. [Prisma 7
production workflow]

Transactional behavior is provider-dependent. Prisma's own documented policy
is: SQL Server migrations are wrapped, PostgreSQL migrations are not wrapped by
default but users may add `BEGIN`/`COMMIT`, and MySQL does not provide
transactional DDL for this purpose. [Prisma Migrate transaction policy]

### `db push`

Prisma 7 `db push` reconciles the Prisma schema directly to a live database
without using migration history. It exposes `--accept-data-loss` and a
destructive `--force-reset`; it does not create a reviewable migration file.
[Prisma 7 `db push` reference]

Prisma 7.10.0 added an AI-agent safety checkpoint around interactive data-loss
confirmation as well as `--accept-data-loss`. This is an invocation safeguard,
not migration history or recovery. [Prisma 7.10.0 release]

## Observed facts: Prisma 8.0.0-rc.8

### The user loop

The documented loop is:

```text
contract emit
    → migration plan
    → review/edit migration.ts and preview
    → db migrate
```

Planning and inspection are offline: they read emitted contracts and migration
history, not the live database. `db migrate` is the only step in this loop that
applies the planned package. [Prisma migration model]

`rc.8` corrected a dangerous origin ambiguity: if migrations already exist,
`migration plan` no longer silently plans a full-create package from an empty
origin. It refuses and requires an explicit state/baseline choice. [Prisma
8.0.0-rc.8 release]

### Current filesystem layout

The `0.17.0` release on **2026-08-04** made two clean-break storage changes:

1. hashes are bare hexadecimal strings, not `sha256:<hex>`;
2. per-migration start/end snapshot siblings were replaced with one
   content-addressed snapshot store under the migrations root. [Prisma 0.17.0
   release]

The current conceptual layout is therefore:

```text
migrations/
├── snapshots/
│   └── <64-hex-storage-hash>/
│       ├── contract.json
│       └── contract.d.ts
└── app/
    ├── refs/
    │   └── <name>.json
    └── <timestamp_slug>/
        ├── migration.ts
        ├── migration.json
        └── ops.json
```

Each distinct contract snapshot is stored once. A migration imports its
bookend contract types from the shared store. [Prisma 0.17.0 release] The
`rc.8` implementation verifies that the snapshot's declared storage hash
matches its directory key, writes both snapshot files to a temporary directory,
then renames that directory into place. Existing content-addressed entries are
idempotent. [Prisma snapshot-store source]

#### Documentation drift found

The current “How migrations work” page still shows sibling
`start-contract.json`, `end-contract.json`, and `*-contract.d.ts` files and
still prints `sha256:` prefixes. The newer `0.17.0` release explicitly removes
that layout and the tagged `rc.8` source implements the shared store. The
release/source is the owner for the current RC. [Prisma migration model]
[Prisma 0.17.0 release]

The graph page also still says “No baseline,” while the newer `rc.8` release
says explicit baseline planning remains available. The safe conclusion is that
automatic adoption/squashing is still immature, but explicit baseline selection
exists in `rc.8`. [Prisma migration graph] [Prisma 8.0.0-rc.8 release]

### Three distinct migration artifacts

The core package separates:

- `migration.ts`: editable TypeScript intent and data/schema authoring;
- `ops.json`: the compiled operations that production runs;
- `migration.json`: strict history metadata including `from`, `to`,
  `providedInvariants`, `createdAt`, and `migrationHash`. [Prisma migration
  model] [Prisma package I/O source]

Production does not execute `migration.ts`. It consumes `ops.json`, so arbitrary
authoring-time application code does not run with production database
credentials. [Prisma migration model] [Prisma applying migrations]

The package hash is SHA-256 over canonicalized manifest content (excluding the
`migrationHash` field itself) plus canonicalized `ops.json`. It therefore
authenticates the state bookends, other manifest metadata, and the exact
executable operation payload. It does **not** authenticate `migration.ts` or the
snapshot bytes as part of that package hash. [Prisma migration hashing source]

The package reader rejects missing `migration.json`/`ops.json`, invalid JSON,
unknown manifest fields, invalid operations, a mismatched derived-invariant
list, and a migration-hash mismatch. [Prisma package I/O source]

### Filesystem crash behavior

Snapshot publication is atomic at the directory-visibility boundary. Migration
package publication is not: the current writer creates the final directory,
writes `migration.json`, then writes `ops.json`. A process failure between those
writes leaves a partial final directory, though the reader later refuses it.
[Prisma package I/O source] [Prisma snapshot-store source]

This is an implementation observation, not a Prisma-documented durability
promise. It suggests that VibORM can raise the bar by publishing the whole
package through one temporary-directory rename.

### State graph, refs, marker, and ledger

Every migration is an edge from the `from` contract hash to the `to` contract
hash. Directory timestamps are human labels, not execution order. The database
stores a marker naming its current graph node; `db migrate` finds a path from
that marker to an explicit target, a ref, or the emitted contract. It refuses an
ambiguous reachable tip rather than choosing by timestamp. [Prisma migration
graph]

Refs are small repository files that name important contract states. The marker
answers “where is this database now?” The append-only ledger answers “what ran,
when, and along which edge?” Rollbacks append another edge and ledger entry;
they do not delete or rewrite history and cannot resurrect discarded data.
[Prisma migration graph] [Prisma rollback and recovery]

In PostgreSQL, the control data lives under `prisma_contract`, including marker,
ledger, and contract records. Current code writes one ledger record per applied
edge and records the operations as actually executed, substituting skip records
for idempotency-skipped work. [Prisma PostgreSQL runner source] [Prisma
PostgreSQL control storage source]

### Apply integrity and failure model

Each operation contains:

1. prechecks for its required origin conditions;
2. executable statements;
3. postchecks for its destination condition. [Prisma migration model]

Before execution, the runner also evaluates the postcheck and skips an operation
whose result already holds. That makes retries converge when the database is
already partly or externally changed in a recognized way. A failed precheck
stops before that operation's DDL. [Prisma applying migrations]

For PostgreSQL, current `rc.8` source begins one transaction for all contract
spaces in the run, acquires a transaction-scoped advisory lock per space,
checks/updates the marker, writes per-edge ledger entries, and commits once. A
failure rolls the run back. The marker update also uses compare-and-swap, so a
lost coordination assumption fails instead of silently overwriting another
runner's state. [Prisma PostgreSQL runner source]

These are PostgreSQL guarantees. The docs describe MongoDB coordination as a
marker compare-and-swap because cross-collection DDL transactions do not exist.
They do not justify projecting PostgreSQL atomicity onto every Prisma 8 target.
[Prisma applying migrations]

### Status, verification, and recovery

Prisma 8 exposes separate read models:

- `migration status`: database marker versus graph path;
- `migration log`: database ledger;
- `migration check`: offline file and graph integrity;
- `db migrate --show`: read-only apply preview;
- `db verify`: marker check plus live-schema verification, optionally strict
  against extra objects, with exit code `4` for drift/marker findings. [Prisma
  migration model] [Prisma applying migrations] [Prisma `db verify`]

Rollback is a new forward-recorded migration to an earlier state, not a down
file. Failed PostgreSQL runs need no partial cleanup because the whole run rolls
back. Recovery beyond `db verify`, `db update`, and `db init` remains manual for
unusual drift. [Prisma rollback and recovery]

### `db update`, the Prisma 8 direct-reconciliation path

`db update` introspects the live database, diffs it against an emitted contract,
and applies the result without creating a checked-in migration package. It has
`--dry-run`, structured `--json`, an explicit `--to`, and a database-name
confirmation for destructive changes. Non-interactive destructive apply must
provide `--confirm <database>`. [Prisma `db update`]

This creates no portable, reviewable graph edge on disk. It is recommended for
local development, preview environments, and workflows where direct
reconciliation is acceptable; reviewed production changes should use
`migration plan` plus `db migrate`. [Prisma `db update`]

### Explicit RC gaps

Current first-party docs still identify these gaps:

- no shadow-database execution rehearsal for Prisma 8 apply;
- no apply-time proof that `ops.json` still corresponds to `migration.ts`;
- no migration squash or post-hoc split command;
- ambiguous graph tips require explicit target selection;
- unusual drift recovery remains manual. [Prisma applying migrations] [Prisma
  migration graph] [Prisma rollback and recovery]

Because `rc.8` is a pre-release and its release policy permits breaking changes
between RCs, none of these shapes should be treated as a frozen third-party
contract yet. [Prisma 8.0.0-rc.8 release]

## Observed facts: Drizzle V1 RC.4

### V3 migration filesystem

The V3 folder format arrived in `1.0.0-beta.2` on **2025-12-02**. It removed the
shared `journal.json`, grouped each SQL file with its own snapshot, and removed
the `drop` command. Drizzle's stated reason was to remove a shared Git conflict
hotspot and make conflicted migrations easier to discard or repair. [Drizzle V3
release]

Current generation writes:

```text
drizzle/
└── <timestamp_slug>/
    ├── snapshot.json
    └── migration.sql
```

`drizzle-kit generate` reads the TypeScript schema, builds a JSON snapshot,
compares it with migration snapshots, emits SQL, and stores both files in the
new directory. Custom empty SQL migrations remain supported. [Drizzle
`generate` docs]

The tagged writer creates the final directory and writes `snapshot.json` before
`migration.sql`; it does not use a temporary directory or rename publication.
[Drizzle generator source]

### Snapshot lineage and commutativity checks

Current snapshots have a random UUID `id` and an array of parent identifiers,
`prevIds`. A generated merge snapshot can name multiple open leaf snapshots.
[Drizzle PostgreSQL snapshot source] [Drizzle PostgreSQL serializer source]

`drizzle-kit check` strictly parses the snapshot version and dialect shape, then
runs a dialect-specific non-commutativity detector. `generate` and the Kit CLI
`migrate` invoke this check. Conflicts refuse by default; `--ignore-conflicts`
bypasses that refusal. [Drizzle `check` docs] [Drizzle check source] [Drizzle CLI
composition source]

The snapshot graph is a generation/conflict-analysis structure, not the runtime
apply order. Direct `drizzle-orm` migrators receive SQL migration metadata and
do not invoke Kit's snapshot checker. [Drizzle migrator source] [Drizzle CLI
composition source]

### Runtime file reader and order

The V1 runtime reader:

- refuses the old V2 `meta/_journal.json` layout;
- lists subdirectories that contain `migration.sql`;
- sorts directory names lexicographically;
- treats the first 14 characters as a UTC timestamp;
- splits SQL on the literal `--> statement-breakpoint` delimiter;
- computes SHA-256 over the complete SQL text. [Drizzle migrator source]

It does not read `snapshot.json`. Therefore the generation DAG does not choose a
database's path through history; after conflict checking, runtime execution is
the sorted SQL list.

### Database migration table and pending selection

For PostgreSQL, the default storage is
`drizzle.__drizzle_migrations`, configurable by table and schema. The current
table holds `id`, `hash`, `created_at`, `name`, and `applied_at`. [Drizzle
`migrate` docs] [Drizzle PostgreSQL migrate source]

Pending selection reads all database rows, creates a set of applied `name`
values, and applies local folders whose names are absent. The stored SQL `hash`
is not compared with the current local hash in this selection path. [Drizzle
pending-selection source]

Consequences directly implied by that code:

- editing `migration.sql` after its named folder was applied is not refused by
  the current migrator;
- removing an applied folder is not surfaced by pending selection;
- the stored hash is audit data, not an enforced execution identity in this
  path.

These are source-derived facts about `v1.0.0-rc.4`, not claims about an
unreleased future Drizzle design.

### Apply transaction and concurrency

The current PostgreSQL, MySQL, and SQLite core migrators collect all pending
migrations and execute them inside one ORM transaction, inserting the database
row after each migration's statements. PostgreSQL and SQLite can therefore
roll back the pending apply batch when their underlying DDL is transactional.
[Drizzle PostgreSQL migrate source] [Drizzle MySQL migrate source] [Drizzle
SQLite migrate source]

The MySQL wrapper cannot make the same whole-batch promise: many MySQL DDL
statements cause implicit commits, so an outer transaction does not make a
multi-statement migration atomic. [MySQL implicit-commit reference]

No dedicated advisory/migration lock acquisition appears in the complete stock
PostgreSQL, MySQL, or SQLite migration functions inspected at `rc.4`. Their
transaction protects database atomicity where supported, but it is not a
portable “one migration runner at a time” protocol. [Drizzle PostgreSQL migrate
source] [Drizzle MySQL migrate source] [Drizzle SQLite migrate source]

### Filesystem split-brain under interruption

The generator discovers every `snapshot.json`; the migrator independently
discovers every `migration.sql`. Because the writer publishes the snapshot
first, interruption between its two writes can leave this state:

```text
generation sees:  snapshot.json
execution sees:   no migration.sql
```

This is an inference from the exact first-party write/read order. It is not a
documented Drizzle durability guarantee. It is nevertheless a concrete failure
mode VibORM should falsify and prevent. [Drizzle generator source] [Drizzle
migrator source]

### `drizzle-kit push`

`push` is direct reconciliation:

1. read the TypeScript schema into a snapshot;
2. introspect the live database;
3. diff them into SQL;
4. apply SQL without generating migration files. [Drizzle `push` docs]

Current V1 options include `--explain` for a dry plan and `--force` to
auto-approve data-loss statements. In non-interactive text mode or JSON mode,
unresolved renames and destructive changes return a structured
`missing_hints` response and require structured hints before retry. RC.4 also
added typed JSON envelopes and a public `drizzle-kit/cli` SDK. [Drizzle
1.0.0-rc.4 release] [Drizzle CLI composition source]

For PostgreSQL and MySQL, the current push handlers send generated statements
one at a time and do not open a command-level transaction. SQLite delegates the
whole list to the configured database `batch` method, whose atomicity is
provider-specific. No migration directory or migration-table history is
created. [Drizzle PostgreSQL push source] [Drizzle MySQL push source] [Drizzle
SQLite push source]

## Comparative matrix

| Concern | Prisma 7.10 GA | Prisma 8.0.0-rc.8 | Drizzle 1.0.0-rc.4 |
| --- | --- | --- | --- |
| Disk unit | Timestamp directory with `migration.sql` | TypeScript intent + strict manifest + compiled `ops.json`; shared content-addressed snapshots | Timestamp directory with `migration.sql` + `snapshot.json` |
| History model | Linear ordered files | Graph edge from exact `from` state to exact `to` state | Snapshot DAG for conflict analysis; lexicographic SQL list for apply |
| Executed artifact | SQL file | `ops.json`; never `migration.ts` | SQL file split by breakpoint comments |
| Execution integrity | Applied checksum tracked; deploy warns on edits | Canonical hash over manifest + exact ops; strict load verification | SQL hash stored, but current pending selection is by folder name only |
| Filesystem atomic publication | Not documented | Snapshot directory yes; migration package no | No; snapshot is written before SQL |
| Live current-state owner | `_prisma_migrations` linear history | Per-space contract marker | Applied-name set derived from `__drizzle_migrations` |
| Audit owner | `_prisma_migrations` | Separate append-only per-edge ledger | `__drizzle_migrations` row per applied folder |
| Apply selection | Pending linear files | Path from live marker to explicit/resolved graph target | Local names absent from DB name set |
| PostgreSQL atomicity | Off by default unless SQL is edited | Whole run, all spaces, one transaction | All pending migrations in one ORM transaction |
| Cross-run coordination | Provider advisory lock, 10-second timeout | PostgreSQL transaction advisory lock + marker CAS | No dedicated migration lock in inspected stock paths |
| Operation pre/post proof | SQL/provider failure only | Per-operation precheck, execute, postcheck; satisfied operations skip | SQL/provider failure only |
| Drift | `migrate dev` shadow DB; `deploy` does not detect production drift | Marker/path checks plus explicit `db verify` live-schema modes | Snapshot consistency check; no equivalent live-schema verify in migrate |
| Branch merge | Linear files; team resolves ordering/history | State graph, paths, refs, explicit ambiguous target | Snapshot parent graph + commutativity check; bypassable |
| Rollback | Manual forward repair / diff and execute | New forward-recorded edge to an earlier state | Custom forward SQL |
| Direct sync | `db push`; no history, data-loss flag | `db update`; dry run, typed consent, verify flow, no checked-in edge | `push`; explain, structured hints, no history |
| Maturity at cutoff | GA | RC | RC; stable line is older |

## Inferred design lessons for VibORM V1

Everything in this section is an inference from the observed systems, not a
claim about current VibORM behavior.

### 1. Authenticate what production runs

The irreducible requirement is not “use JSON operations” or “use TypeScript
migrations.” It is: a reviewer and the production runner must agree on the exact
bytes/operations being authorized.

For VibORM, the smallest compatible design is:

```text
estate.json                   # immutable physical target
snapshots/<hash>.json         # content-addressed schema states
sql/<hash>.sql                # reviewed execution artifacts
states/<state-id>.json        # strict graph node and commit marker
```

The state hash should cover the estate, parent transitions, destination
snapshot, exact SQL ranges, parameters, and every non-SQL execution payload.
Applied state must be reauthenticated before the system decides “already
applied.” This keeps Drizzle's transparent SQL while closing the integrity gap
its current name-only selection leaves open. The Prisma 8 package hash proves
the value of authenticating executable payloads separately from editable
intent. RFC 8785 supplies a cross-runtime JSON canonicalization contract rather
than leaving identity to object insertion order or a private formatter. [Prisma
migration hashing source] [Drizzle pending-selection source] [RFC 8785]

### 2. Publish one state through one atomic manifest boundary

Publish content-addressed snapshot and SQL blobs first, then conditionally
create the state manifest last. The state reader lists only manifests, so an
interruption can leave harmless unreferenced content but cannot expose a partial
state. On filesystems, use a proven no-replace primitive and flush the file and
parent directory; check-then-rename is not a create-if-absent operation.

At startup and in CI, reject:

- a state manifest missing any referenced blob;
- an unexpected file or manifest key;
- a bad artifact hash;
- a hash collision with different bytes;
- duplicate state IDs or invalid graph edges.

This deliberately exceeds both current authoring implementations. Prisma's
snapshot store demonstrates the correct visibility pattern; Prisma's package
writer and Drizzle's snapshot-first writer demonstrate why one final committed
record must own visibility. [Prisma snapshot-store source] [Prisma package I/O source]
[Drizzle generator source]

### 3. Separate current state from audit history

A current-state marker and an append-only ledger answer different questions:

```text
marker: “Which exact schema state may the next migration start from?”
ledger: “Which migration attempts and successful transitions happened?”
```

Do not derive current state from “the last row by timestamp,” and do not use a
mutable marker as the audit record. Prisma 8's split is clearer than both linear
systems. The ledger should record at least migration ID, artifact hash, parent
state, destination state, dialect, started/finished timestamps, tool version,
success/failure/partial outcome, and a redacted failure classification. [Prisma
migration graph] [Prisma PostgreSQL runner source]

### 4. Serialize and compare-and-swap

A database-scoped migration lock prevents normal concurrent runners. A marker
compare-and-swap catches coordination failure, lock misconfiguration, or a
competing tool. Both are justified because they protect different failure
modes; this is not redundant defense.

The lock must have a documented key, timeout, and error. The CAS must be part of
the same transaction as DDL and ledger publication where the dialect permits.
Prisma 8 PostgreSQL currently demonstrates this combined model; Prisma 7 shows
that a lock without strong state identity still leaves drift questions.
[Prisma PostgreSQL runner source] [Prisma 7 production workflow]

### 5. Make dialect failure semantics explicit

One “transactional migration” boolean is too vague. Each migration driver needs
declared capabilities:

- transactional DDL for the relevant operations;
- transaction scope (statement, migration, or whole run);
- advisory/application lock support;
- savepoints;
- whether DDL implicitly commits;
- whether a failed statement may leave a partial effect.

PostgreSQL and SQLite should use an atomic migration boundary when safe. MySQL
must persist enough progress to diagnose and recover from partial apply; wrapping
it in a nominal transaction must never be presented as atomic. [MySQL
implicit-commit reference] [Drizzle MySQL migrate source] [Prisma Migrate
transaction policy]

### 6. Use preconditions and postconditions selectively

Prisma 8's strongest operational improvement is not its file extension; it is
that every planned change states what must be true before and after. VibORM does
not need a second abstract migration language to gain most of this value.

A lean design can attach adapter-owned probes to generated operations:

- precondition: target object and dependent data have the assumed shape;
- SQL execution;
- postcondition: the intended object shape now holds.

Custom raw SQL can remain opaque and be marked as such. Generated changes should
be provable. Retry may skip only when the postcondition proves the complete
effect, never merely because a statement name was seen. [Prisma migration
model]

### 7. Branch safety requires lineage, not timestamp rituals

The minimum V1 requirement is explicit parent identity and a refusal when two
merged branches cannot be reconciled safely. A full arbitrary graph may be more
than VibORM needs initially. A linear parent hash plus a first-class
merge/rebase diagnostic could satisfy the same safety requirement with less
machinery.

What must not remain is silent timestamp ordering after two branches both claim
the same parent. Prisma 8 resolves paths through state nodes; Drizzle identifies
multiple snapshot parents and checks commutativity. Both show that the conflict
is semantic, not a filename problem. [Prisma migration graph] [Drizzle check
source]

### 8. Make `push` a separate product contract

`push` should never impersonate a recorded migration. It should have two explicit
modes:

```text
push --plan       # introspect, diff, classify, print structured plan; no writes
push --apply      # apply exactly that authenticated plan
```

Destructive apply should require target identity, not a generic boolean. The
plan should have a hash so the consented plan cannot change between preview and
apply. Apply should use the same lock, dialect transaction policy, and
post-verification as migrations, but it should not fabricate a checked-in
history edge. Prisma 8's database-name consent and Drizzle's structured hints
are both useful precedents. [Prisma `db update`] [Drizzle 1.0.0-rc.4 release]

### 9. Ship status, verify, baseline, and recovery with apply

Migration apply is not V1-ready if operators cannot answer:

- What exact artifact is this database on?
- Are disk history and database history mutually consistent?
- Has an applied artifact been edited or removed?
- Does the live schema match the recorded destination?
- What would run next?
- What happened in the last failed or partial run?
- How do I adopt an existing database without replaying creation?

These should be first-class commands with stable JSON output and distinct exit
codes. Prisma 8's marker/ledger/status/verify split is the strongest current
model; Drizzle RC.4's JSON envelopes and `missing_hints` protocol are the better
automation surface. [Prisma `db verify`] [Prisma applying migrations] [Drizzle
1.0.0-rc.4 release]

### 10. Keep history immutable; recover forward

Applied migration artifacts should be immutable. A wrong successful migration
is corrected by a new migration. A failed non-transactional migration is
resolved by a recorded recovery action that proves the live state before
advancing the marker. Down files should not promise restoration of deleted data.
Prisma 8 states this clearly; the same rule can be implemented without copying
its entire graph UI. [Prisma rollback and recovery]

## Unknowns and limits of this research

1. **Prisma 8 is still an RC at this cutoff.** The final `8.0.0` filesystem,
   command names, and support matrix may change. The public docs banner now
   defaults to Prisma 8, but the official release remains `8.0.0-rc.8` and is
   marked pre-release. [Prisma 8.0.0-rc.8 release]
2. **Prisma 8 docs lag the tagged source.** Snapshot placement, hash spelling,
   and baseline wording disagree. This note resolves those points using the
   newer release and source, but other documentation may contain similar lag.
3. **Prisma 8 non-PostgreSQL apply guarantees were not generalized.** The
   PostgreSQL transaction/lock/CAS behavior is proven from its runner. MongoDB
   uses a different model; SQLite was not exhaustively audited here.
4. **Neither vendor publishes a formal filesystem durability contract.** The
   partial-directory findings are source-derived. This research did not test
   power-loss behavior or directory `fsync` behavior on every supported OS.
5. **Drizzle commutativity is not a formal proof for arbitrary SQL.** The
   current checker is dialect-specific and can be bypassed. Custom SQL and
   direct ORM migrator calls need separate policy.
6. **Drizzle provider wrappers vary.** The core PostgreSQL, MySQL, and SQLite V1
   migrators were inspected. Hosted/serverless wrappers may impose narrower
   transaction or batch semantics.
7. **Network deployment orchestration is outside scope.** Neither a migration
   tool nor a transaction by itself proves zero-downtime application rollout.
   Expand/contract workflow, application-version compatibility, backups, and
   operational approvals need their own acceptance criteria.

## Primary sources inspected

### Prisma releases and current docs

- [Prisma 7.10.0 release] — 2026-08-25.
- [Prisma 8.0.0-rc.8 release] — 2026-08-26, pre-release.
- [Prisma 0.17.0 release] — 2026-08-04; content-addressed snapshots and bare
  hashes.
- [Prisma migration model]
- [Prisma migration graph]
- [Prisma applying migrations]
- [Prisma rollback and recovery]
- [Prisma `db update`]
- [Prisma `db verify`]

### Prisma 7 docs

- [Prisma 7 migration histories]
- [Prisma 7 development workflow]
- [Prisma 7 production workflow]
- [Prisma 7 limitations]
- [Prisma 7 `db push` reference]
- [Prisma Migrate transaction policy]

### Prisma 8 tagged source (`v8.0.0-rc.8`)

- [Prisma package I/O source]
- [Prisma migration hashing source]
- [Prisma snapshot-store source]
- [Prisma PostgreSQL runner source]
- [Prisma PostgreSQL control storage source]

### Drizzle releases, docs, and tagged source (`v1.0.0-rc.4`)

- [Drizzle V3 release] — 2025-12-02.
- [Drizzle 1.0.0-rc.4 release] — 2026-06-27, pre-release.
- [Drizzle releases]
- [Drizzle `generate` docs]
- [Drizzle `migrate` docs]
- [Drizzle `push` docs]
- [Drizzle `check` docs]
- [Drizzle generator source]
- [Drizzle migrator source]
- [Drizzle pending-selection source]
- [Drizzle check source]
- [Drizzle CLI composition source]
- [Drizzle PostgreSQL snapshot source]
- [Drizzle PostgreSQL serializer source]
- [Drizzle PostgreSQL migrate source]
- [Drizzle MySQL migrate source]
- [Drizzle SQLite migrate source]
- [Drizzle PostgreSQL push source]
- [Drizzle MySQL push source]
- [Drizzle SQLite push source]

[Prisma 7.10.0 release]: https://github.com/prisma/orm/releases/tag/7.10.0
[Prisma 8.0.0-rc.8 release]: https://github.com/prisma/orm/releases/tag/v8.0.0-rc.8
[Prisma 0.17.0 release]: https://github.com/prisma/orm/releases/tag/v0.17.0
[Prisma migration model]: https://docs.prisma.io/docs/orm/migrations/how-migrations-work
[Prisma migration graph]: https://docs.prisma.io/docs/orm/migrations/the-migration-graph
[Prisma applying migrations]: https://docs.prisma.io/docs/orm/migrations/applying-a-migration
[Prisma rollback and recovery]: https://docs.prisma.io/docs/orm/migrations/rollbacks-and-recovery
[Prisma `db update`]: https://docs.prisma.io/docs/cli/db-update
[Prisma `db verify`]: https://docs.prisma.io/docs/cli/db-verify
[Prisma 7 migration histories]: https://docs.prisma.io/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/migration-histories
[Prisma 7 development workflow]: https://docs.prisma.io/docs/orm/v7/prisma-migrate/workflows/development-and-production#create-and-apply-migrations
[Prisma 7 production workflow]: https://docs.prisma.io/docs/orm/v7/prisma-migrate/workflows/development-and-production#production-and-testing-environments
[Prisma 7 limitations]: https://docs.prisma.io/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/limitations-and-known-issues
[Prisma 7 `db push` reference]: https://docs.prisma.io/docs/cli/v7/db/push
[Prisma Migrate transaction policy]: https://www.prisma.io/blog/prisma-migrate-dx-primitives#what-if-schema-migrations-were-atomic
[Prisma package I/O source]: https://github.com/prisma/orm/blob/v8.0.0-rc.8/packages/1-framework/3-tooling/migration/src/io.ts#L23-L64
[Prisma migration hashing source]: https://github.com/prisma/orm/blob/v8.0.0-rc.8/packages/1-framework/3-tooling/migration/src/hash.ts#L20-L83
[Prisma snapshot-store source]: https://github.com/prisma/orm/blob/v8.0.0-rc.8/packages/1-framework/3-tooling/migration/src/contract-snapshot-store.ts#L35-L95
[Prisma PostgreSQL runner source]: https://github.com/prisma/orm/blob/v8.0.0-rc.8/packages/3-targets/3-targets/postgres/src/core/migrations/runner.ts#L70-L213
[Prisma PostgreSQL control storage source]: https://github.com/prisma/orm/blob/v8.0.0-rc.8/packages/3-targets/3-targets/postgres/src/contract-free/control-bootstrap.ts
[Drizzle V3 release]: https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.2
[Drizzle 1.0.0-rc.4 release]: https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.4
[Drizzle releases]: https://github.com/drizzle-team/drizzle-orm/releases
[Drizzle `generate` docs]: https://orm.drizzle.team/docs/drizzle-kit-generate
[Drizzle `migrate` docs]: https://orm.drizzle.team/docs/drizzle-kit-migrate
[Drizzle `push` docs]: https://orm.drizzle.team/docs/drizzle-kit-push
[Drizzle `check` docs]: https://orm.drizzle.team/docs/drizzle-kit-check
[Drizzle generator source]: https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-kit/src/cli/commands/generate-common.ts#L52-L94
[Drizzle migrator source]: https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/migrator.ts#L48-L88
[Drizzle pending-selection source]: https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/migrator.utils.ts#L14-L24
[Drizzle check source]: https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-kit/src/cli/commands/check.ts#L140-L233
[Drizzle CLI composition source]: https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-kit/src/cli/schema.ts#L94-L115
[Drizzle PostgreSQL snapshot source]: https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-kit/src/dialects/postgres/snapshot.ts#L532-L562
[Drizzle PostgreSQL serializer source]: https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-kit/src/dialects/postgres/serializer.ts#L25-L97
[Drizzle PostgreSQL migrate source]: https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/pg-core/async/session.ts#L277-L347
[Drizzle MySQL migrate source]: https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/mysql-core/async/session.ts#L268-L348
[Drizzle SQLite migrate source]: https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/sqlite-core/async/session.ts#L374-L552
[Drizzle PostgreSQL push source]: https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-kit/src/cli/commands/push-postgres.ts#L120-L173
[Drizzle MySQL push source]: https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-kit/src/cli/commands/push-mysql.ts
[Drizzle SQLite push source]: https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-kit/src/cli/commands/push-sqlite.ts
[MySQL implicit-commit reference]: https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html
[RFC 8785]: https://www.rfc-editor.org/rfc/rfc8785

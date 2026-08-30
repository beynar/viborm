# Migration V1: Authenticated State Graph and Safe Push

> **Status:** canonical implementation plan
> **Research cutoff:** 2026-08-27
> **Companion evidence:**
> [migration-v1-systems-research.md](./migration-v1-systems-research.md)
> **Sequence:** implement after the database-namespace program has established
> exact physical targets and pinned migration sessions.

## 1. Outcome

VibORM V1 migrations must make four claims truthfully:

1. the exact reviewed SQL and parameters are what production executes;
2. Git branches can diverge and converge without renaming or reordering files;
3. interrupted generation or application has one detectable, recoverable state;
4. `push` never executes a different live plan from the one the user accepted.

The current global journal, single latest snapshot, name-based tracking, and SQL
delimiter parser cannot support those claims. Replace them with:

```text
immutable estate descriptor
        +
content-addressed schema snapshots and SQL blobs
        +
immutable migration-state manifests
        +
database current-state marker
        +
append-only execution ledger
```

One migration-state manifest is one graph node. It records the target schema
snapshot and one authenticated transition from each parent state. A normal
state has one parent. A branch merge has two or more parent transitions into the
same target state. Human names are metadata only; they never decide order.

`push` remains a separate, history-free live synchronization tool. It reuses
the same differ, statement compiler, lock, execution, and postcondition owners,
but never reads or writes migration state artifacts or pretends it created
history.

The ORM is unreleased. There is no reader, alias, or migrator for journal
versions 1, 2, or the version 3 proposed by the namespace plan. Existing local
fixtures are regenerated against the V1 format.

## 2. Immediate release blocker

Before the graph program, or as its first patch if the namespace program has not
already closed it, repair the current reset path:

- `viborm push --force-reset --dry-run` must perform **zero** database effects;
- force-reset must validate the schema and compile the complete empty-to-target
  program before it clears anything;
- CLI and programmatic push must use one reset owner;
- push must never receive migration storage.

Today the CLI clears the database before it observes `dryRun` in
[`src/cli/commands/push.ts`](../../src/cli/commands/push.ts), while the
programmatic path clears before full planning in
[`src/migrations/push/index.ts`](../../src/migrations/push/index.ts). This is an
independent data-loss defect, not something to leave open until the filesystem
redesign is complete.

## 3. The bar

The research compares Prisma 7.10, Prisma 8.0.0-rc.8, Drizzle 1.0.0-rc.4, and
mature integrity practices. Prisma 8 and Drizzle V1 are release candidates, so
their ideas are inputs, not authorities.

| Concern | Competitor bar | VibORM V1 bar |
| --- | --- | --- |
| Execution identity | Prisma 8 hashes canonical manifest plus compiled operations | Recompute exact SQL, typed parameters, manifest, transition, state, estate, and snapshot hashes before every effect |
| Human review | Drizzle keeps plain SQL; Prisma separates editable source from production operations | Keep exact plain SQL plus a strict manifest; production executes only authenticated SQL slices and parameters |
| Branches | Prisma uses a state graph; Drizzle snapshots carry parents and run a commutativity check | One target-state manifest contains a transition from every parent; no lexical apply order and no “apply every missing branch” guess |
| Storage | Prisma atomically publishes snapshots but not packages; Drizzle publishes snapshot before SQL | Publish immutable content first and commit one state manifest through an atomic no-replace boundary; no mutable global journal |
| Apply state | Prisma separates current marker and ledger | Exact marker CAS plus append-only event ledger, under the same database boundary where possible |
| Retry | Prisma operations use precheck, execute, and postcheck | Every generated effect step has pre/post proof; skip only when the complete postcondition already holds |
| Drift | Prisma 8 exposes `db verify`; Prisma 7 deploy does not check production drift | Refuse apply when live managed schema does not match the marker's authenticated snapshot; verify again before advancing the marker |
| Push | Prisma/Drizzle direct sync has preview and destructive confirmation | Hash the complete baseline-specific plan, replan under lock, require exact consent, and prove the final schema |
| Recovery | Mature tools enforce immutable applied artifacts; MySQL remains non-transactional | Record honest stepwise progress and ambiguous dispatch; never report rollback that the provider could not perform |

VibORM does not need Prisma's extension “spaces,” a Studio migration UI, or a
universal shadow database to meet this bar. It does need the integrity,
coordination, recovery, and operator contracts below.

## 4. Settled ownership

This program extends existing owners. It does not add a second migration
engine.

| Fact or action | Single owner |
| --- | --- |
| Model-to-snapshot serialization | existing migration serializer with the exact resolved relation index |
| Structural difference and destructive/rename resolution | existing differ and unified resolver |
| Dialect statements, probes, and transactional classification | bound `MigrationDriver` |
| Exact migration target | `MigrationTarget` from the namespace program |
| Estate parsing, graph construction, and path selection | one internal migration-estate module |
| Durable state publication | semantic migration storage driver |
| Live session, lock, marker, ledger, and execution boundary | internal migration context |
| Direct synchronization plan | existing push planner |
| User confirmation | CLI or programmatic composition root, never the executor |

Do not introduce a migration manager, event bus, generic storage transaction,
SQL parser service, provider wrapper, second differ, second executor, or public
operation-program API.

### 4.1 Relationship to the namespace plan

Retain these decisions from
[database-namespace-plan.md](./database-namespace-plan.md):

- the exact `MigrationTarget` union;
- PostgreSQL schema-bound artifacts and MySQL database-relative artifacts;
- bound migration drivers and `DDLContext.destination`;
- live-provider admission;
- one pinned PostgreSQL/MySQL session and target-specific lock;
- target-qualified control tables;
- manual transaction/lock-control refusal;
- one dependency-safe reset owner;
- complete compile-before-clear force reset;
- push's total independence from migration storage.

This plan supersedes the namespace plan's persistence and history-collision
shapes:

- version-3 `MigrationJournal` becomes immutable `estate.json` plus graph
  states;
- the mutable journal entry list disappears;
- the single `_snapshot.json` disappears;
- name/checksum-only applied tracking becomes marker plus ledger;
- journal accessors and journal-specific validation disappear;
- a non-empty direct push no longer drops or leaves behind a truthful-looking
  migration marker; it refuses and directs the caller to generate/apply or
  history-aware reset.

`estate.json` stores the same durable target truth. MySQL still persists only
`{ dialect: "mysql" }`; its live database remains an environment-specific
session target.

## 5. Domain model

Use these terms exactly:

- **Estate** — one storage root and its immutable target descriptor, snapshots,
  SQL blobs, and committed state manifests.
- **Schema snapshot** — one strict canonical description of the VibORM-managed
  physical and logical schema.
- **State** — one exact point in migration history. It has a schema snapshot and
  authenticated incoming transitions.
- **Transition** — the forward and rollback program from one parent state to a
  target state.
- **State manifest** — the single committed record defining one target state,
  its human metadata, and all its parent transitions.
- **Marker** — the database's last confirmed state ID and arrival path.
- **Ledger** — immutable database events describing attempts and outcomes.
- **Push plan** — an ephemeral, baseline-specific live transition that is never
  inserted into the estate.

Schema identity and migration-state identity are deliberately different. A
data-only migration can leave the physical schema unchanged but must still
move the database to a new migration state. This avoids a public “invariant
token” concept solely to make data migrations visible.

## 6. On-disk format

### 6.1 Layout

```text
migrations/
├── estate.json
├── snapshots/
│   └── <schema-hash>.json
├── sql/
│   └── <sql-hash>.sql
└── states/
    └── <state-id>.json
```

There is no journal, down directory, backup directory, mutable head file, or
timestamp index.

`estate.json` is created once and never updated:

```ts
interface MigrationEstateDescriptorV1 {
  readonly format: "1";
  readonly target: MigrationTarget;
  readonly hash: "sha256";
}
```

The descriptor contains no state list and no current head. Concurrent
generation therefore cannot lose an update to a shared file. A PostgreSQL
estate remains bound to its configured schema; MySQL and SQLite retain the
portable target forms settled by the namespace plan.

### 6.2 Snapshot identity

`snapshots/<schema-hash>.json` is canonical UTF-8 JSON with a strict format
discriminator and the complete stored `SchemaSnapshot`. Its filename is the
lowercase 64-hex SHA-256 of the exact canonical bytes. The document does not
contain its own hash.

One parser must:

- reject unknown versions, unknown keys, malformed nested members, duplicate
  names, non-canonical order, and illegal scalar values;
- recompute the filename hash from the exact bytes;
- derive the expected live physical fingerprint through the existing dialect
  canonicalization owner;
- preserve logical-only history such as polymorphic storage while excluding it
  from live physical comparison.

No `JSON.parse(...) as SchemaSnapshot` remains.

### 6.3 State manifest

`states/<state-id>.json` has one strict versioned shape:

```ts
interface MigrationStateManifestV1 {
  readonly format: "1";
  readonly estateHash: Sha256;
  readonly name: string;
  readonly stateId: Sha256;
  readonly snapshotHash: Sha256;
  readonly sqlHash: Sha256;
  readonly destinationChecks: readonly MigrationBooleanCheckV1[];
  readonly parents: readonly MigrationParentTransitionV1[];
}

interface MigrationParentTransitionV1 {
  readonly fromState: Sha256 | null;
  readonly transitionHash: Sha256;
  readonly originChecks: readonly MigrationBooleanCheckV1[];
  readonly requestedForwardBoundary:
    | "transactional"
    | "stepwise"
    | null;
  readonly operations: readonly MigrationOperationV1[];
  readonly rollback: MigrationRollbackV1;
}
```

Each operation groups exact effect steps. Stepwise recovery is dispatch-level,
so a step contains exactly one provider dispatch:

```ts
interface MigrationOperationV1 {
  readonly id: string;
  readonly label: string;
  readonly origin: "generated" | "manual";
  readonly risk: "safe" | "destructive" | "opaque";
  readonly steps: readonly MigrationStepV1[];
}

type MigrationStepV1 =
  | {
      readonly retry: "proven";
      readonly precheck: MigrationBooleanCheckV1;
      readonly execute: MigrationDispatchV1;
      readonly postcheck: MigrationBooleanCheckV1;
    }
  | {
      readonly retry: "opaque";
      readonly execute: MigrationDispatchV1;
    };
```

Checks accept one normalized boolean result. Dispatches carry one authenticated
SQL slice plus a closed typed-parameter tuple. The exact nested
check/dispatch/parameter and rollback shapes are closed discriminated unions,
not `unknown` bags. Unknown fields fail.

`requestedForwardBoundary` is non-null only for a manual transition. It records
the author's required execution boundary, not an atomicity fact. A manual
rollback stores its own independent requested boundary inside
`MigrationRollbackV1`. Generated forward and rollback programs carry no such
claim.

The parameter codec accepts only canonical tagged values: null, boolean,
string, finite number, bigint decimal text, bytes, date-time, fixed decimal,
and canonical JSON. Generation uses the existing SQL parameter-normalization
owner and refuses every unsupported or non-canonical value. Apply decodes these
tags back through that same SQL boundary; it never reparses display text.

Hash rules have one implementation and frozen domain labels so two different
artifact kinds cannot share a digest accidentally:

1. `estateHash` hashes exact canonical `estate.json` bytes.
2. `snapshotHash` hashes exact canonical snapshot bytes.
3. `sqlHash` hashes exact SQL blob bytes.
4. Each `dispatchId` hashes `sqlHash`, byte offset/length, and the canonical
   typed-parameter tuple.
5. `transitionHash` hashes the complete parent transition without its own hash,
   including its parent, origin checks, boundary request, operations, rollback
   policy, and all dispatch IDs.
6. `stateId` hashes the complete canonical state manifest without `stateId`,
   including estate, snapshot, SQL, destination checks, parent transitions,
   and name.

Canonical JSON means RFC 8785 JSON Canonicalization Scheme bytes in UTF-8 with
no BOM. Hash input is a frozen ASCII domain label, one `0x00` separator, then
the canonical bytes. Golden vectors must match in Node.js, Bun, and the Workers
runtime before this becomes a V1 format. No locale, insertion order, platform
line ending, or display formatter participates in identity.

Parent transitions are sorted by full `fromState` (`null` first) before SQL and
manifest construction. Parent input order therefore cannot change identity.
Operation, step, parameter, and check arrays retain semantic execution order and
are never sorted after compilation.

The state ID is therefore the state identity, like a Git commit: two byte-
identical concurrent candidates are idempotent; different human metadata or
transition content creates two safe child states rather than a duplicate-ID
corruption. Every read recomputes all six layers. There is no self-referential
checksum header and no checksum derived from bytes different from those
executed.

### 6.4 Exact SQL framing

`sql/<sql-hash>.sql` is the plain review artifact and contains every precheck,
effect dispatch, postcheck, and rollback dispatch. State entries identify each
executable fragment by the SQL blob hash, UTF-8 byte offset, byte length, and
derived dispatch ID.

The executor validates the complete range table before the first effect, then
slices exact bytes. It never searches for a comment marker and never splits on
semicolon-plus-newline. Ranges are ordered and non-overlapping; every byte
outside a range must be the fixed `\n\n` display separator. Generated output is
UTF-8/LF without a BOM, and manual fragments containing `\r` are refused rather
than silently normalized.

Generated DDL already has proven server-statement boundaries, including a
PostgreSQL dollar-quoted function, a MySQL stored routine, or a SQLite trigger
with internal semicolons. Manual generation accepts one `Sql` value per opaque
provider dispatch. That value may contain any text the provider accepts; V1
does not claim to count its server statements. A multi-parent merge supplies
one complete manual transition per parent. MySQL `DELIMITER` is refused because
it is a client command, not server SQL.

A generated logical-only schema change may commit a state with an empty SQL
blob and zero effect steps. A state whose full snapshot and transition program
are both unchanged is a no-op and is not published. Manual migrations remain
non-empty because their purpose is the supplied effect. Each declared manual
forward or rollback program therefore contains at least one dispatch, and no
manual dispatch may render as empty or whitespace-only SQL. Accepted manual SQL
is not trimmed, split, or otherwise normalized.

### 6.5 Immutable states

A state is immutable from the moment its manifest is visible. There is no
official in-place edit, draft lifecycle, checksum repair, or historical source
compiler.

`generate({ dryRun: true })` returns the complete candidate before publication.
Ordinary `generate` publishes a fully resolved candidate. Custom data/backfill
work is supplied through the programmatic manual-migration boundary before
generation; the final estate stores only the exact SQL and closed manifest
production needs. Once shared, a correction is a new state. This is the
Flyway-style immutability rule made structural instead of advisory.

## 7. One state graph

### 7.1 Graph construction

Build the graph from committed state manifests. Names are labels only.
The builder validates, in one pass:

- exact estate target and format;
- estate, SQL, transition, state, and snapshot hashes;
- one manifest per content-addressed state ID;
- one transition per parent in a state;
- present parent states and snapshots;
- root transitions only from the one virtual `null` origin; multiple outgoing
  root states are legal branches;
- no cycles, dangling states, duplicate edges, or unreachable states;
- either no states, for a fresh estate, or at least one valid root-to-leaf path;
- no partial manifest or unreferenced bytes masquerading as history.

The virtual `null` origin maps to the serializer's canonical empty managed
snapshot for the estate target. It is not a stored second root and cannot be
redefined by a state manifest.

The builder returns one immutable `MigrationGraph`. `list`, `show`, `check`,
`status`, `verify`, `generate`, `apply`, `down`, `baseline`, and `reset`
consume that exact instance for one command. No consumer rescans directories or
reconstructs order.

### 7.2 Linear history

A normal state has one parent:

```text
A ── transition ──> B
```

The target state B contains B's snapshot and the exact A-to-B program.

### 7.3 Branch convergence

Two branches from A are legal:

```text
      B
     / \
A ──    ──> D
     \ /
      C
```

D is one state with two parent transitions: B-to-D and C-to-D. A database at
B executes only B-to-D; a database at C executes only C-to-D. No environment
blindly applies “every missing migration,” and no timestamp decides which
branch wins.

When all divergent changes are generated structural operations, `generate`
diffs each leaf snapshot against the desired snapshot and produces the complete
multi-parent state. When a path contains custom/data behavior that cannot be
reconstructed safely, generation returns one unresolved parent-transition
request and writes nothing. The caller must supply the complete manual
transition and common destination checks for every unproved parent. Never infer
that two equal schema snapshots imply equal data state.

### 7.4 Target and path selection

The default target is the unique leaf. If multiple leaves exist, omission of
`to` is an error naming every candidate; an explicit target remains valid.
`to` accepts a full state ID, an unambiguous prefix, or an unambiguous state
name; numeric indexes disappear.

One available route is selected automatically. Two or more routes always
require an explicit `via`; equal snapshots and destination checks do not prove
equal data loss or effect order. V1 performs no commutativity inference and no
filename breaks the tie.

The public path shape is exact:

```ts
type StateSelector =
  | { readonly id: Sha256 }
  | { readonly prefix: string }
  | { readonly name: string };

interface ApplyOptions {
  readonly to?: StateSelector;
  readonly via?: readonly Sha256[];
  readonly dryRun?: boolean;
}

interface ResetOptions {
  readonly to?: StateSelector;
  readonly via?: readonly Sha256[];
  readonly dryRun?: boolean;
}

interface BaselineOptions {
  readonly to: StateSelector;
  readonly via?: readonly Sha256[];
}

type DownOptions =
  | {
      readonly steps?: number;
      readonly to?: never;
      readonly dryRun?: boolean;
    }
  | {
      readonly to: StateSelector;
      readonly steps?: never;
      readonly dryRun?: boolean;
    };
```

`via` contains full target state IDs for every selected forward edge; its final
member must equal resolved `to`. Apply starts after the actual marker, or at
`null` when no marker exists. Baseline and reset start at `null` because they
record or replay a complete root path; reset is allowed to rebuild below an old
baseline boundary. Every adjacent pair must be a real edge and no member may
repeat. `down` never accepts `via`; it follows the marker's actual arrival path,
cannot cross a baseline boundary, and makes `steps`/`to` mutually exclusive.

Path ambiguity is detected by a DAG dynamic program whose count saturates at
two. `MIGRATION_PATH_REQUIRED` returns at most two full-ID witness routes plus
the compact first divergent frontier and a `more` boolean; it never enumerates
every path. Apply preview/effect, baseline, and reset preview/effect use the same
command-specific origin validator and return the selected route.

### 7.5 Data-only states

Because `stateId` includes parent transition hashes, a data-only manifest
creates a new state even when `snapshotHash` is unchanged. No public invariant
registry is needed. Its operation and optional state-level destination checks
provide runtime proof where possible; an opaque data dispatch remains honestly
opaque and restricts retry or recovery unless explicit checks prove an end
state.

## 8. Planning and compilation

Do not add a durable TypeScript migration language in this program. It would
create a second long-lived compiler/version/import contract without improving
the identity of the SQL production runs.

Preserve the existing generated/manual distinction:

- ordinary `generate` converts resolved `DiffOperation` values into structured
  operations;
- the manual boundary accepts complete ordered `Sql` fragments and rollback
  policy before generation;
- a multi-parent state accepts one complete manual transition per parent when
  structural generation cannot prove convergence;
- optional destination checks are supplied with those transitions, not through
  another registry or source file.

Replace the current string artifact with this exact input boundary:

```ts
interface ManualMigrationInput {
  readonly transitions: readonly ManualTransitionInput[];
  readonly destinationChecks?: readonly MigrationCheckInput[];
}

interface ManualTransitionInput {
  readonly from: Sha256 | null;
  readonly execution: "transactional" | "stepwise";
  readonly up: readonly Sql[];
  readonly originChecks?: readonly MigrationCheckInput[];
  readonly rollback:
    | {
        readonly kind: "manual";
        readonly execution: "transactional" | "stepwise";
        readonly sql: readonly Sql[];
      }
    | { readonly kind: "irreversible"; readonly reason: string };
}

interface MigrationCheckInput {
  readonly kind: "trusted-read";
  readonly query: Sql;
  readonly equals: boolean;
}
```

`GenerateOptions.manualMigration` is the only entry for this value.
`from` is a full parent state ID, not a display name or numeric position. A
fresh estate uses `null`. Every `Sql` value is one opaque provider dispatch;
generation creates one opaque step per value and never infers internal
boundaries. The whole state is generated or manual—V1 does not splice custom
text into the middle of generated operations. Forward and rollback execution
requirements are independent. A provider that cannot honor a requested
transactional boundary refuses before effects.

`generate({ dryRun: true })` exposes the exact SQL, parameters, checks,
operation origins/risks, parent transitions, and hashes that publication would
store. Committed estate files are output only; no command recompiles historical
application code.

Extend the existing migration driver so each `DiffOperation` compiles to a
structured operation:

```text
operation label and risk class
  → zero or more prechecks
  → ordered exact dispatches
  → zero or more postchecks
  → transaction classification
```

The bound migration driver derives forward and rollback atomicity separately
from their exact dispatches and the admitted provider. The resolved values live
only on the command's trusted transition projection; they are not persisted as
a second fact. The loader recomputes them on every command. A manual boundary
request is a constraint: the driver must honor it exactly or refuse before the
first effect.

Generated steps must have enough pre/post proof to support safe retry. A custom
operation may be marked opaque, but the manifest and CLI must show that fact.
An opaque operation cannot be automatically skipped or declared recovered from
a partial step.

Checks have two explicit trust classes. Driver-generated probes use a closed
internal catalog/data predicate language and are the only checks the ORM proves
read-only. A manual `trusted-read` check stores exact `Sql` and an expected
boolean; it is migration-author code, may run more than once, and must be
deterministic and side-effect free. The system authenticates and type-checks its
one-row boolean result but does not pretend syntax classification can prove a
PostgreSQL function harmless. This is a trusted-author boundary, not a provider
security claim.

Every stepwise manual forward transition and manual rollback must provide
non-empty checks for both of its end states: parent-origin checks and common
destination checks. The same checks reverse roles during rollback. Otherwise
apply or down refuses before effects because the ORM cannot infer which data or
schema effects arbitrary SQL contains. A transactional manual transition may
omit them because the database boundary and marker commit establish the outcome
together.

The compiler is also the one owner used by push and reset. Remove all
`split(";\n")`, breakpoint parsing, driver/adapter duplicate DDL splitting, and
raw comment deletion.

## 9. Migration storage

### 9.1 Semantic contract

Replace public path-level `get`/`put`/`delete` with two deliberate contracts:

```ts
interface MigrationStorageReader {
  readEstate(): Promise<Uint8Array | null>;
  listStates(): Promise<readonly Sha256[]>;
  listSnapshots(): Promise<readonly Sha256[]>;
  listSql(): Promise<readonly Sha256[]>;
  readState(id: Sha256): Promise<Uint8Array | null>;
  readSnapshot(hash: Sha256): Promise<Uint8Array | null>;
  readSql(hash: Sha256): Promise<Uint8Array | null>;
}

interface MigrationStorageWriter extends MigrationStorageReader {
  publishEstate(bytes: Uint8Array): Promise<PublishResult>;
  publishSnapshot(hash: Sha256, bytes: Uint8Array): Promise<PublishResult>;
  publishSql(hash: Sha256, bytes: Uint8Array): Promise<PublishResult>;
  publishState(id: Sha256, bytes: Uint8Array): Promise<PublishResult>;
}
```

`generate` requires the writer. Apply and read commands require only the reader.
The high-level parser, not the storage implementation, turns bytes into trusted
domain values.

The three inventories are part of the read contract so generic `check` can
report orphan snapshot/SQL blobs, malformed names, and missing references.
Apply selects history from state manifests only; an unreferenced blob never
becomes executable because it appears in an inventory.

The contract promises strongly consistent reads/listing and conditional
create. Content-addressed bytes are idempotent; a different payload at one hash
is corruption. A state becomes visible only when its one manifest key is
created. A driver unable to make this promise is not a writable migration
estate.

Workers KV is not a direct estate owner because its eventual consistency and
last-writer-wins behavior violate this contract. It needs a single-writer
coordinator or an immutable deployment bundle outside KV. S3 and R2 can
implement the contract with conditional writes and strong consistency.

### 9.2 Filesystem publication

The filesystem driver must:

1. write each estate/snapshot/SQL/state candidate to a unique sibling temporary
   file without following symlinks;
2. flush it and validate its hash from a fresh read;
3. publish its final pathname with a proven no-replace primitive, such as a
   same-filesystem hard link from the temporary file;
4. treat `EEXIST` as idempotent only after exact-byte verification;
5. remove the temporary link and flush the parent directory.

A check-then-rename sequence is forbidden because it can overwrite after a
race. On a supported filesystem where Node cannot provide atomic no-replace
publication, the writer refuses instead of weakening the contract. State
manifests are published after their snapshot and SQL blobs, so they are the
single visibility boundary. Stale temporary files and unreferenced blobs are
ignored by normal reads and reported by `check`; they are never history.

### 9.3 Object-store publication

An object-store driver writes immutable SQL/snapshot objects first and
conditionally creates the state manifest last. `listStates()` lists only
committed manifest keys. Missing referenced content is an integrity failure,
not “not generated yet.”

No global head or manifest is conditionally replaced. Two concurrent generators
from one parent safely create two child states. The next `check` reports two
leaves, and the next generation converges them.

## 10. Database control plane

Use two target-qualified control tables derived from one validated base name:

- `_viborm_migration_state` — one current marker row;
- `_viborm_migration_log` — append-only attempt/progress/outcome events.

The marker stores format, `estateHash`, current `stateId`, current
`snapshotHash`, the exact root-to-current path of state/transition hashes,
revision, and update time. The path is current-state truth: apply appends one
edge, down pops the edge actually used, and a baseline starts a path with an
explicit non-rollback boundary. A state change is compare-and-swap: the old
state, path hash, and revision must still match.

Control-table bootstrap belongs to the same locked context. Transactional
providers create both tables with the first marker/ledger publication in the
same transaction. Stepwise providers preflight their exact definitions, create
them idempotently before user-schema effects, then re-read and verify both
definitions. After interruption, the next effectful command completes a missing
control table or refuses a mismatched one. Read-only commands never bootstrap.

The ledger stores, at minimum:

- attempt and event IDs;
- state, transition, SQL, estate, and snapshot hashes;
- from/to states and direction;
- operation/dispatch identity;
- `started`, `step-confirmed`, `applied`, `failed`, `rolled-back`, `baselined`,
  `resolved`, `reset-started`, `reset-step-confirmed`, or `reset-applied` event
  kind;
- `none`, `committed`, `partial`, or `may-have-committed` effect state;
- start/finish timestamps and tool version;
- for `reset-started` only, the canonical reset-plan payload described below;
- normalized redacted failure evidence.

Events are appended; finalized evidence is never updated or deleted. The
marker answers the last confirmed state. An unfinished ledger attempt says the
live schema may be between states and blocks ordinary work. The ledger answers
history. Do not derive one from the other.

Estate format `"1"`, state-manifest format `"1"`, hash canonicalization domains,
and both control-table row formats become permanent compatibility contracts at
V1. Future tool versions remain separate metadata and must continue decoding
and verifying V1 history; the pre-release journal deletion does not authorize
post-V1 format amnesia.

Control tables are excluded from normal schema snapshots, push diffs, drift
fingerprints, and reset inventory except where the reset policy explicitly owns
them.

## 11. Apply protocol

### 11.1 Before the lock

Build and validate the complete graph and selected path. Read every required
SQL blob, state manifest, snapshot, and rollback artifact; recompute every hash;
validate every byte range and typed parameter; and compile no late SQL after
this point.

An invalid later state must fail before an earlier database effect.

### 11.2 Under one pinned target lock

The namespace program's pinned-session owner performs:

1. live-provider admission and exact target assertion;
2. target-specific lock acquisition;
3. read-only marker and unfinished-attempt read;
4. authoritative path selection from the actual marker;
5. live managed-schema introspection;
6. exact comparison with the marker state's authenticated snapshot;
7. transition execution;
8. target snapshot verification;
9. marker compare-and-swap and ledger publication;
10. unlock and producer disposal.

If the marker is absent, ordinary apply requires the managed target to be empty
apart from control objects. Adopting an existing schema is `baseline`, not an
implicit first apply.

### 11.3 Operation protocol

For each proven step:

1. evaluate the complete postcheck;
2. if it already holds, append a skip/confirmed event and continue;
3. otherwise require the precheck;
4. execute the exact authenticated dispatch and typed parameters;
5. require the postcheck;
6. append confirmed progress when the provider boundary is durable.

A precheck and postcheck both failing means unknown or external state. Stop.
Never retry merely because a dispatch has a familiar operation type or name.

An opaque step has no pre/post branch. Inside a proven transaction it executes
once and inherits the transaction's commit/rollback truth. In stepwise mode the
runner first appends a durable dispatch-start event, dispatches once, and then
appends acknowledgement. If the driver proves `none`, a retry may dispatch it
again. `partial`, `committed` without marker advancement, or
`may-have-committed` immediately leaves an unresolved attempt; no later step or
migration may run until recovery establishes a complete origin or destination.

After all operations, require every target state-level destination check, then
re-introspect and require exact target physical schema equality before the
marker may advance.

### 11.4 Transactional transitions

On PostgreSQL and local SQLite, when every operation admits transactional DDL,
run the effects, final physical verification, ledger success, and marker CAS in
one transaction. `BEGIN IMMEDIATE` owns the local SQLite writer boundary.

A provider error rolls back the marker and effects together. A best-effort
failure event may be appended after rollback, but failure logging is not allowed
to change the application error.

### 11.5 Stepwise transitions

MySQL DDL and explicitly non-transactional PostgreSQL operations use the same
stepwise protocol under the session lock:

- append `started` before the first possible effect;
- append a durable confirmation after each proven dispatch;
- retain the unfinished attempt on disconnect or process death;
- inspect postchecks on retry to distinguish completed, not-started, and unknown
  steps;
- advance the marker only after the final live fingerprint matches;
- block later migrations while any attempt is unresolved.

An opaque statement whose outcome is ambiguous cannot auto-resume. It requires
`resolve` after operator inspection. Never claim MySQL rollback because code was
wrapped in a nominal transaction.

## 12. Operator workflows

### 12.1 `check`

`check` is offline by default and CI-safe. It validates every byte/hash, strict
domain shape, snapshot, graph edge, target, virtual root, leaf, path, rollback
policy, referenced blob, and state completeness. It returns stable structured
findings and non-zero exit codes for invalid estate or unresolved branches.

An optional replay mode may use an explicitly supplied disposable database.
V1 does not automatically create, drop, or soft-reset a shadow database. The
caller must provide an empty target and the command must prove emptiness before
work.

### 12.2 `status`, `verify`, and `log`

- `status` is read-only. It reports current marker, selected target, path,
  pending transitions, and any unfinished attempt. A missing control table is
  distinct from permission, transport, malformed-row, and wrong-target errors.
- `verify` acquires the migration lock, compares estate, marker, applied state
  hashes, and live managed schema, then releases without effects.
- `log` reads ledger events and joins them to state names when storage is
  available. Missing state or SQL bytes remain visible as integrity findings.

None of these commands creates a table or catches a provider failure as “no
migrations applied.”

### 12.3 `baseline`

`baseline({ to })` adopts an existing database without executing a migration.
Under the target lock it requires:

- no existing marker or ledger history;
- exact live physical equality with the target state's snapshot;
- a complete valid estate path to that state;
- no manual, opaque, or data-only transition anywhere on that path.

It then appends a baseline event and inserts the marker atomically where the
dialect permits. It cannot baseline a merely similar or partially matching
database, and it does not infer invisible data history from schema equality.
Adopting such a database requires a new structural root state whose snapshot
describes the current managed schema; V1 does not accept an operator assertion
as state proof. The marker records a baseline path boundary, so `down` cannot
invent an arrival parent that was never executed on this database.

### 12.4 `down`

Rollback uses the authenticated reverse transition stored with the parent path
the database actually used. It appends ledger events and moves the marker back;
it never deletes an earlier ledger row.

Rollback policies are honest:

- `schema` — restores the managed schema shape but may lose data created after
  the forward migration;
- `manual` — author-owned reverse operations and checks;
- `irreversible` — no reverse transition, with a required reason.

Generated destructive changes are not called data-restoring. Group-wide
preflight still proves every selected reverse transition before the first
effect.

### 12.5 `resolve`

`resolve` is a narrow recovery command, not checksum repair. It appends one
audited resolution event and changes the marker only when live proof permits:

- mark complete only when all remaining postchecks, every destination check,
  and the target physical fingerprint hold;
- mark rolled back only when every parent-origin check and the origin physical
  fingerprint hold;
- retry only from the first step whose postcheck is false and precheck true;
- otherwise refuse until the operator explicitly restores either the origin or
  destination proof, then records that fact through `resolve`.

Equal physical fingerprints are not proof for a data-only or opaque transition.
If that transition omitted the checks needed to distinguish its two states,
`resolve` refuses rather than accepting an operator label as evidence.

No option can bless changed state or blob bytes, delete a failed attempt, or
invent a state that is absent from the estate.

### 12.6 `reset`

Migration reset preloads and proves the complete root-to-target path before
clearing. It preserves the estate, both control-table structures, every existing
ledger event, and the old marker until final success. The active reset attempt
in the ledger makes that marker explicitly the last confirmed state, not a
claim that the live schema is still stable.

Before the first possible drop, the reset owner appends one authenticated
`ResetPlanV1` to `reset-started`. It contains the estate/target identity, source
marker revision and fingerprint, selected full-ID replay path, exact generated
clear dispatches with typed parameters and checks, referenced state/transition
hashes, and `resetPlanHash`. It references immutable estate programs instead of
copying them. No other migration event duplicates executable estate content.

PostgreSQL/local SQLite run the reset plan, replay, final verification, ledger
success, and marker CAS atomically when both clear and every transition admit
it. On a stepwise provider, every clear dispatch must have driver-owned pre/post
proof or reset refuses before effects. The runner durably confirms each clear
and replay dispatch. After interruption, only `reset()` may consume the active
reset attempt: it reauthenticates the stored plan and estate, probes confirmed
and pending dispatches, and resumes at the first proven incomplete step. An
opaque or ambiguous outcome blocks until the live database is manually restored
to a checkable point; `resolve` cannot label a reset complete or rolled back.

After replay and exact final fingerprint proof, reset compare-and-swaps the
marker to the selected target/path with a new revision and appends
`reset-applied`. A changed estate, target, source marker, or reset-plan hash
refuses rather than silently starting another reset.

MySQL uses this preflighted stepwise protocol and reports exact partial
progress. Provider-specific unsupported histories refuse before the first drop.

The reset owner refuses these inconsistent control states before user-schema
effects: one control table missing, malformed table definitions, ledger events
without a compatible marker except a recognized unfinished first attempt, a
marker without its state manifest, or a marker/estate digest mismatch. Push
uses the same classifier. It refuses every inconsistent or unfinished arm. A
structurally valid stable marker is not treated as a fresh database; it may
proceed only to the no-op proof in Section 13.3.

Delete current `squash()` without replacement in V1. A future compaction feature
must use an explicitly authored, fully checked direct transition; it may never
infer data history from the final schema snapshot.

## 13. Push V1

### 13.1 One immutable internal plan

The push planner returns one frozen internal value containing:

- exact normalized target identity;
- source live fingerprint;
- desired snapshot/fingerprint;
- resolved operations and destructive decisions;
- exact structured statements, typed parameters, and atomicity class;
- force-reset policy when present;
- canonical plan hash.

The hash covers every fact that can change execution. Formatting text is not an
authority input.

### 13.2 Preview and consent

The public call shapes are exact:

```ts
interface PushPlanningOptions {
  readonly forceReset?: boolean;
  readonly skipValidation?: boolean;
  readonly resolve?: ResolveCallback;
}

type PushTargetIdentity =
  | {
      readonly dialect: "postgresql";
      readonly database: string;
      readonly namespace: string;
      readonly bindingId: string;
    }
  | {
      readonly dialect: "mysql";
      readonly database: string;
      readonly bindingId: string;
    }
  | {
      readonly dialect: "sqlite";
      readonly location: string | null;
      readonly bindingId: string;
    };

interface PushStatementPreview {
  readonly sql: string;
  readonly parameters: readonly MigrationParameterV1[];
}

type PushOptions =
  | (PushPlanningOptions & { readonly dryRun: true })
  | (PushPlanningOptions & {
      readonly dryRun?: false;
      readonly consent?: never;
    })
  | {
      readonly consent: PushConsent;
      readonly dryRun?: false;
    };

interface PushConsent {
  readonly format: "1";
  readonly target: PushTargetIdentity;
  readonly planHash: Sha256;
  readonly mode: "diff" | "force-reset";
  readonly validation: "full" | "structural-only";
  readonly resolutions: readonly PushResolution[];
}

interface PushPreview {
  readonly outcome: "planned" | "noop";
  readonly target: PushTargetIdentity;
  readonly planHash: Sha256;
  readonly destructive: boolean;
  readonly operations: readonly PushOperation[];
  readonly statements: readonly PushStatementPreview[];
  readonly consent: PushConsent;
}

interface PushApplyResult {
  readonly outcome: "applied" | "noop";
  readonly target: PushTargetIdentity;
  readonly planHash: Sha256;
  readonly operations: readonly PushOperation[];
  readonly statements: readonly PushStatementPreview[];
}
```

The consent arm accepts no planning inputs: it carries their normalized, closed
decisions so there is no second callback or conflicting option during apply.
The plan hash covers those decisions and every canonical statement parameter.
`target` is a closed normalized live physical identity. `bindingId` is a random
non-secret identity created once per concrete driver binding, so consent for an
in-memory SQLite database or one pooled client cannot be replayed on another
client with a coincidentally equal schema. It is inert plan input, not authority
by itself. Consent is valid only on that same driver binding.

User resolution callbacks never run while the migration lock is held. A call
that supplies `resolve` first performs read-only planning, invokes the callback,
and closes its answers into normalized resolutions. The locked replan consumes
only those values and refuses if the request set changed. A destructive result
still requires preview consent; a callback is not a substitute for accepting an
exact plan hash.

`push({ dryRun: true })` performs no database or storage effect and returns a
`PushPreview`. The preview is not directly executable; only its inert `consent`
value can be passed back to `push`.

Consent is not a trust token. Apply strictly parses it, resolves the current
schema again, reproduces its closed resolutions, and recomputes the complete
plan under the lock. A forged or stale value only causes refusal.

For apply:

1. acquire the target lock;
2. introspect and replan on the pinned session;
3. if consent is present, compare its mode, validation policy, normalized
   resolutions, target, and plan hash with the recomputed values;
4. refuse on any mismatch before the first effect;
5. when consent is absent, execute a non-destructive plan directly from that
   one locked in-memory value;
6. when consent is absent and the plan is destructive or force-reset, throw
   `MIGRATION_CONSENT_REQUIRED` with the complete preview and zero effects;
7. execute only the exact in-memory plan that passed these rules;
8. re-introspect and require the desired fingerprint.

This gives programmatic callers a safe one-shot path for additive changes and
an exact two-call path for destructive work:

```ts
const preview = await migrations.push({ dryRun: true, forceReset: true });
const applied = await migrations.push({ consent: preview.consent });
```

The CLI uses the same calls. It does not hold a database lock while waiting for
a human: it previews, collects consent, then replans and compares under the
lock.

Remove generic `force` authorization. Force-reset is a distinct plan kind with
the same exact consent and compile-before-clear rule.

### 13.3 Relationship to migration-managed databases

Push excludes VibORM control tables and never changes the marker or ledger. To
avoid making a truthful marker lie, a non-empty push plan against a database
with an existing VibORM marker is refused. Use `generate` plus `apply`, or
history-aware `reset`.

A no-op push is allowed against a migration-managed database only when all of
these statements are proven under the target lock:

- both control tables and the marker are structurally valid;
- there is no unfinished ledger attempt;
- the marker's authenticated snapshot hash equals the full desired snapshot
  hash;
- the live managed-schema fingerprint equals both the marker snapshot's
  physical fingerprint and the desired physical fingerprint;
- the authoritative push diff is empty.

This is a narrow no-op proof, not full migration-estate verification. Push does
not read migration storage or attest that all estate, state, snapshot, and SQL
artifacts remain available. `verify` owns that check. There is no
`allowHistoryDrift` escape in V1.

### 13.4 Result and failure truth

Preview returns `planned` or `noop`; apply returns `applied` or `noop`. Partial
execution is not a successful result. It throws a `MigrationError` whose stable metadata
includes `partial` or `may-have-committed`, the last confirmed step, and the
source/target/plan hashes.

Second push must be empty by fresh structural introspection, not a cached
snapshot.

## 14. Dialect and provider truth

### PostgreSQL

- Schema-qualified estate target and live SQL.
- Pinned session advisory lock plus marker CAS.
- Transactional transition when all statements permit it.
- `CREATE INDEX CONCURRENTLY`, enum commit boundaries, and other forbidden-in-
  transaction operations use stepwise classification or refuse before effect.
- `pg`, postgres.js, PGlite, and Bun SQL claim effectful support only after their
  pinned producer contracts pass.
- Neon HTTP remains offline/read-only unless it gains a proven interactive
  session boundary.

### MySQL

- Estate artifacts remain database-relative; the bound session reasserts
  `USE <database>` before each artifact.
- MySQL2 requires the namespace program's non-redirecting attestation.
- DDL is stepwise and partial by default; nominal transactions do not change
  the claim.
- PlanetScale remains offline/read-only for this feature because VTGate routing
  and session semantics do not prove the required containment.

### SQLite family

- SQLite3 and Bun SQLite use one writer boundary and transaction where the
  operation family permits it.
- LibSQL cannot claim V1 constraint alteration until existing rows are
  prevalidated or the table is safely reconstructed.
- D1 cannot claim effectful V1 migration support until table recreation,
  foreign-key handling, atomic native-batch behavior, and marker CAS are proven
  together. Otherwise it supports generation/check/status only and refuses
  before effects.

No provider inherits a guarantee from its dialect name. Each admitted provider
must pass the same marker, lock/CAS, interruption, drift, and postcondition
contracts.

## 15. Public contract

Keep one migration client composition root. Its V1 surface is intentional:

```text
generate
check / list / show / graph
status / verify / log
apply / down / baseline / resolve / reset
push
```

Programmatic methods use the same nouns. `apply({ to })` targets a state ID,
unambiguous prefix, or unambiguous state name. Numeric index targeting
disappears.

Remove from `viborm/migrations`:

- `MigrationContext` and options;
- raw differ, serializer, and snapshot helpers;
- path-level storage helpers;
- legacy resolver aliases;
- `journal()`, the journal types, and journal formatting;
- caller-fabricated `MigrationEntry` reads;
- old `squash()` semantics;
- push's storage friend seam;
- direct public DDL executor internals.

Export only:

- `createMigrationClient` and exact operation/result types;
- `MigrationStorageReader` / `MigrationStorageWriter` and conformance kit;
- the filesystem storage factory;
- committed-state read models, manual-transition inputs, previews, and results;
- migration errors and stable error metadata.

All CLI commands support stable `--json` output. Human text is a view of the
same result, not a second outcome model.

Pin stable error families for automation: invalid estate/artifact, ambiguous
graph or path, live drift, lock timeout, marker conflict, unfinished attempt,
consent required/mismatch, unsupported provider, partial effect, and ambiguous
commit. Provider causes remain attached and redacted through the existing error
boundary; CLI exit codes derive from these families rather than message text.

## 16. Implementation program

### Phase 0 — stop destructive dry-run and freeze evidence

- Repair the force-reset dry-run and compile-before-clear defects.
- Freeze current 29-case DDL output, apply/down behavior, and second-push
  convergence as transition-compiler baselines.
- Add current-estate corruption tests that demonstrate the bugs this plan
  removes.

Done when every dry-run is effect-free and the baseline corpus is reproducible.

### Phase 1 — trusted domains and structured statements

- Add strict snapshot, estate, manifest, state, transition, operation, SQL
  range, and typed-parameter validators.
- Add one canonical JSON and portable SHA-256 owner.
- Change migration drivers from concatenated strings to ordered structured
  statements plus probes and atomicity classification.
- Remove every generic SQL splitter and breakpoint parser.

Done when hostile JSON/SQL framing cannot cross a trust boundary and existing
generated SQL remains byte-identical where semantics did not change.

### Phase 2 — immutable storage and graph

- Implement `estate.json`, content-addressed snapshots and SQL, state hashing,
  and graph construction.
- Replace path-level storage with reader/writer semantic contracts.
- Implement atomic filesystem publication and a reusable storage conformance
  suite.
- Delete journal, latest snapshot, down/backup directories, and duplicate
  filesystem readers.

Done when generation interruption after every write/flush/publication leaves
either the old valid graph or one complete new state, never a torn state.

### Phase 3 — generation and branch convergence

- Add dry-run generation, manual transition inputs, immutable state
  publication, show, graph, and check.
- Compile one parent transition normally and multiple transitions for merged
  leaves.
- Scaffold and refuse unproved custom/data convergence.
- Prove identical explicit generation inputs produce byte-identical blobs and
  the same state ID.

Done when two independent branches merge without renaming and databases on
either branch reach one state through their own exact transition.

### Phase 4 — marker, ledger, and apply

- Create strict control-table schemas and runtime row parsers.
- Reuse the namespace program's pinned lock/session owner.
- Implement live fingerprint refusal, marker CAS, append-only events, operation
  pre/post checks, transactional apply, and stepwise apply.
- Add honest partial/ambiguous error metadata.

Done when two concurrent runners cannot interleave, drift refuses before DDL,
and interruption after every dispatch converges or blocks with exact recovery
evidence.

### Phase 5 — operator recovery

- Implement status, verify, log, baseline, down, resolve, and reset.
- Remove write-on-read status and tracking-only rollback.
- Delete the current snapshot-only squash path without a V1 replacement.

Done when every database state can be explained from marker plus ledger and no
recovery command fabricates success.

### Phase 6 — authenticated push

- Make the existing push planner return the one immutable plan.
- Add plan hashing, exact consent, under-lock replan, baseline recheck, shared
  structured execution, and final fingerprint proof.
- Refuse non-empty push against a migration marker.
- Delete push storage access and duplicate reset paths.

Done when stale consent, reset dry-run, partial provider execution, and a
post-apply mismatch are all falsified.

### Phase 7 — provider closure and public cleanup

- Run the provider admission matrix and retain only proven effectful claims.
- Close LibSQL existing-row validation and D1 recreation, or keep their
  effectful migration support explicitly disabled.
- Cut obsolete exports, update package entry points, CLI help, docs, examples,
  root/migration `AGENTS.md`, and `CONTEXT.md`.
- Add a census forbidding the journal, raw storage mutation, delimiter parser,
  second migration executor, and public context/plan internals.

Done when the package surface and documentation describe exactly the providers
and guarantees the test matrix proves.

## 17. Required falsifiers

### Estate and hashing

- Alter SQL, manifest, forward statement, rollback statement, typed
  parameter, or snapshot bytes independently.
- Rename, remove, duplicate, or reorder state manifests and referenced blobs.
- Malformed/unknown versions and keys at every JSON boundary.
- Duplicate state, duplicate parent, dangling parent, cycle, an illegal second
  virtual root, unresolved leaves, and ambiguous target prefixes.
- Data-only state with unchanged snapshot.
- Same inputs produce the same state; changed name or transition produces a
  distinct intact child state.
- Caller-supplied storage returning inconsistent list/read views.

### Publication and concurrency

- Kill generation after every file write, flush, directory flush, snapshot/SQL
  publish, state publication, and parent-directory flush.
- Two generators from one parent produce two intact leaves with no lost update.
- Identical concurrent state publication is idempotent; same hash with different
  bytes is corruption.
- Object-store manifest visible before referenced bytes, stale listing, and CAS
  conflict.
- Orphan snapshot/SQL inventories are reported but cannot become history.
- Workers KV writable-driver refusal.

### Graph and branches

- Linear, diamond, three-parent merge, data/custom branch, multiple valid
  routes, explicit target, and rollback to the actually used parent.
- A generated structural merge reaches byte-identical final snapshots from
  every parent.
- A custom/data merge cannot publish until every parent transition and common
  destination check is explicit.
- Two routes with equal final schemas but different drops/rebuilds require
  explicit `via`; wrong, partial, repeated, ambiguous-name, and stale-marker
  paths refuse.

### SQL framing

- PostgreSQL dollar quotes, nested tags, comments, and function bodies.
- MySQL procedure/trigger with internal semicolons and `DELIMITER` refusal.
- SQLite trigger body, quoted semicolons, and comments.
- UTF-8 byte offsets, manual CRLF refusal, generated LF output, overlapping
  ranges, invalid gap bytes, and altered dispatch identities.
- One manual `Sql` containing multiple provider statements remains one opaque
  dispatch and never acquires fabricated per-statement progress.

### Checks and direction-specific execution

- Driver probes and trusted manual reads retain distinct manifest arms and one
  exact boolean-result parser.
- Stepwise data-only manual work without complete origin/destination checks
  refuses before dispatch.
- Forward transactional plus rollback stepwise, and forward stepwise plus
  rollback transactional, derive independently and use the correct boundary.
- A manual transactional requirement on MySQL or another incapable provider
  refuses before effects.

### Database execution

- Artifact invalidity in the last pending state fails before the first DDL.
- Live drift before apply and drift between preview and effect.
- Two concurrent applies, dropped pinned connection, lock timeout, malformed
  lock result, and marker CAS failure.
- Interrupt before/after every precheck, dispatch, postcheck, progress event,
  marker update, commit, and acknowledgement.
- Proven and opaque step branches never read fields the other arm does not have;
  an ambiguous opaque dispatch blocks all later work.
- PostgreSQL transaction rollback and non-transactional classification.
- MySQL failure and disconnect after every dispatch, including ambiguous
  dispatch.
- SQLite busy writer, foreign-key recreation, and post-commit acknowledgement
  loss.
- Baseline exact match/mismatch; resolve complete/origin/neither fingerprint.
- Equal physical fingerprints cannot resolve opaque data without the required
  state checks.
- Kill stepwise reset before/after every clear/replay dispatch and control event;
  only the authenticated stored reset plan can resume it.
- Applied state or blob altered or missing; marker/ledger disagreement.

### Push

- `--force-reset --dry-run` performs zero writes.
- Desired schema invalid or DDL compilation fails before reset.
- Preview hash differs after an external schema change; apply refuses.
- New non-destructive and destructive operations after consent both refuse.
- Wrong target identity, stale destructive decision, and forged plan object.
- Consent replay on a different driver binding refuses.
- Preview exposes exact canonical parameters; changing one parameter changes
  the plan hash and refuses consent.
- Post-apply fingerprint mismatch.
- MySQL partial error reports exact confirmed progress.
- Non-empty push against migration marker refuses; no-op succeeds.
- Second push is empty on every admitted provider.

## 18. Sequential validation gates

Do not overlap Vitest, TypeScript, provider, or benchmark processes.

1. Focused artifact, graph, storage, generation, apply, recovery, push, and public
   type tests.
2. `pnpm test:layer:migrations`
3. `pnpm test:layer:adapters`
4. `pnpm test:layer:drivers`
5. `pnpm test:layer:client`
6. `pnpm test:types`, with no TS2589/TS2590 and the existing 300-second/4-GB
   limits.
7. Repository-pinned Biome on every touched TypeScript file.
8. `pnpm package:build` and `pnpm test:package`.
9. SQLite3, Bun SQLite, PGlite, `pg`, postgres.js, Bun SQL, and MySQL2 full
   lifecycle contracts.
10. LibSQL and D1 effectful contracts, or exact pre-effect refusal tests.
11. Neon HTTP and PlanetScale offline/read-only plus effectful refusal tests.
12. Filesystem crash-injection suite on Linux and macOS; document that rename
    visibility is not a universal power-loss proof on untested filesystems.
13. Strong-object-store conformance fixture with conditional publication.
14. `pnpm test:core`.
15. `pnpm test:all`.
16. `pnpm test:providers`, with hosted skips reported honestly.
17. `git diff --check` and a final forbidden-owner census.

No migration benchmark gate is required: this is a correctness path, not a
per-query hot path. Type-check and large-graph construction receive scale gates:
10,000 states, 1,000 snapshots, a 20-leaf merge, and a 100,000-event ledger
status read must remain linear or `O((V + E) log V)` without quadratic rescans.

## 19. Completion criteria

The feature is V1-ready only when all are true:

1. No global mutable journal or latest snapshot exists.
2. Every state, executable SQL blob, and snapshot is authenticated on every
   read before effects.
3. Production never evaluates migration TypeScript.
4. No SQL statement boundary is inferred from delimiters or comments.
5. State publication is atomic in visibility and crash-tested.
6. Concurrent branch generation loses no history.
7. Branches converge through explicit parent-specific transitions.
8. Marker and ledger have separate representations and owners.
9. Lock and marker CAS protect different failure modes and both are proven.
10. Live drift refuses apply before DDL; final drift refuses marker advance.
11. PostgreSQL/SQLite transactional claims and MySQL stepwise claims match real
    provider behavior.
12. Interrupted non-transactional work is explainable and recoverable without
    guessing.
13. Applied, rolled-back, baselined, and resolved events remain auditable.
14. Status, verify, and log are read-only and do not hide provider failures.
15. Baseline and rollback preserve the exact arrival path and baseline
    boundary.
16. Push dry-run is effect-free, consent is plan-specific, and final state is
    attested.
17. Push cannot silently invalidate an existing migration marker.
18. Every admitted provider passes direct, transaction, interruption,
    concurrency, reset, and second-push contracts.
19. Public exports contain no context, raw storage mutation, duplicate
    resolver, or execution internals.
20. Documentation states exact provider limits, rollback data limits, storage
    requirements, baseline/recovery workflow, and expand/contract deployment
    guidance.

## 20. Explicit non-goals

- No legacy journal conversion or compatibility spelling.
- No automatic mutation of a committed state.
- No automatic checksum repair.
- No V1 squash or compaction command.
- No global migration registry or hosted control plane.
- No arbitrary SQL multi-statement parser; each manual `Sql` value is one opaque
  provider dispatch.
- No automatic shadow-database creation or destructive soft reset.
- No claim that rollback restores discarded data.
- No claim that a migration tool alone provides zero-downtime deployment.
- No effectful provider support without a proven lock/CAS/execution boundary.
- No migration Studio UI in this program.

The desired result is not the largest migration system. It is the smallest one
whose files, graph, database state, and operator claims cannot contradict each
other.

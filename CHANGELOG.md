# Changelog

All notable changes to VibORM are recorded here. Releases follow Semantic
Versioning.

## Unreleased

The extension capabilities the RBAC extension is built on (`rows`
predicates that traverse relations, values a call supplies as plan
parameters, verbs that judge the rows a write takes and the rows it
produces, per-row evidence, controls bound to a client, extensions that
compose by order), and `viborm/rbac` itself, built from them alone. Core
names no role, grant or action.

### Added

- **`rows` predicates may go through relations.** A predicate is any
  `where` of its model, `some`/`every`/`none`/`is` and `recurse` included,
  admitted once at `$extends` through that model's `where` schema. Inside a
  predicate's own relation reads, every other extension's filters apply at
  their default mode and its own extension's do not, so a cycle of filters
  terminates and no per-call mode widens what a filter reads. A `recurse`
  in a predicate must write its `depth` (`false` for the whole closure); the
  16-level nesting bound on a caller's `where` does not apply to them.
- **Values a call supplies, by marker.** In a `rows` predicate,
  `{ control, path }` reads a field of an object control, `{ now: true }` is
  the call's one instant (the one a tombstone writes), and
  `{ $if: { control, path?, exists | equals | in | has | hasSome } }` tests a
  call value without a column: a false test removes its arm. `data` stamps
  take `{ control, path }` and `{ now: true }` too.
- **Controls bound to a client.** A control can be declared `bound: true`:
  no call's arguments are read for it, and only a binding supplies it. A
  client factory's scope has `$bind(values)`, which admits the calling
  extension's own controls once and returns the receiving client with them
  bound; interactive transactions and their savepoints, array-transaction
  members, a client `$extends` derives and cached-read keys keep the values.
- **References to an earlier extension's controls.** A `rows` predicate or a
  `data` stamp may name a control an extension applied before it declares
  (an audit stamp can take another extension's actor).
- **`softDelete(config).rows` and `.methods`**, its two steps apart, so a
  chain can apply every `rows` step before any methods step.
- **Equal values bind once over a driver's bind budget.** A statement over
  its driver's budget is sent with numbered placeholders (`?NNN`, `$n`), each
  distinct value bound once, so D1 runs statements of up to 100 distinct
  values: a plain `include` read on D1 that bound 125-131 values was refused,
  and runs. MySQL and better-sqlite3 (`viborm/sqlite3`), whose transports do
  not number placeholders, keep refusing such a statement whole.
- **`rows` verbs: what a call may do to the rows it sees, per model.** A
  `rows` member may declare `verbs: { [model]: { predicates, read, update,
  delete, writes } }`. Each named predicate is admitted once; `read`
  narrows every mode, and a mode's `root` or `related` may name a predicate.
  A delete (tombstones included) takes `delete`'s predicate; an update
  takes, for each field its data writes, that field's `writes` entry, else
  `update`'s. A verb a model's entry leaves out matches nothing. A key of a
  model's entry other than these and `place`, `moves`, `acyclic`,
  `evidence` and `reads` (below) is refused at `$extends` with a
  `ClientInitializationError` naming the model and the key (a misspelt
  `writes` would judge its fields at `update`). A nested `delete` takes its
  target at the target's `delete` predicate: a to-one `delete: true` on a
  target the call sees and may not delete is a `NestedWriteError` that never
  tells it from a hidden one.
- **A write is judged by the statement it emits.** On a model with verbs,
  `data: {}`, or a parent a nested write bumps, is judged at `update`;
  stamps and generated values (`updatedAt`) never change the verb. A row
  only addressed to reach its children is read.
- **A link's change is a write of the row whose key or join row changes.**
  On a model with verbs, a `connect`, `set` or `disconnect` judges that row,
  at both ends of a join; `set: []` refuses, with `NestedWriteError`, a
  visible link the call may not write.
- **`rows` verbs judge the row a write produces.** A model's entry may name
  `place` (the predicate every created row holds), `moves: { [field]: name }`
  (the predicate the new row of an update writing that field holds) and
  `acyclic: [relation]` (a to-one relation of the model to itself whose new
  target must lie outside the row's own subtree). An updated row is also
  judged at the predicates that judged its old row. The produced row is
  judged as a value, against the rows as they stand before the write, inside
  the statement that writes it (`INSERT … SELECT … WHERE`, `UPDATE … WHERE`
  over the produced rows), on every create and update site: `create`,
  `createMany`, `upsert`'s two arms, nested `create`, `connectOrCreate`,
  `update`, `updateMany` and a foreign key's `connect` or unlink. A refused
  row is written by no statement, before any constraint is checked:
  `ForbiddenError` at the root, `NestedWriteError` nested. A missing key
  target and a hidden one give the same error. A model naming no `place` is
  not judged on create; a row of database defaults only, on a model with a
  `place`, is refused before any statement, as is a list `push`/`unshift` or
  an exact decimal's `multiply`/`divide` on a field the judgement reads.
- **Adapters: `assertions.holds(condition, from?)`**, the expression a
  judged statement carries: 1, or the statement fails on its own sentinel
  before it writes. Only that sentinel is a refusal: a caller's division by
  zero or invalid JSON in the same statement is the provider's `QueryError`.
- **Shared relation bodies, a driver fact.** A driver whose transport bounds
  a statement declares `sharesRelationBodies`: each relation filter body a
  statement repeats is stated once, in a `WITH`, as the key set its
  repeats test (`EXISTS (SELECT 1 FROM set WHERE set.k = parent.fk)`). D1
  and every PostgreSQL driver declare it by default; `sharedRelationBodies:
  false` keeps the bodies inline, as 1.2.4 spelled them (a server that bounds
  the relations of one statement, Neki's 256, needs the shared form). The
  answers are the same; SQLite3, libSQL, Bun SQLite and MySQL SQL is
  unchanged.
- **`uncacheable` controls.** A control declared `uncacheable: true` keeps
  every read holding its value out of the cache: `$withCache` on such a read
  is a `ValidationError` at the control, before any statement.
- **`rows` verbs report and gate per row.** A model's entry may declare
  `evidence: { as, names, ordered? }`, a projection key (`$` and an
  identifier) a `select` or `include` may name at any depth, on reads and on
  the rows a write returns: per row, whether each named predicate holds
  there, or with `ordered` the last one that holds (`null` where the row's
  `read` does not). `reads: { [field]: name }` gates a scalar field: a row
  carries it only where the predicate holds, an explicit `select` of it on a
  row without it is a `ValidationError` at `select.<field>`, and every
  operand a call writes over it (`where`, unique lookups, cursors,
  `connect`, `orderBy`, `distinct`, aggregates, `groupBy`, relation filters)
  reads it as absent there. Keys and foreign keys cannot be gated. The
  client's types admit the key and make gated fields optional by default.
- **`viborm/rbac` defaults:** `update` and `delete` imply `read`; `create`
  judges a proposed row and implies nothing (declare `actions: { create:
  ["read"] }` to say otherwise). An inherited branch another branch provably
  contains is dropped from a predicate: the same rows, a smaller statement.
- **`viborm/rbac`, authorization judged in the statement** (not yet
  published, OD-11; [guide](docs/content/docs/extensions/rbac.mdx)).
  `rbac({ actor, levels, limit, models })` declares one rule per model and
  action (`within`, `arms`, `actions` with what each implies, `operations`,
  `create`, `fields`, `domains`), with the helpers `owner`, `member`,
  `grant.to`, `grant.administer`, `team`, `role`, `everyone`, `up`,
  `session`, `notBanned` and `keyLimit`. `rbac(config)(base)` compiles it
  against `base`'s schema into one predicate per model and action and
  applies it to every model, as a rows step then a methods step, also
  offered apart as `.rows` and `.methods` so other `rows` steps (soft
  delete, tenancy) go first. `db.$as(actor)` returns a view with the actor
  bound: validated once against the `viborm/validation` actor schema, no
  chain rebuilt, kept by transactions and by clients `$extends` derives.
  Every read takes only the rows the actor views, at every depth; an update
  or delete is judged at the actions of the fields it writes; a created or
  updated row is judged inside the statement that writes it (placement,
  written keys' targets visible, no parent cycle), with `ForbiddenError`.
  `can`/`assert` answer from the same predicates through `$access`, for the
  one row a unique selector names, for one action or a list (`can([...])`
  returns a record, one statement, one per asked level on a model whose
  actions are the `levels`; `assert`'s `ForbiddenError` never tells a hidden
  row from a missing action),
  `include: { $access: true }` reports the actions held per row at any
  depth, a field with a `read` action is omitted where the actor lacks it,
  `limit` narrows API keys by intersection and `as` narrows a call to an
  action or a named domain, never wider. Refused before any statement: a
  call without an actor or passing `actor` in its arguments
  (`ValidationError`), a model the policy does not list, a verb or an `as`
  mode the model does not declare (`ForbiddenError`, OD-7). Refused when
  applied, with `ClientInitializationError`: unknown models, fields, actions
  and actor paths, unknown keys of the policy, of a model that lists its
  `actions` and of a `fields` entry, a key spelled like a declaration key or
  a level, a `keyLimit` model the schema lacks, a declared ceiling the model
  does not declare, rules that read themselves, a read-gated key or unique
  field, an actor schema that is not a finite strict object, an action or
  domain named `default`. A stored ceiling row allows its action and every
  action it implies. An update that writes a tombstone's marker by hand, or a
  restore, is judged at the delete action too. A `Date`, `Decimal` or
  bytes constant in a policy reaches its predicate as a value (it was
  walked as a clause and lost). A cached read on a governed view is refused with
  `ValidationError` before any statement, unless the policy declares
  `cache: "allow"` (OD-10). Raw SQL and statement transforms are not
  filtered.

### Changed

- **A `rows` predicate is admitted at `$extends`.** A misspelt key anywhere
  inside it is a `ClientInitializationError` naming the extension, the
  model, the mode, the purpose and the path. **Upgrade:** a definition that
  carried a misspelt nested key used to fail at the first query that read
  it; it now fails where it is applied.
- **A `rows` value is always a value.** An object control value is no longer
  read as filter operators (a tenant of `{ not: "acme" }` matched every
  other tenant's rows); read a field of it with `path`.
- **A `null` control value is a missing value in a `rows` predicate:** it
  never compares as `IS NULL` (an actor with `userId: null` matched every
  orphaned row). A required control's missing value matches nothing; an
  optional one drops its filter, as before. **Upgrade:** to filter on
  `IS NULL`, write the literal `null` in the predicate.
- **Each `rows` predicate is prepared once for every call.** The 256-entry
  memo of prepared modes and values is gone: no tenant, version or actor
  takes room or pushes another out.
- **A control name declared twice in a chain is refused at `$extends`**
  with a `ClientInitializationError` naming both extensions, a second
  extension's, a reused `rows.control` and a `rows.control` repeating the
  definition's own controls alike. **Upgrade:** such a chain used to be
  accepted and refused every call that passed either value.
- **A reference to a control no earlier extension declares is refused at
  `$extends`**, by the chain; a definition read on its own no longer checks
  its references.
- **Views other than the client `$extends` returns run method factories
  lazily**: an interactive transaction's `tx` and a client `$bind` returns
  run a model's factories when that model is first read, client factories
  when a client method is. **Upgrade:** a factory that throws now fails at
  that first read inside the transaction, not at `$transaction`.
- **A read allocates no more per call than in 1.2.4**, with or without a
  `rows` extension (Node 24, a 50-model schema: `findUnique` 54,760 →
  54,352 B, `findMany` with two includes 106,744 → 106,616 B, a relation
  filter 62,184 → 61,824 B); a client retains about 300 B more.

### Fixed

- **An update with nothing to assign no longer fails.** On a model with no
  `updatedAt` and no stamp, `update({ data: {} })` and
  `updateMany({ data: {} })` sent `UPDATE … SET` with an empty list and threw
  `QueryError` on every provider (1.2.4 included). `update` now reads and
  returns the row it addresses (`NotFoundError` when there is none), and
  `updateMany` returns the count of rows it addresses.
- **D1 runs relation filters nested deeper than its expression limit.** D1
  compiles with an expression depth of 100, and SQLite counts nested
  relation filters about quadratically, so a statement six `some`/`is`
  levels deep was refused ("Expression tree is too large"). On D1 each
  relation filter now reads its rows from a derived table, which SQLite
  flattens back to the same plan, and a long conjunction nests as a balanced
  tree; every other driver's SQL is unchanged.
- **`deleted: "with"` and `scope: "all"` no longer widen a `rows`
  predicate's relation reads.** A predicate that reached its rows through a
  relation counted a tombstoned row, or another tenant's, when the call
  passed the wider mode.
- **A `rows` predicate whose relations form a cycle** (a model's filter
  through a relation back to itself, or two extensions' filters through each
  other) threw a `RangeError` at the first read; it now terminates.
- **A `rows` predicate object that contains itself** overflowed the stack at
  `$extends`; it is refused there with a `ClientInitializationError` naming
  its path. One that shares a sub-object is admitted.

## 1.2.4 — 2026-10-13

Fixes from a third-party review of 1.2.2 and 1.2.3: an ambiguous retry no
longer lets `resolve` close its attempt as rolled back, `down()` on Neki
survives a slow `resolve` callback, and a held relation filter whose `is` or
`recurse` can only be `undefined` is type-checked in the form the runtime
reads.

### Fixed

- **Neki: a `RESET` that is never answered no longer holds the migration
  lock forever.** The reset `down()` runs before asking its resolver on Neki
  is bounded like every cleanup statement, each `RESET` on its own: one
  unanswered past `CLEANUP_BOUND_MS` (5 s) loses and discards the session, so
  its lock is freed, instead of waiting forever while other migration
  commands block on the lock. Slow but answered resets still reach the
  resolver. The command-end reset bounds each statement the same way.
- **`resolve({ outcome: "rolled-back" })` after a resumed retry that lost its
  reply.** A stepwise step the server refused whole is resumed by `apply()`
  under its original attempt (1.2.3). If that retry's reply was lost, it may
  have committed, but `resolve('rolled-back')` ignored every announcement of
  a dispatch that had any recorded refusal, so it could close an attempt
  whose manual step committed, and the next `apply()` would run it again.
  Each announcement is now answered only by its own refusal, the count
  `apply()` already used to resume: the retry's open announcement refuses
  `resolve('rolled-back')` with `V11020` (`effectState:
  "may-have-committed"`).
- **Neki: `down()` with a slow `resolve` callback.** On Neki the command holds
  the session lock, with `idle_session_timeout` set to `idleTimeout`, for the
  whole command, and `down()`'s loss-approval callback ran under both: a
  callback longer than `idleTimeout` (30 s by default) ended the session, and
  `down()` failed with `V1001` after the approval. Before the callback the
  command now resets its session limits and releases the lock; before the
  rollback it takes both again (within `lockWait`) and re-reads the marker,
  refusing with `V11015` if another command moved it, as on PostgreSQL.
  Standard PostgreSQL, which runs the callback outside its locked
  transactions, is unchanged.
- **A held relation filter whose `is` or `recurse` can only be `undefined`.**
  `where: { writer?: { is?: undefined; email: string; emial: string } }`
  compiled: the misspelled-key check read the `is` key as the explicit
  `{ is, isNot }` filter and never looked at `emial`, and a `recurse?:
  undefined` was read as the recursive filter. The runtime treats such a
  selector as absent (the shorthand filter, or the ordinary one), and so does
  the check now: the typo is a type error, and `recurse` / `self` spelled
  `undefined` beside a field still compile. Type-checking cost on the
  recursive-where fixture: +582 instantiations on TypeScript 7 (1,816,860).

### Release tooling

- `scripts/release-ci.mjs` reads the CI run's jobs through
  `/actions/runs/{id}/jobs?filter=all` and proves each required job by its
  record from the latest attempt that ran it, so a run finished by "re-run
  failed jobs" is accepted on the push and pull-request paths alike without
  depending on whether a later attempt's listing repeats the jobs it did not
  re-run. Each record must belong to the run, its attempts and the SHA.

### Upgrading from 1.2.3

`npm install viborm@1.2.4`. No code change is needed. An attempt that
`resolve({ outcome: "rolled-back" })` closed under 1.2.3 is not reopened; if a
resumed manual step of it lost its reply, check its effect by hand before
running `apply()` again.

## 1.2.3 — 2026-10-13

Migrations on PlanetScale's Postgres (Neki) hold one session lock for the
whole command, so stepwise and transactional states apply together there, and
every PostgreSQL command resets its session limits by name. Measured on a Neki
branch (PostgreSQL 18.6).

### Fixed

- **Neki: a stepwise state, or a `CONCURRENTLY` step, after a transactional
  one.** Each migration transaction took `pg_try_advisory_xact_lock`, and
  stepwise work then took `pg_try_advisory_lock` inside it. Neki refuses to
  mix the two (`NK013 not implemented: [61] Mixing session and transaction
  advisory locks is unavailable`), so `apply()` failed with `V11005` ("the
  lock statement itself failed"). On Neki (`version()` names it, asked once
  per command) the command now takes the session lock once, in autocommit,
  before its first read, and never the transaction lock; it waits within
  `lockWait` with the same backoff, releases at the end and on every failure,
  and every group still re-reads the marker under it. The pre-lock no-op
  read of `apply()` is not asked on Neki: its proof takes the transaction
  lock. Standard PostgreSQL and PGlite keep the transaction lock per group.
- **Neki: the session limits.** Under the session lock the limits were set by
  a `DO` block that called `set_config(name, …)` over `pg_settings` rows;
  Neki refuses a computed setting name in a routine body (`42501`). The
  optional settings the server has are now read first, and the block names
  each setting by a constant.
- **Neki: the limits reset.** The command reset them with
  `SELECT count(set_config(name, reset_val, false)) FROM pg_settings …`,
  which Neki refuses (`NK013 [101]`). It now sends one `RESET` per setting
  it set. A refused reset fails the command with `V11005` (beside the
  command's own failure, if any) and the connection is closed, never handed
  back to the pool carrying the migration's timeouts.
- **The error names what the server refused.** A refused limits statement
  surfaced as `V11001 PostgreSQL catalog query "control catalog" failed`,
  the read it preceded; it is now its own `V11005`. `V11005` and the
  migration errors that wrap a provider refusal (a refused unlock, the
  schema preflight, an unreadable control table, a MySQL partial program)
  carry `meta.providerSqlState` and `meta.providerCode`, as `V11001` did.
  The provider's message stays in the cause, disclosed as the driver's
  diagnostics allow.

- **A stepwise state resumes after a statement the server refused whole.**
  A stepwise state (`execution: "stepwise"`) whose statement PostgreSQL
  refused whole (V11001 with `effectState: "none"`, for example a timeout or a
  constraint violation in a backfill) no longer blocks every later `apply()`
  with V11016 until `resolve` runs. Once the cause is fixed, `apply()` resumes
  the attempt: it re-runs the refused statement and the ones after it, never
  a statement already confirmed, under the same marker and attempt checks as a
  resumed Neki state, then runs the destination checks and moves the marker.
  A statement refused again leaves the attempt resumable. On Neki, a manual
  `execution: "transactional"` state that mixes schema and data changes is
  split at commit boundaries and resumed like a generated one.

### Changed

- **`limits.idleTimeout` defaults to 30 s (was 1 s).** It sets
  `idle_in_transaction_session_timeout` in every migration transaction and
  `idle_session_timeout` while a session holds the session lock, so it also
  bounds the client's own pauses between two statements: at 1 s a loaded
  client's pause between two parts of a split state ended the session
  (`08006` on the next `BEGIN`). 30 s still frees a dead client's migration
  lock within half a minute.
- **On Neki a command holds the session lock from its start.** Another
  command waiting for it sees `pg_try_advisory_lock` held rather than the
  transaction lock, and the session carries the command's limits until its
  last `RESET`.

- An unfinished stepwise attempt left by 1.2.x after a statement the server
  refused whole is now resumed by the next `apply()` instead of refused.
  `down()` likewise resumes a rollback stopped at such a statement. A stepwise
  stop whose outcome is not known (lost connection, `DO`/`CALL`/`EXECUTE`/
  `CONCURRENTLY`, V11020) still blocks with V11016 and still needs `resolve`.

### Upgrading from 1.2.2

`npm install viborm@1.2.3`. No code change is needed. A client that relied on the
1 s idle limit to end a stalled migration quickly passes
`limits: { idleTimeout: 1000 }`. On Neki, an `apply()` that 1.2.2 refused
with `V11005` (`NK013`) for a stepwise state applies now; a split state 1.2.2
left unfinished resumes as before. If an unfinished stepwise attempt's
refused statement must not run again, run `resolve` before deploying 1.2.3:
its next `apply()` resumes it.

## 1.2.2 — 2026-10-13

Restores the misspelled-key type errors 1.2.1 gave up, at 1.2.1's
type-checking cost, and applies migration states that mix schema and data
changes on PlanetScale's Postgres (Neki).

### Fixed

- **A misspelled key below an optional key is a type error again.** 1.2.1
  checked only the keys a value's type requires, so these compiled; each is
  refused again, and runtime validation refused them all along:
  - below an optional key of a held `where` value, at the root and in a
    nested `select`/`include` `where`: with
    `filter: { writer?: { email: string; emial: string } }`,
    `findMany({ where: filter })` and
    `select: { books: { where: filter } }` (1.1.0 caught the root case, 1.2.0
    both);
  - inside a conditional spread in a `where` literal, at the root and in a
    nested `where`:
    `{ title, ...(ok ? { writer: { email, emial } } : {}) }` (same history);
  - the keys of a nested `select`/`include`, in a held relation node
    (`books: { select?: { title?: true; ttitle?: true } }`, or the same with
    `include`) or in a conditional spread
    (`books: { select: { title: true, ...(ok ? { ttitle: true } : {}) } }`)
    (1.2.0 caught these; 1.1.0 did not check nested `select`/`include`
    keys);
  - the `where` of a held relation node, when that `where` is optional in the
    node's type (`books: { where?: { writer?: { emial: string } } }`), or a
    conditional spread in it. No earlier release checked this.

  The check now walks every key of a held or spread `where` object, and stops
  at any `where` object whose type names every key of its model's `where`:
  the client's own payload, however it is spelled (`Parameters<…>`,
  `ModelCoreInput<…, "where">`, `InferDatabase`'s `Where`, an `AND` element).
  Following the optional keys of that type is what produced 1.2.0's TS2589.
  A nested `select`/`include` refuses every unknown key it names, typed
  `?: undefined`, so the relation's own name, which a held node's recursive
  arm carries as an optional `undefined` member, is still accepted. On the
  50-model package fixture, which now includes held filters with payloads
  under optional keys, instantiations for 1.2.1 / 1.2.2: TypeScript 5.9.3
  1,268,876 / 1,268,196; TypeScript 6.0.3 1,442,440 / 1,441,760; TypeScript
  7.0.2 (single-threaded) 1,813,234 / 1,816,278. Without the stop at the
  payload, the same fixture reaches 27.5M on TypeScript 7 with five TS2589.
- **TS2589 on an `any` value inside a `where`.** The misspelled-key check
  unwrapped an `any` filter into itself until the checker gave up: on 1.2.1
  under a required relation key (`writer: value`), a to-one `is` / `isNot`, a
  `some` / `every` / `none`, an `AND` / `OR` / `NOT` group and a nested
  `select`/`include` `where: value`. An `any` value states no key and is no
  longer walked, so these compile, as do the optional-key spellings the check
  now reaches (`...(ok ? { writer: value } : {})`, `{ OR?: any[] }`).
- **Neki: a pending path that mixes schema and data states applies.** 1.2.1
  refused any `apply()` whose statements ran a data statement after a schema
  change, across every state the run applied (`V11021`, before effects), so
  an estate already applied elsewhere could not be deployed to Neki at all.
  Neki plans a statement against the schema committed before its
  transaction (measured on Neki's PostgreSQL 18.6), so on Neki `apply()` now
  commits exactly where that matters, and nowhere on PostgreSQL:
  - consecutive states share a transaction until a state's statements or
    checks would read a change an earlier one made; that state starts a new
    transaction, after the earlier states committed and the marker moved;
  - a state whose own statements need a commit inside it (an `ALTER TABLE …
    ADD COLUMN` then an `UPDATE` of that column) runs as successive committed
    parts: the first runs its origin checks and opens its ledger attempt,
    each records its steps in the transaction they ran in, the last runs its
    destination checks, proves the state and moves the marker. A failure in
    a later part leaves the marker on the previous state and the attempt open
    (`status()` reports `unfinished: true`); the next `apply()` resumes it,
    running only the parts that did not commit. A failure in the first part
    leaves nothing, as before;
  - a change Neki's planner does not need committed — defaults, NOT NULL,
    CHECK and foreign keys, a validated constraint, a comment — commits
    nothing. A created or dropped table, index or constraint does: a literal
    naming it (`to_regclass('…')`, `'…'::regclass`) is resolved against the
    committed schema there and silently answers for the old one.
  It is still refused before effects (`V11021`, naming both statements)
  where no commit can be placed: two statements of one dispatch (one `sql`
  fragment holding `ALTER …; UPDATE …`) that need one between them.
- **Neki: a column change of a table created or renamed in the same
  transaction** (`ALTER COLUMN … TYPE`, `RENAME COLUMN`, `DROP COLUMN`,
  `SET SCHEMA`) failed mid-transaction there (`NK316`); `apply()` commits
  before it, and the other commands refuse it before effects (`V11021`).

### Changed

- **Neki: `apply()` resumes an open attempt it left.** Only the attempt of a
  state split at Neki's commit boundaries is resumed, from its confirmed
  steps; any other unfinished attempt still blocks `apply()`
  (`V11016`). Such a state's ledger now holds `started` and `step-confirmed`
  events, which a transactional state never wrote before; on PostgreSQL the
  groups, statements and ledger events are unchanged.
  `apply({ dryRun: true })` previews only the statements left to run of
  such an attempt.
- **Neki: what `down()`, `reset()`, `resolve({ outcome: "retry" })` and
  `push()` refuse.** They run their program in one transaction and refuse a
  program that would need a commit on Neki (`V11021`), now by the same
  measured rule: a data statement after a change Neki's planner sees (a
  default, NOT NULL, a CHECK or foreign key) is no longer refused, and a
  column change of a table created in the same transaction is. Whether the
  server is Neki is asked only of a program that would need a commit there;
  `apply()` reads its states' checks with their statements, the other
  commands their statements.
- A relation filter typed by a type parameter under an optional key, such as
  `<W extends UserWhere>(author: W, ok: boolean) => post.findMany({ where: {
  ...(ok ? { author } : {}) } })` or a held `{ author?: W }`, is refused, as
  1.2.0 refused it and as every release refuses it under a required key: its
  keys cannot be checked. Type the value as the payload (`author: UserWhere`)
  or write the filter out. Generic scalar values and generic `select` maps
  still compile.

### Not checked

- A misspelled key below an optional key of a `where` object that also
  spreads a value typed as the full `where` payload
  (`{ ...filter, ...(ok ? { writer: { emial } } : {}) }`). That object names
  every key of its model's `where`, so the check treats it as the payload.

### Upgrading from 1.2.1

- No schema or database change is required. A query that compiled on 1.2.1
  can now report a misspelled key below an optional key, which runtime
  validation already refused, or refuse a relation filter typed by a type
  parameter under an optional key (see Changed).
- On Neki, re-run `apply()` on the path 1.2.1 refused: no estate change is
  needed. A state it splits commits its schema part first; plan for that
  intermediate schema to be visible to the application while its data part
  runs.

## 1.2.1 — 2026-10-13

Fixes two type-checking regressions of 1.2.0: on queries whose nested
`select`/`include` `where` is typed by a held `where` type, and on a relation
node typed as the client's own payload and passed back.

### Fixed

- **TS2589 and `any` results on a nested `where` typed by a held `where`
  type.** 1.2.0's misspelled-key check on a nested `select`/`include` `where`
  (and, as in 1.1.0, on a root relation filter) followed every optional
  relation key of a value typed as the client's own `where` payload, such as a
  helper's `{ where: GrantWhere, select }` with `GrantWhere` read through
  `Parameters<…>`, and enumerated the paths through the model graph. On
  hub-shaped schemas the checker gave up with `TS2589: Type instantiation is
  excessively deep and possibly infinite`, the affected results became `any`
  (an exported query emitted `Promise<any>`), and wrong-type errors followed.
  The check now descends only the keys a value's type requires. On a 50-model
  schema with two hub models, recursive relation filters, helper-built queries
  and a client union, instantiations for 1.1.0 / 1.2.0 / 1.2.1:
  - TypeScript 5.9.3: 6.36M / 16.88M / 1.17M;
  - TypeScript 6.0.3: 6.54M / 17.05M / 1.34M;
  - TypeScript 7.0.2 (single-threaded): 9.05M / 17.45M / 1.71M;
  - `bun check` (Bun 1.4.3) wall time: 2.2 s / 3.3 s / 0.5 s.

  1.2.0 reported three TS2589 on each TypeScript (plus 22 follow-on errors on
  5.9 and 6) and nine under `bun check`, with `any` results; 1.2.1 reports
  none and infers every result. The TS2589 1.1.0 already had there, on a
  payload-typed `where` spread into a root relation filter, is gone too. The
  package tests now type-check that schema on all four checkers, the three
  TypeScripts within instantiation budgets.
- **TS2322 on a relation node typed as the client's own payload.** A nested
  node read through `Parameters<…>` and passed back, such as
  `select: { id: true, grants: grantNode }` with `grantNode` typed
  `Exclude<NonNullable<TeamSelect["grants"]>, boolean>`, or a held `include`
  node, was refused with `Property 'grants' is missing … but required in type
  'Record<"grants", never>'`. A to-many node's payload type is the union of
  the ordinary and the recursive node, and the recursive node's projection
  carries the relation's own name as an optional member that refuses it.
  1.2.0's misspelled-key check on a nested `select`/`include` counted that
  member as a key the caller wrote and refused it as unknown. The check now
  reads only the keys a value's type requires, as the `where` check does.
  1.1.0 compiled these queries, and 1.2.1 infers the same results.

### Changed

- A misspelled key below a key that is OPTIONAL in a `where` value's type is
  no longer a type error, at the root or in a nested `select`/`include`
  `where`. That covers a held value (with
  `filter: { writer?: { email: string; emial: string } }`,
  `findMany({ where: filter })` compiles) and a conditional spread inside a
  literal, which makes its keys optional the same way
  (`{ title, ...(ok ? { writer: { email, emial } } : {}) }`). 1.1.0 reported
  both at the root and 1.2.0 in nested `where`s too. A key the value's type
  requires, which includes every key written out in a literal, is checked as
  before, and runtime validation still refuses the unknown key.
- The same holds one level up, for the keys of a nested `select` or
  `include`: a misspelled key that is OPTIONAL in the value's type is no
  longer a type error (`books: { select: { title: true, ...(ok ? { ttitle:
  true } : {}) } }`, or a held `{ select?: { title?: true; ttitle?: true } }`
  node). 1.1.0 did not check nested `select`/`include` keys at all. Keys
  written out in a literal are checked as in 1.2.0, and runtime validation
  still refuses the unknown key.

### Upgrading from 1.2.0

- No source, schema or database change is required. Workarounds for 1.2.0's
  TS2589, such as typing a held filter `{}` or casting it, can be removed. To
  keep a type error on a misspelling inside a held `where` value, give the
  value a type that requires its keys, or write the filter inline without a
  conditional spread.

## 1.2.0 — 2026-10-12

Makes migrations safe to run unattended, from a deploy step or from a tenant's
Durable Object: bounded sessions, honest outcomes, recovery commands, consent at
`generate`, and SQLite rebuilds that cannot lose data. Also closes the round-2
review's client leftovers.

### Added

- **Tenant migrator.** `createTenantMigrator({ client, history, tables, limits })`
  from `viborm/migrations/tenant` changes one tenant's schema from its Durable
  Object. It is a helper over `createMigrationClient`.
  - `change(schema, { decisions, signal, beforeDestructive })` never throws. It
    returns `{ kind: "applied" | "noop" | "refused" | "failed" | "ambiguous",
    error?, marker? }`. `refused` means nothing changed.
  - Calls queue one at a time per migrator. `apply` is retried up to 4 times on
    transient failures and on a held lock (V11005), never after an ambiguous
    one. `beforeDestructive` is awaited before a destructive change publishes;
    if it throws, nothing is published.
  - `status`, `log`, `resolve`, `down`, `reanchor` and `prune` are exposed for
    RPC.
- **Decisions as data.** `createPredefinedResolver(decisions)` and the type
  `MigrationDecision` (from `viborm/migrations`) build a resolver from plain
  JSON: column and table renames, enum value mappings, and destructive
  approvals by `{ operation, table, column }`. A change no decision names is
  refused (V11010); an invalid entry, or one that answers no change of the
  plan, is refused with V4002 before anything is published.
- **`reanchor()`** (`migrations.reanchor()`, the tenant migrator's `reanchor()`,
  `viborm migrate reanchor [--to <state>]`). After a restore leaves the history
  older than the database (`status().markerState` is `"ahead"` or
  `"unknown"`), it moves the marker, under the lock, onto the one state whose
  snapshot the live schema matches exactly, writes a `reanchored` ledger event
  and runs no migration SQL. It refuses when no state matches (V11014), when
  several match, when the route holds a manual, opaque or data-only transition,
  when the marker's own path passed through the state, when an attempt is
  unfinished, or when the history holds the marker (V11009). `{ to }` adopts the
  named state as the new baseline.
- **Authored checkpoints bound a history.** `generate({ from: null })` (CLI
  `--from empty`) on a history whose schema equals its single leaf publishes a
  checkpoint. `migrations.prune({ checkpoint, into })` copies the checkpoint
  and the states after it into a fresh storage, never changes the source and
  touches no database (API only). `reanchor()` then moves each database onto the
  checkpoint, and every command loads only the checkpoint onwards.
- **Migration history storage for Workers.**
  `createDurableObjectStorageWriter(ctx.storage, { prefix })` from
  `viborm/migrations/storage/durable-object` and
  `createR2StorageWriter(bucket, { prefix })` from
  `viborm/migrations/storage/r2`. Both publish with an atomic conditional
  create and load without `nodejs_compat`. A prefix may hold any character,
  one outside the Basic Multilingual Plane (an emoji) included.
- **Per-dialect migration entries.** `viborm/migrations/postgres`,
  `viborm/migrations/sqlite` and `viborm/migrations/mysql` have the API of
  `viborm/migrations` but register only their own dialect's migration driver,
  so a PostgreSQL Worker no longer bundles the MySQL, SQLite and libSQL
  migration code, and the SQLite and MySQL entries carry no PostgreSQL catalog
  code.
- **Recoverable PostgreSQL index builds and foreign keys.**
  `generate({ lowLock: true })` (CLI `viborm migrate generate --low-lock`)
  publishes indexes on existing tables as `CREATE [UNIQUE] INDEX CONCURRENTLY`
  steps and foreign keys as `NOT VALID` plus a separate `VALIDATE CONSTRAINT`.
  No step blocks writes, the large-table refusal applies to none of them, and an
  interrupted build leaves one attempt that `resolve` settles. Apply such states
  over a direct, unpooled connection.
- **Migration limits.** `createMigrationClient(client, { limits })` takes a
  `MigrationLimits`: `lockTimeout`, `statementTimeout`, `idleTimeout`,
  `lockWait`, `connectionWait` (milliseconds) and `largeTableRows` (rows,
  PostgreSQL only). It is accepted without `storage` or `tables`.
- `auditStorage(client)` from `viborm/migrations`: the SQLite storage audit
  behind `viborm check --db`, for runtime and Durable Object callers.
- `parse(schema, value, { allIssues: true })` in `viborm/validation` reports
  every issue of a payload. Client operations still report the first one.
- `recurse: { maxOccurrences: n }` on a recursive projection sets its output
  budget (default 10,000 occurrences per outer row).
- `viborm/bun-sqlite` accepts `options.timeout`, the busy timeout in
  milliseconds (default 5000), applied as `PRAGMA busy_timeout`.
- Driver hook `beforeForeignKeysOff()`, run on the migration connection before
  `PRAGMA foreign_keys=OFF` (a Durable Object driver calls
  `ctx.storage.sync()` there).
- Exported types: `MigrationApproval`, `InvalidIndex`, `DownPreviewEdge` and
  `StorageColumnAudit` from `viborm/migrations`; `SQLITE_MIGRATION_CAPABILITY`
  and `SqliteMigrationCapability` from `viborm/driver`.
- Docs: a guide, "Per-tenant schemas from Durable Objects"
  (/docs/migration/per-tenant-schemas-durable-objects), and "Bounded History
  with Checkpoints" in the migrate guide.

### Changed

#### Migrations: safety

- **`generate` asks before destructive changes.** Drops, type changes, a
  tightened NOT NULL, a narrower decimal and a required column without a
  default go to the `resolve` callback before anything is published, as in
  `push`. Without a resolver `generate` refuses with V11017
  (`MIGRATION_CONSENT_REQUIRED`); a rejected change refuses with V11010. The
  approvals are saved in the state and shown by `show()` and `reviewSql`.
  `viborm migrate generate` asks on a terminal, accepts `--accept-data-loss`, or
  uses `migrations.resolve` from `viborm.config.ts`; piped input or `--json`
  without either refuses.
- **`down` and `resolve` refuse what they cannot do safely.** `down` asks
  before a generated destructive rollback touches a table that holds rows
  (V11017 without a resolver, V11010 when rejected) and takes `expectRevision`
  (V11015 when the marker moved). `viborm migrate down` gains
  `--accept-data-loss` and `--expect-revision <n>` and asks on a terminal.
  `resolve({ outcome: "rolled-back" })` refuses while a manual opaque step
  committed (V11019) or may have committed (V11020).
- **`down({ dryRun: true })`** returns `edges` (each edge's rollback SQL) and
  `refusal` (what `down` would raise, or `null`); `DownResult` is a union on
  `preview`. `viborm migrate down --dry-run` prints both and exits non-zero
  where `down` would refuse.
- **PostgreSQL migrations run under limits.** `lock_timeout = 4s` and
  `statement_timeout = 10min` on every migration transaction, idle timeouts of
  1 s, and a 10 s wait for the migration connection on every dialect. A
  statement stopped by a limit fails with V11001 whose `cause` is the V5006 or
  V2002. Only `CREATE`/`DROP INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY`
  and `ALTER TABLE … DETACH PARTITION … CONCURRENTLY`, read from the
  statement's own words, run without the limits.
- **PostgreSQL refuses a large-table rewrite** (`apply`, `down`, `push`, and
  `push({ dryRun: true })`), before any statement: a type change, `SET NOT
  NULL`, a volatile default, or a `FOREIGN KEY`/`CHECK` without `NOT VALID` on a
  table the planner estimates above `limits.largeTableRows` (1,000,000) is
  V11009, also when the same path renames the table first.
- **`generate` refuses a manual `CONCURRENTLY` statement declared
  `execution: "transactional"`** (V11012); 1.1.0 published it and `apply`
  failed with V2001. It reads PostgreSQL's executable words, as the session
  does: `ALTER TABLE … DETACH PARTITION … CONCURRENTLY` counts, and a comment
  or string literal that mentions `CONCURRENTLY`, or SQLite or MySQL SQL, does
  not.
- **Hyperdrive and Neon `-pooler` are refused for migrations.** Effectful
  commands (`apply`, `down`, `reset`, `baseline`, `resolve`, `verify`, `push`)
  refuse a `*.hyperdrive.local` or `ep-…-pooler.…` host with V8002 before
  connecting, unless the driver is given `migrationSessionAttestation:
  "dedicated-session"`.
- **SQLite admission is positive.** Migrations run only on a SQLite driver that
  declares `sqliteMigrationCapability` (the stock `sqlite3` and `bun-sqlite`
  do). An undeclared custom SQLite driver is refused (V8002) by every migration
  command, `generate` and `check` included.
- **SQLite stepwise transitions are refused.** `generate` refuses a manual
  transition or rollback declared `execution: "stepwise"` with V11021
  (`meta.feature: "stepwise execution"`) before publishing it. `apply`, `down`
  and `reset` refuse one that 1.1.0 published, with the same error, before any
  of the path runs; `resolve` still settles an attempt 1.1.0 left unfinished.
- **SQLite rebuilds refuse to lose data.**
  - A rebuild that would drop a trigger or break a view, including one written
    after a leading SQL comment, is refused with V11009 naming each dependent.
  - A type change into INTEGER, REAL or TEXT storage converts each value
    exactly or aborts with nothing changed (V2005).
  - The foreign-key lift is proven: `PRAGMA foreign_keys` must read `0`
    (V11021), and each `DROP TABLE` must keep every referencing table's rows
    and keys (V11001, rolled back).
  - A rebuild on a driver without transactions is refused (V11021).
  - Dropping a `decimal(p,s)` domain converts the stored coefficient (`5.00`
    becomes `5`, not `500`); a fractional value aborts; decimal to TEXT, REAL
    or a list is refused (V8001).
- **SQLite zone-less DateTime text is read as UTC.** `YYYY-MM-DD HH:MM:SS[.fff]`
  (as `datetime('now')` writes it) is accepted by the storage audit and by
  rebuilds. After every program that runs manual SQL, VibORM rewrites the
  destination's DateTime and Time text into canonical storage in the same
  transaction; a value it cannot rewrite aborts with V11014 and the marker does
  not move. Typed-client input still needs `T` and a zone.
- **SQLite migrations hold the write lock.** Every effectful command reads the
  marker inside `BEGIN IMMEDIATE`, waiting up to `limits.lockWait` (10 s). A
  concurrent runner gets `noop` or V11015 instead of its first colliding
  statement's error.
- **A reorder-only document is a `noop`.** `generate` publishes nothing for a
  schema that only reorders models or fields.
- **`push` refuses to orphan polymorphic rows**: a stored discriminator the
  schema no longer declares refuses with V11010, as `generate` already did.
- `resolve({ outcome: "retry" })`, `reset()` and `reset({ dryRun: true })`
  refuse, before any effect, what `apply` refuses about the program they run:
  a SQLite rebuild that would drop a manual trigger or break a view (V11009), a
  PostgreSQL rewrite of a table above `largeTableRows`, and on PlanetScale Neki
  a data statement after a schema change (V11021).
- PlanetScale Neki: `apply`, `down` and `push` refuse, before any effect and
  with V11021 naming both statements, a transaction that runs a data statement
  after a schema change (Neki plans each statement against the schema committed
  before its transaction).
- PostgreSQL: renaming a column or a table also renames the names derived from
  it: a per-column enum type (`<table>_<column>_enum`, by `ALTER TYPE …
  RENAME`), and an index, unique constraint or foreign key named after its
  table and columns (`_idx`, `_key`, `_fkey`). Such a rename was refused with
  V8001 (a unique index), asked as a destructive drop or type change (an enum
  without `name`), or rebuilt its index. A table rename also moves an index, unique or foreign
  key whose name takes the derived shape `<table>_…_idx` (`_key`, `_fkey`)
  whatever follows the table's name: a compound unique over `.map()`ped
  columns, a named compound unique, an index over a mapped field. A name you
  set yourself in that shape moves with the table; any other custom name stays
  as it is.
- MySQL: renaming a table, or a column, with a derived unique, index or
  foreign key is no longer refused with V8001. The rename carries `RENAME
  INDEX`; a foreign key is dropped and added under its new name in the same
  `ALTER TABLE`, which MySQL runs as a table copy.

#### Migrations: outcomes and recovery

- A statement a migration dispatches that the database refuses fails with
  `MigrationError` V11001 (`meta.providerCode`/`providerSqlState`, provider
  error as `cause`) instead of the driver's `QueryError`/`ConstraintError`. A
  refused PostgreSQL catalog read is V11001 naming the read and its SQLSTATE.
- A failed transactional `apply` leaves a durable `failed` event, shown by
  `status().lastFailure`; a failed first apply keeps the two control tables.
- A lost COMMIT reply is decided by re-reading the marker: `applied`, or V11020
  (`MIGRATION_AMBIGUOUS_COMMIT`). A failure to end the session after a commit is
  an `applied` with `warnings`.
- A lost migration connection fails with retryable V1001 and nothing more is
  sent on it (node-postgres, postgres.js and Bun SQL). postgres.js
  `CONNECTION_DESTROYED`, `CONNECTION_ENDED` and `EPIPE` map to `ConnectionError`
  (V1001) instead of `QueryError`.
- An INVALID index left by an interrupted concurrent build no longer breaks
  every command: `status()` lists it in `invalidIndexes`, schema-comparing
  commands refuse with V11023 (`MIGRATION_INVALID_INDEX`), and `resolve` drops
  or rebuilds it.
- A marker the history does not hold: `status()` returns
  `markerState: "ahead" | "unknown"` instead of throwing V11002, `verify()`
  returns `{ ok: false, markerState }`, and `apply({ ifAhead: "noop" })`
  boots without touching the database.
- `apply` starts again when no marker exists and every attempt is closed;
  `baseline` accepts the same histories.
- A transactional group writes one `applied` event per state instead of
  `started` and `step-confirmed` events, and a step that fails inside it reports
  V11001 or V11014 instead of V11009/`MIGRATION_PARTIAL_EFFECT`. Every command
  except `log()` reads only the open attempts and the latest failure.
- An edge that validates a constraint commits alone.
- `baseline`, `down`, `resolve({ outcome: "retry" })` and `reset` prove the
  live schema with the catalog digest; a digest defect is `INTERNAL_ERROR`
  instead of `MIGRATION_DRIFT`.
- The ledger has a new event kind, `reanchored`, written only by `reanchor()`.
- PostgreSQL stores each partial-index predicate in the marker row
  (`predicates`) when `apply()` reaches a state.
- `generate({ from: null })` on a populated history publishes a checkpoint when
  the schema equals the single leaf, and otherwise refuses with V11012.
- A push consent is no longer tied to the client that previewed it;
  `PushTargetIdentity` loses `bindingId`.
- SQLite: a force-reset plan whose tables hold foreign keys lists `PRAGMA
  defer_foreign_keys = ON` (it had no statement there, and crashed), which
  changes `push({ forceReset: true })` plan hashes and reset clear-dispatch
  identities for those schemas.
- The tenant migrator applies a tenant's first `change()` when given
  `beforeDestructive` (1.1.0 refused it with V11012).
- Tenant migrator: a transport `apply` refuses (a Neon `-pooler` host or
  Hyperdrive without the attestation) is `refused` with V8002 before `generate`
  publishes anything; it was `failed`, with a published state left behind.
- Tenant migrator: `error` carries `causeCode`, the code of its cause, and
  `providerSqlState`, the server's SQLSTATE, when there is one.
- `down({ resolve })`: the resolver is asked with no transaction open, and the
  lock is let go while it answers. It was asked inside the locked transaction,
  so on PostgreSQL a resolver slower than `idleTimeout` (1 s by default; an
  interactive prompt) had the server end the session (25P03) and `down` failed
  with V1001; on SQLite every other writer got `SQLITE_BUSY` while it waited.
  The rollback then takes the lock again and re-reads the marker and the open
  attempts: if another command moved the marker, or left an attempt open,
  meanwhile, `down` refuses with V11015 and runs nothing.
- A manual stepwise statement the database refused whole (one statement, such
  as a unique-key violation or `lock_timeout`) committed nothing: it fails with
  V11001 (`MIGRATION_FAILED`, `meta.effectState: "none"`, `meta.partial:
  true`) instead of V11020, its refusal is recorded in the ledger, and
  `resolve({ outcome: "rolled-back" })` closes its attempt once the origin
  checks hold. The attempt stays open until then, so the tenant migrator
  reports it as `ambiguous` and does not retry it. A `CALL`, `DO`, `EXECUTE` or
  `CONCURRENTLY` statement, which can commit part of its work before failing,
  still reports V11020.
- Migration errors keep their metadata and keep a thrown non-Error as `cause`;
  `MIGRATION_PATH_REQUIRED` (V11013) and the `createMigrationClient` options
  refusal (V4002) have new messages.

#### Migrations: transports and packaging

- **PostgreSQL migrations take a transaction-scoped lock** in each migration
  transaction, so every command runs through PgBouncer in transaction mode.
  Only stepwise work takes a session lock. A later group re-reads the marker
  and refuses with V11015 if it moved.
- PostgreSQL: a command waiting for the migration lock waits outside any
  transaction, instead of one statement looping on the server. Each locked
  transaction sets its limits and tries the lock in one statement; a refused
  try rolls back, then the command tries again with one autocommit statement
  after each pause (50 ms, doubling to 250 ms, jittered) until the lock is
  free or `lockWait` is spent (V11005). The wait holds no snapshot, so another
  command's `CREATE INDEX CONCURRENTLY` (a `lowLock` step) is no longer held
  up until the waiter gives up, and the seed-2 tenant battle sends about 33
  statements per change instead of 62. Neon HTTP keeps the one-statement wait,
  since one request cannot loop across requests.
- PostgreSQL: `apply`, `baseline` and `reset` create the migration control
  tables in a transaction of their own, committed before the first marker; the
  lock is taken again and the marker re-read before work continues. A
  `baseline` refused by its live proof now leaves the empty control tables
  behind, as a failed first `apply` already did.
- PostgreSQL: partial-index predicates are deparsed through regular scratch
  views in the estate's schema (created, read and dropped in one transaction,
  under a random name) instead of temporary views. The deparsed text is
  unchanged.
- **Neon HTTP runs `apply()`**, one HTTP request per transactional group.
  Stepwise transitions and destinations the one-statement digest cannot prove
  (a partial index) are refused with V11021. The other commands still refuse
  (V8002). A request refused for the lock or a moved marker records no
  `failed` event: the group never ran.
- **`createFsStorageWriter` is exported only from
  `viborm/migrations/storage/fs`.** `viborm/migrations` loads no Node builtin
  and runs on Workers without `nodejs_compat`.
- `viborm/migrations/tenant` registers no migration driver; the dialect entry
  you import does.
- `sideEffects` in `package.json` lists the four migrations entries instead of
  `false`.
- `createStorageConformanceSuite()` runs nine cases instead of four.

#### Schema and drivers

- **PostgreSQL: only a generated uuid gets `DEFAULT gen_random_uuid()`.** A
  caller-supplied uuid (`.uuid()` off the key, `.id({ generate: false })`, or one
  with its own `.default(...)`) gets none, so the next `generate` or `push`
  emits one `ALTER COLUMN … DROP DEFAULT` per affected column.
- **Connection URL and options combine key by key.** On `viborm/pg`,
  `viborm/postgres` and `viborm/mysql2`, the URL supplies only the keys it
  carries and every key set in `options` wins. `viborm/pg`'s
  `options.connectionString` wins over `databaseUrl`. On `viborm/pg` and
  `viborm/postgres`, an undefined or empty `databaseUrl` with no host, pool or
  client throws V1004.
- Every driver's `createClient` refuses a configuration key it does not read
  (V1004), for example `databaseUrl` on `viborm/sqlite3`.
- `viborm/sqlite3` keeps the `options.timeout` you pass instead of 5000 ms.
- `viborm/mysql2` refuses TLS URL settings it cannot honour with its own
  messages.
- `sslrootcert=system` in a PostgreSQL URL is read by `viborm/pg` and
  `viborm/postgres` as `sslmode=verify-full`.
- `@cloudflare/workers-types` peer range is `^4 || ^5`.

#### Client

- **To-many nested writes accept any verb order.** `{ connect, disconnect }`
  and other adding-before-clearing spellings no longer fail with V4001; they
  run in the fixed clear-first order (`disconnect, delete, set, updateMany,
  deleteMany, update, upsert, connectOrCreate, connect, create, createMany`).
- **JSON `{ set: value }` is the write envelope on create too**: `create`,
  `createMany`, both `upsert` arms and nested creates store `value`, as update
  did.
- **Caller-input mistakes are `ValidationError` (V4001)** with the key in the
  issue path: an empty `groupBy` `by` (was V2001); an `orderBy` or `having`
  field outside `by` (was V9001); a `select` that names nothing at any depth,
  `select: { _count: true }` on a model with no to-many relation included (was
  V9001; `createMany` now refuses before writing); a JSON null sentinel under
  `path` or used as a filter.
- A recursive projection over its output budget is `UnsupportedOperationError`
  (V8003, `meta.feature: "recursive output budget"`) instead of V4001.
- A `ValidationError` names its model (`Validation failed for user.create: …`),
  and a union refusal reports the failing member's own issue.
- A BigInt field accepts an integer string (`"-42"` reads as `-42n`).
  `toJsonSchema` describes BigInt as an integer string and exports decimal
  precision and identifier formats as patterns.
- A `_sum` that leaves its type's range no longer fails the call: a `number`
  sum returns `±Infinity`, a `bigint`/`decimal` sum is exact on SQLite, an
  `int` sum past 2^53 returns the nearest double. `having` and `orderBy` on a
  `_sum` use the same total.
- `in`/`notIn` lists bind as one parameter on PostgreSQL (`= ANY($1)`) and,
  past 25 members, on the SQLite family (`json_each(?)`). Shorter SQLite lists
  keep a parameter per member, so a key list beside another indexed column
  still seeks the primary key without `ANALYZE`. A `bytes` list past 25
  members needs SQLite 3.41 (`unhex`). An `OR` of equalities on one column is
  sent as `in`, and other long `OR`s are balanced trees.
- Nested one-to-many `create` lists send one multi-row INSERT per child table,
  and a counter `upsert` on one unique key is one `INSERT … ON CONFLICT DO
  UPDATE` on PostgreSQL and SQLite.
- The client types reject a misspelled key beside a correct one in nested write
  data, a nested `select`/`include`/`where`, a root `where` operator object and
  a `groupBy` `orderBy` outside `by`.
- Editor hovers over `RelationLinks<S>` and `$schema` relation targets print an
  equivalent but differently shaped type; inferred results and emitted
  declarations are unchanged.

### Fixed

- Works on PlanetScale Neki: two-term recursive CTEs; no whole-row reference in
  introspection; introspection errors name their query.
- Works on PlanetScale Neki: `apply`, `baseline`, `verify`, `status`, `down`
  and `reset`, partial indexes included. Stepwise transitions (and `lowLock`
  steps) do not run on Neki yet.
- SQLite `push`: rebuilding a table with an expression default, such as
  `s.dateTime().now()`, no longer fails with V2001, and the rebuild no longer
  copies a `sqlite_autoindex_*` name into its UNIQUE constraint. Present in
  1.1.0.
- PostgreSQL: a partial-index predicate combining `BETWEEN` with `AND` no longer
  fails its first `apply` with false drift (V11014).
- PostgreSQL: float defaults at or above 1e21 no longer fail `push` with V11014.
- `viborm/pglite` accepts a PGlite instance from another copy of
  `@electric-sql/pglite` (1.1.0 failed every transaction with V5001).
- R2 history storage: losing a publish race with R2 error 10058 returns
  `identical` or V11022 when the winner is readable.
- Workers with `nodejs_compat`: a refusal raised before any I/O no longer
  surfaces as an unhandled rejection.
- A PostgreSQL `apply` no longer reports the large-table preflight as "NaN
  rows" when `EXPLAIN` gives no estimate; it names the plan line.
- Migration commands: a lost connection, a lock wait that ran out, or another
  retryable failure while reading the control tables is reported as itself
  (V1001, V1002, V11005, …), no longer as V11009 "Migration control tables
  cannot be authenticated". A PostgreSQL command reopens its lock on the read
  that follows one of its own commits (a stepwise or `lowLock` step), so under
  contention the tenant migrator refused such a change instead of retrying it.
- `migrations.reset()` and `reset({ dryRun: true })` on SQLite no longer fail
  with an uncoded `Error` ("Cannot drop foreign key") on any schema with a
  relation, and `push({ forceReset: true })` no longer fails the same way. The
  SQLite clear defers foreign keys to COMMIT, so tables whose keys form a cycle
  or reference themselves are cleared too.
- SQLite `reset()` replays a table recreation with foreign keys lifted and
  checked, as `apply` does. `ON DELETE CASCADE` / `SET NULL` deleted or nulled
  the child rows a replayed manual migration wrote, and verify still passed.
- `viborm/pg`: a password callback in `options` beside `databaseUrl` or
  `options.connectionString` is refused at construction with
  `ClientInitializationError` (V1004). node-postgres replaced it with the URL's
  password, or none, and every connection failed to authenticate.

### Performance

- PostgreSQL: an `apply()` with nothing to do sends 2 statements instead of
  about 30, estates with partial indexes (soft delete) included. Every command
  reads the control plane in 3 statements instead of 5.
- PostgreSQL: a two-operation transactional change sends 3 control statements
  while holding the table lock instead of 17.
- Migration commands cache parsed artifacts per process: a 200-state history
  loads in about 11 ms warm instead of 190 ms.
- A nested `create` of 25 posts sends 5 statements instead of 29 on SQLite and
  4 instead of 28 on PGlite.
- SQLite: a page of 100 posts with their tags (many-to-many) went from about
  7.8 ms to 0.8 ms.
- Type-checking a 100-model schema (TypeScript 5.9): a three-level include
  1.66M instantiations to 311k, a nested create with include 1.66M to 347k, a
  filtered select 1.53M to 311k (2.1 s to 0.65 s).

### Upgrading from 1.1.0

- **Upgrade every machine and CI job together** that runs migration commands
  or reads the history. 1.1.0 refuses three things 1.2.0 writes:
  - a destructive state's `approvals`: keep 1.2.0 for any history that holds
    one;
  - the PostgreSQL marker's `predicates` key (V11012). To run 1.1.0 against the
    database again, first run
    `UPDATE "<schema>"."_viborm_migration_state" SET payload = (payload::jsonb - 'predicates')::text WHERE singleton = 1;`
  - a `reanchored` event (V11012). To run 1.1.0 again, run
    `DELETE FROM "<schema>"."_viborm_migration_log" WHERE kind = 'reanchored';`
    (on MySQL and SQLite drop the `"<schema>".` qualifier; MySQL keeps it, with
    backticks, when the client sets a namespace).
- **PostgreSQL migration role:** commands that compare partial indexes
  (`apply`, `baseline`, `verify`, `down`, `reset`, `push`) need `CREATE` on the
  estate's schema instead of `TEMP` on the database. A role that changes the
  schema already has it; grant it to a role that only applies data-only
  transitions.
- **PlanetScale Neki:** put a data change that depends on a schema change in a
  state of its own, then run `apply({ to: <schema state> })` and `apply()`.
- **Destructive changes:** pass `resolve` to `generate` and `down`, for example
  `resolve: (c) => (c.type === "destructive" ? c.proceed() : undefined)` or
  `lenientResolver`. CI jobs running `viborm migrate generate` or `migrate down`
  on such changes pass `--accept-data-loss` or set `migrations.resolve`. A
  relative `down({ steps })` should pass `expectRevision`. When
  `resolve --rolled-back` refuses with V11019/V11020, finish by hand and run
  `resolve --complete`. Scripts that check only the exit code of
  `migrate down --dry-run` now fail where `down` would; narrow `DownResult` on
  `preview`.
- **Limits:** a migration that waits over 4 s for a lock or runs over 10 min
  now fails; re-run it, or raise `limits` (`0` turns a server limit off). A
  V11009 large-table refusal runs from a job with
  `limits: { largeTableRows: 0, statementTimeout: 0 }`, or use
  `generate({ lowLock: true })` for indexes and foreign keys. A manual
  `CONCURRENTLY` transition must declare `execution: "stepwise"`.
- **Hyperdrive and Neon:** migrate through the direct endpoint (drop `-pooler`;
  use the origin URL instead of Hyperdrive). Pass
  `migrationSessionAttestation: "dedicated-session"` only after verifying the
  endpoint keeps one server session per connection. PgBouncer in transaction
  mode now works without it. `apply()` over Neon HTTP migrates instead of
  throwing V8002: remove a fallback that relied on it, and keep a session client
  for the other commands, stepwise and partial-index changes.
- **Custom SQLite drivers** that run migrations add
  `readonly sqliteMigrationCapability = SQLITE_MIGRATION_CAPABILITY;` after
  confirming its claims, need transactions for rebuilds, and on Durable Objects
  implement `beforeForeignKeysOff()`.
- **SQLite stepwise transitions:** declare SQLite manual work, rollbacks
  included, `execution: "transactional"`. Apply, roll back or reset across a
  stepwise state 1.1.0 published with 1.1.0 while a database still needs it;
  regenerate an unapplied one as `execution: "transactional"`.
- **SQLite rebuilds:** drop the triggers or views a V11009 names before the
  change and recreate them after; clean values that do not convert exactly
  before a type change; a decimal column retyped to `int`/`bigint` under 1.1.x
  holds coefficients (divide by `10^scale`); regenerate unapplied 1.1.x
  transitions to get the checked copies.
- **SQLite DateTime:** remove manual `replace(col, ' ', 'T') || 'Z'` repair
  steps, and run `viborm check --db` before a manual migration on an existing
  database.
- **Reorder-only documents:** treat `outcome: "noop"` (`stateId: null`) as
  nothing to apply.
- **`generate({ from: null })`** on a populated history: omit `from` to keep
  generating ordinary states.
- **Error codes:** catch V11001 (read `error.cause` or
  `meta.providerSqlState`) where you caught `QueryError`, `ConstraintError`,
  V2xxx, V5006 or V2002 from migration commands, or V11009 from a refused
  catalog read; treat V1001, V1002 and V11020 as retryable; read `apply()`'s
  `warnings` instead of alerting on V11005 after success; handle V11001 and
  V11014 where you matched V11009 or `MIGRATION_PARTIAL_EFFECT` from a
  transactional apply; handle `INTERNAL_ERROR` beside `MIGRATION_DRIFT` from
  `baseline`, `down`, `resolve` and `reset`; match V11023 instead of V8001 for an
  invalid index, and `status().markerState` instead of V11002/V11022 for version
  skew. Wherever you match V11020 after a stepwise `apply` or `down`, also match
  V11001 with `meta.partial === true`, and settle its attempt with
  `resolve({ outcome: "rolled-back" })`. Match migration errors on `code`, not
  message text.
- **Ledger and status readers:** expect one `applied` event per state from a
  transactional apply; check `marker`, not the presence of the control tables;
  handle `"reanchored"` in a switch over `LedgerEventV1["kind"]`. Push consents
  saved by 1.1.0 are stale (V11018): preview again, and stop reading
  `bindingId`. On SQLite, so is a force-reset consent for a schema with
  foreign keys taken before the upgrade: take a fresh
  `push({ forceReset: true, dryRun: true })` preview.
- **Imports:** `import { createFsStorageWriter } from
  "viborm/migrations/storage/fs"`. Next to `viborm/migrations/tenant`, import a
  dialect entry such as `import "viborm/migrations/postgres";`. Custom storage
  writers must pass the nine conformance cases.
- **PostgreSQL uuid defaults:** run `migrate generate` once per history and
  apply the `DROP DEFAULT` everywhere (`push` shows the same diff); raw SQL that
  relied on the database inventing those uuids must supply them.
- **Driver configuration:** remove keys a driver does not document (on
  `viborm/sqlite3`, `dataDir` replaces `databaseUrl`); remove from `options` any
  value you relied on the URL to override; set or omit a `databaseUrl` that may
  be undefined; on `viborm/sqlite3`, remove `options.timeout` to keep 5000 ms. A
  URL combining `sslrootcert=system` with a weaker `sslmode` now verifies TLS.
  PlanetScale users stay on `@planetscale/database` 1.x. On `viborm/pg`, pass
  a password callback with `host`, `user` and `database` in `options` and no
  URL.
- **Nested writes:** a payload naming one target in a clearing and an adding
  verb meets the clearing verb first; split it if the removal must win.
- **JSON:** to store a document whose only key is `set` through a create, write
  `{ set: { set: value } }`.
- **Validation:** catch `ValidationError` (`V4001`) and read
  `error.issues[0].path` for the mistakes listed above; catch the recursion
  budget as `UnsupportedOperationError`; match `error.meta.model` instead of
  message text; check types before VibORM if a BigInt field must refuse
  strings; regenerate published JSON Schemas.
- **Aggregates:** test `Number.isFinite(result._sum.field)` for a `number`
  sum and `Number.isSafeInteger` for an `int` sum, or declare `s.bigInt()`;
  grouped `orderBy` on an overflowing sum may reorder rows.
- **Logged SQL:** `in` lists appear as one parameter (on SQLite past 25
  members, which for a `bytes` list needs SQLite 3.41), nested `create` lists as
  one multi-row INSERT, counter upserts as one `INSERT … ON CONFLICT`, and
  many-to-many pages join the junction first: update statement counters, log
  filters and fingerprints. Manual chunking of large `in` lists can go.
- **Types:** fix the misspelled keys `tsc` reports; write out whole nested
  write objects, root operator objects or nested `where`s instead of passing a
  type parameter, and narrow a `groupBy` `orderBy` type to the grouped fields.
- **Migration lock (PostgreSQL):** each locked transaction opens with
  `BEGIN` and one `SELECT set_config(…), …, pg_try_advisory_xact_lock(…) AS
  acquired`; while a command waits, logs show `ROLLBACK`, then
  `SELECT pg_try_advisory_xact_lock(…) AS acquired` every 50 to 250 ms,
  instead of one `WITH RECURSIVE lock_attempt` statement: update statement
  counters and log filters.
- **`down({ resolve })` (PostgreSQL):** a `down` that asks its resolver can
  now fail with V11015 when another command moved the marker while the
  resolver answered; run it again.
- **Renames (PostgreSQL, MySQL):** a rename refused before can be generated
  now; its SQL carries the derived names' `RENAME` statements. States published
  earlier keep their SQL. A name you set yourself is not renamed, unless it
  takes the derived shape `<table>_…_idx` (`_key`, `_fkey`): to keep such a
  name across a table rename, give it a name that does not start with
  `<table>_`, or expect `generate` to drop and recreate it under the declared
  name.
- **Tenant migrator:** handle V8002 as `refused` (use the direct endpoint), and
  read `error.causeCode` and `error.providerSqlState` to diagnose a failure
  received over RPC.

## 1.1.0 — 2026-10-10

Adds recursive relation filters, fixes the regressions found in the round-2
review of 1.0.0, and removes per-operation work that protected nothing.

### Added

- **Recursive relation filters.** A `where` filter on an ordinary self relation
  accepts `recurse` and quantifies over the relation's transitive closure. This
  covers a foreign key such as `parent`/`children`, or a junction such as
  `team.parents`/`team.children`.
  - Example: `{ parent: { recurse: true, self: true, some: { grants: { some: {
    userId } } } } }` matches a document when it, or any ancestor, carries the
    grant.
  - `recurse` takes the same options as in `select`/`include`: `true` follows
    100 levels, `{ depth: n }` follows 1–1000 levels, `{ depth: false }` is
    exhaustive.
  - `self: true` includes the row itself. `some`/`every`/`none` take the related
    model's full `where`; with `recurse`, a to-one relation accepts them too.
  - Cycles and diamonds terminate, and each reached row counts once. Rows
    hidden by `softDelete` or a `rows` extension stop the walk.
  - It compiles to one correlated `WITH RECURSIVE` inside `EXISTS`. It works in
    every read, `count`, aggregates, `updateMany`/`deleteMany`, and nested
    inside other relation filters.
- **`viborm check --db`** audits SQLite-family storage: non-canonical
  DateTime/Time text, decimal columns without VibORM's scaled-integer storage,
  and audited columns missing from the database. It exits 1 when any exists,
  prints the repair route and adds a `storage` report to `--json`.

### Fixed

- **SQLite, libSQL, bun:sqlite and D1: typed queries no longer inspect physical
  storage.** In 1.0.0, every statement on a model with a DateTime, Time or
  Decimal column was surrounded by a catalog read, `BEGIN IMMEDIATE`, a storage
  assertion and `COMMIT`; DateTime and Time columns also scanned the whole table
  twice. A primary-key lookup on a `createdAt` + `updatedAt` model took 82 ms at
  1k rows and 7.7 s at 100k. D1 refused every query on a model with a text
  DateTime column (statement too long, or pattern too complex). One
  non-canonical timestamp row made the whole model fail with V8003. A typed
  statement now sends only its own SQL: one statement per `findUnique`, about
  0.05 ms at 100k rows, and no write lock for reads.
- **libSQL: a `SQLITE_BUSY` while opening a transaction no longer loses later
  writes.** The SDK reused a connection left inside the failed `BEGIN`, so later
  writes were acknowledged and never committed. The client is now quarantined
  (V1003) as it already was for a busy statement.
- **`where: { field: 0 }` on an int or bigint column no longer throws** "Explicit
  zero is not portable for an auto-increment field" when an `.increment()` id
  was built first. The zero refusal applies to the auto-increment id on create
  only.
- **Push never renames a table without a named pair.** `lenientResolver` and the
  documented resolver could rename another application's table into a new
  model, labelled non-destructive. `lenientResolver` now renames columns only
  and leaves table pairs undecided, in push and in `migrate generate` alike:
  name each table pair in a resolver. Every table rename is destructive and
  needs consent.
- **PostgreSQL: adding enum values uses `ALTER TYPE … ADD VALUE [BEFORE …]`
  again.** 1.0.0 recreated the type for an append, rewriting every table using
  it, and failed when a view, rule or CHECK depended on the column. The type is
  replaced only for removals, reorders, and when the same migration may use a
  new value (a default naming it, a column converted to the enum, or a new
  partial-index predicate naming the enum or one of its columns); any such
  replacement still fails on a dependent view, rule or CHECK (#85).
  `apply`, `down` and `reset` commit after a migration that adds enum values.
- **postgres.js: a `BEGIN` that cannot connect leaves the client usable.** It
  rejects with the retryable V1001 instead of quarantining the client with V5001
  until `$disconnect()`.
- **`s.enum()` accepts a readonly tuple**, so the documented
  `const STATUS = [...] as const` recipe compiles and keeps its literal union.
- **libSQL: BigInt keys read from a many-to-many junction are exact** with a
  supplied client in `intMode: "number"`.
- **MySQL: `updateMany`/`deleteMany` filtered through a relation now match the
  rows that matched before the statement.** MySQL evaluates such a filter row
  by row while the statement, and the cascades it fires, change the rows the
  filter reads, so a self relation or a cascading delete could change or remove
  the wrong rows. The filter now reads the matching keys first, in the same
  statement, as PostgreSQL and SQLite already answered.

### Performance

- `exist()` and unpaged `count()`/`aggregate()` read the filtered table
  directly instead of a subquery ordered by primary key: `count()` on 200k rows
  went from about 1.8 ms to about 30 µs on SQLite and from about 35 ms to 10 ms
  on PGlite.
- A supplied libSQL client no longer sends a setup statement before its first
  query: one Turso round trip less per client.
- Nested writes on D1, Neon HTTP and MySQL batch routes no longer send a
  `DELETE` that could never match.
- bun:sqlite reuses compiled statements through its own `query()` cache.

### Changed

- **TypeScript 5.9 is the minimum supported version (was 5.8).** On 5.8 a
  three-level include over a 100-model schema fails with TS2589. The package
  gate type-checks that schema as an installed consumer on 5.9.
- libSQL: a supplied client may use intMode `"number"` or `"bigint"` (1.0.0
  refused `"number"` with V1004); `"string"` mode is not supported for typed
  reads.
- Documentation: the homepage states the V1 status; the configuration and
  Cloudflare KV examples run as written; the Raw SQL page warns about compact
  ids stored as bytes, and the vector page about hand-made HNSW indexes. The
  postgres.js page documents its two round trips per query, the
  `options.prepare` opt-in, and `viborm/pg` as the one-round-trip driver.
- On a to-one relation filter, the key `recurse` now always selects the
  recursive filter. Filter a target field literally named `recurse` through
  `is`: `{ parent: { is: { recurse: … } } }`.

### Upgrading from 1.0.0

- **SQLite databases written by another tool or by an RC.** Typed queries no
  longer check stored values. Timestamps stored as non-canonical text are
  missed or misordered by filters until repaired. A foreign `DECIMAL(p,s)`
  column that VibORM never pushed or migrated reads whole numbers as scaled
  coefficients (3 reads as 0.03). Run `viborm check --db`, and adopt foreign
  tables through push, migrate or a baseline; see the SQLite migration guide.
- **PostgreSQL migrations generated by 1.1.0 that add enum values** must be
  applied, rolled back and reset by 1.1.0 or later.

## 1.0.0 — 2026-10-09

- Repair the confirmed transaction, driver lifecycle, SQLite storage, scalar,
  nested-write, cache, type and migration defects from the October 8 adversarial
  review. Provider qualification and remaining product gaps are recorded in the
  remediation report.
- Support Neon serverless 1.2 and libSQL 0.18; require a fixed SQLite library floor.
  Raw SQL remains physical, while typed DateTime, Decimal, ID and vector values
  have explicit admission and decoding contracts.
- Refuse unsafe schema/index adoption before effects; preserve migration atomicity,
  canonical temporal defaults and JSON null distinctions.
- Load TypeScript config and project environment files in the CLI; correct the
  installation and persistence recipes. Ship third-party license notices.
- Preserve exact cyclic relation types when applications export inferred clients
  or client factories and emit declarations. No getter annotations or codegen
  are required. Rebuilding a client from separately emitted raw cyclic models
  retains its documented limitation.
- Keep PostgreSQL migration rename planning, generated constraint names and
  rollback consistent. Apply accepted table and column renames before enum
  changes that use their new names, retaining enum array and default metadata.

- **Fixed: an unlimited soft delete no longer reads every candidate key to
  lock them.** Before tombstoning a model that a restricting relation
  references, a `deleteMany` without `limit` locked its candidates by reading
  all their keys into memory. PostgreSQL and MySQL now take the same locks
  with one counted row back; SQLite, which has no row locks, skips the read.
  A `deleteMany` with `select` still reads one key per row it returns.
- **Fixed: a limited soft delete checks every value its statements bind.** A
  soft `deleteMany` with `limit` chose its window of locked keys by counting
  the keys alone, so a long `in` list or a selected result re-read by key
  without `RETURNING` (MySQL) could still fail with "needs N bound values,
  above the verified limit". The keys are still capped at half the bind
  budget, and the compiled statements, with everything they bind, are now
  checked too; past either, the window is the key range. In an array
  transaction the window is SQL beside the caller's filter, which is then
  bound twice; past the budget it is refused before anything is written.
- **Fixed: a mutable control value no longer keys shared state.** A control
  value holding a `Date` or bytes, or a frozen object whose getter changes its
  answer, could key a row filter or a cached read whose value then changed
  under it. Such a value, and one holding a getter or a non-enumerable
  property, now binds its row filters for its call alone and its read is not
  cached.
- **Fixed: a dropped `pg` connection no longer ends the process.** While a
  `$transaction` (or a migration's reserved session) held a pooled client,
  nothing listened to that client's `error` event: a server restart, failover
  or terminated backend crashed Node with an unhandled `error`, and code that
  contained it could commit and return the broken client to the pool. The
  transaction now rejects with that failure, never commits after it, and
  releases the client so the pool destroys it.

## 1.0.0-rc.5 — Release candidate

- **Performance: a client created per request.** Clients built over the same
  schema object share the schema's validation, registries and prepared
  queries, so a client created per request (a Worker, a serverless handler)
  no longer rebuilds them; better-sqlite3 reuses its prepared statements per
  SQL text; SQLite and D1 collection reads decode positional rows; first-use
  code stays out of the cold path, and the result cache loads with
  `viborm/cache`, not with the client. The shipped bundle is about 36 KiB
  smaller.
- **Added: `viborm check`**, a CLI command that runs the full schema
  validation, and `createClient({ skipSchemaValidation: true })` for an
  application that already ran it: the client then resolves relations only.
- **Behaviour change: `v.array` reports a hostile array** (a revoked proxy, a
  throwing read) as a validation issue instead of throwing.
- **Behaviour change: malformed binary data from a driver is refused**
  instead of decoded leniently. Every shipped driver returns well-formed
  values.
- **Behaviour change: `isRetryable()`** on an error carrying an unregistered
  code answers "not retryable" instead of throwing.
- **Fixed: cache keys accept a value reached twice.** A cached read whose
  arguments reused one array or object (`{ id: { in: ids }, parentId: { in:
  ids } }`) failed with "Circular reference in cache key args"; only a real
  cycle is refused now.
- **Fixed: `push` reads the database catalog one statement at a time.** It
  read every catalog query at once on its one session, which node-postgres
  queues and warns, on every `push`, that pg@9 will refuse.
- **Added: `viborm/soft-delete`, the official soft-delete extension.**
  `softDelete({ models, actor })(client)` turns deletes of the named models
  into tombstones (the call's time in a nullable `DateTime` field, and
  optionally the actor), hides tombstones from every query that selects rows,
  and adds `restore`/`restoreMany`. `deleted: "without" | "with" | "only"`
  chooses the rows of one call; `mode: "hard"` deletes physically (a purge
  also says `deleted: "only"`, see the guide's warning). The extension is
  one file of about 100 lines, built only from the public capabilities below,
  in its own entry point: the root entry never imports it.
- **Added: three extension capabilities, `controls`, `rows` and `deletion`.**
  `controls` declares call arguments (a closed list or a Standard Schema,
  placed on reads, writes or named
  operations; a schema may be an object or a function carrying
  `~standard`, such as an ArkType type), checked once before request
  handlers and visible only to the declaring extension's handlers
  (`context.controls`). `rows` declares row filters per model, one
  set per mode, chosen per call by a control; core applies them at every
  place a query selects rows (root reads and writes, aggregates, cursors,
  every relation, quantifiers, counts, ordering, recursion, nested write
  targets). A to-one relation whose target is filtered out reads `null` and,
  on a client with `rows`, is typed `| null`
  when its target model has an entry (or the same field and relation names as
  one); a reference to a missing row is still an error. `deletion` turns a delete of the named
  models into an update with the call's one time and constant data, refused
  while a visible row still references it through a restricting foreign key
  (on PostgreSQL and MySQL it locks its candidates before that check, so a
  concurrent `connect` cannot leave a live row referencing a tombstone),
  unless the call's controls match `removeWhen`. A cached read that receives
  a control is keyed on its value and, on a client with `rows`, on the `rows`
  declarations; a read that receives none keeps today's key. Definitions are
  trusted: VibORM does not check a declaration at runtime.
- **Added: `data`, an extension capability that writes fields.** For the
  models it names, an extension writes fields on every create (`create`) and
  every update (`update`) of them: root and nested, one row or many, both
  arms of an `upsert`, and the update a soft delete makes. A value is a
  constant, `{ control: "<name>" }` for the value the call passed, or, on an
  update, one of the field's update operators such as `{ increment: 1 }`. A
  `connect` or `set` that only moves a foreign key, and a delete that stays
  physical, write nothing. When two extensions write the same field, the one
  applied later wins. An extension now has ten capabilities. A field the
  schema requires may be left out of a create when an extension writes it
  on that call, a required foreign key such as `tenantId` included. When
  TypeScript knows the models the `data` entry names (written inline, or
  passed to a recipe as a written list), the client's types agree: those
  fields are optional in its create data, nested creates included, and keep
  their own types.
- **Added: an extension fills a field only when the caller left it out.** A
  call that writes a field an extension writes keeps its own value, at any
  depth, on a create and on an update, and wins over every extension that
  writes it. Writing it through the relation whose foreign key it is
  (`tenant: { connect: ... }` for `tenantId`) counts as writing it: the
  relation decides the key. A field written as `undefined` counts as left
  out. A value the extension would have written there is not checked either,
  so a field's own schema never sees or refuses it. Under tenancy, reads stay with the call's tenant but writes are not
  enforced: a caller who writes `tenantId`, or connects a tenant, by hand
  writes into that tenant.
- **Added: a `rows` filter can use a value the call passes.** Write
  `{ control: "<name>" }` where a filter takes a value, at any depth (inside
  `in`, `AND`, `OR` and `NOT` too), and each call sees the rows that match the
  value it passed: one client serves every tenant. A call that does not pass
  an optional control drops the filters that name it; one that does not pass
  a control `required` on a model matches none of that model's rows, even
  when it reaches them through a relation of a model the control is not
  required on. Each mode and value is
  prepared once and reused; a client keeps 256 of them, and past that the
  oldest is prepared again when it comes back. Cached reads are keyed on the
  value, so two tenants never share an entry.
- **Added: `required: true` on a control.** A call that leaves out a
  required control is refused with a `ValidationError` at the control's path,
  on every operation the control is placed on (without `on`, every operation
  of every model).
- **Docs: extension recipes.** A new guide page gives tenancy, audit stamping
  and optimistic locking, each one declaration built from the capabilities
  in this release, to copy into your code. They are recipes, not package
  entries. Each keeps the model names you pass it, with no `as const`, so
  your editor lets a required `tenantId` be left out of a create of those
  models.
- **Added: `ExtensionState` and `ExtendedOperationResult`** are exported from
  `viborm`, for plugins generic over the client they receive.
  `ExtendedOperationResult` and a model-mapped query handler's `proceed()`
  read the client's `rows`; `OperationResult`, `InferDatabase` and
  `renderOperationResultType` stay schema-only. `Client`'s
  optional third type parameter is now the chain's controls (see "Changed
  (types)" below), and `$withCache()` accepts the chain's controls.
- **Behaviour change: a limited `deleteMany` or `updateMany` takes the first
  rows by id.** `limit: n` now takes the first `n` matching rows ordered by
  primary key, ascending (a compound key field by field, in the order the
  model declares them), as `findMany` with `take` and no `orderBy` does. Before,
  it took whichever rows the database reached first, which differed between
  databases and could differ between the hard and the soft delete of the same
  rows. Now every path picks the same rows: a hard delete, a soft delete with
  or without a restricting child (skipping rows deleted already), a scalar
  update, an update whose `data` carries a relation, inside
  `$transaction([...])`, and with or without `RETURNING`. The SQL gains an
  `ORDER BY` on the primary key: inside the key subquery on PostgreSQL and
  SQLite, and on the statement itself on MySQL. On a compound key whose
  `.id([...])` lists the fields in another order than the model declares
  them, an update whose `data` carries a relation now runs its rows in that
  declaration order too.
- **Changed (types): extension typing for plugins generic over their client.**
  Inside a function generic over `VibORMClient<C, X>`, index a model with
  `M[K & keyof M]`: `VibORMClient<C, X>["post"]` is now a TypeScript error
  there. A definition written against one client and applied to another now
  compiles, with its method types following the first client; build each
  definition from the client it is applied to. Replacing an earlier
  extension's model method is refused when the extension is applied, and is
  no longer flagged in your editor. `Client`'s third type parameter used to
  say whether the cache extension was applied; it is now the controls the
  client's extensions declare, and the cache's `cache` option is one of them.
  `Client<C, D, true>` no longer compiles: take the type from the client you
  built (`typeof client`) instead.
- **Breaking: a mutation's `cache` option is the cache extension's declared
  control.** VibORM now takes `cache` out of a mutation's arguments and checks
  it once, before any request handler runs, the way it handles every argument
  an extension declares. Five things change for code that touched it:
  - A request handler can no longer add or replace `cache`: a patch that
    names it is refused with a `QueryError` ("named control \"cache\""),
    whichever order the two extensions were applied in.
  - Request handlers no longer see `cache` in their input (query handlers
    already did not).
  - A `cache` value whose getter throws is a `QueryError`, no longer a
    `CacheConfigurationError`. A malformed value is still a
    `CacheConfigurationError`.
  - `cache` is checked before request handlers run, so an invalid `cache`
    fails before them, and a request handler that throws no longer stops
    `cache` from being read.
  - A mutation whose arguments are not an object (a string, a number) fails
    with the `ValidationError` ("Expected object") a client without the cache
    gives, no longer a `CacheConfigurationError`.
  - Added: the value `cache()` returns has a `controls` member, which declares
    `cache` on writes.
  - Added: request and query handler contexts of a model operation have an
    optional `controls`: the values of the controls the handler's own
    extension declares, and only those.
  - Unchanged: the message of a `cache` value the cache refuses still reads
    "Invalid mutation cache options: …". (The third type parameter of the
    public `Client` type does change: see "Changed (types)" above.)

## 1.0.0-rc.4 — 2026-09-29

- **Breaking: instrumentation presentation moves into the `instrumentation()`
  extension.** Core no longer builds span names, span attributes, log events
  or per-channel SQL/parameter disclosure, and it has no runtime import of the
  extension: it asks the fixed-name extension what it wants and hands it
  neutral facts, so a client without the extension no longer carries that
  code. Spans, log events and thrown-error diagnostics of an installed
  extension are unchanged. These public members and exports are removed or
  changed:
  - `Driver.getBaseAttributes()` and `Driver.getContextAttributes()` are
    removed. Span attributes, including `db.namespace`, are built by the
    extension from the driver's `dialect`, `driverName` and
    `adapter.namespace`.
  - The protected `Driver` members `getInstrumentation()`,
    `isTracingEnabled()`, `getLogger()`, `getLoggingDisclosure()` and
    `getTracingDisclosure()` are removed, so a subclass can no longer steer
    what a log or span discloses by overriding a hook: the extension reads
    each channel's disclosure from its own configuration.
    `canDiscloseParameters()` and `getErrorDisclosure()` remain protected and
    overridable; their default bodies now read the extension installed on the
    executing client's chain.
  - The protected `observeTrustedDriverLifecycle()` takes a lifecycle boundary
    (`"connect"`, `"disconnect"`, `"transaction"`, `"savepoint"`) in place of a
    span name, and the statement and lifecycle execution gates hand the
    extension a dispatch record instead of span options.
  - The statement gate's `execute()` no longer normalizes a statement failure.
    Each caller passes an executor that already normalizes, so a subclass
    that calls `observeTrustedStatement()` and relies on the gate to normalize
    must wrap its executor in `executeNormalizedStatement()`.
  - `CacheDriver.getBaseAttributes()` is removed. Cache spans and cache log
    events are built by the extension; the backend's name still comes from
    `CacheDriver.driverName`.
  - The `segment` lifecycle unit is removed from `ObservationUnit`: nothing
    produced it. `viborm/instrumentation` no
    longer exports `SPAN_RECORD_SERIES_SEGMENT` or the seven
    `ATTR_VIBORM_WRITE_*` attribute names (`ATTR_VIBORM_WRITE_ATOMICITY`,
    `ATTR_VIBORM_WRITE_COMMIT_OUTCOME`, `ATTR_VIBORM_WRITE_COMMITTED_SEGMENTS`,
    `ATTR_VIBORM_WRITE_COMMITTED_WRITE_MEMBERS`,
    `ATTR_VIBORM_WRITE_COMPLETED_MEMBERS`, `ATTR_VIBORM_WRITE_MEMBER_PATH`,
    `ATTR_VIBORM_WRITE_STATEMENT_COUNT`), which no span carried.
  - Added: `instrumentation({ tracing: { tracer } })` takes the tracer the
    runtime or application already holds: Cloudflare Workers' `tracing` from
    `cloudflare:workers`, or any OpenTelemetry `Tracer`. Spans start through
    its two-argument `startActiveSpan(name, fn)` and nest under the caller's
    active span, and the library never imports `@opentelemetry/api` itself.
    With a handed tracer, `root` spans (cache revalidation) nest under the
    active span, and status is set only where the span supports `setStatus`.
    Without `tracer`, the API is auto-detected as before.
  - Fixed: a custom adapter whose `namespace` getter throws no longer loses an
    operation's error log or fails `$withCache` (its spans are presented
    without `db.*` attributes), and a native-batch member's failure is logged
    to the client that member belongs to, with that client's disclosure, not
    to the client whose chain observes the batch.
- **Fixed: layer type programs fit their shard heap again.** The `updatedAt`
  arm of scalar update admission related every field's update schema to
  `VibSchema` structurally, which raised every type program that includes
  `src` by about half (0.91M to 1.38M types) and pushed the instrumentation
  layer's program out of its 1280 MB heap. The arm now reads the schema's
  input and output from its `[inferred]` brand and yields the same record,
  pinned by `tests/types/operation-schemas/updated-at.core.types.ts`. No
  public type changes.

Published to npm (`next`) only: the release workflow verified the published
bytes before the registry served them and stopped, so rc.4 has no GitHub
release or `v1.0.0-rc.4` tag.

## 1.0.0-rc.3 — 2026-09-29

- Add the type-only `InferDatabase<Schema>` export from `viborm/client`.
  Each model exposes `Row`, `Create`, `Update`, `Where`, and `FindMany`, derived
  from the existing public inference types. No query runtime behavior changes.
- Document application type helpers, operation validation, JSON Schema export,
  and runtime TypeScript descriptions in the
  [Types and JSON Schema guide](docs/content/docs/client/types-and-json-schema.mdx).

This release candidate targets npm `next`, not `latest`. Publication requires
the protected workflow in [RELEASING.md](RELEASING.md).

## 1.0.0-rc.2 — 2026-09-28

- Reduce temporary engine allocations by sharing stateless operation methods,
  lowering only the projection columns needed, and removing intermediate
  filter, selection, and decoder collections. Operation admission and cache
  codecs remain instance-local; public results and failure ordering are unchanged.
- Preserve the release automation repair that resumes a GitHub draft by its
  returned identity instead of requiring immediate visibility in the release list.

Saved SQLite measurements support the allocation work; they are not timings of
the integrated RC2 package or a performance guarantee for every provider. See
the [performance review](docs/architecture/rc2-performance-review.md) for the
measured source identities, limits, and qualification evidence. Publication
still requires the protected release workflow in [RELEASING.md](RELEASING.md).

## 1.0.0-rc.1 — 2026-09-28

This candidate brings the changes below together for V1 qualification. It is
not a stable release. Read the [V1 upgrade guide](docs/content/docs/getting-started/upgrading-to-v1.mdx)
before upgrading from `0.1.0` or a development checkout. Provider and migration
limits remain part of the contract; see the [driver guide](docs/content/docs/drivers/index.mdx).
This candidate was published through the workflow described in
[RELEASING.md](RELEASING.md); stable V1 promotion remains separate.

- **Fix: omitted `.updatedAt()` fields refresh on update** (#54). Non-array
  DateTime, Date and Time fields now receive the application's current UTC
  value at update admission, including explicit empty update payloads, bulk
  updates, upsert update arms and nested updates. Explicit values still win;
  create defaults, `.now()` restrictions and ordinary temporal fields are
  unchanged. A create-default override does not replace the update clock.
  Each admitted occurrence evaluates once; reusing admitted input does not
  regenerate it during retry. Temporal arrays keep their prior explicit-value
  behavior and do not gain an automatic list default. Validation failures from
  omitted-field defaults now propagate with their field path rather than being
  silently discarded by the object validator.
- **Breaking: `.now()` creation timestamps are insert-only** (#47). A
  `s.dateTime().now()`, `s.date().now()` or `s.time().now()` field was
  documented as a creation timestamp that is "set once", yet an ordinary
  `update` accepted it and overwrote the stored creation time. It is now
  refused by every update surface — `update`, `updateMany`, the `update` arm of
  `upsert`, and nested `update` / `updateMany` / `upsert.update` at any depth —
  in TypeScript (the key is typed `?: never`, so a payload held in a variable
  is refused too) and at runtime, where the call fails with `Unknown key:
  <field>` before the forbidden assignment executes, whether the value is spelled directly,
  inside `{ set }`, or as `undefined`. An explicit `<field>: undefined` is the
  one spelling TypeScript cannot refuse, because an optional key always admits
  `undefined`: it compiles and is refused at runtime. Create, `createMany`, nested create,
  `upsert.create` and `connectOrCreate.create` still accept an explicit value,
  and an omitted one is still generated. Filtering, ordering and reading the
  field are unchanged. The generator declared last decides:
  `.now().updatedAt()` stays updatable, `.updatedAt().now()` does not, and
  `.now().default(value)` / `.nullable().now()` keep the restriction.
  This insert-only rule does not apply to `.updatedAt()` or ordinary temporal
  fields; automatic `.updatedAt()` refresh is described above. The schema
  registry exported by `viborm/validation` shows the same rule: for such a
  field, `createSchemaRegistry(...).proxy.<model>.scalars.<field>.update` is
  now `undefined` (and typed `undefined`), while its `base`, `create` and
  `filter` are unchanged. To change a
  creation timestamp deliberately, use raw SQL — the restriction covers what
  the typed client writes, not the column.
- **Fix: table removal follows foreign keys, not table names** (#42). A push or
  generated migration that removed a populated parent and child on SQLite
  failed with `Foreign key constraint violation` whenever the parent's name
  sorted first, and succeeded with the names swapped. Drops are now ordered
  child-first from the foreign keys the database holds; unrelated drops keep
  their order, and the preview, consent and executed program agree. On SQLite
  a generated rollback recreates referenced tables first. PostgreSQL and MySQL
  keep their forward order: they drop the keys before the tables. Their
  generated rollback of such a removal now recreates every table before it
  restores the keys, once each; it used to restore a child's key before the
  parent existed and then a second time, so it failed. Tables that reference
  each other are dropped in an order their `onDelete` actions allow, when one
  exists: a `setNull` or `cascade` key can let one of them go first. **Newly
  refused on SQLite:** removing tables that no order can drop, such as a cycle
  of `restrict`/`noAction` keys, a cycle whose `cascade` reaches rows a
  `restrict` key still guards, or a table whose `restrict` key references
  itself, is refused before any statement runs (`V11009`, naming each blocked
  table and the key that refuses it). The refusal is decided from the schema
  alone, because no order safe for every row set can be established from it.
  Such a plan used to run in catalog order: it failed and rolled back unless
  the rows happened to satisfy that order, and it succeeded on empty tables,
  which are now refused too. Remove one relation, or change its action to
  `setNull`, in a separate change first.
- **One native type per dialect** (#45). Every scalar factory that takes a
  native type — `s.string`, `s.int`, `s.number`, `s.bigInt`, `s.boolean`,
  `s.dateTime`, `s.date`, `s.time`, `s.json`, `s.blob`, `s.vector`, and the
  second argument of `s.enum` — also takes a map by dialect:
  `s.string({ pg: PG.STRING.CITEXT, mysql: MYSQL.STRING.LONGTEXT, sqlite:
  SQLITE.STRING.TEXT })`. Each migration, adapter and identifier-storage
  decision uses its own dialect's entry, or the automatic column when the map
  omits it, so a DDL change to one entry is a migration on that dialect only.
  The map's keys are exact in TypeScript (beside a real key, and in a map held
  in a variable) and at runtime; an object with no dialect key must be a whole
  `{ db, type }` value; each entry must be its key's dialect and, at runtime, a
  value the `PG` / `MYSQL` / `SQLITE` constants produce; `{}` and an object that
  is both a `{ db, type }` constant and a map are refused. A union of two maps
  that share no dialect key needs a `NativeTypeMap` annotation. The factory
  stores a frozen copy. Parameterized constants (`PG.STRING.VARCHAR(n)` and
  the rest) now return their dialect in their type (`DialectNativeType<"pg">`,
  still a `NativeType`). Schema documents carry a map as the new optional
  `nativeByDialect` field, mutually exclusive with `native`, with the same
  catalog check (`J011`); `NativeTypeMap` is exported from `viborm/schema`.
  The single `{ db, type }` argument is unchanged in TypeScript, including
  custom spellings outside the catalog. At runtime (untyped callers only) it
  must now name `pg`, `mysql` or `sqlite` as `db` and carry a string `type`;
  before, an unknown `db` was silently ignored on every dialect, and a
  `db: "pg"` value with a missing, misspelled or non-string `type` crashed
  `serializeModels` with a `TypeError`. Before, a map was accepted at runtime,
  silently ignored on every dialect, and crashed `serializeSchema` with a
  `TypeError`.
- **A many-to-many junction's two foreign keys can have different actions
  (#46).** `.onDelete()` and `.onUpdate()` on a model-target `s.toMany` now
  also take `{ source, target }`: `source` is the junction's key to the model
  that declares the configuration, `target` its key to the target model (not
  the column order). `s.toMany(() => topic).onDelete({ source: "cascade",
  target: "noAction" })` removes a post's memberships when the post is deleted
  and refuses to delete a topic that is still assigned (a nested `delete`
  through a post first removes that post's own membership). Both sides are
  required; an extra key or `setNull` on either side is refused where it is
  written, at runtime and in TypeScript. A bare action keeps meaning "both
  keys", and existing declarations produce the same DDL. The one-owner rule
  (R011) is unchanged: moving the configuration to the other endpoint means
  swapping the sides, and that migrates to nothing. Schema JSON adds
  `junction.onDeleteSides` / `junction.onUpdateSides`, each exclusive with the
  symmetric key (`J004`); the serializer writes them only for unequal sides.
  Internal state: `relation["~"].state.junction.onDelete` / `onUpdate` now
  always hold the `{ source, target }` pair, and a resolved junction edge
  carries its actions on `topology.source` / `topology.target` instead of
  beside the topology.
- **Breaking: `_count` is a reserved member name.** A schema whose model
  declares a scalar, a relation or a polymorphic slot named `_count` is now
  refused where the schema is validated — client construction, migrations and
  `validateSchema` — with `[F010] Model '<model>' declares a member named
  '_count'; '_count' is reserved for relation counts. Rename it, and use
  .map("_count") on a renamed scalar to keep its column name.` Before, such a
  schema was accepted and `_count` had no single meaning: admission and the
  type renderer read `select._count` / `include._count` as relation counts,
  while the runtime published the member (even when `omit`, or the model's own
  `.omit()`, had excluded it) and the static result type intersected the member
  with the counts. `_count` in `select` and `include` is now relation counts
  everywhere. To keep the column, rename the member and map it:
  `tally: s.int().map("_count")`. A `groupBy` can no longer group by a field
  named `_count`, since none exists; the grouped-field collision refusal for
  `_avg`, `_sum`, `_min` and `_max` is unchanged. In TypeScript the key is
  refused at compile time too: `s.model({ _count: ... })` and
  `.extends({ _count: ... })` no longer type-check, and the diagnostic names
  the reason: ``not assignable to type '"`_count` is reserved for relation
  counts (F010)"'``.
- **Breaking: `_distance` is a reserved member name**, by the same rule as
  `_count`. A schema whose model declares a scalar, a relation or a
  polymorphic slot named `_distance` is refused where the schema is validated
  — client construction, migrations and `validateSchema` — with `[F010] Model
  '<model>' declares a member named '_distance'; '_distance' is reserved for
  distance results. Rename it, and use .map("_distance") on a renamed scalar to
  keep its column name.` Before, such a schema was accepted and the key had two
  producers: selecting a point's distance beside a scalar or relation of that
  name, in either order, or a recursive relation of that name whose node
  selected a distance, was refused per query with `A distance result cannot be
  selected together with a model field named '_distance'.`; that sentence no
  longer exists, and `_distance` in a result is always the selected distance.
  To keep the column, rename the member and map it:
  `rank: s.int().map("_distance")`, which can be selected, filtered and
  ordered beside a distance. In TypeScript the key is refused at compile time
  too: `s.model({ _distance: ... })` and `.extends({ _distance: ... })` no
  longer type-check, and the diagnostic names the reason:
  ``not assignable to type '"`_distance` is reserved for distance results
  (F010)"'``.
- **A singular polymorphic slot reads every arm.** A `select` that named only
  some arms of a required or optional to-one variant slot used to return
  `null` for a row whose target belongs to an unnamed arm; the documented
  contract and the inferred type always said an unnamed arm keeps its default
  projection, and the runtime now agrees. `subject: {}` reads every arm at its
  default projection too. A missing row behind an unnamed arm is now the
  slot's integrity refusal (`Polymorphic relation '<slot>' references a
  missing '<arm>' record.`) where it used to read as `null`. Selections that
  name every arm are unchanged. The TypeScript renderer's empty-`select`
  refusal now names the model instead of `'undefined'`.
- **Error-surface change: a malformed polymorphic slot is a malformed
  result.** A driver (or its `parseResult` middleware) that hands back a NULL
  or non-object value where a polymorphic to-one or to-many slot's document
  belongs used to escape as a raw `TypeError` (NULL) or be refused at its
  first variant arm, in that arm's sentence (any other non-object). It now
  fails at the slot, with the ordinary malformed-result `QueryEngineError`
  every other provider document raises:
  `Driver "<driver>" returned a malformed polymorphic slot scalar for
  operation "<operation>": the slot is not an object.` (`meta.scalarType` is
  `"polymorphic slot"`). The same holds for a polymorphic to-many slot's
  orphan-integrity entry: when it is present but is not an object (NULL, an
  array, a number or a string), the read fails with `...: the integrity entry
  is not an object.` It used to be ignored (NULL, number, string) or have its
  array entries read as orphan counts. An absent entry still means no
  orphaned membership. The statements VibORM issues always build these
  documents, so only a driver or middleware that rewrites results can observe
  the change; well-formed results are unchanged.
- **PGlite runs the full GeoPoint tier with PostGIS.** The optional
  `@electric-sql/pglite` peer now admits 0.4 and 0.5 besides 0.3
  (`^0.3.2 || ^0.4.0 || ^0.5.0`), and VibORM is tested on 0.5.8 (PostgreSQL
  18.3). With `@electric-sql/pglite-postgis` 0.2.8 (PostGIS 3.6, which requires
  PGlite 0.5.8 exactly) loaded through PGlite's own `extensions` option,
  `CREATE EXTENSION postgis` run by the caller, and `postgis: true`, the PGlite
  driver passes the same GeoPoint contracts as `pg` and postgres.js — bounds,
  polygons, distance, `_distance`, the generated migration estate and GiST
  index planning — in process, with no server. The driver gains no option:
  the extension is PGlite's to load and the caller's to install, and
  `postgis: true` stays an assertion that migrations prove. On PGlite 0.5,
  pgvector is its own package, `@electric-sql/pglite-pgvector`, where 0.3 and
  0.4 exported `@electric-sql/pglite/vector`; and 0.5.8 starts with
  `enable_seqscan` on, where 0.3 started with it off. A persistent `dataDir`
  does not cross a PostgreSQL major: moving one from PGlite 0.3 to 0.5 is a
  dump and restore.
- **Behaviour change on batch-only drivers: `createMany` with `skipDuplicates`
  warns and runs instead of refusing.** Where no savepoint can isolate one
  member — D1 Workers bindings, Neon HTTP, a native array batch, and a member of
  an array `$transaction([...])` — a `createMany` with `skipDuplicates` that is
  relation-bearing, or nested under another `create`/`update` (many-to-many
  included), used to throw `TransactionError` (`V5001`) before any write. It
  now runs **without** `skipDuplicates` and warns once per client and model —
  on the `warning` log channel when logging routes warnings (the sentence in
  `meta.notice`), with `console.warn` otherwise: `createMany skipDuplicates
  cannot skip rows involving nested writes on driver "d1" (no savepoint
  available) in post.createMany; running without skipDuplicates — a duplicate
  will fail with a unique-constraint error.` A duplicate then fails with the
  ordinary `UniqueConstraintError`, and rows an earlier batch committed stay
  committed, exactly as for the same call without `skipDuplicates`. A root
  scalar `createMany` with `skipDuplicates` is unchanged (it skips in SQL),
  except on MySQL inside an array `$transaction([...])`, whose per-row skip
  needs a savepoint: it too now runs without the flag and warns instead of
  refusing. Interactive drivers keep skipping inside a savepoint.
- **Recursive relation projections.** A self-relation's node — `parent`,
  `children`, a proven one-to-one inverse or a paired junction graph — takes
  `recurse` in `select` and `include`: `true`/`{}` follow the relation to depth
  100, `{ depth: n }` to `n` levels (1–1000), `{ depth: false }` exhaustively;
  a junction graph prunes cycles path-locally by default and may unfold them
  with `{ preventCycles: false }` under a bounded depth, while a foreign-key
  cycle inside the traversed window is an error. The node's own projection
  repeats at every level, filters prune every hop, each level keeps its
  `orderBy`, and the repeated key is absent at a numeric cutoff and present
  (`[]` or `null`) where the data ends. One provider statement serves any
  depth; the result composes with the cache, `omit`, extensions, arrays and
  callback transactions like any other relation projection, and
  `renderOperationResultType` renders a recursive result as named declarations.
  Output grows with paths, not rows: a graph can return exponentially more
  occurrences than it stores, even with cycle prevention, so depth 100 is not a
  size bound. Executed locally on SQLite, PGlite, native PostgreSQL 16 and
  native MySQL 8.4 (the placement matrix and the hierarchy and graph worlds on
  all four; the composition matrix on SQLite; 300 generated cases each on
  SQLite, native PostgreSQL and native MySQL); hosted providers are not yet
  qualified. Where the provider spells `LATERAL` the carrier's recursive CTE
  lives in a lateral derived table, because MySQL materializes a correlated
  CTE that is read twice once per statement. Providers cap exhaustive
  traversals with their own limits: MySQL's `cte_max_recursion_depth` surfaces
  as the provider's error (errno 3636), never as a truncated result. A
  recursive node may select a point's distance, returned as the node's
  `_distance`; no relation can take that name (see "`_distance` is a reserved
  member name" above).
- **A connection must be representable.** An explicit `connect`, and the found
  and the create arm of `connectOrCreate`, establish a relation by writing the
  value the target holds for the referenced field. Every component that
  connection needs must be present and non-NULL. A target whose
  referenced field reads NULL cannot establish the requested relation, so the
  write is refused — `NestedWriteError`, naming the relation and the field —
  instead of writing that NULL and silently disconnecting the holder from
  whatever it pointed at. One requirement covers both directions (a parent-held
  edge and a child-held one), found and produced values, and single and compound
  references; it is checked before the connection is consumed, so nothing is
  written and then discovered. Ordinary nullable scalar writes, an explicit
  `disconnect`, and a NULL field that is not part of the consumed reference are
  unaffected, and a model declaring a nullable referenced unique is not itself
  refused.
- **A selected bulk mutation carries its selector to the
  effect.** An `updateMany` or `deleteMany` that captures an identity set and
  then consumes it sends BOTH the complete captured identity set and that
  statement's original prepared selector in the consuming statement. A row that
  stopped matching the selector between the capture and the effect is therefore
  not mutated, on the batch route as on the interactive one, and the existing
  `selected-row cardinality changed` error is the answer when fewer rows are
  affected than were captured. Failure and commit stay separate facts: on an
  operation-owned interactive transaction its owner rolls back; on an already
  acknowledged atomic batch the acknowledged effects and the result-phase
  failure are both reported truthfully — a check after dispatch cannot undo that
  batch and does not claim to. Compound and mapped keys, `limit` and the
  zero-result answer are unchanged.
  A nested captured series is BOUNDED in the same spirit: the initial filter
  selects the worklist ONCE, and a qualifying row that joins after that boundary
  is not adopted into it. The filter is not re-evaluated before every member —
  an earlier member may legally change the facts a later one was selected by —
  but the actual identity, parent and relation-membership requirements are still
  enforced where they always were, so a member that loses or changes its
  membership is still not consumed. `FOR UPDATE` locks rows; it does not exclude
  phantoms, and nothing here claims otherwise.
- **Native MySQL is part of local release qualification.**
  The `mysql2` driver is qualified against a local MySQL 8.4 — schema push and
  re-push, the migration and namespace boundaries, the read and nested-write
  inventory, and concurrency — rather than inheriting its status from shared
  transport code. A database-selected deadlock victim is a FAILED transaction:
  it is reported as the provider failure it is, with no committed victim
  effects, and it is never treated as an eligible unique-key race or silently
  replayed. The recoverable unique-key race that `upsert` and `connectOrCreate`
  already converge under is unchanged. Hosted MySQL (PlanetScale) qualification
  remains deferred.

- Prepare the V1 release and publication system.
- **The query engine is replaced.** Raptor 3 (the name that appears in some
  engine error messages) is now the only engine behind the public client API,
  which is unchanged: every operation, filter, nested
  write, transaction form and result shape is the same, and the differences
  the cutover surfaced were repaired to the old engine's answers or ruled and
  documented one by one. What changed at the adapter and driver contracts is
  listed below. Every refusal the engine raises is a documented sentence, and
  the sentences fall into three kinds that are easy to confuse:

    - **An invalid request.** The operation asked for something the data cannot
      represent — a connection whose reference value is NULL, a `_distance`
      selection beside a field of that name. Nothing is written; correcting the
      request is the whole remedy.
    - **An operational database failure.** The provider refused the work or
      aborted the transaction — a deadlock victim, a constraint violation, a
      driver that answered a malformed or missing result. The driver normalizes
      it; it is a fact about that run, not a limit of the ORM, and the same
      request can succeed on the next one.
    - **A capability refusal.** The engine will not do this here — building a
      write to one SQL statement, a generated non-increment key on a transport
      with no interactive transaction. This one names a boundary that will not
      move by retrying.

  A failed internal invariant is none of the three: it is thrown as an
  `EngineInvariantError`, carries no `V####` code, and is a defect to report.
  Counting sentences does not measure any of this. The three kinds above are
  this changelog's own reading of what a failure means to a caller; the census
  (`scripts/raptor3-refusal-census.mjs`) separates a different three by
  construction — invariants, private-fit internals and refusals — and reports
  23 distinct candidate sentences this engine spells that the previous one did
  not: a count of SENTENCES, not of operations you can no longer perform, and
  not a coverage figure. What the engine does and does not support is the
  behavioural inventory's fact, one row per admitted fact.
- `DatabaseAdapter["expressions"]["integerDivide"](left, right)` is a
  **required** adapter member: the portable integer quotient the engine uses when it has to state in SQL
  the value an integer or bigint column will hold after a `{ divide }` (PostgreSQL integer
  division, `TRUNCATE(a / b, 0)` on MySQL, `a / CAST(b AS INTEGER)` on SQLite).
  A third-party adapter must add it; this is a compile-time change for adapter
  authors and invisible to client code.
- `PendingOperation.buildStatement()` (and the engine's internal
  `QueryEngine.build()`, which backs it) answers the one SQL statement a
  **read** compiles to, taken from the prepared read the execution itself
  runs. Every write now answers the `does not compile to one SQL statement`
  refusal — including a write the previous engine could fold into a single
  statement, such as a scalar `delete` on a driver with `RETURNING`. Run the
  operation instead of building it.
- A nested write that must observe its own earlier writes — a member that
  reads a row an earlier member wrote, a series of dependent members — now
  runs on a **batch-only** transport that keeps no session between requests
  (Neon HTTP, D1) as a succession of atomic batches, each committing as it
  completes. A key the database generated in one batch is read back at the
  end of that batch and carried into the next as a literal, so such a write
  no longer fails with a bare provider error once its first batch has
  committed. This is verified on a batch-only fixture that keeps no session
  between requests; the live Neon suite is credential-gated on
  `NEON_TEST_DATABASE_URL` and was not run for this release, and the D1 driver
  is exercised on the Workers runtime's own local D1 and on no hosted
  Cloudflare D1. A failure in a later batch leaves the earlier batches committed,
  and the error says so (`atomicity: "segment"`, `committedSegments`). Nothing
  changes on a transport with an interactive transaction, where the whole
  write is one transaction.
- The transport facts each driver guarantees for a nested write — how it runs,
  what a mid-way failure leaves behind and how it is reported, the bind
  capacity per statement, and which of these are verified live — are stated
  per driver in the [drivers overview](/docs/drivers)
  under "Nested writes and failures per driver".
- The SQLite drivers (`sqlite3`, `bun-sqlite`, `d1`, `libsql`) no longer
  normalize `count`/`exist` results in their driver-level `parseResult`
  middleware. The query engine's decoder owns the meaning of a count and an
  exists answer — it asks for its own `_count` alias and reads it back — so
  those answers are unchanged on every SQLite driver. The
  `DriverResultParser.parseResult` contract itself is untouched: a consumer
  that wrapped `driver.result.parseResult` is still asked once per operation
  with the provider's raw result, and is unaffected in outcome. The shipped
  `parseResult` function itself no longer exists on those drivers: a wrapper
  that captured it before installing its own must check for its absence
  before calling it.
- The MySQL adapter no longer normalizes `count`/`exist` results in its
  adapter-level `parseResult`. The query engine's decoder owns the meaning of a
  count and an exists answer — it asks for its own `_count` alias and reads it
  back, and a count carried under any other column was refused before this
  deletion exactly as it is after it — so those answers are unchanged, on the
  live route and inside `$transaction([…])`.
- The PostgreSQL adapter no longer converts a bigint in its adapter-level
  `parseResult`. That leg was offered the operation's row array rather than a
  value, and an integer's width is owned by the query engine's own scalar
  codec, which turns a bigint or an integer text into a number and refuses one
  outside the safe integer range. Count answers are unchanged on both the `pg`
  and the `postgres.js` transport.
- `DatabaseAdapter["result"]["parseResult"]` is untouched: it remains a
  required member, still asked once per operation with the provider's raw
  result, and on all three shipped adapters it is now the pass-through the
  SQLite adapter has always installed.
- A nested write under a parent with a generated increment key now runs on a
  PostgreSQL-family transport that has no callback transaction (Neon HTTP, a
  batch-only PGlite) as one native batch: the parent's INSERT is a
  data-modifying CTE whose own RETURNING stores the key in the batch
  reference table, and every later statement of the same batch reads it back. Such writes were
  refused before ("Raptor 3 G1 atomic output requires exact identity scratch
  or segmented RETURNING"). A generated key that is not an increment key on
  such a transport keeps that refusal.
- The batch reference contract (`@internal` `BatchReferenceSqlAdapter`) gains
  an optional `storeReturning(batchId, key, insert, column)`, present on the
  PostgreSQL adapter; the PostgreSQL batch reference table is no longer
  declared `ON COMMIT DROP`, so the table survives the batch that created it;
  each dispatched batch makes its own reference rows and drops them at its own
  end. The logical `CastType` gains `"bigint"` (`BIGINT` on
  PostgreSQL, the 64-bit integer cast the other dialects already had), so a
  `bigint` increment key is read back at its own width.

### Decimal (breaking)

A decimal field admits `Decimal | string`. A JavaScript `number` is a double
rather than an exact decimal, so it is refused at every decimal position —
create and update values, `increment`/`decrement`/`multiply`/`divide`,
`push`/`unshift`, every filter operand, `having` operands, cursors and unique
lookups — with one issue: `Expected an exact decimal: a Decimal or a string
like '-12.345' (sign, digits, at most one dot, no exponent); a JavaScript
number is a double and is not accepted`. The keys, the nullable arms and the
operand forms (literal, field reference, SQL fragment, callback) do not move;
only the literal narrows, and the input types drop `number`. Write
`{ total: "0.3" }`, not `{ total: 0.3 }`.

- `new Decimal(value)` takes a `Decimal`, a string, or a whole `bigint`
  (`new Decimal(5n)` is `5`); a number throws `TypeError`. The arithmetic and
  comparison methods take the same arguments, so `total.plus("1")` rather than
  `total.plus(1)`.
- The `String(number)` rule and the documented `0.1 + 0.2` case are gone with
  it: there is no double to spell.
- The input JSON Schema of a decimal is the string alone
  (`{ type: "string", pattern }`, with the domain in `description`); the
  `{ type: "number" }` arm is gone, so a document generated from it no longer
  describes values the validator refuses.
- A schema document's decimal default written as a JSON number (`"default":
  1.5`, or a number member of a list default) is refused with `J008`; write
  the string `"1.5"`. An invalid `precision`/`scale` in a document reports the
  per-key sentence below under `J010`.
- `s.decimal({ precision, scale })` reads its argument as the developer's own
  code. Each bad bound has one sentence at its key —
  `'precision' must be an integer between 1 and the maximum safe integer` at
  `descriptor.precision`, `'scale' must be an integer between 0 and precision`
  at `descriptor.scale` — replacing the five earlier messages. A missing or
  non-object argument (untyped JavaScript) now reports the `precision`
  sentence at `descriptor.precision` instead of
  `A decimal must declare { precision, scale }` at `descriptor`. Extra,
  inherited, symbol and non-enumerable keys are ignored at runtime (the types
  still refuse extra keys), and a throwing getter or a revoked proxy throws its
  own error instead of a `ValidationError`.
- `.default(x)` checks the default against the field's own schema and reports
  one sentence, `The decimal default did not satisfy its field schema`, in
  place of the list-specific messages (`must be an array`, `dense array with
  no shadow properties`, `Could not snapshot`). Extra properties on a list
  default are dropped rather than refused. A custom `.schema()` that throws, or
  that returns a non-object result such as `null`, lets that error (a
  `TypeError` for `null`) escape `.default()` instead of `The decimal field
  schema failed while validating its default`. The check is still eager, at
  `.default()`, `.array()` and `.schema()`.

### Geo: a geographic value is validated as the record VibORM returns (breaking for refusal wording and polygon admission)

A `GeoPoint`, `GeoBounds` or `GeoArea` argument is now read by the same record
walker as every other object operand, not by a bespoke reader. For points and
bounds the accepted values are unchanged for ordinary input; what changes is
the posture toward unusual objects and the wording of refusals. Polygons are
checked for their shape first and their geometry second; the geometry refused
is what the databases were measured to answer wrongly or differently.

- Refusals name the key: `{ longitude, latitude, latitdue }` fails with
  `Unknown key: latitdue` at path `latitdue` (was `Expected GeoPoint with
  exactly longitude and latitude`), a missing coordinate fails with
  `Missing required field: latitude`, a non-object with `Expected object`
  (was `Expected GeoPoint object`), and a non-finite coordinate with
  `Expected finite number` (was `Expected finite longitude`). Range messages
  are unchanged. Unknown-key and missing-key refusals now point at the key:
  `data.location.extra` and `data.location.longitude` where the path was
  `data.location`; an object without the coordinates, such as a `Date` or a
  `Map`, also fails at `data.location.longitude`.
- Bounds and areas follow the same rule: `{ bounds: { …, nort: 49 } }` fails
  with `Unknown key: nort` at `bounds.nort` (was `Expected GeoBounds with
  exactly south and west and north and east`), `{ bounds, extra }` with
  `Unknown key: extra`, and a bounds coordinate out of range with
  `Latitude must be between -90 and 90` or `Longitude must be between -180 and
  180` (was `south must be between -90 and 90`, and so on; paths unchanged).
  `GeoBounds south must be less than or equal to north` and `Expected GeoArea
  with exactly one of bounds or polygon` are kept word for word, but an area
  carrying both variants where one is itself invalid now reports that
  variant's refusal (for example the `south`/`north` message at
  `bounds.south`) instead of the exactly-one message.
- An area spelled `{ bounds: undefined, polygon }` is now the polygon area: an
  explicit `undefined` is an absent key, as everywhere else.
- Newly accepted: an inherited enumerable coordinate, a class instance, and an
  object carrying extra symbol or non-enumerable keys; the walker reads
  enumerable string keys only, as it does for every other argument.
- A getter or proxy trap that throws while a point is read surfaces as a
  validation issue carrying the thrown cause (through `parse` and every
  operation boundary) instead of the former `Could not read …` message; in an
  operation it is reported at `root` as `Schema validation failed
  unexpectedly` where the path named the coordinate. A direct call of a geo
  validator, and `v.point()["~standard"].validate`, now let the throw
  propagate, as every other `v.object` schema already did, and so does `s.point().default(…)`, whose value is the
  developer's own declaration: a throwing getter there is that raw error at
  declaration time instead of a `ValidationError`.
- A `GeoPolygon` is checked for its shape first: exactly `outer` and optional
  `holes`, finite in-range vertices, at least three vertices per ring
  (`A GeoPolygon ring needs at least 3 vertices`, kept), all reported by the
  record walker. Its geometry is checked second, on the great-circle reading:
  a polygon is refused when it has no single meaning there, or when it falls
  outside one of three stated domain choices (next entry); a valid polygon a
  database computes differently is admitted (below). Measured with
  VibORM's own predicates on PostGIS 3.6.2 and MySQL 8, PostGIS raises only
  for an edge between antipodal endpoints and answers every other malformed
  polygon silently: a hole reaching outside the outer ring adds its own area,
  a point inside two holes matches, a bowtie matches both lobes, and MySQL
  answers a pole vertex with the equator and the opposite pole. Those polygons
  are refused at admission, the same on every dialect, with the pre-D2
  messages word for word: `A
  GeoPolygon ring cannot self-intersect` (a crossing or touching ring,
  including one that repeats a vertex further on or goes past a whole turn
  over itself), `A GeoPolygon ring must have non-zero area`, `A GeoPolygon
  ring cannot contain a pole` (a vertex on a pole), `A GeoPolygon cannot
  contain a pole` (a ring winding around one, or running over both), `A
  GeoPolygon hole must be strictly inside its outer ring` and `GeoPolygon
  holes cannot touch or overlap`. Each is reported at its ring (`outer` or
  `holes.<i>`), except the vertex and edge refusals (`ring cannot contain a
  pole`, `cannot join vertices within 0.01 degrees of antipodal`), reported
  at the offending vertex (`outer.<j>` or `holes.<i>.<j>`, the vertex ending
  the edge).
- Three of those refusals are VibORM's own domain choices, each for its
  stated reason, not properties every valid polygon lacks: the resolution,
  1e-9 degrees (about 0.1 mm), a fixed margin for floating-point rounding
  within which a point is on what it touches, so closer rings touch and a
  shorter edge is a repeated vertex; near-antipodal edges, refused within
  0.01 degrees of opposite points, where one float64 step of a written
  coordinate turns the edge's great circle by more than a third of that
  resolution; and the poles, where a vertex within the resolution of a pole
  has no longitude, and a ring winding around a pole or running over both
  has no side away from both, while an edge of exactly 180 degrees of
  longitude runs over the pole and is admitted. The entries below give
  each one's figures.
- A vertex on a pole has no longitude and is refused with `A GeoPolygon ring
  cannot contain a pole`, at the vertex, as before D2; a vertex within 1e-9
  degrees of a pole, VibORM's resolution, counts as on it. A vertex any
  further off is admitted, however near (the databases' reading of such
  rings is below). A ring winding around a pole, or running over both poles,
  has no side away from both and is refused with `A GeoPolygon cannot
  contain a pole`.
- The geometry reads each edge as PostgreSQL does, as the great-circle arc
  between its vertices on the sphere, not as a straight line of longitude and
  latitude. MySQL reads the edge on the ellipsoid instead: the largest
  departure from the arc observed over 30 random edges per length (measured
  by bisection) is 0.0007 degrees (about 79 m) on a 10-degree edge, 0.007 at
  30, 0.029 at 60, 0.075 at 90, 0.17 at 120 and 0.46 at 150, none along the
  equator or a meridian, so
  points within that band beside an edge can be answered differently by the two
  databases (stated, not refused: below); a long edge split into shorter ones
  narrows the band with the square of the length.
  Around every vertex, whatever the edge length, MySQL also answers points
  within about 1e-6 degrees (about 11 cm) unlike PostgreSQL and the sphere:
  about 13% of such points in random pentagons with edges of 0.001 to 5
  degrees (1,240 to 1,332 of about 9,600 per size), none from 1.8e-6 out,
  PostGIS none; there MySQL's SPATIAL index and table scans can also
  answer differently (152 points in the review's run, all within 7e-7 of a
  vertex). In the 0.001-degree square from (10, 40), MySQL matched
  (10.0009994, 39.9999994), outside, and missed (10.0000006, 40.0009994),
  inside.
  In the box from (0, 40) to (10, 50) both databases put (5, 40.05) outside and
  (5, 50.05) inside, because the south edge bows north to about latitude
  40.105 and the north edge to about 50.10. So a hole drawn touching or just
  inside a straight parallel edge crosses the edge's arc and is refused
  (PostGIS matched points in the hole beside it), a hole between the straight
  line and the arc on the inner side is accepted, and three vertices in a
  straight line of longitude and latitude off the equator form a thin
  triangle, not a zero-area ring. A touch is refused even where it is exact,
  as before D2: it is where the two databases' edges (sphere, ellipsoid) and
  tolerances part. A differential run of 4,800 random holes and
  quadrilaterals against PostGIS geography agreed on every verdict.
- Newly accepted, because both databases answer them correctly: a closing
  vertex repeated at the end, or any vertex repeated consecutively (it is sent
  as written and closed once more), a ring that goes past a whole turn of
  longitude beside itself. SQLite-family providers still refuse polygon
  filtering, now after admission.
- Admitted, the database's reading stated instead of refused (owner decision,
  2026-09-24: VibORM refuses a polygon with no single meaning, or outside
  its stated domain choices, never a valid one because a database computes
  it differently; `point.mdx`, "How each
  database reads a polygon", has the figures and the advice):
  - Rings reaching across the equator, the 0/180 meridian and the 90/-90
    meridian at once, every ring of half the globe or more among them.
    PostGIS then has no reference point outside the polygon's box and falls
    back to one it derives from the first edge sent or from its internal
    circle tree over the edges, so its answer depends on vertex order and
    query path: table scans went wrong on 42 of 44 random ring rotations
    where either fallback point fell inside the ring and on none of 436 where
    both fell outside; 23 of 372 random such rings were misread, one of them
    27% of half the globe, and none of 494 reaching across two planes or
    fewer. Rerun on the admitted witnesses (400 random points each, table and
    index scans): the tropics band from -170 to 170 at ±30 (11.18 steradians
    on the great-circle reading) 38 points wrong on PostGIS, a band with two
    175-degree edges on each side 398 of 398, a random ring across all three
    planes 347 of 397, the Pacific from 115 to -75 degrees none; MySQL none
    on any. Splitting such an area into polygons joined with `OR`, each on
    one side of one of those planes, avoids it. `A GeoPolygon cannot reach
    across the equator and the 0/180 and 90/-90 meridians at once` and
    `A GeoPolygon must cover less than half the globe` are gone.
  - Edges of any length short of the antipodal bound below. MySQL's
    ellipsoid edge was observed to leave the great-circle arc by as much as
    0.46 degrees on 150-degree edges, 1.6 at 170, 2.7 at 174, 8.4 at 178 and
    16 at 179 (the largest over 30 random edges per length), and
    in every run of 30 random triangles with an edge up to 2 degrees short
    of antipodal it answered some points far from the edge unlike PostGIS and
    the sphere. `A GeoPolygon edge must be shorter than 150 degrees` is gone.
  - Rings of any size above VibORM's resolution. MySQL answers points within
    about 1e-6 degrees of a vertex unlike the sphere, so it misplaced points
    a tenth of the ring from every edge in rings a few 1e-6 degrees across
    (0.4% at 5e-6, 9% at 2e-6, 16 to 32% at 1e-6, 34 to 56% below) and none
    of 16,000 in rings 1.4e-5 across; PostGIS answered all of them. `A
    GeoPolygon ring must be at least 2e-5 degrees across` is gone.
  - Vertices near a pole. With two consecutive vertices a few 1e-6 degrees
    from a pole, MySQL (from about 3e-6 degrees down) and PostGIS (from about
    6e-7 down) answered points 70 degrees from the ring wrongly: in the ring
    from (-60, -89.9999999) east to (120, -89.9999999) and back along latitude
    -60, MySQL matched (30, 70) and missed (30, -70), and PostGIS's answer
    changed with its query plan on another. None of about 1,500 such rings
    from 5.6e-6 degrees out was answered wrongly. `A GeoPolygon vertex must
    be at least 1e-4 degrees from a pole` is gone.
  - An edge 180 degrees of longitude long between vertices that are not
    antipodal, such as (0, 10) to (180, 20): it lies on one great circle and
    runs over the pole on its vertices' side, the pole on the ring. Both
    databases read it so away from the edge (8 named and 140 random such
    rings, about 118,000 points at least 0.01 degrees from every edge: none
    wrong on PostGIS, one on MySQL, inside its ellipsoid band beside another
    edge); on the edge itself they part: PostGIS matched (0, 50), (180, 60)
    and the pole on the edge from (0, 10) to (180, 20), MySQL did not, and
    for (0, 10) to (180, 10) they answered (0, 80) differently. `A
    GeoPolygon edge cannot span exactly 180 degrees` is gone.
- An edge whose end lies within 0.01 degrees of its start's antipode is
  refused with `A GeoPolygon edge cannot join vertices within 0.01 degrees of
  antipodal`, at the vertex ending it: two antipodal points lie on every great
  circle through them, and near the antipode a one-step float64 move of a
  written coordinate turns the edge's circle by up to about 3e-12 / d degrees
  at d degrees from antipodal (3.1e-9 at 0.001, 3.0e-10 at 0.01, over 2,000
  random edges per distance), so nearer than 0.01 the written coordinates do
  not fix the edge to VibORM's 1e-9-degree resolution. An edge between
  exactly antipodal endpoints, such as (0, 0) to (180, 0), which PostGIS
  raises for, is refused by it.
- Points within 1e-9 degrees, about 0.1 mm, of an edge count as on it, and an
  edge shorter than that is a repeated vertex. That is VibORM's resolution at
  every ring size: against 60-digit geometry on 9,000 random rings 1e-9 to
  1e-4 degrees across, every ring whose edges and clearances exceed twice it
  was judged exactly (4,048 simple rings admitted with the right winding,
  2,135 crossing ones refused), and so was every one of 6,190 polygons with
  vertices 3.5e-9 to 3.6e-4 degrees from a pole, over it or with holes by
  it. A ring whose vertices all lie within it of
  one another, one distinct vertex included, is refused with `A GeoPolygon
  ring must have non-zero area`. Cross products are taken from vertex
  differences, so a 1e-7-degree bowtie inside a larger ring is refused at any
  latitude (the plain product admitted it at latitude 45).
- A polygon without `outer` fails with `Missing required field: outer` (was
  `Expected GeoPolygon with outer and optional holes`), and a ring that is not
  an array with `Expected array` (was `Expected outer ring array`). A ring is
  read by index like every array operand: an empty slot in a sparse ring fails
  as `Expected object` at its index, and an inherited index is read.
- Unchanged: longitude `-180` still becomes `180`, `-0` still becomes `0`,
  `holes: []` is still the same argument as no `holes`, and an accepted
  polygon is still sent with its outer ring counterclockwise and its holes
  clockwise.

### Identifiers are generated by VibORM (breaking for the dependency graph)

`@paralleldrive/cuid2`, `nanoid` and `ulidx` leave the runtime dependency graph
and nothing joins it: SHA3-512, the one hash CUID2 needs, is VibORM's own
Keccak-f[1600] and adds no dependency at all. Every format is built here, from
`crypto.getRandomValues` and nothing else — a runtime that cannot provide secure
randomness is refused rather than served a weaker identifier. CUID2 output is
byte-identical to the package it replaces, proven by a differential test against
the pinned upstream, and the digest is byte-identical to `@noble/hashes` over
the NIST known-answer vectors and 10,000 random messages, proven by a second
differential test that keeps that package installed for development only.

- Added `s.string().uuidv7()` and `s.string().ksuid()`, with the matching
  `generate` kinds in the JSON schema document.
- `s.string().id()` now sets `hasDefault`, so a generated primary key is
  optional in the create type as it already was at runtime. `.id()` no longer
  overrides a generator declared before it, and `.id(prefix)` after a generator
  is refused (`.id("")` names no prefix, so it stays a plain key declaration).
- A nanoid length outside the range a nanoid can have — not a whole number, or
  outside 1 to 65536, the entropy source's own per-call quota — is refused at
  declaration instead of silently producing empty identifiers or throwing a
  platform error on every row.

### Identifier storage (breaking for new schemas)

Naming a format is now a promise about every value of the field, and VibORM both
holds you to it and takes advantage of it. `.uuid()`, `.uuidv7()`, `.ulid()`,
`.ksuid()`, `.nanoid()` and `.cuid()` declare a **domain**; a bare `.id()` still
declares a **key** and is unchanged in every respect — its values are whatever a
string column holds, and it is still stored as text.

- **Values are validated.** A declared or derived domain admits only its own
  values, everywhere one can appear: `create`, `update`, `where`, unique
  selectors, cursors, and every `connect` / `connectOrCreate` / `upsert` key. A
  prefix is matched whole, and aliases normalize once — an uppercase UUID and a
  lowercase ULID address the same row their canonical spelling does. Previously
  `s.string().uuid()` refused nothing.
- **Storage changes for new schemas.** `uuid`/`uuidv7` become `uuid` on
  PostgreSQL and `BINARY(16)`/`BLOB` elsewhere; `ulid` becomes
  `bytea`/`BINARY(16)`/`BLOB`; `ksuid` becomes `bytea`(20)/`BINARY(20)`/`BLOB`.
  A declared prefix is no longer stored — it is identical in every row and is
  re-applied on read. `nanoid` and `cuid` keep text storage.
- **Foreign keys derive.** A column that references a key is admitted,
  normalized and stored exactly as that key is, with no declaration of its own —
  through self-relations, compound members, one-to-one chains, junction columns
  and polymorphic carrier columns alike. Declaring a DIFFERENT domain on a
  foreign key than its target has, or reaching one column through references
  whose keys disagree, is a schema error (FK012).
- **Four operators are gone from the compact formats.** `contains`,
  `startsWith`, `endsWith` and `mode` are removed from the filter TYPE of a
  `uuid`/`uuidv7`/`ulid`/`ksuid` field and refused by the engine: sixteen bytes
  are not the text you wrote them as. `equals`, `not`, `in`, `notIn`, `lt`,
  `lte`, `gt`, `gte`, `orderBy`, cursor pagination, `_min`/`_max`, `_count` and
  `groupBy` are exact and unchanged — the byte order of all four formats IS
  their canonical text order. The loss goes by the FORMAT, not by the storage:
  a compact format that takes the text-family override below still loses them,
  because the validation schema is built before any adapter exists and one
  filter type per field rather than one per deployment is what keeps the type
  and the runtime saying the same thing. A DERIVED domain narrows at run time
  only: a foreign key has no declaration of its own to compute a type from.
- **A field reference across storage is refused.** `where: { id: { equals: (ctx)
  => ctx.fields.someString } }` compiled and matched nothing when `id` was
  compactly stored and `someString` was not — it compared payload bytes with
  public text. Both directions now raise before any I/O, naming what each column
  holds. Two TEXT columns are untouched whatever their domains: a `nanoid`
  stores exactly the string it shows, so comparing it with an ordinary string
  column asks the question it appears to ask.
- **`_min`/`_max` aggregate the transported spelling.** PostgreSQL has neither
  `min(uuid)` nor `max(bytea)`, and the answer is the same either way.
- **`DEFAULT gen_random_uuid()`** is emitted only for an unprefixed `.uuid()`
  field, and only where the column can hold one: `uuidv7` needs PostgreSQL 18,
  and no database can produce a prefixed value or a `bytea` payload.

### Existing databases

A column that already holds text has two routes, and neither is silent.

- **Keep the column.** A text-family native type
  (`s.string(PG.STRING.VARCHAR(40)).uuid()`, `TEXT`, `citext`, MySQL `CHAR(n)`,
  …) opts out of compact storage while keeping the domain validated. PostgreSQL's
  `char(n)` is not among them — `character(n)` blank-pads to its full width, so
  no value of the domain would ever be returned. A native type the domain cannot
  live in is refused where it is declared (F013), with a message naming the
  spellings that format does accept.
- **Convert the rows.** The generated `alterColumn` into a binary column is now
  **refused** rather than run: nothing can re-read stored text as bytes, and the
  refusal names the manual route. PostgreSQL's `text` → `uuid` leg still runs —
  `col::uuid` is a real per-value conversion — and is now preceded by a guard
  that says how many rows would fail it and what the two routes are, instead of
  naming one offending value.
- `identifierConversionChecks` (new, from `viborm/migrations`, alongside the
  `MigrationCheckInput` type) renders the questions a conversion has to answer
  first — every row in the domain, no two rows folding together under the
  uuid/ulid alias, every referencing foreign key still finding its parent after
  that fold — as `trusted-read` checks you can run or pass to `generate()`. The
  fold question is asked of the key and of any referencing column that is a
  complete key of its own model, never of a plain many-side foreign key. On
  MySQL every identity comparison is rendered as `CAST(… AS BINARY)`: the 8.0
  default collation folds case in `=`, which admitted a foreign key that the
  `BINARY(n)` column would then leave without a parent.
  The per-dialect recipes are in the new
  [Converting identifier columns](https://viborm.dev/docs/migration/identifiers)
  guide; every statement on that page was executed against PostgreSQL 16,
  MySQL 8 and SQLite.

### Decimal API change (breaking)

The exact decimal value type is now VibORM's own `Decimal` instead of
decimal.js, and it brings no dependency with it: an immutable signed `BigInt`
coefficient and a scale, where decimal.js was 32 KB minified.
`Decimal` is still exported from `viborm`, still constructed once per selected
leaf, and still satisfies `instanceof Decimal`. Nothing VibORM owns changed:
`s.decimal({ precision, scale })`, the frozen descriptor, exact admission,
canonical identity, provider representations, DDL, filters, updates, aggregates
and migrations all behave exactly as before, and the accepted input grammar
(`"+1.5"`, `".5"`, `"1."` accepted; `"1e3"` refused) is unchanged.

What changes for application code that does arithmetic on returned values:

- **18 prototype members instead of ~130**, every one of them distinct.
  Kept: `abs`, `cmp`, `div`, `eq`, `gt`, `gte`, `lt`, `lte`, `minus`, `neg`,
  `plus`, `times`, `toFixed`, `toJSON`, `toNumber`, `toString`, `valueOf`,
  and the constructor.
- **No aliases.** decimal.js spelled three operations twice; only `plus`,
  `minus` and `times` exist here.
- **Gone:** `pow`, `sqrt`, `mod`, `prec`, `round`, `toExponential`,
  `toPrecision`, `isZero`, `isNeg`, `isNaN`, `isFinite`, `floor`, `ceil`,
  `trunc`, `toDP`, `toSD`, `dp`, `sd`, `ln`, `log`, `exp`, the trigonometric
  methods, `toFraction`, `toNearest`, `clamp`, and the radix conversions.
  `x.isZero()` becomes `x.eq("0")`; `x.isNeg()` becomes `x.lt("0")` (a JavaScript number is refused; write the string or a bigint); rounding to a
  fixed number of places is `x.toFixed(n)`.
- **No NaN and no Infinity.** `new Decimal("abc")`, `new Decimal(NaN)` and
  `new Decimal(Infinity)` throw `TypeError` where decimal.js produced a NaN
  value, and `div(0)` throws `RangeError("Division by zero")`.
- **No configuration at all.** `Decimal.set({...})` is gone and nothing
  replaces it: the class has no static properties, so nothing an application
  sets can move a value in either direction. `div` takes its decimal places and
  its rounding as arguments — `div(other, fractionDigits = 20, rounding =
  "half-up")`, where `rounding` is `"half-up"` (ties away from zero, the
  default and what decimal.js's default produced) or `"half-even"` (ties to the
  even neighbour, what the SQL engines do). `toFixed` rounds half away from
  zero.
- **`toString()` never emits exponent notation.** There is no `toExpNeg` /
  `toExpPos` equivalent and no threshold: the canonical text of a value is
  every digit it has, which is also the text VibORM stores, compares and keys
  cache entries on.
- **`structuredClone` of a `Decimal` returns an empty object** rather than
  throwing, because the value lives in private fields. It was already not
  cloneable; it is now quietly not cloneable. Post `row.total.toString()`
  across a worker or a `structuredClone`-based cache boundary and rebuild the
  value on the other side. VibORM's own cache stores the canonical text, so
  nothing internal is affected.
- **No `@types/*` package.** The declarations are VibORM's own and ship with
  it, so `dependencies` carries no type-only package.

There is no compatibility shim, and a decimal.js instance is not accepted as
input. Convert one at the boundary:

```ts
import { Decimal } from "viborm";

const converted = new Decimal(oldDecimalJsValue.toFixed());
```

Use `toFixed()` with no argument rather than `toString()`: it is decimal.js's
complete value in plain notation, so it cannot hand the new constructor an
exponent form shaped by the old constructor's `toExpNeg`/`toExpPos`, which the
accepted grammar refuses.

## 0.1.0 - 2026-01-24

- Published the initial development package.

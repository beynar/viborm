# RBAC extension: one predicate per action, judged in the statement

> Draft for the owner, 2026-10-15, revised the same day under three adversarial reviews (security, first principles, feasibility); every finding's disposition is in Appendix A. Base `2fcaa26a8` (VibORM 1.2.4, branch `rbac` = `origin/main`). Nothing here is implemented. Input: the design brief agreed in chat on 2026-10-14/15 (the truths and the features 0 to 12 are the owner's) and the read-only census of the extension language and the engine at this commit. Labels, as in the v3.1 and v4 plans: **measured** (the census spike, S-A to S-X5, and this plan's spike, S-Y1 to S-Y4, on SQLite3 in memory under vitest, `scratchpad/rbac/spike/*.spike.ts`; the feasibility review's spikes, S-Z1 bundle sizes from `pnpm package:build` and `scripts/measure-bundle.mjs` into `scratchpad/rbac/bundle-baseline.json`, and S-Z2/S-Z3 a policy-shaped rows domain on SQLite3 metered by a statement transform, `scratchpad/rbac/spike2/binds.spike.ts`, one run on one machine; repository untouched by all of them), **source** (file:line at `2fcaa26a8`; `raptor3/` means `src/query-engine/raptor3/`), **estimate** (a number with its basis), **judgement** (a reasoned choice, basis given). "Unmeasured" where nothing was run. A choice this text makes that the owner has not made is marked **OD-n** and collected in §11.

Method: ELEGANCE.md. State the fewest independent truths; derive every feature from them; for each derivation answer the five questions of "Apply the principles". Where the brief and the code disagree, or where the derivation does not reach the brief's spelling, the text says so and chooses, with evidence (§3.4).

## 1. Goal

In the owner's words: **"une permission se juge dans la requête"**: a permission is judged in the query. The application says who the caller is, once per request; the database decides, in the operation that reads or writes, which rows that caller may take and what it may do to them, from the relations of the rows as they are at that moment. One declaration per model and action is the only place a rule is written: filtering at every scope, write admission, placement, `can`/`assert`, access evidence, field levels and key narrowing are all read from it.

The capabilities are the deliverable; `viborm/rbac` is the acceptance test. Like `viborm/soft-delete` (AGENTS.md Rule 6 and the paragraph on official extensions, AGENTS.md:283-289), the entry is an ordinary definition built from public exports only: a need it cannot meet through the public capabilities is a capability to add, never a friend import. AGENTS.md:293-295 says today "The extension foundation ships no RBAC helper; complete policy still needs graph-wide semantic ownership": this plan is that ownership, and the sentence changes when it lands.

### 1.1 Acceptance test

The whole RBAC of an app-shaped synthetic schema, through public exports only. The schema is a **copy** of `tests/package/fixtures/recursive-where/` (that fixture is pinned by the recursive-where type budgets and stays untouched): `tests/package/fixtures/rbac-app/`, trimmed to the models named here, its `group` model called `pageGroup`, its grant arc reduced to four things (page, group, document, collection), and extended by `teamMember.role`, `accessGrant.actions` (with `level` nullable), `collection.status`/`createdById`/`budget`, `document.archivedAt`, `deletedAt` on `member`, `teamMember` and `accessGrant`, a `user.apiKeys` relation through `apiKey.referenceId`, and a `rolePermission { organizationId, role, action }` model for the stored-role variant. It is synthetic: no name, rule or shape is taken from the owner's private application. The fixture today is type-only (source: used only by `type-recursive-where-smoke.mjs`; no seed, no runner), so U0 (§6.1) builds its seed, an independent oracle and the runners.

```ts
// policy.ts: the app's whole permission model.
import { v } from "viborm/validation";
import {
  rbac, owner, member, grant, team, role, everyone, up, session, notBanned, keyLimit,
} from "viborm/rbac";

/** Who calls: facts of the request only. Bound once by `db.$as(actor)`; nothing here is read from the database. */
export const Actor = v.object({
  userId: v.string(),
  organizationId: v.string(),
  network: v.string(),                    // where the request comes from ("office", "public"): a request fact
  session: v.string().optional(),         // the session's id, never its bearer token (§5.4)
  key: v.object({                         // an API key or a delegated token: its id and its immutable claims
    id: v.string(),
    scopes: v.record(v.string(), v.array(v.string())),                                    // per model: the actions it may use
    resources: v.object({ document: v.union([v.literal("all"), v.array(v.string())]) }), // "all" is written, never implied
  }).optional(),
});

/** The organization role caps every arm: a reader granted edit holds view. */
const ceiling = { reader: "view", member: "full", admin: "full" };
/** An active member of the row's organization: not banned, on a live session or a live key, capped by its role. */
const inOrg = member({ via: "organization", ceiling, user: { AND: [notBanned(), session()] } });
const admin = member({ via: "organization", roles: ["admin"] });

/** Grants on a row, per action: to the actor, to everyone, to a team the actor is in or below, to the actor's role. */
const given = grant.to(
  [owner("userId"), everyone(), team("granteeTeam", { below: "children", memberOf: "members" }), role("granteeRole", { via: "organization" })],
  { relation: "grants", level: "level", actions: "actions" },
);
/** Who writes a grant: whoever administers EVERY thing it is attached to; never more than the writer holds there. */
const grants = grant.administer({ page: "full", group: "full", document: "share", collection: "full" }, { level: "level", actions: "actions" });

export const policy = rbac({
  actor: Actor,
  levels: ["view", "edit", "full"],                          // ordered: full implies edit implies view
  limit: keyLimit({ when: "key", scopes: "key.scopes", ids: { document: { path: "key.resources.document", through: "parent" } } }),
  models: {
    organization: {
      view: member(),
      invite: admin,
      export: { AND: [admin, { plan: "pro" }, { actor: { network: "office" } }] }, // a row fact, and a request fact
    },
    member: {
      within: inOrg,
      view: {},
      edit: admin,                                             // the new row too: no move into an org the actor does not run
      create: { organization: "invite" },                      // the invited user must be visible to the actor
      operations: { delete: "edit" },
    },
    user: { view: { members: { some: { organizationId: { actor: "organizationId" } } } } },
    team: {
      within: inOrg,
      view: {},
      invite: { OR: [admin, { members: { some: { userId: { actor: "userId" }, role: "lead" } } }] },
      edit: admin,                                             // `parents` is read by team(...): only admins re-parent
    },
    teamMember: {
      view: { team: "view" },
      manage: { team: "invite" },
      create: { team: "invite" },
      operations: { update: "manage", delete: "manage" },
    },
    accessGrant: {
      view: { OR: [{ userId: { actor: "userId" } }, grants.admin] },
      edit: grants.admin,
      create: grants.place,                                    // admin, one thing at least, contents bounded by what is held
      operations: { delete: "edit" },
    },
    pageGroup: { within: inOrg, arms: [owner("createdById"), admin, given] },
    page: {
      within: inOrg,
      arms: [owner("ownerId"), { AND: [{ personal: false }, admin] }, given, (a) => ({ personal: false, group: a })],
      create: { OR: [{ group: "edit" }, { groupId: null, personal: true, ownerId: { actor: "userId" } }] },
      fields: { ownerId: { write: "full" } },
      domains: { given },                                      // `as: "given"`: P(view) ∧ given(view)
    },
    document: {
      within: inOrg,
      actions: { view: [], comment: ["view"], archive: ["view"], edit: ["comment", "archive"], share: ["edit"], export: ["view"] },
      arms: [up("parent", owner("ownerId")), { AND: [admin, up("parent", { parentId: null, personal: false })] }, up("parent", given)],
      operations: { delete: "share" },
      create: { OR: [{ parent: "edit" }, { parentId: null, ownerId: { actor: "userId" } }] },
      fields: { ownerId: { write: "share" }, archivedAt: { write: "archive" } },
    },
    collection: {
      within: inOrg,
      arms: [owner("ownerId"), { status: "draft", createdById: { actor: "userId" } }, given],
      create: { createdById: { actor: "userId" } },
      fields: { budget: { read: "full" } },
    },
  },
});

// The stored-role variant: the ceiling read from `rolePermission` rows instead of declared.
// const inOrg = member({ via: "organization", ceiling: { relation: "permissions", action: "action" }, user: { AND: [notBanned(), session()] } });
```

```ts
// server.ts
import { defineExtension } from "viborm";
import { softDelete } from "viborm/soft-delete";

const tombstones = softDelete({ models: Object.fromEntries(
  ["page", "member", "teamMember", "accessGrant"].map((m) => [m, { deletedAt: "deletedAt" }])) });
const audit = defineExtension({ name: "audit", data: { models: {
  document: { update: { updatedBy: { control: "actor", path: "userId" } } },   // rbac's actor, read by order (K7(c))
} } });
const db = policy(tombstones(base)).$extends(audit);           // needs OD-1 (K7(b)): refused in both orders today

export async function handle(request: Request) {
  const call = db.$as(await authenticate(request));            // per request: validated once, nothing shared is mutated

  await call.page.findMany({ include: { group: true } });                   // pages the actor views; a hidden group reads null
  await call.page.findMany({ as: "given" });                                // given to me: P(view) ∧ given(view)
  await call.page.findMany({ deleted: "with" });                            // tombstoned pages too; a tombstoned grant or membership still grants nothing
  await call.document.findMany({ where: { parentId: null }, include: { $access: true, children: { include: { $access: true } } } });
  await call.page.update({ where: { id }, data: { title } });               // edit; NotFoundError when not editable
  await call.page.update({ where: { id }, data: { ownerId } });             // full; the new owner must be visible
  await call.page.update({ where: { id }, data: { groupId } });             // edit on the page, the new group editable; else ForbiddenError
  await call.page.update({ where: { id }, data: { group: { connect: { id: hiddenGroup } } } }); // NestedWriteError
  await call.document.update({ where: { id }, data: { archivedAt: now } });  // archive alone (audit's updatedBy takes no action)
  await call.document.update({ where: { id }, data: { parentId: childId } }); // ForbiddenError: a parent inside its own subtree
  await call.document.delete({ where: { id }, as: "edit" });                // still judged at share: NotFoundError for an editor
  await call.member.update({ where: { id }, data: { organizationId: otherOrg } }); // ForbiddenError unless admin of both
  await call.page.create({ data: { title, organizationId, ownerId, groupId } }); // ForbiddenError unless the group is editable and every key's target visible
  await call.accessGrant.create({ data: { organizationId, documentId, userId: me, actions: ["export"] } }); // ForbiddenError for a sharer without export
  await call.accessGrant.create({ data: { organizationId, pageId: myPage, groupId: theirGroup, userId: me, level: "full" } }); // ForbiddenError
  await call.teamMember.create({ data: { teamId, userId } });              // invite on the team; the user visible
  await call.team.update({ where: { id: myTeam }, data: { parents: { connect: { id: admins } } } }); // NotFoundError for a lead
  await call.team.can("invite", { id: teamId });                            // boolean, one statement
  await call.document.can(["comment", "edit", "share"], { id });            // { comment, edit, share }, one statement
  await call.organization.assert("export", { id: orgId });                  // ForbiddenError unless admin, plan pro, office network
  await call.collection.findMany({ select: { id: true, budget: true } });   // ValidationError if a returned row lacks full
  await call.$queryRaw`SELECT * FROM "page"`;                               // EVERY row: raw SQL is not filtered (§10)

  const keyed = db.$as({ ...actor, session: undefined, key: { id: keyId, scopes: { page: ["view"] }, resources: { document: ["d1"] } } });
  await keyed.page.findMany();                                              // pages, if the key row is live (enabled, not expired)
  await keyed.page.create({ data: { title, organizationId, ownerId } });   // ForbiddenError: the key does not hold edit (create)
  await keyed.member.findMany();                                            // []: member is not in the key's scopes
  await db.page.findMany({ actor });                                        // ValidationError: `actor` is bound only
  await db.page.findMany();                                                 // ValidationError: control "actor" is required
  await db.page.create({ data: { title, organizationId } });               // ValidationError: required on creates too
}
```

The simplest case, a blog where the author edits and admins delete, in eight lines:

```ts
const blog = rbac({
  actor: v.object({ userId: v.string(), admin: v.boolean() }),   // `admin`: an identity-provider claim, not a row of this database
  models: {
    post: { view: {}, edit: owner("authorId"), delete: { actor: { admin: true } }, create: { authorId: { actor: "userId" } } },
    user: { view: {} },
  },
});
const call = blog(base).$as({ userId: session.userId, admin: session.admin });
```

Spellings that differ from the brief are derived in §3 and listed in §3.4. The acceptance gate (§6.3): the blocks compile under `tsc --strict` from the packed tarball (TS 5.9, 6 and 7, and `bun check`); `rbac(...)(base)` admits both policies (W-D8); and every commented line, including the commented variant, behaves as its comment says on the substrates of §7 against the oracle over the seeded copy.

### 1.2 Done, as capability contracts

| # | Contract | Core owner | Executed witness (§7) |
|---|---|---|---|
| C1 | A call with an actor sees, at every scope, only rows whose `view` predicate holds: root reads, aggregates, `groupBy`, cursors, includes, to-one and to-many, `some`/`every`/`none`/`is`/`isNot`, relation counts and order, recursive reads, polymorphic arms | `raptor3/shared/query.ts` (`#within`, `correlation()`/`#related`, `#walk`, `#step`) | W-R1..W-R9 |
| C2 | A policy predicate may traverse relations (including `recurse` at a written depth) and read actor values; it is admitted once through the model's `where` schema; its traversals read every other layer at that layer's default mode and never its own | `src/extensions/definition.ts`, `raptor3/shared/query.ts`, `row-scope.ts` | W-K1a..W-K1g |
| C3 | Actor values are plan parameters: one prepared predicate per name serves every actor; no per-actor memo; one absence rule; null never matches `IS NULL` | `src/extensions/rows.ts`, `raptor3/shared/query.ts` (`PreparedOperand`) | W-K2a..W-K2g |
| C4 | A write is judged on its old row at the actions of the fields the call's data writes (relation fields and join rows included, both endpoints of a join); a parent addressed by a nested write at `view`; every candidate set inside the read predicate | `raptor3/commands/commands.ts`, `relation-body.ts`, `selection.ts` | W-W1..W-W12 |
| C5 | The row a write produces is judged against the database before the write and before any constraint: placement on creates, the judging predicates on every update's new row, every written key's target visible, no parent cycle | `raptor3/commands/commands.ts` (create and update sites) | W-P1..W-P16 |
| C6 | `db.$as(actor)` derives a view binding only rbac's bound-only control; the base view is unchanged; two views never share an actor; transactions and derived clients keep it | `src/client/client.ts` (`#createView`), `src/extensions/methods.ts`, `controls.ts` | W-AS1..W-AS7 |
| C7 | `can`/`assert` answer from the same predicates in one statement, through `$access` only; `assert` throws `ForbiddenError` | `src/rbac/index.ts`; `src/errors/` (new class) | W-CAN1..W-CAN6 |
| C8 | `$access` (a key the extension declares) reports, per row, at any depth, on read and write results, the actions the actor holds, from the same predicates, in the same statement | `raptor3/shared/query.ts`, the row parser, select admission | W-EV1..W-EV4 |
| C9 | A field with a read action is omitted where the actor lacks it, on read and write results, reads as absent in every operand the caller writes, and an explicit `select` of it fails rather than empties | `raptor3/shared/query.ts`, the row parser | W-F1..W-F8 |
| C10 | Key limits and named domains only narrow: a key is denied on every model and action it does not list, creation included | `src/rbac/index.ts` (compile), K2 conditions | W-L1..W-L8, W-N1..W-N4 |
| C11 | Every model of the schema is governed; no actor, no rule, an absent or null actor value: no row, no effect | `controls.ts`, `rows.ts`, `src/rbac/index.ts` | W-D1..W-D12 |
| C12 | Composition is intersection: with soft delete, tenancy, audit; a tombstoned membership or grant grants nothing under any mode the call passes | `row-scope.ts` (layered `RowDomain`), `src/extensions/chain.ts` | W-C1..W-C8 |
| C13 | Raw SQL and statement transforms are not filtered, and the guide says so in bold | none (documented boundary) | W-X1 (negative witness) |

## 2. Baseline and evidence

Commit `2fcaa26a8` (VibORM 1.2.4). The census (read-only, `scratchpad/rbac/census.md`) and the spikes establish what exists.

**The extension language (source).** Ten capabilities exactly (AGENTS.md:208-216); `controls`, `rows`, `deletion` and `data` are plain data core honours at every scope; "a capability that needs a branch naming one extension, model, marker field or mode in core is a design failure". `rows` declares, per model and mode, a `root` and a `related` predicate (`src/extensions/rows.ts`, `raptor3/shared/row-scope.ts:11-27`); the mode is chosen by one control's value (`callRows`, rows.ts:457-481); `bindRows` builds one `RowDomain` per product of every member's modes (rows.ts:374-447). A control value enters a predicate through `{ control: "<name>" }` (`referenceOf`, rows.ts:102-111), put in as it is (rows.ts:184-189: `{ ownerId: null }` would mean IS NULL), memoized in a 256-entry FIFO map (rows.ts:72-74, 506-512). The rows control goes on every candidate-selecting operation, updates and deletes included, never on creates (controls.ts:299-303, 363-369); a `required` control is asked for only on the models the definition names in `rows`, `data` or `deletion` (controls.ts:337-350). Controls are admitted once, removed from the arguments before request transforms, and seen only by the declaring extension (controls.ts:512-577).

**The engine (source).** The domain enters every candidate lookup: root reads (`raptor3/shared/query.ts:1967-1982`), aggregates (:1992-2005), cursors (:3970-3982), every relation through `correlation()` → `#related` (:3532-3555); writes take key-preserving candidates (:1948-1961); a tombstone's candidates also take the default domain (`Commands.candidates`, commands.ts:514-530). A prepared predicate captures its value (`PreparedOperand`, query.ts:365-372); `PreparedDomain` memoizes prepared selectors per purpose and one read view (query.ts:944-956). Aliases come from a per-instance counter (`#nextAlias`, query.ts:990, 1104-1135), and `under()` builds a fresh instance with the counter at 0 (query.ts:1021-1023). A write's returned root row is an unscoped identity capture (commands.ts:1630-1641). A many-to-many connect writes a join row through the internal `link` command (commands.ts:151-159; relation-body.ts:1220-1232). `recurse: true` and `{}` admit as depth 100 (recurrence.ts:99-100). `v.object` exposes `entries` and rejects unknown keys by default (validation/primitives/object.ts:39, 413). SQLite queues `assertions.exists` statements that abort a batch (adapters/databases/sqlite/sqlite-adapter.ts:720-725). Interactive transactions build their view from `engine.bind(...)` alone (client.ts:904-907). A client method's type is fixed by the client it was defined against (methods.ts:161-169); every view invokes every model factory of every extension eagerly (methods.ts:494-518).

**Contradictions and measurements.** They decide the shape of §4:

| # | Fact | Evidence |
|---|---|---|
| C1 | The guides say a `rows` filter cannot go through a relation (recipes.mdx:238-240, create.mdx:349-353); nothing refuses it | measured S-A, S-A2, S-X2: accepted and correct when acyclic |
| C2 | A relation filter in a `related` predicate that reaches back to a model with a `related` predicate overflows the stack while lowering | measured S-B, S-X1, S-X3, S-X4: `RangeError`, through query.ts:3553 |
| C3 | Domain predicates bypass `where` admission (row-scope.ts:5-10); `recurse: true` reads `depth: undefined`; a misspelt nested key reaches the preparer raw | measured S-C (one hop instead of the closure), S-X5 (raw `TypeError` at the first read) |
| C4 | The 256 memo is FIFO, not LRU | source rows.ts:72-74, 506-512 |
| C5 | There is no `deletion.eligible`; eligibility is a rule (caller selector ∧ call domain ∧ default domain) | source controls.ts:77-87, commands.ts:514-530 |
| C6 | No "numeric cap" rule in AGENTS.md; the nearest written rule is src/client/AGENTS.md:141 ("never a numeric depth cap"); shipped caps this plan touches: `BOUND_LIMIT = 256` (rows.ts:74), the predicate depth `> 16` refusal (definition.ts:290), `DEFAULT_DEPTH = 100` (recurrence.ts:99) | source; the rule is the owner's chat ruling (brief) |
| C7 | AGENTS.md:254-257 says `rows`/`data`/`deletion` are "neither copied nor checked"; model and top-level field names are checked | source definition.ts:247-378 |
| C8 | Soft delete binds its actor by re-applying the whole extension per request | source soft-delete/index.ts:62-108 |
| C9 | A `required` control is required at runtime only; every control is optional in the types | source controls.ts:225-239, :546-551 |
| C10 | Control names are one name space with no duplicate refusal; rbac's `actor` (object) and audit's `actor` (string) both validate the same argument, so every write fails one of them | **measured S-Y4** |
| C11 | An object control value is put in as it is: its keys become filter operators | measured S-D |
| C12 | An absent optional control drops the whole predicate (fail-open), inside relation filters and OR arms too; only `required` gives `MATCH_NOTHING` | source rows.ts:79-85, 188, 203-230 |
| C13 | Soft delete's `with` mode is `{}` at both scopes (soft-delete/index.ts:89) and its control reaches every candidate operation; a policy traversal lowered under the call's `RowDomain` would count tombstoned rows under `deleted: "with"` | source |
| Y1 | `rows` after `softDelete(...)` is refused (its `restore` methods are result consumers) | **measured S-Y1** (chain.ts:486-491) |
| Y2 | `softDelete(...)` after a rows extension with model methods is refused the same way | **measured S-Y2** |
| Y3 | One `$extends` of a one-model rows definition | **measured S-Y3**: 13.35 µs per call, one run (an order of magnitude) |
| Y4 | The D1 driver declares 100 bind parameters per statement | source src/drivers/d1/index.ts:193; statement text is capped at 100 KB by Cloudflare's published D1 limits (provider fact, declared nowhere in the repo) |
| Z1 | Gzip headroom under the shipped `size-limit` rows: pg-representative 168,757 / 170,000 B (1,243 left); d1-worker 168,149 / 170,000 (1,851); every public entry 388,228 / 394,000 (5,772); pg + soft delete 169,100 / 173,500 (4,400) | **measured S-Z1** (1 kB = 1,000 B, `bytes-iec`) |
| Z2 | A simplified page `view` predicate (tenancy, owner, admin, grants with a team walk, group arm; acyclic, no `$access`) binds 42 values, 11 distinct, 4.9 KB of SQL; with `include: { group: true }` 63 binds, 16 distinct; `pageGroup` with its pages 64. Most binds are policy constants (`in` lists bind per member on SQLite, booleans, dates), not actor values | **measured S-Z2**, one run; `$access` over three levels adds about two full predicates (estimate: ≥ 120 binds before dedupe) |
| Z3 | Preparation and lowering before the statement: 0.18-0.49 ms per call for the 42-bind predicate, against 0.012-0.027 ms for a whole base `page.findMany`; there is no cross-call statement cache, so the memo path also lowers per statement | **measured S-Z3**, one run |
| Z4 | Recursive-where type headroom: TS 5.9 1,268,196 of 1,283,834 (1.2%), TS 6 1,441,760 of 1,474,755 (2.3%), TS 7 1,816,860 of 1,881,970 (3.5%) | source type-recursive-where-budgets.json (baseline × 1.1), CHANGELOG 1.2.2/1.2.4 |

Y1 and Y2 mean the brief's composition (`softDelete` + `rbac`) cannot be built today in either order (§4.7). Z1 means the base budget of the first draft (+2.5 KB) breaks two shipped limits before any rbac code ships (§8, OD-17).

## 3. The truths and the derivations

### 3.1 The truths

Four. The brief's T4 (default deny) is derived (R6, R9); the brief's T5 is kept, because the review showed it is not derivable: `RowDomain` is a conjunction at the root (row-scope.ts:9-11), but nothing in T1 to T3 decides which rows a policy's own traversals read, and "relations as they are now" would count a tombstoned grant, which still physically exists.

- **T1. A permission is a predicate judged by the database.** A `where` over the row's relations and the actor's facts, decided inside the operation that takes the effect, over the relations as they are when it runs. Nothing about the actor is read from the database beforehand. (Whether "inside the operation" must be one statement, or may be a premise in the same atomic operation before the effect, is **OD-13**: the brief says "the same statement".)
- **T2. One predicate per (model, action) is the sole authority.** Everything that answers "may this actor…" is a projection of those predicates. An engine decision in place of a predicate, dropping a filter because a value is absent or reaching a model that has no predicate, would be a second authority.
- **T3. The actor is the request's parameter, and the only input that is not a relation.** Bound once, through a derived view (`db.$as(actor)`), never computed by the engine, never set on a client other requests share (concurrent requests in one Worker isolate would see each other's actor). A governed call without it is incomplete. Its lifetime is the request; the predicates' lifetime is the client.
- **T5. Composition is intersection, everywhere.** Every other extension's domain applies to every row the operation reads, including the rows a policy's own traversals read.

### 3.2 Rules the truths force

Each written once; the features cite them.

- **R1, the one formula (T2).** `P(M, a) = within(M)(a) ∧ limit(M, a) ∧ ( ⋁_{b ⊒ a} rule(M, b) ∨ ⋁_{g ∈ arms(M)} g(a) )`. `b ⊒ a` means b is a or implies it, transitively; `rule(M, b)` is the predicate written under the action's name; an arm, `within` and `limit` are a `where` (the same at every action) or a function of the action `(a, model) => where`, evaluated once per declared action at `rbac()` (finite, inspectable, no template holes). Helpers give each action its own meaning: `given(a)` is one `EXISTS` with `level ∈ ↑a` or `actions` meeting `↑a`; a ceiling admits a role iff its allowed set contains a. Because the ceiling is evaluated at a, no cross term between a grant's level and a role's ceiling is needed (a reader granted `edit` holds `view` because `edit ⊒ view` and the reader's set contains `view`). An action M does not declare is `false`.
- **R2, view is the floor, by the engine (T2).** A caller's filter is a read of the rows it is evaluated on: if a write's candidates or a mode could reach rows the read predicate hides, `updateMany({ where: { title: { startsWith: "x" } } })` would count invisible rows, an oracle. So every non-read verb, every mode and every evidence projection is conjoined with the model's read predicate (K3). This holds whatever the policy's functions say, so no monotonicity obligation falls on authors. Precedent (judgement): PostgreSQL row-level security applies the SELECT policy to the rows an UPDATE or DELETE reads.
- **R3, the old row of a write (T2).** An occurrence is judged at `⋀_{f ∈ W} P(M, write(f))` on the row it takes. W is the fields the call's data writes, as the chain's request transforms leave it, relation fields included (a `connect`, `disconnect` or `set` writes its relation field; a join row writes the relation field on both endpoints). `write(f)` is the declared write action, else `operations.update`. Stamps (`data`) and schema-generated values (`updatedAt`, `now()`) are not in W: their values are declared, not chosen by the caller, and R4 judges the row they produce. An occurrence that writes nothing of its own (a parent addressed by a nested write) is only read to reach its children: it is judged at `view`, and its children by their own verb or placement, so a root create and the equivalent nested create get one answer.
- **R4, the new row of a write (T1, T2).** The row a write produces must satisfy, against the database **before** the operation's writes and before any constraint is checked: for an update, the predicates that judged its old row (PostgreSQL's WITH CHECK defaulting to USING); for a create, `place(M) = within(M)(c) ∧ limit(M, c) ∧ create(M)` with `c = operations.create`; for an update that writes a field `create(M)` reads, `place(M)` as well (the move); for each written foreign key, its target satisfies `P(T, view)` (the visibility a `connect` already obeys, relation-body.ts:83-92: one rule for two spellings of one effect, ELEGANCE 9); for a written self-referential key a policy recurses over (`up("parent")`), the new parent outside the row's own closure (a cycle would make every recursive read of that tree throw, query.ts:6201-6204). No row the operation itself writes is visible to this judgement, except that a row created earlier in the same operation is visible to its own children as the values written to it. So a grant cannot justify itself, and a missing target and a hidden one give the same `ForbiddenError`.
- **R5, layering (T5, T2, R8).** A policy's traversals read every other layer of the chain at that layer's **default** mode, whatever mode controls the call passes, and never the layer being lowered. A per-call mode is a choice about the rows the caller asked for (root and related), not about the facts a permission reads; if `deleted: "with"` or tenancy's `scope: "all"` reached the traversals, a per-call choice would widen a permission (R8). This is the rule tombstones already use (commands.ts:514-530). Excluding the layer being lowered terminates C2 with no depth number.
- **R6, absence (T2).** Order per call: conditions on actor values (`{ actor: { network: "office" } }`, "the actor carries a key") fold first, and a false condition removes its arm with every reference inside it; constants simplify; then any remaining reference whose value is absent resolves by its control's `required`. The actor is required, so the whole predicate is false (`MATCH_NOTHING`, today's rule, rows.ts:203-230); an optional control of another extension keeps today's drop. A `null` value is absent: a parameter never lowers to an `IS NULL` test (an actor with `userId: null` would otherwise own every orphaned row; `ownerId` is set null on user delete, content.ts:24-27). Optional facts are therefore guarded by conditions in the helpers: `session()` is `OR[$if session ⇒ a live session, $if key ⇒ a live key]`. A path the actor schema does not declare is refused at `rbac()` (K2(e)), so no typo can fold a guard false.
- **R7, the instant (T1, T3).** "Now" in a predicate (a session's or a key's expiry) is the call's one instant, the one tombstones already use (`CallScope.instant()`, row-scope.ts:92-96): re-observed per call, never frozen at `$as`.
- **R8, nothing per call widens (T2, T3).** A mode only narrows a verb and never replaces it: `domain(m, v) = verb(v) ∧ P(view) ∧ N(m)`, where `verb(v)` is the operation's predicate and `N(m)` the mode's narrowing (an action mode is `P(a)`, a named domain its `where`). So `delete({ as: "edit" })` is still judged at `delete`'s action, and `update({ as: "view" })` at `edit`. Limits are conjunctions. Anything that widens (an operator's view of every row) is decided where the actor is bound or by using the client below `rbac`.
- **R9, reach (T2, T3).** `rbac()` names every model of the receiving schema. A model the policy does not list is `false` at every verb; an action a model does not declare is `false`. A root call whose domain is false **at definition time** (an unlisted model, an action or mode the model does not declare) is refused before any statement; one that folds false **per call** (an actor condition, an absent value) returns the ordinary outcome (`[]`, `null`, `NotFoundError`, count 0), with no statement issued as an optimization only, so the result never depends on where the predicate turned false (ELEGANCE 7). The actor control is bound-only and required on every operation of every model, creates included.
- **R10, attachments (T2, R3, R4).** A row a policy traverses through a foreign key into another row (a grant on a page, a membership in an organization, a team edge, a `teamMember` row) is part of that row's rule: writing it changes permissions there. T2 makes the attaching model's own predicates the authority, and R3/R4 make them judge both the old and the new row. What they must say is that every attachment is administered, as a conjunction over the row's non-null keys, never a disjunction across an arc (the fixture's grant arc is a convention only: every thing key is nullable, access.ts:96-160). `grant.administer(...)` emits that conjunction, "at least one thing", and the bound on contents (`NOT (actions has x) ∨ P(thing, x)` per action, `level ⊑ held`). Which action administers is the policy's, not an engine default: "the attached row's top action" does not exist in a partial order (`document`, `team`), and a declared administering action per attached model would restate what the attaching model's predicates already say (`teamMember.create: { team: "invite" }`), a second authority; nor can it express an edge administered from its other end (a membership attaches to a `user`, whose visibility it changes, but the organization's `invite` administers it).

### 3.3 The features, derived

E: what must be expressed; O: owner (information, authority, lifetime); D: what disappears, and the invariant that makes it unnecessary; I: what stays intact; W: the falsifying witness.

**D0. Setup.** `const db = rbac(config)(base); const call = db.$as(actor);`
- E: a governed client from one declaration; a per-request view.
- O: the declaration is data at application time; the actor belongs to the request (T3). `rbac(config)` applies two definitions, rows and controls first, then the `$as`/`can`/`assert` methods typed against the client that carries the rows, as `softDelete` does (soft-delete/index.ts:62-131); `$extends` takes a definition object, not a function. It reads `base.$schema` to name every model (R9).
- D: per-request re-application (C8) disappears for rbac: `$as` derives a view, not a chain (K6). The brief's `unlisted: "deny"` key disappears: under R9 its only legal value is `"deny"`.
- I: the base client is unchanged; `db` without an actor refuses before any statement.
- W: W-AS1 (`$as` builds no chain, no `RowsBinding`, no `PreparedDomain`); W-D1; W-D8 (both §1.1 policies admitted).

**D1. Policy = a `where` per (model, action), full vocabulary.**
- E: relation filters, `some`/`every`/`none`/`is`, `AND`/`OR`/`NOT`, `recurse` over trees and graphs, actor values.
- O: the vocabulary's owner is the `where` preparer (`prepareSelector`, query.ts:1710-1754); admission's owner is the model's where schema (schema.ts:453-459), which domain predicates skip today (C3). Admitted once at `$extends` (ELEGANCE 5), then prepared as any `where`.
- D: the guides' "no filter through a relation" (never enforced, C1); the `depth > 16` refusal (definition.ts:290), replaced by exact cycle detection. In a domain predicate, `recurse: true` and `recurse: {}` are refused: admission would give them depth 100 (recurrence.ts:99-100), an engine number that would silently stop inheritance at depth 101. Only a depth the author wrote is accepted, `false` or a number; `up()` and `team(below)` emit `depth: false`.
- I: tenancy and soft delete keep their exact predicates and SQL; a misspelt key fails at `$extends` instead of at the first read (S-X5): failure moves earlier, never later.
- W: W-K1a (`recurse: true` refused, `depth: false` returns the closure), W-K1b (S-X5 refused), W-K1c (S-B/S-X1/S-X3/S-X4 terminate with oracle rows), W-K1f (a 101-deep tree inherits under `up()`).

**D2. Rule helpers.** `owner(field)`, `member({ via, roles, ceiling, user })`, `grant.to(arms, shape)`, `grant.administer(things, shape)`, `team(relation, { below, memberOf })`, `role(field, { via })`, `everyone()`, `up(relation, arm)` = `{ [relation]: { recurse: { depth: false }, self: true, some: arm } }`, `session()`, `notBanned()`, `keyLimit(...)`.
- E: the app's recurring shapes, written once.
- O: `src/rbac/index.ts`. Each helper returns a `where` or a function of `(action, model)` returning one (R1); `member({ via })` reads the foreign key behind `via` from `base.$schema` (F3 checks that reading a relation's fields at runtime holds). A helper is evaluated at `rbac()`, never per call. On a model with its own `actions` map, `given` reads the grant's `actions` column; on a model whose actions are the `levels`, its `level` column and its `actions`.
- D: the hand-written spreads of the fixture (rules.ts:1-200); the first draft's template holes and global `roles` (the ceiling is an argument of `member()`, so a hand-written `within` cannot silently ignore it).
- I: a helper's output is inspectable data.
- W: W-H1 (each helper's output selects the fixture's hand-written rule's rows on the seeded data, every substrate).

**D3. Actions, not only a ladder.** `actions: { view: [], comment: ["view"], … }`; `levels` is sugar for a chain; `operations: { read, update, delete, create }` maps operations to actions.
- E: named actions in a partial order; operations mapped to them.
- O: the declaration, compiled by R1. The engine sees predicates by name, never actions (K3).
- D: a ladder-specific path. A rule key that is neither a level nor in `actions` (`invite`, `export`, the blog's `delete`) names an action implying `view` only. Defaults (**OD-3**): read → `view`, update → `edit`, create → `edit`, delete → `delete`; when the model's actions are exactly the `levels` chain, delete → its last level. No other default exists: an operation whose action is undeclared is false (R9), so a model nobody deletes needs no `delete: false`.
- I: an operation takes exactly one action.
- W: W-A1 (per action, the row set R1 predicts, computed by the oracle).

**D4. A write takes the action of what it writes.** `fields: { ownerId: { write: "full" }, archivedAt: { write: "archive" } }`.
- E: an update's action is a function of the fields the caller's data writes.
- O: R3. The engine knows per occurrence, at preparation, which fields the call's data writes (the same facts `Commands.stamp` reads, commands.ts:484-513) and ANDs one named predicate per written field (K3).
- D: **the brief's `update({ ..., action: "archive" })` disappears**: a caller-named action is either the derived one (redundant), weaker (a hole: a title edit judged at `archive`) or an extra conjunction (a no-op a policy can state). An update writing only `archivedAt` is judged at `archive`, and audit's `updatedBy` stamp or the schema's `updatedAt` do not raise it to `edit`. A value-dependent write (publish when `status` becomes `"published"`) is a placement predicate (R4). The first draft's implicit rule "a field the policy reads is written at the top action" is deleted: it duplicated `fields.write`, refused the §1.1 `document` and the blog (neither has a top action), and its job is done by R4 (the new row) and R10 (attachments). If the owner names a case neither expresses, the argument returns AND-only (**OD-4**).
- I: an update on a row the actor can view but not edit gives `NotFoundError` (commands.ts:2220, 2252); `updateMany` counts exclude rows not editable.
- W: W-W1 (title at edit, ownerId at full), W-W2 (archive-only writer archives, cannot edit), W-W3 (R10: an editor of a page cannot write a grant on it; its `full` holder can), W-W4 (`updateMany` count), W-W5′ (with audit stamping, an archive-only writer archives).

**D5. Field-level read.** `fields: { budget: { read: "full" } }`.
- E: a field present only where the actor holds an action.
- O: the read action's predicate, evaluated per row as evidence (K5), on read results and on every write result (the root row a write returns is an identity capture, commands.ts:1630-1641, so its evidence is computed at capture); the row parser omits the key. Every operand the caller writes (`where`, unique selectors of `findUnique`, cursor anchors, `connect`/`upsert` where, relation filters, relation `orderBy`, aggregates, `groupBy`, `having`, `distinct`, nested write where) reads the field as absent where the evidence is false.
- D: a separate field policy. Read-gating a key or foreign-key column is refused at `rbac()` (masking it would change identity and joins).
- I: rows are not dropped; an explicit `select: { budget: true }` fails with `ValidationError` at `select.budget` when a returned row lacks the action. Timing: after the read statement, before any result (**OD-5**).
- W: W-F1..W-F8 (W-F7 write results, W-F8 unique and relation positions).

**D6. `$access`.** Per row, the actions the actor holds, or the highest level when ordered.
- E: at any depth, on read and write results, from the same predicates, in the same statement.
- O: projection is owned by `select`/`include`, which already recurses through relations. So the extension declares a projection key (`evidence: { as: "$access", … }`) and `include: { $access: true }` works at every depth (**OD-2**, a departure from `access: true`). Core names no rbac member (Rule 6). The value is one boolean expression per action (the predicate's own `EXISTS`), or with ordered levels a `CASE WHEN`.
- D: application-side recomputation.
- I: rows are those of the call's domain; `$access.view` is always true and still reported.
- W: W-EV1 (oracle per row), W-EV2 (nested two levels), W-EV3 (ordered: highest), W-EV4 (one statement, by statement observation).

**D7. Placement and moves.** `create: { group: "edit" }`.
- E: a create is allowed when its row satisfies placement; a move is judged on both sides.
- O: R4. `{ group: "edit" }` is sugar for `{ group: { is: P(pageGroup, edit) } }` (a relation key whose value is an action name is not valid `where` otherwise); cross-model references are inlined at `rbac()` with cycle detection on the (model, action) pair. A move of `groupId`: the old row at `write(groupId)` (`edit` here); the new row under the predicates that judged it (so the page is still editable after the move) and `place(page)`, which reads `groupId` (so the new group is editable); the old group is not judged apart, since the old row's predicate already reads it.
- D: a "creation" capability beside "deletion" (C5); a move rule; a check on scalar foreign keys apart from `connect`.
- I: a nested `connect` outside its domain keeps `NestedWriteError` (relation-body.ts:83-92); root placement refusals give the new `ForbiddenError`. Every create site of v4 §2.2's list is a placement site. Whether an update may remove the actor's own access (transferring a personal page) is **OD-14**: under the recommended reading it may not.
- W: W-P1..W-P16 (§7).

**D8. `can` / `assert`.**
- E: a boolean (or a record) from the predicates, in one statement; `assert` throws.
- O: model methods of the entry over the model's `findUnique` with `select: { $access: [actions] }` under the view domain: one path, one statement for a list. In M1, before `$access` exists, `can(a)` reads under `as: a`; that form is deleted at M2's exit.
- D: a second decision path.
- I: `assert` throws `ForbiddenError` whether the row is hidden or the action lacking; `can` on a hidden row is `false`.
- W: W-CAN1..W-CAN6 (W-CAN6: `can` equals the oracle for every action on every seeded row).

**D9. Permissions as data or code; ABAC.**
- E: grants carrying `actions: string[]`, a role ceiling declared or stored, actor attributes, row attributes.
- O: all are `where` data. A stored role or grant is a relation filter; a declared ceiling is expanded by `member()` per action; a stored one (`rolePermission`) is a relation filter per action. An actor attribute is a **request fact** (the network, an identity-provider claim) folded per call by R6. A fact of a row (an organization's plan) is a row attribute, never copied onto the actor: a copy would be a second authority and stale after a downgrade (T1).
- D: a role model or permission engine in core; a pre-query permission load.
- I: an actor condition that folds false makes its arm false (R6, R9).
- W: W-A2 (stored actions), W-A3 (ceiling), W-A4 (request fact, both folds), W-A5 (row attribute, plan downgrade seen at once), W-A6 (stored ceiling equals declared on the seed).

**D10. Narrowing and the operator escape.**
- E: a key or delegated token holds a subset: actions it lists, rows it lists, through a tree.
- O: `limit` (R1), a function of `(model, action)` evaluated at `rbac()`; `keyLimit` emits `$if actor carries key ⇒ ( key.scopes[M] meets ↑a ∧ ids(M) )`. Scopes close downward under `implies`, so a key scoped `["share"]` views and `P(M, a) ⊆ P(M, view)` holds (R2 holds anyway). A model absent from the key's scopes is a path the actor lacks: false (R6), so a key scoped to pages reaches nothing else. `create` is an action (D3), so a view-only key creates nothing. `ids(M)` is `"all"` or `up(through, { id: { in: list } })`; an absent list is false. Key liveness is a relation (`session()`'s key arm reads `apiKeys` rows: enabled, not expired), as a session's is; the key's scopes are claims of the credential, immutable for its lifetime (judgement: a key whose scopes change in place must state them as a relation instead).
- D: a second policy for keys; the brief's function of the actor (it would make a predicate per actor and cannot be a cache key, `stableStringify` throws on a function, cache/key.ts:250-360).
- **The brief's per-call `scope: "all"` moves to binding time** (R8): on the governed client, any code holding `call` could pass it. The operator escape is the client below `rbac`, or a bound-only value (**OD-8**).
- W: W-L1..W-L8 (W-L5 unlisted model with a key, W-L6 view-only key cannot create, move or `connect`, W-L7 `["share"]` key views and shares, W-L8 absent resources deny).

**D11. Named read domains.** `domains: { given }`.
- E: a second named domain on the same policy.
- O: a mode of the extension's one `rows` member whose narrowing is the domain's `where` (or function at `view`): `as: "given"` is `P(view) ∧ given(view)`; action domains (`as: "edit"`) are `P(view) ∧ P(edit)`. Mode names are shared by every model (definition.ts:328-343); a mode a model lacks (`call.page.findMany({ as: "invite" })`) is a definition-time false, refused before any statement (R9).
- D: a check that a named domain is narrower (it is, by R8); the first draft's arm names and `without`.
- I: an unknown `as` value is the existing `ValidationError` of a `oneOf` control.
- W: W-N1..W-N4 (W-N4: `update({ as: "view" })` by a viewer → `NotFoundError`; `delete({ as: "edit" })` by an editor who is not a sharer → `NotFoundError`; `deleteMany({ as: "given" })` counts deletable rows only).

**D12. Composition.** `softDelete` + `rbac` + `audit`; raw SQL unfiltered.
- E: every domain applies, including inside the policy's traversals, at the other layers' defaults.
- O: T5 and R5. Two blockers not in the brief: Y1/Y2 and C10 (core changes, K7). Audit stamps rbac's actor by referencing it (K7(c)).
- D: nothing.
- I: raw SQL and statement transforms are not filtered; migrations are not affected; soft delete's `mode: "hard"` is open to every holder of `delete` on the governed client (the guide says so). Database cascades are the schema's declared effect of a delete (**OD-15**).
- W: W-C1..W-C8 (W-K1g: `deleted: "with"`, `deleted: "only"` and tenancy's `scope: "all"` revive no tombstoned `member`, `teamMember` or `accessGrant`).

### 3.4 Where the derivation departs from the brief

| # | Brief | This plan | Why |
|---|---|---|---|
| 1 | `base.$extends(rbac(...))` | `rbac(...)(base)` | methods typed against the rows client (D0) |
| 2 | `access: true`, nested in `include` args | a projection key the extension declares | projection already recurses (D6, OD-2) |
| 3 | `update({ ..., action: "archive" })` | `fields: { f: { write: "archive" } }` | redundant, a hole or a no-op (D4, OD-4) |
| 4 | `limits: { key: (actor) => … }` | `limit: keyLimit(...)`, a function of (model, action) at `rbac()` | one prepared predicate for every actor; fail closed on unlisted models (D10) |
| 5 | `scope: "all"` per call | the base client, or bound-only | R8, OD-8 |
| 6 | "`creation`, the counterpart of `deletion.eligible`" | R4 on every produced row | no `eligible` exists (C5); creation and moves are one rule |
| 7 | T4 a truth | derived from T2 and T3 (R6, R9) | a drop or an unreachable-model default is a second authority |
| 8 | `unlisted: "deny"` | absent | its only legal value (R9) |
| 9 | global `roles: {…}` | `member({ ceiling })` | an argument of the helper that applies it (D2) |
| 10 | "templates" for helpers | functions of the action | no intermediate language (ELEGANCE 2) |
| 11 | `plan` on the actor | a row attribute | a row fact on the actor is a second authority (D9) |
| 12 | "a 256-entry LRU" | FIFO, and deleted for domain values | C4, K2 |
| 13 | "a numeric cap is forbidden by AGENTS.md" | not in AGENTS.md; src/client/AGENTS.md:141 and the owner's ruling | C6 |
| 14 | composition "just works" | blocked today in both orders | Y1, Y2 (K7) |

## 4. Capability set changes

Seven changes, all inside the ten capabilities; no eleventh capability, no registry. None names rbac, an action, a role, a grant, an actor field or `$access` in core: the engine learns named predicates, verbs, written fields, produced rows, evidence and parameters, which are facts of any `where`. Runtime line counts are estimates (esbuild-stripped, as v4 §4 counts them), basis named in each.

### 4.1 K1: relation predicates in domains, admitted and layered

- **Today.** Domain predicates reach the preparer as written (row-scope.ts:5-10); top-level names only are checked (definition.ts:289-327); the `related` predicate of a target is lowered inside a relation filter of the same domain (query.ts:3548-3555 via 3443-3448), recursing without end on a cycle (C2). The root domain is merged into the caller's selector at preparation (`#within`, query.ts:1967-1982, through `andSelectors`, :957-971), and `modelDomain` skips members with no predicate for a model (rows.ts:356-372), so by lowering time nothing says which layer a relation filter came from. A nested lowering from `under()` restarts aliases at `q0` (query.ts:1021-1023), which would bind an outer correlation to an inner alias: wrong rows, no error.
- **Change.** (a) Admission: each domain predicate is parsed once at `$extends` through the model's where schema; refusals are `ClientInitializationError` naming model, name and path; `recurse: true`/`{}` refused, a written depth required (D1). Markers are admitted per F3 (sentinels where the field type has a distinguishable value; else a parameter node inside the validation where schemas, the fallback F3 costs). (b) Layers: a `PreparedPredicate` node is tagged with its layer; `PreparedDomain` keeps per-layer prepared selectors; lowering keeps an exclusion stack on the **same** `Queries` (one alias counter), honoured at the six domain read sites (query.ts:1951, 1972, 2823, 3549, 3980, 5129). Inside a policy's traversals every other layer is read at `CallRows.defaults` (R5).
- **Deletes.** The `depth > 16` check (definition.ts:289-294); the guides' "no filter through a relation"; the raw `TypeError` of S-X5.
- **Cost.** Runtime +150 to +250 lines, −15 (estimate, the feasibility review's: tagged node, per-layer selectors, the stack at six sites). Types: none. Cold start: admission builds the where schemas of every referenced model when `rbac(...)(base)` is applied (**unmeasured**; §8 row).
- **Witness.** W-K1a..g: closure at a written depth; S-X5 refused; four cycles terminate with oracle rows; an alias-shadowing case against the oracle; a 101-deep tree; `deleted: "with"`/`"only"` and `scope: "all"` revive nothing; tenancy's and soft delete's suites unchanged, SQL text pinned before and after.

### 4.2 K2: actor values as plan parameters

- **Today.** A value is substituted into a copy of the predicate per call (rows.ts:177-265) and memoized per (combination, values) in 256 FIFO entries (rows.ts:484-515); an object value is read as operators (C11); an absent optional value drops the predicate (C12); a null is IS NULL (rows.ts:184-189); `PreparedOperand` captures its value (query.ts:365-372).
- **Change.** (a) Markers: `{ control, path }` reads a field of an object control; `{ now: true }` the call's instant (R7); a condition node, spelled for the spike `{ $if: { control, path, exists | equals | has | meets } }`, tests call values with no column (**OD-12**). Data stamps accept the same markers (K7(c)). (b) Preparation: a reference prepares as `{ kind: "parameter", control, path }`, once per named predicate. The sites that read a value today must treat a parameter: shorthand detection (query.ts:2364-2386), `in`/`notIn` members (:2457-2470, an array parameter is one operand), captured operators (:2486-2494), equality facts and keys (:2326-2347), `SelectorFacts.equals`/`exact` (:1915-1937, 2821-2825), `sameColumnIn`/`wholeValue` (:479-522, 815-822). Value-dependent lowering (`null`, id encoding, query.ts:3000) runs after resolution, except that a parameter never lowers to IS NULL (R6). (c) Lowering: the call's admitted values travel with its `Queries`; conditions fold, then R6. Memos keyed by `PreparedDomain` that become per call: the read view (query.ts:948-956); the prepared selectors (:944-946, 963) stay shared, since they hold parameters. (d) Value dedupe: on a driver that declares a bind budget (D1 today), equal values bind once and are referenced by number (`?NNN` on SQLite, `$n` on PostgreSQL), constants and actor values alike (Z2: most binds are constants); drivers without a budget keep today's text, so no SQL pin churns. (e) Paths: the actor is a `viborm/validation` object schema; `rbac()` checks every path against its `entries` (object.ts:413), refuses an unknown one (`ClientInitializationError` naming model and path), refuses a schema it cannot walk (not a `v.object`, unknown keys admitted, recursive), and types paths structurally over the schema's finite output, with no depth number.
- **Deletes.** For domain values: `RowsBinding.bound`, `BOUND_LIMIT` and its FIFO (rows.ts:55, 72-74, 506-512), the per-value key (rows.ts:484-515), `boundDomain`/`boundModels` and the domain branch of `boundWhere`/`boundValue` (rows.ts:176-265); the guides' paragraphs on "256 prepared modes and values" (create.mdx:435-446, recipes.mdx:217-225) and the memo's implementation-only pins (v4 §6 "the 257th distinct value evicts the oldest"; extension-controls.core.test.ts, "the lock's version takes room beside the tenant"). Behavioural witnesses (two tenants never share rows or cache entries) stay. Stamps keep their per-call bind (rows.ts:271-303).
- **Cost.** Runtime +220, −90 (estimate; basis: the v4 walker and memo were ~70 lines; parameter operand at the listed sites; dedupe ~40). Per statement: preparation and lowering are already per statement on both paths (Z3); the governed read measured 0.18-0.49 ms against 0.012-0.027 ms for a base read. Because K2 makes the SQL text identical for every actor, a text cache keyed by prepared domain and operation shape becomes possible (**OD-18**, not in scope).
- **Witness.** W-K2a: 10,000 actors, one prepared predicate per name by identity; W-K2b: results equal to the v4 memo path; W-K2c: DC10/DC11 hold under parameters; W-K2d: an absent `session` path under `NOT` → false; W-K2e: tenancy's absent optional control still drops, SQL text unchanged; W-K2f: total and distinct binds and SQL bytes of §1.1's heaviest reads and writes, with and without `$access`, ≤ 100 distinct and ≤ 100 KB under D1's driver (M1 exit); W-K2g: `userId: null` matches no orphaned row.

### 4.3 K3: named predicates, verbs and written fields, per model

- **Today.** One predicate per purpose and mode for every operation (rows.ts:457-481); nested writes share the `related` predicate a relation read uses (relation-body.ts:303-325, 566-573, 589-596, 641-647, 785-795, 946-956). All `rows` models share mode names (definition.ts:328-359), and the modes multiply with every other member's in the eager product (rows.ts:399-412).
- **Change.** A rows member may declare, **per model** (not per mode): `predicates: { [name]: where }`, prepared once per name; `verbs: { read, update, delete }` naming predicates; `writes: { [field]: name }` (R3). Modes keep today's shape and narrow by name (`N(m)`); the domain of a call is `verb(v) ∧ verb(read) ∧ N(m)` (R2, R8). When a model declares any verb, a verb it omits is `false`, never "filters nothing". The engine picks the verb from the operation or the nested verb (nested `update`/`updateMany`/upsert update arm → update; `delete`/`deleteMany` → delete; `connect`/`set`/`disconnect` look the target up at read and judge the row whose key or relation field changes at `writes` for that field, both endpoints of a join); a tombstone's candidates at delete (commands.ts:514-530). R3's conjunction is built per occurrence from the fields the call's data writes, at preparation.
- **Deletes.** Nothing; a plain `where` mode keeps today's path byte for byte.
- **Cost.** Runtime +160 (estimate; basis: the purpose plumbing of v3.1). Mode × model duplication disappears: `rbac` emits one predicate per (model, action) and modes reference names. Types: data types only.
- **Witness.** W-W1..W-W10 (W-W9: an m2m `connect` from the attacker's side refused; W-W10: a root create and the nested equivalent give one answer); W-N4; the row-scope, bound-rows and deletion suites unchanged.

### 4.4 K4: the produced row

- **Today.** Creates take no domain (controls.ts:298-303); nothing checks a row after a write.
- **Change.** Per model: `place: name` (every created row) and `moves: { [field]: name }` (the new row of an update writing that field); every update on a model with `verbs` also checks its new row under the predicates that judged its old one (R4). `rbac` compiles `moves` from R4: written keys' target visibility, `place` for fields `create(M)` reads, acyclicity for recursed self keys. The produced row is judged as a value against the state **before** the operation's writes and before any constraint. Two lowerings, chosen by G1 (**OD-13**): (i) the same statement (`INSERT … SELECT … WHERE <place>`, `UPDATE … WHERE <old> AND <new>`), zero rows meaning refused: T1 literally, but every INSERT site is rewritten (multi-row inserts, ON CONFLICT upsert, `createMany` chunking, commands.ts:1772, `lastInsertId`) and dependent child statements in a batch still need an assertion; (iii) a premise **before** the write in the same batch or transaction, with the written values substituted for the row's columns, through the existing `assertions.exists` that aborts a batch (sqlite-adapter.ts:720-725), so it works on D1 and batch-only drivers. The first draft's option (ii), a check after the write, is struck: it sees the row it judges, so a grant justifies itself, and constraint errors come first, turning FK and unique errors into existence oracles.
- **Deletes.** Nothing.
- **Cost.** Runtime +200 for (iii) (estimate; basis: `Commands.stamp` and its sites, +80 in v4, plus substitution); (i) is larger, unmeasured. SQL: one predicate per produced row.
- **Witness.** W-P1..W-P16.

### 4.5 K5: evidence

- **Today.** No public capability adds a projection and strips it (request.ts:14-51; src/extensions/query.ts:67, 425-458); only the official default omit rewrites a projection (client.ts:626-631 → omit.ts:209-258). Select schemas are shared per `EngineSchema` across chains (commands/index.ts:296-359).
- **Change.** Per model: `evidence: { as: key, names: [...], ordered? }` and `reads: { [field]: name }`. The declared key is a projection member at every depth, on read results and write results (evidence computed at the identity capture, commands.ts:1630-1641). A read-gated field is projected beside its evidence; the parser omits it where false; its operand in every caller-written position lowers as `CASE WHEN <evidence> THEN <column> END`; an explicit selection fails as D5 says.
- **Costs to count (G2, G3).** Select admission must accept a key declared by the chain: per-chain select schemas, or admission of declared keys beside the shared schema (unmeasured). Omitting a field per row makes rows shape-changing, which forces the parser's copy path on governed models (AGENTS.md:197-206). `CASE WHEN` masking re-lowers the evidence per operand (binds; defeats an index on the field). Read-gating key and foreign-key columns is refused at `rbac()`.
- **Cost.** Runtime +200 (estimate; basis: the polymorphic arm CASE and decoder of v3.1 M2, plus write-result capture). Types: one extension-state slot (evidence key and read-gated fields per model); it lands in the select/result recursion, not the `data` slot whose +0.6-1.6% v4 measured: **unmeasured**, F8.
- **Witness.** W-EV1..W-EV4, W-F1..W-F8.

### 4.6 K6: bound views

- **Today.** A client method's scope cannot derive a client and its type is the defining client's (methods.ts:161-169); every view invokes every factory eagerly (methods.ts:494-518, 548-563); transactions build their view from `engine.bind(...)` (client.ts:904-907); a control comes only from arguments (controls.ts:512-563).
- **Change.** (a) The client scope gains `bind(values)`, accepting only **the calling extension's own** controls: it validates once, freezes, and returns a view of the same chain and engine binding whose calls admit the values as if passed (cache key included). Its result type is the receiving client's (`this`), which needs OD-1 option (1) (method result types read the receiving client's state); under option (2), rbac must be the outermost step. (b) A control may be declared `bound: true`: accepted only from a binding. Passing it in arguments is then refused by placement itself, so no separate "bound control passed again" check exists. (c) The bound values are view state: `#createView` threads them into interactive transactions, array-transaction members keep their own view's (pending-operation.ts:453-484), and a client derived by `$extends` from a bound view keeps them. (d) Method factories bind lazily per model on first access, so a view costs what it uses. `$as` is the rbac entry's client method, `(actor) => scope.bind({ actor })`. Rebinding on a bound view is not refused: `call` already runs raw SQL unfiltered, so a refusal would have no unique coverage; the guide says `call` must not be handed to untrusted code. If the owner makes a bound view refuse raw SQL (**OD-16**), rebinding is refused with it.
- **Deletes.** Nothing in core. Soft delete's per-request re-application could later use `bind` (not in scope).
- **Cost.** Runtime +90 (estimate; view state, admission merge, lazy factories). Types: `this`-typed result, **unmeasured** (F5). Per request: one view (F5 measures it with 50 model factories against S-Y3).
- **Witness.** W-AS1..W-AS7.

### 4.7 K7: composition

- **Today.** `rows` after any `client`/`model`/model-mapped `query` consumer is refused (chain.ts:486-491; Y1, Y2); control names are not checked for duplicates (chain.ts:315-344; C10); a definition cannot reference another's control (create.mdx:419-420).
- **Change.** (a) A duplicate control name across a chain is refused at `$extends` (`ClientInitializationError` naming both extensions): its unique coverage is C10's failure of every write. (b) The order guard, **OD-1**: (1) method and handler result types read the extension state of the client they are called on, so the guard's type reason disappears and it narrows to model-mapped query handlers (type cost unmeasured; K6's typing needs it); (2) official entries expose their rows step and methods step, applied rows first; (3) leave it (fails C12). Recommended: (1) if F6 fits §8, else (2). (c) A definition may reference a control declared by an earlier extension of the chain, in predicates and stamps, paths included (`updatedBy: { control: "actor", path: "userId" }`): order owns it, one actor for every extension (**OD-9**).
- **Cost.** (a) +10; (b)(1) unmeasured types, (2) about 20 lines per entry; (c) +30 (estimate).
- **Witness.** W-C1..W-C8.

## 5. Semantics, as consequences

### 5.1 Operation matrix

`P(a)` is R1 for the model and action; every candidate set is also inside `P(view)` and the call's mode (R2, R8); "new row" is R4.

| Operation | Old row (candidates) | New row | A hidden or ineligible target gives |
|---|---|---|---|
| `findMany`, `findFirst`, `findUnique`, `count`, `aggregate`, `groupBy` | `P(view) ∧ N(mode)` | n/a | `[]`, `null`, a count without it |
| `*OrThrow` | same | n/a | `NotFoundError` (commands/index.ts:158-165) |
| `update` | `⋀_{f ∈ W} P(write(f))`; `P(view)` if W is empty | the same predicates; `place` if W meets what `create` reads; written keys' targets visible; no cycle | `NotFoundError` (old); `ForbiddenError` (new) |
| `updateMany` | same, one set | same, per row | count excludes (old); `ForbiddenError` (new, the statement fails whole) |
| `delete`, `deleteMany`, a tombstone | `P(operations.delete)`; a tombstone also the default domain (commands.ts:514-530) | none; database cascades: OD-15 | `NotFoundError` / count |
| `create`, `createMany` | none | `place`; every written key's target visible | `ForbiddenError` |
| `upsert` | update arm as `update`; create arm as `create` | per arm | update arm hidden → create arm → `ForbiddenError`, or `UniqueConstraintError` if the key exists hidden (§5.2) |
| nested `create`/`createMany`/`connectOrCreate` | the parent at `view` (R3) | the child's `place`, its key to the parent included | `NestedWriteError` |
| nested `update`/`updateMany`, upsert update arm | the child at its written fields | as `update` | `NestedWriteError` |
| nested `delete`/`deleteMany` | the child at `delete` | none | `NestedWriteError` / count |
| `connect` (foreign key) | target at read; the key holder at `write(key)` | the key holder as `update` | `NestedWriteError` |
| `connect`, `disconnect`, `set` (join) | targets at read; both endpoints at `write(relation)` | both endpoints as `update` | `NestedWriteError` |
| `disconnect`, `set` (foreign key) | members at read (a member the actor cannot see keeps its link, create.mdx:356-357); changed rows at `write(key)` | as `update` | `NestedWriteError` |
| raw SQL, statement transforms | not judged | not judged | §10 |

### 5.2 Scopes and residual disclosures

- **Quantifiers.** `every`/`none`/negated counts read "every visible member" (the related domain sits outside negation, query.ts:3532-3555): `none: {}` holds for a row whose members are all hidden.
- **Counts and order.** `_count` and relation-count order count visible members; ordering by a to-one field reads a hidden target as absent.
- **Cursors.** A cursor on a hidden row is a missing cursor: an empty page (query.ts:3970-3982).
- **Recursion.** A recursive read walks visible nodes; a hidden node cuts its branch (a document shared under a hidden parent is reached by a root read, not by the walk). Inside a policy (`up("parent")`) the walk reads the other layers at their defaults (R5): a tombstoned folder stops inheritance, a folder the actor cannot view does not.
- **Unlisted models.** False at every verb: a root call is refused before any statement (R9); through a relation it reads `null` / `[]`; inside policies it is read under the other layers only (R5), which is what lets `session` and `teamParent` stay unlisted and still decide.
- **Residual disclosures** (documented, not prevented; each reveals existence, never content): a unique constraint on create or upsert over a hidden key (`UniqueConstraintError`), `createMany({ skipDuplicates })` counts, `connectOrCreate` choosing its arm; a visible foreign key whose include reads `null` shows a hidden row exists; a polymorphic arm reads `null` when hidden and errors when gone (query.ts:5119-5145). The guide says every unique key should include the tenant column.

### 5.3 Errors

| Situation | Class | When |
|---|---|---|
| no actor on the governed client | `ValidationError` at `actor` ("is required") | admission, before any statement |
| `actor` passed in arguments | `ValidationError` (not accepted here: bound only) | admission |
| actor fails its schema at `$as` | `ValidationError` at `actor` | at `$as` |
| a definition error: unknown model, field or actor path; an actor schema `rbac()` cannot walk; `recurse: true` in a domain predicate; a cycle in action references; a read-gated key column; a duplicate control name | `ClientInitializationError` | `rbac(...)(base)` / `$extends` |
| hidden or non-editable root target | `NotFoundError` (unchanged) | after the statement |
| hidden nested target, or nested placement refused | `NestedWriteError` (unchanged class) | in the operation |
| a produced row refused at the root (create, move, written key target hidden or missing, cycle); `assert`; a root call false at definition time (R9) | `ForbiddenError` (new; a `VibORMErrorCode` in errors/base.ts:13 and the error-names smoke) | produced row: in the operation, before the write; `assert`, R9: before any statement |
| explicit `select` of a read-gated field on a row lacking its action | `ValidationError` at `select.<field>` | after the read statement, before the result (OD-5) |
| a cached read on a governed view (OD-10, built: §11.3) | `ValidationError` at `actor` (the uncacheable control) | before any statement |
| upsert creating over a hidden key | `UniqueConstraintError` | provider (§5.2) |

An error never distinguishes "hidden" from "lacking the action" for a row the actor cannot view, nor a hidden written-key target from a missing one.

### 5.4 Cache and transactions

- **Held (verified by the security review).** Two actors cannot share an entry even under a 64-bit hash collision: every hit compares the full stored key (driver.ts:419-421; key.ts:121-133). A read without controls below rbac cannot warm a governed entry: its key is `args` alone, a governed read's is `[args, controls, rows]` (cache-flow.ts:94-105).
- **Refused by default (OD-10).** A cached read is an observation (ELEGANCE 6) and suspends T1: a grant revoked by another process is served until the TTL (src/cache/AGENTS.md:91-94), the call's instant (R7) is not in the key, so an entry computed during a live session is served after it expires, and the full stored key holds the bound actor in plain text. Under "security wins ties", rbac declares its actor control uncacheable and a `$withCache` read on a governed view fails with `ValidationError`, unless `rbac({ cache: "allow" })` is declared; the guide says in bold that it suspends T1.
- **Secrets.** The guide forbids binding bearer secrets (a session token lands in the cache key and in error metadata); bind the session's id.
- **Transactions.** An interactive transaction from `call` keeps the actor (K6(c)); produced-row premises (K4 (iii)) run inside it; an array transaction may mix views, each member under its own actor. Judgements see each statement's snapshot under the provider's isolation; under READ COMMITTED a premise and its write see two snapshots (OD-13; G1 measures the window).

## 6. Milestones

Each unit: implementer, adversarial executing reviewer, repair; budgets locked at the end; one PR (memory: PR hygiene). Spikes run on scratch copies before any engine unit; a spike that falsifies a design stops the milestone and comes back to the owner with numbers.

### 6.1 M1: the floor (K1, K2, K3, K6, K7(a), the entry's filtering, writes and single-action `can`)

Before any unit: the owner decides **OD-17** (bundle limits) and **OD-1**. Spikes:

- **F0, bundle.** Gzip of the F1-F4 prototypes on pg-representative and d1-worker, against Z1's headroom. Falsified if the prototypes exceed what OD-17 allows.
- **F1, layering.** K1(b) with the tagged node and exclusion stack: S-B, S-X1, S-X3, S-X4 with oracle rows; an alias-shadowing case; `deleted: "with"`/`"only"` and `scope: "all"` revive nothing. Falsified if a cycle needs a depth number or any result differs from the oracle.
- **F2, parameters and binds.** K2(b)-(d): one prepared predicate for 10,000 actors; total and distinct binds and SQL bytes of §1.1's heaviest reads and writes, with and without `$access`, under the D1 driver's budget (no live D1 needed); absolute preparation and lowering per statement on the §1.1 reads, against Workers CPU; DC10/DC11. Falsified if a fact site needs the value, or any statement exceeds 100 distinct values or 100 KB after dedupe.
- **F3, admission.** The whole §1.1 policy through the where schemas, with actor-valued enum, boolean, DateTime, json and `in`-array fields; markers restored by identity, not position (admission rewrites shorthand to `equals`, a to-one to `is`). If sentinels fail, cost the fallback (a parameter node in the validation where schemas, a 15.9k-line subsystem) before U1.
- **F4, verbs.** Visible-not-editable update → `NotFoundError`; a nested update and an include of the same relation judged at different verbs; `delete({ as: "edit" })`.
- **F5, `$as`.** No chain rebuild (identity pins); 1,000 interleaved requests under `Promise.all` with actors whose results differ, with includes and `$access`, never mix; cost with 50 model factories, eager and lazy; the `this`-typed result under OD-1 (1).
- **F6, composition.** K7(b) options (1) and (2): type budgets for (1); the §1.1 `server.ts` chain compiling and running for each.
- **F8, types.** The §1.1 policy compiled with predicates opaque in the definition types (the 1.2.0 TS2589 lesson: type-recursive-where-smoke.mjs:1-40; CHANGELOG.md:181-189, 282-301); on the type-budgets.json 50- and 100-model fixtures with `$access` nested two deep and read-gated fields, under TS 5.9, 6 and 7 and `bun check`; the structural path type.
- **F9, nested recursion.** On SQLite3, PG, MySQL and real Neki: a recursive filter and a recursive projection over a self relation whose related domain contains `up()` (`#step` applies the related domain at every hop, query.ts:5428-5440, 5590-5603, and the anchor, 5541-5555, so this nests `WITH RECURSIVE` inside a recursive term), and `up(parent, team-below)`; oracle rows; timed on a 1,000-node tree and a 100-team graph. Plus one line: the keyed snapshot MySQL already takes for a mutation selector reading a relation (`lowerMutationLimit`, query.ts:2041-2066) holds under a recursive domain.

Units: **U0** the fixture copy, seed, oracle and runners (D1 through `vitest.d1.config.ts`, Neki through a credentialed hosted run), and the estate: refusal census (scripts/raptor3-refusal-census.mjs, every new throw), extension-system census, error-names (`ForbiddenError`, a new `VibORMErrorCode`; errors at 100%), exports and public-surface golden smokes, coverage (extensions at 100% with `src/rbac/index.ts`; query-engine-core floors for K1-K5 branches), deletion of the memo pins (estimate: comparable to one engine unit); U1 K1; U2 K2 with dedupe; U3 K3; U4 K6 + K7(a); U5 the entry: `rbac()`, R1 compile, helpers, `$as`, single-action `can`/`assert`, filtering and old-row writes; the docs that become wrong (recipes.mdx:238-240, create.mdx:349-353 and :435-446, AGENTS.md:254-257 and :293-295). **M1 exit:** every M1 witness on its substrates, W-K2f included; §8; the framing grep finds no action, role, grant, actor-field or `$access` name in `src/` outside `src/rbac/`. **M1 is not published as authorization** (**OD-11**): without K4 a create or a foreign-key move is not judged.

### 6.2 M2: produced rows, evidence, field levels, limits, named domains (K4, K5, K7(b)/(c), the rest of the entry)

- **G1, produced rows.** K4 (i) against (iii) on SQLite3 (batch-only and no-RETURNING variants), D1, PGlite, Docker PG and MySQL, over v4 §2.2's create and update sites: autoincrement keys inside a batch, `createMany`, a nested create under a created parent, the self-granting insert (refused), identical errors for a missing and a hidden target, and the window between premise and write under READ COMMITTED (raptor3/AGENTS.md:2236-2244) with a concurrent revocation on Docker PG. Falsified if neither keeps T1 on D1.
- **G2, evidence cost.** `$access` on 1,000 documents two levels deep with `document`'s six actions: SQL bytes, binds, time per row; select admission of a declared key.
- **G3, field reads.** The guarded operand in every position of D5, write results, the parser's copy path on governed models, OD-5's timing.
- **G4, array parameters.** `in: { control: "actor", path: "key.resources.document" }` per dialect (variable length; PostgreSQL `= ANY`).
- **G5, cache.** The uncacheable control against the cache suites; `cache: "allow"`.

Units: U6 K4; U7 K5; U8 K7(b)/(c) as the owner rules; U9 the entry's `create`, `$access`, `fields.read`, `limit`, `domains`, `can` lists through `$access` (the `as: a` form deleted), `grant.administer`; U10 `viborm/rbac` export, guide page (`docs/content/docs/extensions/rbac.mdx`: raw SQL in bold, `call` is not a sandbox, `mode: "hard"`, cascades, residual disclosures, tenant-scoped unique keys, no bearer secrets), consumer smoke, size rows, coverage policy entry (scripts/coverage-policy.mjs:36-58, 105-115). **M2 exit:** §1.1 verbatim from the packed tarball; every witness; §8; independent review of the changed perimeter on frozen source.

## 7. Witness matrix

Substrates: **S3** SQLite3 (with batch-only and no-RETURNING variants, tests/raptor3/post-prep/row-scopes.test.ts), **PGl** PGlite, **PG** Docker PostgreSQL 127.0.0.1:5434, **My** Docker MySQL 3307, **D1** Workers D1 (a new row-scope run), **Nk** real Neki (a new recursion run). Expected rows come from the U0 oracle over the seeded copy, written independently of the engine.

| Witness | What it pins | S3 | PGl | PG | My | D1 | Nk |
|---|---|---|---|---|---|---|---|
| W-R1..R9 | C1: each scope of §5.2 under `P(view)` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ with `PgDriver({ sharedRelationBodies: true })` (R1 was ✗ before E5.2: > 256 relations in one statement) |
| W-K1a..g | C2: written depth, typo refusal, four cycles, alias shadowing, 101-deep tree, other modes revive nothing, unchanged suites | ✓ | ✓ | ✓ | ✓ | ✓ (K1e golden normalized for D1's balanced conjunctions) | ✓ (a-d, f, g) |
| W-K2a..g | C3: one prepared predicate, memo-path equality, DC10/DC11, absent under NOT, tenancy unchanged, D1 binds and bytes, null matches nothing | ✓ | ✓ | ✓ | ✓ | ✓ | |
| W-W1..W12 | C4: field actions, archive-only, grant writes need every attachment administered, counts, stamps take no action, nested verbs, connect/set/disconnect, tombstone at delete, m2m from the attacker's side, root and nested create agree; W11/W12 (E4) a lax to-one `delete: true` on a target the call may not delete is `NestedWriteError` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| W-P1..P16 | C5: root create, `createMany`, upsert arms, nested create/`connectOrCreate`, scalar-key move, connect move, `within` on create, concurrent revocation, rollback; P10 grant arc (create and update forms), P11 move on a model without `create:`, P12 a sharer cannot grant `export`, P13 personal-page transfer per OD-14, P14 parent cycle, P15 self-granting insert, P16 scalar key to a hidden and to a missing target give one error | ✓ | ✓ | ✓ | ✓ | ✓ | |
| W-AS1..AS7 | C6: identity, interleaving with differing results, transaction keeps actor, array tx mixes, `$extends` from a bound view keeps it, `bind` refuses another extension's control, cache key per actor | ✓ | ✓ | | | ✓ (AS3: no callback transaction) | |
| W-CAN1..6 | C7: single, list, hidden row false, `assert` class, organization-level, equals the oracle | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| W-EV1..4 | C8: oracle per row, nested, ordered, one statement | ✓ | ✓ | ✓ | ✓ | ✓ | |
| W-F1..F8 | C9: omitted, present at level, explicit select fails, filter/order/aggregate guarded, nested include, no row dropped, write results, unique and relation positions | ✓ | ✓ | ✓ | ✓ | | |
| W-L1..L8, W-N1..N4 | C10: actions, ids through tree, no-key actor unaffected, array parameters, unlisted model with a key, view-only key cannot create, `["share"]` key views, absent resources deny; `given`, `as: edit`, unknown name, modes never replace a verb | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (L, N1-N3) |
| W-D1..D12 | C11: no actor, unlisted model, undeclared action, absent actor field, `session()` per OD-6, a definition-time false root call refused before any statement (D6), a revoked or expired key reaches nothing (D7), §1.1 and the blog admitted (D8), per-call fold gives the ordinary outcome (D9), unknown path refused (D10), null value (D11), create with no actor refused on every model (D12) | ✓ | ✓ | | | | |
| W-C1..C8 | C12: soft delete + rbac per OD-1, tenancy + rbac, audit + rbac, tombstoned grant, duplicate control refused, cached read refused (C7), audit stamps rbac's actor path (C8) | ✓ | ✓ | ✓ | ✓ | ✓ (C1-C4, C7) | ✓ (C1-C4, C7) |
| W-X1 | C13: `$queryRaw` on the governed client returns every row | ✓ | | | | | |
| W-H1, W-A1..A6 | helpers equal the fixture's hand rules; R1 per action; stored actions; ceiling; request fact; row attribute; stored ceiling | ✓ | ✓ | ✓ | ✓ | | |

The M2 exit's runs of every row are §11.3's.

Types and package, on the packed tarball: §1.1 under TS 5.9.3, 6 and 7 and `bun check`; the budgets of §8; `$as`, `can`, `assert` and the evidence key's result types (tests/types/client/); exports, public-surface golden and error-names smokes; `rbac-consumer-smoke.mjs` beside soft-delete-consumer-smoke.mjs; the extension-system and refusal censuses.

## 8. Budgets

Gates or estimates with their basis; a breach is a design signal, never permission to raise a ceiling (v3.1 §5.2).

| Item | Budget | Basis |
|---|---|---|
| Runtime lines, core (K1-K7) | recorded; estimate +1,060 to +1,160 / −105 | §4 sums (estimates) |
| Base entry gzip, pg-representative and d1-worker | inside Z1's headroom (1,243 B and 1,851 B) unless **OD-17** raises the limits or names offsetting deletions | **M2 exit (wave 5), `pnpm size`:** pg-representative 179,118 B, d1-worker 178,645 B (2fcaa26a8: 170.0 kB limits), pg + migrations 280,460 B, pg + soft delete 179,510 B, every public entry 405,558 B (now exporting `viborm/rbac`); limits raised under OD-17 each wave, reasons in `package.json`. Measured S-Z1. At ~2.3 B gzip per runtime line (v3.1+v4: +5.4 KB for ~2,350 lines) the estimate is ~2.2 KB, about twice the smaller headroom; fitting 1.2 KB means ~530 lines, half the estimate (judgement: not reachable without deletions) |
| New size rows | pg + rbac, the `viborm/rbac` entry, and their `measure-bundle` scenarios | the soft-delete precedent (420 B entry row). **M2 exit:** pg + rbac 184,652 B (+5,534 over pg-representative), the `viborm/rbac` entry bundled alone 13,061 B (`dist/rbac.mjs` 6,562 B by `gzip -9`; the rest is the root's error base); fixtures `pg-rbac.mjs`, `rbac-entry.mjs` |
| Cold `rbac(policy)(base)` on the 50-model schema | time and memory recorded | K1(a) builds where schemas at application. **Measured** (unit T, 89936c45d, Node 24.22, 15 fresh processes; harness `scratchpad/rbac/t/bench/cold.template.ts`, esbuild-bundled, SQL-only SQLite driver; a synthetic 50-model schema: organization, user, membership and 47 content models with an owner, a ternary tree and a self relation every 7th; every model listed: `member` with a ceiling, `owner`, the tree's parent by action, `up()` on the self relations): `rbac(config)` 0.11 ms; `rbac(...)(base)` median 20.1 ms (17.8-36.6), +5.19 MB retained heap (4.97-5.40); the first governed read after it 5.6 ms. **M2 exit** (same harness, the clone at wave 5, 15 processes): `rbac(config)` 0.12 ms; `rbac(...)(base)` 23.2 ms (22.5-30.5), +5.56 MB; first read 5.5 ms |
| Unextended client and a rows client without parameters | allocates nothing new; keeps its exact path | the v3.1 and v4 stability rule. **Measured, breached** (unit T; harness `scratchpad/rbac/t/bench/alloc.template.ts`: Node 24.22 `--expose-gc --max-semi-space-size=256`, `gc()` before each sample so the used-heap delta is the sample's allocation, median of 400; the 50-model schema on a SQL-only SQLite driver; 2fcaa26a8 against 89936c45d, three runs each, identical to the byte but for ±160 B): `createClient` allocates 33,224 → 33,480 B and retains 10,897 → 11,245 B per client; per base call `findUnique` 54,760 → 56,112 B (+2.5%), `findMany` with two includes 106,664 → 108,352 (+1.6%), a relation filter 62,184 → 64,504 (+3.7%); a rows client whose predicates read no control 58,808 → 62,032 (+5.5%), 113,216 → 118,568 (+4.7%), 68,240 → 74,120 (+8.6%). Nearly all of it arrives with 50856ee26 (K1, K2, K6, K7); K3 adds ≤ 200 B. §9.3's last stop rule applied; **closed by E5.1** (M2 exit, three runs each, same harness): per call base `findUnique` 54,352 B, `findMany` + 2 includes 106,616, relation filter 61,824; rows client 58,536 / 112,952 / 67,800: every per-call figure at or below 2fcaa26a8's. `createClient` 33,352 B (+128), retained per client 11,145-11,198 B (+250-300 B, the view state of K6) |
| Type programs (client-1..4, instrumentation, floor) | each ≤ +2% types and instantiations; peak RSS ≤ 1,536 MiB | v4 §4 |
| Recursive-where programs | inside today's ceiling; the fixture is not edited | Z4: 1.2% / 2.3% / 3.5% left |
| §1.1 program and the 50/100-model fixtures with `$access` | recorded; no TS2589; no `where` type walked over a policy | the 1.2.0 history (6.36M → 16.88M → 1.17M instantiations). **M2 exit:** the rbac type smoke (§1.1 applied, `$as` with and without a key, `can`/`assert` with one action and a list, `$access` at two depths, a gated field, a domain, four biting `@ts-expect-error`) 627,189 / 752,765 / 1,114,768 instantiations on TS 5.9.3 / 6.0.3 / 7.0.2, no TS2589, budgets re-recorded by U9 with the reason; recursive-where 1,269,186 / 1,442,750 / 1,817,244 inside its ceilings; floor-scale 50/100 inside `type-budgets.json`; layer type stages peak 1,426 MiB |
| `$as` per request | ≤ 1/4 of one `$extends` of the same chain, measured side by side with 50 model factories | S-Y3 (13.35 µs, one run) |
| Preparation and lowering per statement | recorded against Workers CPU for the §1.1 reads | Z3 (0.18-0.49 ms measured). **Measured** (unit T, 89936c45d; harness `scratchpad/rbac/t/bench/prepare.template.ts`: Node 24.22 (V8, as Workers), §1.1's chain with soft delete on a SQL-only SQLite driver declaring D1's adapter facts, 20 actors' views bound once, median of 7 rounds of 200 calls; beside it the same call on the client below rbac): `page.findMany({ include: { group } })` 153 µs (below: 17); `as: "given"` 121 µs (8); document roots with children 157 µs (22); `organization.can("export")` 35 µs (19); `page.update` of a title 204 µs (27); `accessGrant.updateMany` 716 µs (6). **M2 exit** (same harness): 167 (17), 131 (8), 160 (22), `can` through `$access` 25 (20), 217 (27), 809 (7) µs |
| SQL size, `$access`, produced rows | recorded, not gated | owner ruling: SQL cost is minor next to security |
| D1 per statement | ≤ 100 distinct bound values and ≤ 100 KB of text for every §1.1 read and write, `$access` included | provider facts (Y4). **Measured** (unit T, `tests/providers/workers/d1-rbac-statement-budget.test.ts`, the values bound and the text prepared read off the D1 binding; M1, so without `$access`): over the sampled actors, every governed model at every action as a mode and through `can`, §1.1's `server.ts` lines and the heaviest writes, 651 statements, at most 92 bound values (`page.findMany({ include: { group } })`) and 62.2 KB (the grant `updateMany`). Beyond §1.1, `user.findMany` including all of its relations at once is 120.5 KB, over the limit (local workerd does not enforce the text limit; Cloudflare's D1 would refuse it). **M2 exit** (D1 states repeated relation bodies once, E5.2): 699 statements, at most 83 bound values and 18.9 KB; every relation of every model included at once at most 98 values and 35.0 KB (was 120.5 KB); the grant move 44.6 KB at depth 80 (was 261 KB at depth 180; W-P10's update form now runs on D1 against the oracle). Neki: W-R1 green with `sharedRelationBodies` (the grant read 241 → 41 relations) |

## 9. Ownership, risks, stop rules

### 9.1 Ownership

| Owner | Takes |
|---|---|
| `src/extensions/definition.ts` | domain admission through where schemas (K1a); refusals at application |
| `src/extensions/rows.ts` | markers with paths, `now`, conditions; named predicates, verbs, `writes`, `place`, `moves`, `evidence`, `reads` per model; deletion of the per-value memo |
| `src/extensions/controls.ts` | `bound: true`, uncacheable controls, admission of bound values, references to earlier controls |
| `src/extensions/chain.ts` | duplicate control names; the order guard per OD-1 |
| `src/extensions/methods.ts`, `src/client/client.ts` | `bind(values)`, bound views, lazy factories, transactions and derived clients keep them |
| `raptor3/shared/row-scope.ts` | layered `RowDomain`, defaults for traversals; verbs in `RowPurpose` facts |
| `raptor3/shared/query.ts` | parameter operand, dedupe, layered lowering, evidence, guarded operands |
| `raptor3/commands/commands.ts`, `relation-body.ts`, `selection.ts` | verb choice, per-field old row, produced rows |
| `src/errors/` | `ForbiddenError` |
| `src/rbac/index.ts` (public exports only) | `rbac()`, R1/R4/R10 compilation, helpers, `$as`, `can`, `assert` |
| docs | `extensions/rbac.mdx`; corrections in create.mdx, recipes.mdx, AGENTS.md |

### 9.2 Risks

| # | Risk | Mitigation, witness |
|---|---|---|
| R1 | Types: a policy typed as `where` walks every optional relation (TS2589, 1.2.0); recursive-where headroom is 1.2-3.5% (Z4) | predicates opaque in the definition types; a copied fixture; F8 |
| R2 | D1's 100 values and 100 KB per statement, exceeded by constants (Z2) | K2(d) dedupe; F2, G2; stop if exceeded |
| R3 | Recursion nested inside a recursive term on MySQL and Neki | F9 before U1 |
| R4 | Base bundle headroom already smaller than the estimate (Z1) | OD-17 and F0 before M1 |
| R5 | Unique constraints and the residuals of §5.2 disclose existence | inherent; documented |
| R6 | Preparation and lowering per statement are 10-20× a base read (Z3) | recorded; OD-18 |
| R7 | Composition blocked (Y1, Y2) | K7(b), F6 before M1 units |
| R8 | `$as` cost dominated by method factories | lazy factories in K6(d); F5 |
| R9 | A hand-written write predicate ORs across an attachment arc (R10) | `grant.administer`; guide; W-P10 |
| R10 | A premise and its write see two snapshots under READ COMMITTED | OD-13; G1 |

### 9.3 Stop and revise if

- a branch or a name for a role, a grant, an action, an actor field, `$access` or the rbac extension appears in core (Rule 6);
- a feature needs a second statement of a rule beside `P(M, a)` (T2), including a JavaScript re-evaluation of a predicate;
- a numeric cap is introduced, raised or kept for domain values, depth, recursion or parameters (the shipped ones, rows.ts:74 and definition.ts:290, are deleted; recurrence.ts:99's default never reaches a domain predicate); provider limits (Y4) are facts to meet;
- an actor is stored by a setter on a shared client, or `$as` rebuilds the chain;
- a policy, as predicate data, becomes part of a call-site type;
- an eleventh capability or a second registry is needed;
- the engine reads the actor's facts before the statement (T1), or a per-call mode reaches a policy's traversals (R5), or a produced row is judged against a row its own operation wrote (R4);
- any absence fails open (R6);
- a budget of §8 breaks.

## 10. What this does not do

- **Raw SQL is not filtered.** `$queryRaw`, `$executeRaw` and the unsafe forms run as written on the governed client; the guide says so in bold, next to the first example. **`call` is not a sandbox**: it must not be handed to untrusted code (OD-16).
- **Statement transforms are not filtered.** They are trusted rewrites after the policy is applied, and can remove it.
- **Migrations are unaffected.**
- **Database cascades** (`onDelete` cascade and set-null) run as the schema declares, without judging each child row (OD-15). A set-null on a foreign key a policy reads moves rows without placement (deleting a `pageGroup` nulls `groupId` on its pages, content.ts:30-33); the guide's rule: a key a policy reads is `restrict` or `cascade`.
- **Soft delete's hard mode** is open to every holder of `delete` on the governed client.
- **Authentication**: who the actor is stays the application's; `$as` trusts what it is given after its schema. Accepting an invitation for a user not yet visible is an authentication flow on the base client.
- **Database row-level security**: nothing is installed in the database; a connection used without VibORM sees every row.
- **The residual disclosures of §5.2.**
- **Tenancy's plain-`where` updates** keep today's path: no new-row check (K3 keeps a plain mode byte for byte).
- **The base client**: below `rbac`, every row; it is the operator's tool.

## 11. Decisions for the owner

1. **OD-1** The order guard (K7(b)): types read the receiving client (recommended if within budget; K6's `$as` typing needs it), or entries expose their steps, or no composition.
2. **OD-2** `$access` as a projection key the extension declares (recommended) or the brief's `access: true` argument.
3. **OD-3** Default `operations`: read → `view`, update → `edit`, create → `edit`, delete → `delete` (the last level when the actions are the `levels` chain); undeclared → false.
4. **OD-4** The custom-write `action` argument: removed (recommended), or kept AND-only.
5. **OD-5** Explicit `select` of a read-gated field: `ValidationError` after the read (recommended) or before any statement.
6. **OD-6** `session()`: a live session relation or a live key relation, each guarded by the actor carrying it (recommended), or the fixture's omission of the clause.
7. **OD-7** R9's refusal before any statement only for definition-time false (recommended), class `ForbiddenError` (recommended) or `ValidationError`.
8. **OD-8** Operator escape: the base client only (recommended) or a bound-only `scope`.
9. **OD-9** Audit with rbac: references to an earlier extension's control (recommended), or separate names bound twice.
10. **OD-10** Caching on a governed view: refused unless `rbac({ cache: "allow" })` (recommended), or allowed with the staleness documented.
11. **OD-11** Publish after M2 only (recommended), or M1 behind "reads and old-row writes only".
12. **OD-12** The spelling of K2's condition node and `{ now: true }` (decided in F2, reported for approval).
13. **OD-13** T1 literally (K4 (i), one statement) or the same atomic operation (K4 (iii), a premise before the write in the same batch or transaction; recommended on cost, with G1's READ COMMITTED window reported).
14. **OD-14** An update's new row under the predicates that judged its old row, plus `place` when it touches what `create` reads (recommended: a personal page cannot be transferred, PostgreSQL's WITH CHECK default), or `place` on every update (refuses an owner's title edit of a page in a group they cannot edit), or the new row judged only on the arms whose keys were written (allows transfers; reopens W-P11 for models without `create:` unless they declare one).
15. **OD-15** Database cascades: a documented boundary with the guide's rule (recommended: a premise per cascade would refuse every delete reaching an unlisted owned child, `session` or `pageVersion`, against the schema's declared ownership), or a premise refusing a cascade that reaches rows outside `P(child, delete)`.
16. **OD-16** A bound view refuses raw SQL by default, and then refuses rebinding (not recommended for M1: it changes `call`'s surface; a capability boundary the owner may want later).
17. **OD-17** Base bundle limits before M1: raise pg-representative and d1-worker, or fit K1-K7 into the measured headroom, or name offsetting deletions.
18. **OD-18** An SQL-text cache keyed by prepared domain and operation shape (possible only after K2; not in scope).


### 11.1 Rulings (Arnaud, 2026-10-15)

- **OD-13:** one statement (K4 (i)). The new row of a create or a move is judged inside the statement that writes it; no premise read, no READ COMMITTED window. Security over SQL cost.
- **OD-17:** raise the bundle limits by the measured growth, each with its reason recorded in `package.json`, as 1.2.0 did.
- **OD-2 and OD-4:** accepted as recommended: `$access` is a projection key the entry declares; the custom-write `action` argument is removed.
- **Scope:** M1 and M2 land in one PR. Publishing stays the owner's.
- Every other OD takes its recommended option unless implementation falsifies it, in which case the plan is amended here.


### 11.2 Spike outcomes (2026-10-15; measurements in the program's scratchpad, `rbac/F*.md`)

Every truth stands. Five designs hold as written; four are amended here, and the units build on the amended text.

- **F1 (K1(b)) holds.** 72/72 oracle cases on SQLite3, PGlite, Docker PostgreSQL and MySQL; no cycle needed a depth number. Today's reading widens a traversal under `deleted: "with"` and `scope: "all"` (C13, measured); R5 closes it. Only the four lowering-time read sites take the stack; every predicate walker learns the layer node (MySQL's keyed snapshot reads it); the defaults link is memoized per `RowDomain` and `bindRows` must keep producing a domain with its defaults. Answers: traversals under `scope: "all"` stay in the call's tenant (R5); the same extension applied twice is two layers reading each other at their defaults; R5 is fixed.
- **F2 (K2) holds.** ≤ 34 distinct binds and ≤ 60.6 KB per §1.1 statement after dedupe. Amendments: dedupe (K2(d)) applies to every statement over the driver's budget, since a plain `include` read already binds 125-131 values and D1 refuses it today; K4 folds the values a write sets into its predicate (an unfolded grant create reaches 71.5 KB); `userId: null` lowers to `WHERE 0` (R6, measured against the memo's `IS NULL`). Measured gzip +2.0 KB, against the estimate of +0.3 KB: **OD-17** applies.
- **F3 (K1(a)) amended.** Sentinels are falsified: `in`/`notIn` on enum, uuid and int, `has` on arrays, `contains`, json and decimal positions keep no sentinel. The fallback, a parameter node inside the validation where schemas, admits 63/63 predicates at +434 B gzip (sentinels: 60/63 at +1,303 B). The validator's `MAX_FILTER_DEPTH = 16` (filter-depth.ts:7) refuses three §1.1 predicates (depth 19-20); it is lifted for domain predicates only, whose termination K1(b) proves exactly; a caller's `where` keeps the cap. A misspelt nested key fails at `$extends` with `ClientInitializationError` naming model, name and path (the meta allowlist keeps `model`; name and path travel in the message). Cold admission of the whole policy: 15.2 ms, +2.27 MB.
- **F4 (K3) amended: R3's "an occurrence writing nothing of its own is judged at `view`" is falsified.** The engine emits an UPDATE on that row anyway (`updatedAt`, every stamp), so a viewer could forge a row's audit trail. **R3 now reads:** an occurrence is judged by the statement it emits. If it emits an UPDATE on the row, it is judged at `⋀_{f ∈ W} P(M, write(f))` over the caller-written fields, or at `P(M, operations.update)` when the caller wrote none (stamps and schema values never lower the action below the update verb, and never raise an archive-only write to `edit`); if it emits no statement (pure addressing), at `view`. A root create and a nested create under a parent are not one effect: the nested form writes the parent, and is judged as such. `set []` refuses a link the actor cannot write (NestedWriteError), as `disconnect` does. Everything else in K3 held, 20/20.
- **F5 (K6) holds with amendments.** Lazy per-model factories are required (eager `$as`: 57.7 µs, over the budget; lazy: 2.1-6.3 µs). The `this`-typed result is a polymorphic `this` parameter, no core type change. Identity, 1,000 interleaved actors, transactions, array transactions and `$extends` from a bound view all held.
- **F6 (K7) amended.** K7(a) and K7(c) hold. **OD-1 option (1) is falsified**: with the guard lifted, a model method whose result type is inferred keeps its defining client's type and reports a hidden relation as present. Option (2) is adopted: the guard stays; official entries expose their rows step and methods step, applied rows first; no core type change. The soft-delete entry row rises from 420 B to 450 B (**OD-17**).
- **F8 (types) holds for opaque policies; K5's typing is amended.** No TS2589 on TS 5.9.3, 6.0.3, 7.0.2 or bun; a policy costs ~740 instantiations per model and no `where` type is walked. The evidence slot "in the select/result recursion" is falsified (3.8× the pinned fixture). K5's types are projected operation signatures computed by core at `$extends` from the declared projection key, as extra overloads per model; read-gated fields are carried as a boolean default omit, so the existing omit machinery makes them optional by default and present when selected, at every depth; actor paths are typed with a visited set, no depth number. Unmeasured: chains with data stamps, `$withCache` and `$transaction` clients (U7). The §1.1 text uses `v.optional(v.string())`, the validation spelling.
- **F9 holds.** 348/348 on SQLite3, PGlite, Docker PG (JIT on and off), MySQL 8.4 and real Neki 18.6; two-term recursive CTEs only; MySQL's keyed snapshot holds under a recursive domain.
- **U0.** Fixture, seed, oracle, runners and `ForbiddenError` are in; the oracle and the hand-written policy agree row for row on four substrates. D1 refuses 18 of 222 sampled pairs today for the 100-bind limit, the evidence behind K2(d).

### 11.3 M2 exit (wave 5 integration, 2026-10-15)

Two amendments, both inside the ten capabilities and naming no rbac framing in core:

- **OD-10 is built as a control fact.** A control may be declared `uncacheable: true`; a read holding a value of one is refused by the cached-read wrapper with `ValidationError` at the control, before any statement, whether the cache would serve it or a transaction or statement transform bypasses it (`uncacheableRead`, `src/extensions/controls.ts`; `#wrapOfficialCachedRead`, `src/client/client.ts`). `rbac` declares its actor uncacheable unless `rbac({ cache: "allow" })`. Witnesses: W-C7 (entry runner, five substrates and Neki) and the capability's core test, both red with the throw removed.
- **G6 holds as a driver fact (E5.2).** `sharesRelationBodies`: a statement states each relation body it repeats once, as a key set its repeats test. D1 declares it; `PgDriver({ sharedRelationBodies: true })` declares it for a server that bounds the relations of a statement (Neki). Off elsewhere, so PostgreSQL's and SQLite's SQL is byte-identical. It closes the two §9.3 provider breaches of wave 4: the D1 grant move (261 KB, depth 180 → 44.6 KB, depth 80) and Neki's W-R1 (241 → 41 relations).

**Verdict: not met**, on four items; every §7 witness and every §8 row is otherwise met on its substrates:

1. **Independent review of the changed perimeter on frozen source** (§6.2) has not run: a process item for the owner.
2. **K5 inside a polymorphic arm** (defect, fails closed): `include: { subject: { page: { include: { $access: true } } } }` is refused with `ValidationError`, and an explicit `select` of a read-gated field inside an arm omits it where the action is lacking instead of refusing (C9). A gated field there is omitted exactly where the oracle says (W-F5 in an arm, green). Pinned as they stand in `rbac-entry-behavior.ts`.
3. **§5.3 "actor fails its schema at `$as`"** (definition gap, fails closed): `v.object` is partial by default, so `$as` admits an actor missing a declared key; R6 makes every rule reading it false and the types refuse the call. Either `rbac()` requires `{ partial: false }` (the §1.1 spelling would change) or §5.3 reads "a value of the wrong type".
4. **OD-5 on D1** (harness gap): whether a batch-only driver commits a write before an explicit `select` of a gated field is refused is unmeasured; §7 runs W-F on S3, PGl, PG and My only.

### 11.4 Independent review and its fixes (2026-10-16)

The independent review of §6.2 ran on frozen source (2999badd6) with five lenses; three ran (security, first principles, docs and public API) before the agent budget ran out, and the engine-SQL and cost lenses did not. Its findings, the two-skeptic verdicts and the dispositions are in `rbac-extension-review-2026-10-16.md`. Amendments:

- **R1 is not monotone, and nothing infers that it is.** An arm, `within` or `limit` may read the action, so on a leveled model `P(full)` can hold where `P(edit)` does not. `$access` keeps reading the highest level held; `can`/`assert` ask each level by itself (one statement per asked level on a leveled model, one otherwise), never from the highest (W-CAN8). Closing P under the levels (`P(a) = ⋁_{b ⊒ a} term(b)`) is left to the owner: it would make `$access` exact for every policy at a cost in statement size.
- **D8: `can`/`assert` run over `findUnique`**, as written: a filter, an empty `where` or an undefined key is a `ValidationError` before any statement (W-CAN7).
- **The implication prover is a declared mechanism (D13).** A placement and a move drop a conjunct that another one, or a judgement the same statement makes, provably implies by structure: `in`/`hasSome` subsets, quantifier and `OR`/`AND` monotonicity, a contrapositive `NOT`, a relation's body at its target. It is what keeps the heaviest grant writes inside D1's limits (deleting it put W-W3 and W-P10's update form back over them, measured on D1). Sound, never complete: an unproved implication keeps the conjunct. Two defects fixed: values compare structurally (`Object.is` on numbers, so NaN and ±Infinity are no `null`; bigints; dates by instant), where `JSON.stringify` crashed on a bigint and merged NaN into `null`; and the R6 safeguard drops a conjunct only where the clause that implies it holds it verbatim or reads each of its actor values outside every `$if` arm, which the engine may fold away with the values inside it. Witnesses: the two skeptics' cases, in `compile.core.test.ts`.
- **A value is never walked as a clause.** The compiler took any object for a clause, so `{ createdAt: { gt: date } }` lowered to `{ gt: {} }`; a `Date`, a `Decimal` or bytes now reaches the predicate as the value it is (found while covering the structural equality).
- **Definitions that would judge less than they say are refused when applied:** an unknown key of the policy, of a model that lists its `actions` and of a `fields` entry; a key spelled like a declaration key or a level (an action of that name would join `view`'s rule, R2); a `keyLimit` model the schema lacks; a declared ceiling at a level the model does not declare (the top level still allows every action, A1); a read-gated unique field (a write's unique constraint would confirm the gated value, §5.2).
- **One implication rule for stored action data:** a stored ceiling row allows its action and every action that action implies, as grants and key scopes do (A1 amended).
- **A tombstone marker written by hand is a delete:** an update writing a field a model's tombstone manages, and soft delete's `restore`, are judged at `delete` too (W-C9; W-C1 now expects `full` for a restore of a page).
- **§1.1 as shipped** composes `policy.methods(tombstones.methods(policy.rows(tombstones.rows(base)).$extends(audit)))` (§11.2 F6, OD-1 option 2), the stored-role variant lists its `roles`, and the optional actor keys are spelled `.optional()` on `v.object`; the guide and the consumer smoke carry that spelling.
- **Cost for every application, stated:** the core capabilities cost about 10 kB gzip on an application bundle whether or not it imports `viborm/rbac` (pg 168.6 → 178.9 kB, D1 168.0 → 178.4 kB from 1.2.4); the guide no longer says it costs nothing.

## Appendix A. Review dispositions

S: security lens; P: first-principles lens; V: feasibility lens (V, not F, so as not to collide with the spikes F0-F9). "Accepted" means the plan changed where named; "refuted" gives the evidence; "partly" says which part.

| Finding | Disposition | Where |
|---|---|---|
| S1 other extensions' modes inside traversals | accepted: traversals read other layers at their defaults | T5, R5, K1(b), W-K1g, F1 |
| S2 many-to-many links unjudged | accepted: a join writes the relation field on both endpoints; the "not judged" row deleted | R3, K3, §5.1, W-W9, §1.1 (`team.edit`) |
| S3 grant arc admitted on one arm | partly: accepted that every attachment must be judged on the old and new row as a conjunction, emitted by `grant.administer`, with W-P10 for both forms; refuted that the engine requires "N's top action, or a declared administering action": "top" does not exist in a partial order (`document`, `team`); a declared administering action restates the attaching model's own write predicates (T2: two authorities); and it cannot express an edge administered from its other end (`member.userId` changes a user's visibility, but the organization's `invite` administers it) | R10, R4, §1.1 `accessGrant`, W-P10 |
| S4 option (ii) self-justifies | accepted: (ii) struck; the produced row is judged against the state before the write and before constraints | R4, K4, G1, W-P15, W-P16 |
| S5 grant carries actions its writer lacks | accepted | R10 (bound clause), §1.1, W-P12 |
| S6 modes reach writes; verb maps may leave a verb unfiltered | accepted: `domain = verb ∧ P(view) ∧ N(m)`; an omitted verb is false | R8, K3, W-N4 |
| S7 new row checked only when placement reads a written field | accepted: every update's new row under the predicates that judged its old row | R4, OD-14, W-P11, §1.1 `member` |
| S8a models missing from limits not narrowed | accepted: absent scope path is false | D10, W-L5 |
| S8b placement not narrowed by limits | accepted: `create` is an action | R4 (`place`), D3, W-L6 |
| S8c `["edit"]` without `"view"` | accepted: scopes close downward | D10, W-L7 |
| S8d absent resources mean all | accepted: `"all"` is written; absence denies | §1.1 Actor, D10, W-L8 |
| S9 field reads and evidence on write results and unique selectors | accepted | D5, K5, W-F7, W-F8 |
| S10 scalar foreign key skips visibility | accepted: written keys' targets visible, one error for hidden and missing; residual oracles listed; tenant-scoped unique keys in the guide | R4, §5.2, §5.3, W-P16 |
| S11 R4 contradicts the acceptance test | accepted: the implicit top-action rule deleted; the move rule stated | D4, D7, §1.1 comments |
| S12 null actor value matches IS NULL | accepted | R6, K2(b), W-K2g, W-D11 |
| S13 actor bound-only and required everywhere | accepted: every model named, `bound: true`, required on creates; blog fixed | R9, K6(b), §1.1, W-D12 |
| S14 wrong paths fail open in conditions | accepted: paths checked against `entries` at `rbac()` | R6, K2(e), W-D10 |
| S15 cache staleness, expiry, secrets | accepted: refused by default; no bearer secrets; the two verified properties recorded | §5.4, OD-10, W-C7 |
| S16 cascades unjudged | partly: stated in §5.1 and §10 and made OD-15; a premise check is not recommended (it would refuse every delete reaching an unlisted owned child) | §5.1, §10, OD-15 |
| S17 parent cycles | accepted | R4, W-P14 |
| S18a `bind` open to every extension | accepted: own controls only | K6(a), W-AS6 |
| S18b `$extends` on a bound view | accepted: keeps the binding | K6(c), W-AS5 |
| S18c `call` is not a sandbox | accepted | §10, K6 |
| S18d raw SQL refused on bound views | accepted as an option | OD-16 |
| S18 (implied) refusal to rebind | refuted: no unique coverage while `call` runs raw SQL unfiltered (memory rule: no guard without named coverage); tied to OD-16 | K6 |
| S19 key liveness unchecked | accepted: the key arm is a relation | D10, OD-6, §1.1, W-D5, W-D7 |
| S20a soft delete's hard mode | accepted | D12, §10 |
| S20b written fields after transforms and stamps | partly: after request transforms, accepted; stamps refuted per P6 (their values are declared; counting them makes an archive-only write impossible on any model with `updatedAt`); the new row (R4) judges what stamps write | R3 |
| S20c existence residuals | accepted | §5.2 |
| S20d memos keyed by `PreparedDomain`; W-AS2 | accepted | K2(c), F5, W-AS2 |
| P1 R4 rejects §1.1 and the blog, duplicates `fields.write` | accepted; the sub-point "an undeclared delete is refused at `rbac()`" refuted: R9 makes it false, a legal policy (nobody deletes members), and a refusal would force `delete: false` boilerplate | D4, D3, OD-3, W-D8 |
| P2 limits break R2, skip creation | accepted (with S8) | D10, R2, W-L6, W-L7 |
| P3 `as` reaches writes | accepted: full verbs per model, modes conjoined | R8, K3, W-N4 |
| P4 acceptance test incomplete; escalation; T1 violations | accepted: bound grants, `teamMember`/`member` creates, `plan` a row fact with a request fact for ABAC, archive write, the composed chain live, a key actor, a nested out-of-domain `connect`, `$queryRaw`, the stored-role variant, all commented and gated | §1.1, D9, W-P12 |
| P5 the truth set reduces the wrong truth | accepted: T5 kept, T4 derived (R6, R9), T1/T3 overlap removed | §3.1 |
| P6 stamps as written fields | accepted | R3, D4, W-W5′ |
| P7 nested parent judged at update | accepted: at `view` | R3, §5.1, W-W10 |
| P8 placement outside R1 | accepted: `operations.create`, `place = within ∧ limit ∧ create`; the update post-image is OD-14 | R4, D3, OD-14, W-P13 |
| P9 caching without invalidation | accepted (with S15) | §5.4, OD-10, W-C7 |
| P10 `recurse: true` becomes depth 100 | accepted | D1, K1(a), W-K1a, W-K1f |
| P11 templates, arm names, `without`, `limits` | partly: helpers and arms become functions of the action, `domains` a plain `where`, `without` and arm names deleted, `roles` an argument of `member()`; folding limits into each model's `within` refuted: a model without it would be unnarrowed for a key (S8a), so `limit` stays one top-level function of (model, action), with `keyLimit` as the helper | R1, D2, D10, D11, §3.4 |
| P12 P copied under many keys; core names `$access` | accepted: named predicates per model; the evidence key declared | K3, K5, D6 |
| P13 `on: "bound"` without a consumer; overlapping guards | accepted: the actor is bound-only (consumer T3); the re-pass and rebind refusals dropped | K6, §5.3 |
| P14 error depends on where the predicate turned false | accepted | R9, OD-7, W-D9 |
| P15 misspelt path denies silently | accepted (with S14) | K2(e), W-D10 |
| P16 two absence rules | accepted: one rule by `required`, with the fold order | R6 |
| P17 separate names for the caller | accepted: references, stamps with paths | K7(c), OD-9, W-C8, §1.1 `server.ts` |
| P18 two `can` implementations | accepted: `$access` only from M2 | D8, W-CAN6 |
| P19a T1 weakened silently | accepted | T1, OD-13 |
| P19b `unlisted` dead | accepted | D0, §3.4 |
| P19c global mode names | accepted: a definition-time false, refused before any statement | D11, R9 |
| P19d blog forged authorship | accepted | §1.1 |
| V1 base bundle budget breaks the limits | accepted | §2 Z1, §8, OD-17, F0 |
| V2 D1 binds exceeded by constants | accepted | §2 Z2, K2(d), F2, W-K2f in M1 exit |
| V3 layering gives wrong rows, loses identity | accepted | K1(b), F1 |
| V4 F7 tests a solved case; nesting untested | accepted: F9 replaces F7, one-line F7 kept | §6.1 |
| V5 `$as` typing and cost | accepted | K6, OD-1, F5 |
| V6 sentinels for enum and boolean | accepted | K1(a), F3, §8 cold row |
| V7 preparation sites understated; F2 compares nothing | accepted | K2(b), §2 Z3, F2, OD-18 |
| V8 R1 expansion multiplies SQL | partly: accepted that disjunctions merge under one quantifier (helpers do it, R1); refuted that ceilings need one term per level: evaluated at the action, a ceiling admits a role iff its set contains the action, independent of the grant's level | R1, G2 |
| V9 type headroom, fixture edits, path type | accepted | §1.1 (copy), §2 Z4, F8, K2(e) |
| V10 (ii) needs no transaction; (i) is expensive | partly: the assertion mechanism adopted, as a premise before the write (S4 forbids a check after it), recommended as (iii) | K4, G1, OD-13 |
| V11 evidence plumbing uncounted | accepted | K5, G2, G3 |
| V12 fixture type-only; estate missing | accepted | §1.1, U0 |
| V13 mode names shared; required on named models only | accepted: verbs, writes, place, evidence per model; every model named | K3, R9 |
| V14 §1.1 comments contradict R4 | accepted (with S11) | §1.1 |

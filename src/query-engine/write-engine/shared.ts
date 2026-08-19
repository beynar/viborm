import { TransactionError } from "@errors";
import { getModelKeyCatalog, type Model } from "@schema/model";
import { isSql } from "@sql";
import { isRecord as isRecordValue } from "@validation/value-guards";

export { isRecord } from "@validation/value-guards";

import type { RecordMutationData } from "../builders/relation-mutation-parser";
import {
  getWhereUniqueEntries,
  partitionWhereUnique,
} from "../builders/where-unique-builder";
import {
  createChildScope,
  getPolymorphicRelationInfo,
  getRelationInfo,
  getTableName,
} from "../context/query-scope";
import type { QueryEngine } from "../query-engine";
import { getForeignKeyTargetFields } from "../TargetConstraint";
import type { QueryScope } from "../types";
import type { RelationMembershipBinding } from "./relation-membership";
import type { StepScope } from "./StepScope";

/**
 * Options used when a create operation contributes an arm or a nested fresh
 * subtree to a caller-owned operation.
 */
export interface SubOperationOptions {
  /** Share the enclosing operation's id allocator instead of minting a fresh one. */
  readonly scope?: StepScope;
  /** Skip the constructor own-write preflight; the caller runs it per-arm (deferred). */
  readonly skipOwnWrite?: boolean;
  /**
   * An enclosing probe-first upsert's missing-row race fact. Supplying it before
   * compilation lets the create compiler attach it to the root INSERT and decide
   * whether a multi-write fold can preserve exact failure attribution.
   */
  readonly rootRacePin?: import("./create-race-pin").CreateRacePin;
  /**
   * X1b — a nested fresh `create` at DEPTH: this `CreateOperation` is not a standalone
   * operation but a create SUBTREE spliced under a located target's write (a nested
   * `create` arm one or more levels deep). It carries the ALREADY-VALIDATED create data
   * (`data` — the enclosing operation's whole-args parse validated the whole tree, so this
   * subtree does NOT re-parse; re-parsing a schema's transformed output is non-idempotent,
   * X2). It emits NO terminal read (the enclosing operation owns the result), and it folds
   * one source-bound incoming membership into its ROOT record's INSERT. Every
   * mechanism the create ROOT already
   * supports — a database-generated / compound PK (backward `Ref` / per-field identity),
   * a parent-held-FK to-one grandchild (before-parent create), the fresh-parent adopt
   * family and M2M — falls out unchanged, one architecture, at any depth.
   */
  readonly nestedFresh?: {
    readonly data: RecordMutationData;
    readonly incomingMembership?: RelationMembershipBinding;
    readonly relationName: string;
    /**
     * A nested createMany series member may absorb a conflict on this record's
     * root INSERT. Descendant conflicts remain ordinary failures, and the series
     * savepoint removes the complete skipped subtree.
     */
    readonly skipDuplicates?: boolean;
    /**
     * The raceable missing-premise pin of an enclosing adopt arm. A nested
     * `upsert`/`connectOrCreate` whose probe found nothing takes its CREATE arm, and
     * that arm's missing premise is enforced by the fresh row's own unique constraint
     * (the Pin Rule, `whenMissing: "constraint"`): a concurrent writer that created
     * the row between the probe and the write makes this INSERT violate the pinned
     * unique, which is the raceable signal `race-retry.ts` matches. When the arm's
     * payload carries relations the whole arm is this create SUBTREE, so the pin has
     * to ride the subtree's ROOT record INSERT — the one statement that used to be
     * the arm's own leaf. Absent for every other `nestedFresh` caller (a nested
     * `create` is unconditional: its violation is a genuine error, never a race).
     */
    readonly rootRacePin?: import("./create-race-pin").CreateRacePin;
  };
  /**
   * PACKAGE J3 — an INDEPENDENT ROOT create whose data a caller has already
   * validated: one row of a relation-bearing root `createMany`, handed to
   * `CreateOperation` as a series member (`CreateManyRecordSeries`).
   *
   * It is a discriminated CONSTRUCTOR INPUT, not a second create compiler: the only
   * thing it replaces is the whole-args parse, because the `createMany` args schema
   * already validated this row (each row is parsed exactly once, plan §5.1) and
   * re-parsing a schema's transformed output is non-idempotent (X2). Everything
   * downstream — the tree walk, the own-write preflight, the terminal read, the
   * result parse — is the public route's, unchanged.
   *
   * It is deliberately NOT {@link nestedFresh}, which is the other already-validated
   * input route and answers a different question. A nested fresh subtree is spliced
   * under an enclosing record: it suppresses its terminal read (the enclosing
   * operation owns the result) and defers its own-write preflight to the enclosing
   * whole-tree walk. A series member is nobody's subtree — it must produce a result
   * for its caller and it must run its OWN preflight, because there is no enclosing
   * tree that ran one.
   *
   * `select` is the projection the member answers with. The series asks for the
   * complete final root row key and nothing else (plan §6 J3 step 4); the public
   * returning projection is read later, by {@link file://./CreateManyRecordSeries.ts},
   * after every member's effects have landed.
   */
  readonly parsedRoot?: {
    readonly data: RecordMutationData;
    readonly select: Record<string, unknown>;
    /** Root-series contract: a root conflict suppresses this complete record tree. */
    readonly skipDuplicates?: boolean;
  };
  /**
   * PACKAGE K5 — an INDEPENDENT ROOT update of ONE CAPTURED ROW: one member of a
   * relation-bearing root `updateMany` (`UpdateManyRecordSeries`).
   *
   * It is the update family's sibling of {@link parsedRoot}, and it differs in the
   * one way the two families differ: a create names its own row by writing it, while
   * an update must be TOLD which row it is about. So this carries a `where` — the
   * complete captured row key, already a `whereUnique` — and the member addresses
   * exactly that row. Nothing about the located row, its projection, its transitions
   * or its descendants changes: those are `RecordUpdateCompiler`'s, reached through
   * the ordinary constructor path.
   *
   * `data` IS RAW, DELIBERATELY, AND EACH MEMBER PARSES IT ITSELF. Plan §6 K5 said
   * "parsed data is shared immutable ParsedRecordPrograms"; that was measured wrong
   * and this is the amendment. Client-side scalar defaults are THUNKS evaluated at
   * parse time (`defaultUlid` / `defaultCuid` / `@now`, applied by the object
   * primitive on every absent key), so a nested `create` parsed ONCE and shared
   * across N members would give N children the SAME primary key — a unique violation
   * on member 1 that rolls the whole series back, for the ordinary payload
   * `updateMany({ data: { posts: { create: { title } } } })` on any model whose id is
   * generated client-side. Re-materializing the defaults per member would be a second
   * owner of default application; refusing nested `create` under N>1 is a refusal
   * §5.2 does not authorize. Parsing the RAW data per member is the only shape that
   * keeps identities distinct, and it is not a new cost: the public `update` route
   * already parses its relation payloads from raw a second time (the whole-args parse
   * at the top of this constructor is not what drives the write).
   *
   * What is NOT re-done per member is the ENVELOPE: `where`, `select`, `limit` and
   * the portable-primary-key check belong to the bulk call, ran once, under the
   * public operation name `updateMany`.
   *
   * `select` is the projection the member answers with — its complete FINAL root row
   * key, after any transition, and nothing else. The public returning projection is
   * read later, by `UpdateManyRecordSeries`, once every member's effects have landed.
   */
  readonly capturedRoot?: {
    readonly data: Record<string, unknown>;
    readonly where: Record<string, unknown>;
    readonly select: Record<string, unknown>;
  };
}

export function pinnedTargetValues(
  targetScope: QueryScope,
  where: Record<string, unknown>
): Readonly<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const { fieldName, value } of getWhereUniqueEntries(
    targetScope,
    where
  )) {
    if (!Object.hasOwn(values, fieldName)) values[fieldName] = value;
  }
  return values;
}

/**
 * Does this `select` project a RELATION rather than scalars alone?
 *
 * Two keys spell one projection and both are it: a relation key, and `_count` — a
 * relation-derived projection built by the same correlated-subquery machinery, and
 * NOT a member of `relationSet`.
 *
 * One home (X2), because four fold gates ask it and must answer alike:
 * `CreateOperation.foldStep`, `UpdateOperation.directWrite`,
 * `UpsertOperation.canFoldUpdateArm` and `DeleteOperation.foldStep`. Each folds its
 * operation into ONE `… RETURNING <select>` statement, and **a relation subquery in
 * a RETURNING list has no table alias to correlate against**: its outer column
 * reference is emitted bare and binds by NAME, so the inner table captures it
 * whenever both tables carry a column of that name. This is the identical defect
 * `restrictToScalarProjection` (`validation/model/args/bulk-write-projection.ts`)
 * refuses outright on bulk writes.
 *
 * Measured on PGlite (PG 17) and better-sqlite3 3.51, an `author` with three `post`
 * children and a `post` table that has its own `id`, `findUnique` as the control:
 *
 *   findUnique({ select: { id, _count: { select: { posts } } } })   -> { posts: 3 }
 *   delete    (same select, folded)                                 -> { posts: 0 }
 *   update    (same select, folded)                                 -> { posts: 0 }
 *   create    (pure scalar, folded, one child row whose own id equals
 *              its FK)                                              -> { posts: 1 }, truth 0
 *
 * The correlation degrades to `post.id = post.authorId`, so the answer is not even
 * reliably empty — it counts whatever the captured name happens to make true, which
 * is why a child table without an `id` column would have looked correct. Answer "yes,
 * a relation" here and the gate declines the fold; the unfolded path reads the
 * projection through an aliased SELECT, which correlates and answers the truth.
 *
 * WHY THIS IS NOT DERIVED FROM A COMPILED SELECTION FACT (a prototype that did
 * exactly that was built whole and rejected on measurement — the falsifier is in
 * `docs/architecture/guard-ownership-ledger.md`): the four
 * gates ask BEFORE any SQL exists, in their operation constructors, and the
 * selection traversal that could compile such a fact spends
 * `QueryScope.nextAlias()` per relation. Asking it here would either renumber
 * every alias in the statement this gate has not built yet, or pay a second
 * speculative traversal per parse — the measured e2e cost that rejected the
 * prototype. A pure predicate over `(model, select)` is the cheaper truth, and
 * it is a different question anyway: "may this projection ride a RETURNING
 * list", not "what will the rows contain".
 */
export function selectProjectsRelation(
  model: Model<any>,
  select: Readonly<Record<string, unknown>> | undefined
): boolean {
  if (!select) return false;
  return Object.keys(select).some(
    (key) =>
      key === "_count" ||
      model["~"].relationSet.has(key) ||
      model["~"].polymorphicRelationSet.has(key)
  );
}

/**
 * THE whole-projection question, in one place: does this result shape name NO
 * relation at all?
 *
 * A projection names a relation through EITHER half — a relation (or `_count`)
 * key inside `select`, or an `include` at all — and the two halves are not
 * interchangeable. Every caller that needs "scalars only" needs both, so the
 * conjunction lives here rather than being re-spelled at each site: the four
 * mutation operations were each writing `!selectProjectsRelation(…) &&
 * !parsedInclude` in their fold gates, and `DeleteOperation`'s terminal read
 * asked the SAME question with the `!parsedInclude` half alone. That half is a
 * proxy, not the invariant: a relation nested in `select` slipped past it and the
 * read emitted a LATERAL join under `FOR UPDATE`, which PostgreSQL rejects with
 * 0A000 — the delete crashed. One spelling, so a caller cannot hold a correct
 * expression of this invariant at one site and a wrong proxy for it at another.
 */
export function projectionNamesNoRelation(
  model: Model<any>,
  select: Readonly<Record<string, unknown>> | undefined,
  include: Readonly<Record<string, unknown>> | undefined
): boolean {
  if (include) return false;
  return !selectProjectsRelation(model, select);
}

/**
 * PHASE 8.1, INVARIANT 1 — does this projection read the table the statement is
 * MUTATING?
 *
 * In PostgreSQL every sub-statement of one command sees the same snapshot, so
 * the `SELECT` on the outer side of `WITH u AS (UPDATE … RETURNING *) SELECT …`
 * reads every table as it stood BEFORE the statement. The mutated row is the one
 * exception: it arrives through `u`, post-mutation, out of `RETURNING`. Any
 * OTHER row of that same table is read stale.
 *
 * A projection that never reaches the mutated model therefore reads only
 * untouched tables and answers exactly what the unfolded terminal read answers.
 * One that does — a self-relation (`employee.manager`, `category.parent`) — can
 * address the mutated row itself and would hand back its pre-mutation shape, so
 * the fold declines. Walks the whole projection, at every depth, because a
 * self-relation two levels down reads the same table a top-level one does.
 *
 * ### The walk is over the WHOLE payload, not over `select`/`include` alone
 *
 * This first shipped walking each relation payload's `select` and `include` and
 * nothing else, which is a hole, because a relation payload's `where` compiles
 * to a correlated subquery that reads a table — and when that table is the
 * mutated one, the folded answer is filtered on the PRE-statement value.
 * MEASURED on PGlite against the same update run with the fold forced off
 * (`acct` 1-N `memo`; every `acct` starts at tier `T`; memos 10 and 11 belong to
 * acct 3):
 *
 *   update({ where: { id: 3 }, data: { tier: "gold" },
 *            include: { memos: { where: { acct: { tier: "gold" } } } } })
 *     folded -> memos: []           unfolded -> memos: [10, 11]
 *   …the same update with the filter on the OLD value (`tier: "T"`)
 *     folded -> memos: [10, 11]     unfolded -> memos: []
 *
 * Symmetric in both directions: the folded arm filtered on the pre-update tier.
 * `_count: { select: { memos: { where: … } } }` answered 0 against 2 the same
 * way, and `orderBy` / `cursor` reach a table by the identical mechanism.
 *
 * So the walk asks the question the invariant actually asks — *can any read this
 * payload compiles to land on the mutated table* — of EVERY key, at every depth,
 * and it needs no list of which payload keys carry a read. A key that names a
 * relation of the current model moves the scope to that relation's target; every
 * other key (`where`, `orderBy`, `cursor`, `_count`, `AND`/`OR`/`NOT`,
 * `some`/`every`/`none`, `is`/`isNot`, an operator envelope, an array element)
 * keeps the scope and is walked through, so a relation named anywhere under it
 * is found wherever it sits.
 *
 * It over-approximates in one direction only, which costs a statement and never
 * an answer: a literal inside a JSON-column filter whose own key happens to
 * spell a relation name (`where: { meta: { equals: { memos: 1 } } }`) is read as
 * a relation traversal and declines a fold that would have been legal.
 *
 * `_count` gets NO case of its own, and that is measured rather than assumed.
 * The shorthand `_count: true` never arrives here — `CountSchema`
 * (`validation/model/core/select.ts`) coerces it to `{ select: { <every to-many
 * relation>: true } }` at the parse boundary, so what this walks is the object
 * form, whose relation names sit under `select`, one scope-preserving hop down.
 * And a `_count` that is NOT that object form reads nothing to guard: the
 * projection builder emits a count only when `_count.select` is a record
 * (`select-builder.ts` — `buildCountPairs` is reached through that test alone),
 * and it is the SAME builder on the folded and the unfolded path, so both answer
 * without the key. A guard for `_count: true` here therefore declines folds that
 * are legal and covers nothing — removing it leaves the `_count` shorthand
 * witness below green, which is what says the coverage was not its own.
 *
 * ### Why this walk is not the selection traversal
 *
 * The select builder walks the same payload and emits the projection, so folding
 * this question into it looks like one walk where there are two. It is not the
 * same walk, in two ways that both matter:
 *
 *  · REACH. That traversal walks PROJECTION keys and hands `where`/`orderBy`/
 *    `cursor` opaquely to the filter builders. This one must descend INTO them —
 *    the measured counterexample above is a relation `where`, and the fold it
 *    caught was legal by every projection reading. Deriving this from the
 *    projection walk means widening the projection walk into a whole-payload
 *    walker, which is a bigger builder, not a smaller estate.
 *  · TIME. This answers in an operation CONSTRUCTOR, before the statement it
 *    guards exists. See the note on {@link selectProjectsRelation}.
 */
export function projectionReadsMutatedModel(
  scope: QueryScope,
  select: Readonly<Record<string, unknown>> | undefined,
  include: Readonly<Record<string, unknown>> | undefined
): boolean {
  return projectionReadsAnyTable(
    scope,
    select,
    include,
    new Set([getTableName(scope.model)])
  );
}

/** Whether a projection reaches any table whose rows the same command mutates. */
export function projectionReadsAnyTable(
  scope: QueryScope,
  select: Readonly<Record<string, unknown>> | undefined,
  include: Readonly<Record<string, unknown>> | undefined,
  tables: ReadonlySet<string>
): boolean {
  return (
    payloadReachesAnyTable(scope, select, tables) ||
    payloadReachesAnyTable(scope, include, tables)
  );
}

function payloadReachesAnyTable(
  scope: QueryScope,
  value: unknown,
  tables: ReadonlySet<string>
): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => payloadReachesAnyTable(scope, entry, tables));
  }
  if (!isRecordValue(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    // A key that projects nothing and filters nothing reads nothing. `null` is
    // NOT in this set: `where: { manager: null }` is a to-one absence filter,
    // which reads the related table to establish the absence.
    if (entry === false || entry === undefined) continue;
    const polymorphic = getPolymorphicRelationInfo(scope, key);
    if (polymorphic) {
      if (
        polymorphicPayloadReachesAnyTable(scope, polymorphic, entry, tables)
      ) {
        return true;
      }
      continue;
    }
    const relation = getRelationInfo(scope, key);
    if (relation) {
      if (tables.has(getTableName(relation.targetModel))) return true;
      const child = createChildScope(
        scope,
        relation.targetModel,
        scope.rootAlias
      );
      if (payloadReachesAnyTable(child, entry, tables)) return true;
      continue;
    }
    if (payloadReachesAnyTable(scope, entry, tables)) return true;
  }
  return false;
}

/**
 * The FOUR payload shapes a polymorphic key can wear, all of which can reach a
 * table under mutation. A false `false` here lets a mutation fold read the very
 * table the statement mutates (PostgreSQL 0A000), so the collection shapes are
 * enumerated rather than left to the arm-target pre-check:
 *
 * - `{ type, is|isNot }`         — the singular tagged predicate;
 * - `{ some|every|none: {…} }`   — the collection quantifiers, each carrying one
 *                                  tagged predicate of the same shape;
 * - `{ <publicType>: projection }` — the singular flat variant map;
 * - `{ only?, variants: {…} }`   — the collection selection envelope.
 *
 * The final loop's arm-target pre-check answers the self-target case for every
 * shape (both member kinds carry `targetModel`); what the explicit branches add
 * is NESTED reach — a `where` or a nested include one hop inside an arm.
 */
function polymorphicPayloadReachesAnyTable(
  scope: QueryScope,
  relation: NonNullable<ReturnType<typeof getPolymorphicRelationInfo>>,
  value: unknown,
  tables: ReadonlySet<string>
): boolean {
  if (isRecordValue(value) && typeof value.type === "string") {
    return taggedPredicateReachesAnyTable(
      scope,
      relation,
      value.type,
      value,
      tables
    );
  }

  if (isRecordValue(value)) {
    for (const quantifier of ["some", "every", "none"] as const) {
      const tagged = value[quantifier];
      if (!(isRecordValue(tagged) && typeof tagged.type === "string")) continue;
      if (
        taggedPredicateReachesAnyTable(
          scope,
          relation,
          tagged.type,
          tagged,
          tables
        )
      ) {
        return true;
      }
    }
  }

  const variants =
    isRecordValue(value) && isRecordValue(value.variants)
      ? value.variants
      : undefined;

  for (const [publicType, member] of relation.storage.members) {
    if (tables.has(getTableName(member.targetModel))) return true;
    const override = variants
      ? variants[publicType]
      : isRecordValue(value)
        ? value[publicType]
        : undefined;
    if (!isRecordValue(override)) continue;
    const child = createChildScope(scope, member.targetModel, scope.rootAlias);
    if (payloadReachesAnyTable(child, override, tables)) return true;
  }
  return false;
}

function taggedPredicateReachesAnyTable(
  scope: QueryScope,
  relation: NonNullable<ReturnType<typeof getPolymorphicRelationInfo>>,
  publicType: string,
  tagged: Readonly<Record<string, unknown>>,
  tables: ReadonlySet<string>
): boolean {
  const nested = isRecordValue(tagged.is)
    ? tagged.is
    : isRecordValue(tagged.isNot)
      ? tagged.isNot
      : undefined;
  if (!nested) return false;
  const member = relation.storage.members.get(publicType);
  if (!member) return false;
  if (tables.has(getTableName(member.targetModel))) return true;
  const child = createChildScope(scope, member.targetModel, scope.rootAlias);
  return payloadReachesAnyTable(child, nested, tables);
}

/**
 * PHASE 8.1, INVARIANT 2 — can this `SET` fire a referential action?
 *
 * `ON UPDATE CASCADE` / `SET NULL` / `SET DEFAULT` rewrite rows in a CHILD table
 * as part of the same statement. The outer `SELECT` of the fold reads that table
 * from the pre-statement snapshot, so it would hand back the children as they
 * were before the cascade — where the unfolded terminal read, running after the
 * `UPDATE`, sees them after it. That is a wrong answer, not a slower one.
 *
 * A foreign key may only point at a UNIQUE column set, so a `SET` that rewrites
 * no unique-participating field can fire no action at all. That is the test, and
 * `getForeignKeyTargetFields` is the one home for which column sets those are.
 * It asks a WIDER question than the catalog's `uniqueOverlapFields`, deliberately: a
 * `whereUnique` can only address a declared unique CONSTRAINT, but PostgreSQL
 * (and MySQL) accept a unique INDEX as an FK target too, and viborm's migration
 * driver emits `.index([...], { unique: true })` as exactly that. Asking the
 * narrower question here was a hole — `update({ data: { code } })` on a model
 * whose `code` is a unique index cascaded into the child table mid-statement and
 * the folded arm answered with the pre-cascade children, i.e. an EMPTY list.
 *
 * It over-approximates in one direction only — a unique column that NOTHING
 * references declines a fold that would have been legal — which costs a
 * statement, never an answer. Deciding it exactly would mean scanning every
 * model in the schema for an inbound reference, and the mainstream `update`
 * rewrites ordinary scalars.
 */
export function setCanFireReferentialAction(
  model: Model<any>,
  set: Readonly<Record<string, unknown>>
): boolean {
  return getForeignKeyTargetFields(model).some((field) =>
    Object.hasOwn(set, field)
  );
}

/**
 * Whether a referenced-key transition is a NO-OP — an `increment: 0` or a `set` to the
 * value the key already carries. The SET writes something, but the key does not MOVE, so
 * no slot is vacated, no child is stranded, and the ordinary parts hold unchanged: no
 * occupied guard, no post-transition ordering, no reorder.
 *
 * One home (X2), because two levels ask it of the same payload and must answer alike:
 * the ROOT's `interpretReferencedKeyTransition` ({@link UpdateOperation}, whose
 * `{ regime: "none" }` this decides) and the nested update TARGET's
 * `interpretChildParts` ({@link RelationWritePart}, deciding whether its own primary key
 * transitions at all). Split, the root accepted a same-value SET on an occupied relation
 * — pinned by `relation-key-update-legality.test.ts` — while depth rejected it with a
 * message asserting a transition that is not happening.
 *
 * Both operands are compile-time literals (the where-pinned pre-value and
 * `getUpdatedPrimaryKeyValue`), so an int/bigint/string key compares by value and a Date
 * by instant.
 */
export function sameScalarValue(before: unknown, after: unknown): boolean {
  if (before instanceof Date && after instanceof Date) {
    return before.getTime() === after.getTime();
  }
  if (typeof before === typeof after) return before === after;
  // Cross-type numeric identity. From the public client this branch is UNREACHABLE, and
  // that — not the exactness of `String()` — is what makes the string compare safe. The
  // typed parse boundary refuses a number wherever a bigInt field is addressed and a
  // bigint wherever an int field is addressed, in `where` and in `data` alike, so the
  // field's declared type governs BOTH operands and they arrive the same type. Measured
  // on PGlite against `s.bigInt().id()`: `where: { id: 42 }` → "ValidationError:
  // Validation failed for update: Expected bigint"; `data: { id: 42 }` → "… Expected
  // bigint, Expected object"; `data: { id: { increment: 0 } }` → "… Expected bigint,
  // Expected bigint" — and the int model mirrors it for a bigint literal. The arithmetic
  // route is closed twice over: `toBigInt` (`mutation-identity.ts`) converts a number
  // only when `Number.isSafeInteger`, and every safe integer stringifies to its exact
  // decimal, so String() there answers what BigInt() would.
  //
  // `String()` is NOT exact in general — it prints the SHORTEST round-tripping decimal.
  // `String(18014398509481992)` is "18014398509481990" while `String(18014398509481992n)`
  // is "…992", and 2^54+8 is well inside an int64 key (this client stores it as a
  // `s.bigInt().id()` on PG and SQLite). So if the parse boundary is ever loosened to
  // accept numbers for bigInt fields, a `set` at an unsafe magnitude reaches here as a
  // divergent pair and this compare must become `BigInt(before) === after`: otherwise a
  // same-value SET reads as a TRANSITION and fires an occupied guard the root does not.
  if (
    (typeof before === "bigint" || typeof before === "number") &&
    (typeof after === "bigint" || typeof after === "number")
  ) {
    return String(before) === String(after);
  }
  return false;
}

/**
 * Can this create-data value address the written row in a compile-time `where`?
 *
 * A NULL never can: SQL unique constraints do not equate NULLs, so a nullable
 * unique the create data sets to null names no row. Neither can a value the engine
 * resolves later (raw `Sql`, a batch-value reference — what a later statement
 * compares against need not be what the INSERT wrote), nor a structured value (a
 * list, a JSON object): those are not columns a unique constraint of this schema
 * spans, and equality on them is dialect business. Everything else — strings,
 * numbers, bigints, booleans, `Date`, `Decimal`, byte arrays — is the literal the
 * INSERT writes verbatim.
 */
function isAddressableLiteral(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (isSql(value) || Array.isArray(value)) {
    return false;
  }
  if (typeof value !== "object") return true;
  const prototype = Object.getPrototypeOf(value);
  return !(prototype === Object.prototype || prototype === null);
}

/**
 * The `whereUnique` for a COMPLETE unique constraint of `model` whose every column
 * `createData` supplies as an addressable literal — **W4's create-data-unique
 * identity source**: a create arm whose payload spells a whole unique NAMES the row
 * it is about to insert, at compile time, without reading anything back. Single-column
 * `.unique()`s first (declaration order), then compound uniques; `undefined` when none
 * is complete.
 *
 * `explicitFields` narrows the same scan to values the source payload actually
 * supplied. Create's post-write locator uses it so a materialized application
 * default cannot masquerade as the value emitted by the INSERT. Existing arm
 * identity callers omit it and keep their historical parsed-data contract.
 *
 * `state.uniques` is the model's single-column unique/id scalars, so a compound PK's
 * members never appear there individually — half a compound key is a filter, never an
 * identity.
 *
 * One home (X2): the root `upsert`'s create arm ({@link UpsertOperation}) and the
 * junction upsert's create arm ({@link RelationJunctionPart}) ask the same question of
 * the same payload, so they ask it here. The two differ only in what they DO with the
 * answer — a read-back `where` there, a dedup-ledger key plus a duplicate-item UPDATE
 * `where` here.
 */
export function createDataUniqueWhere(
  model: Model<any>,
  createData: Record<string, unknown>,
  explicitFields?: ReadonlySet<string>
): Record<string, unknown> | undefined {
  // Bare scalar selectors first (shape order), then grouped compound uniques —
  // the compound PRIMARY key is deliberately not consulted: half a compound key
  // is a filter, never an identity, and the whole one is the row key, which a
  // create arm addresses through its own identity channel.
  for (const key of getModelKeyCatalog(model).addressableKeys) {
    if (key.name === undefined) {
      const field = key.fields[0] as string;
      if (explicitFields && !explicitFields.has(field)) continue;
      const value = createData[field];
      if (isAddressableLiteral(value)) return { [field]: value };
    }
  }
  for (const key of getModelKeyCatalog(model).addressableKeys) {
    if (key.kind !== "compoundUnique" || key.fields.length === 0) continue;
    const values: Record<string, unknown> = {};
    let complete = true;
    for (const field of key.fields) {
      if (explicitFields && !explicitFields.has(field)) {
        complete = false;
        break;
      }
      const value = createData[field];
      if (!isAddressableLiteral(value)) {
        complete = false;
        break;
      }
      values[field] = value;
    }
    if (complete) return { [key.name as string]: values };
  }
  return undefined;
}

/**
 * The complete relation-target selector as conjuncts: one equality per unique
 * discriminator field, followed by the optional non-unique filter. Probes and
 * guards share this owner so both phases address the same row.
 */
export function uniqueSelectorConjuncts(
  scope: { model: Model<any> },
  where: Record<string, unknown>
): Record<string, unknown>[] {
  const { entries, filters } = partitionWhereUnique(scope, where);
  const conjuncts: Record<string, unknown>[] = entries.map(
    ({ fieldName, value }) => ({ [fieldName]: { equals: value } })
  );
  if (filters) conjuncts.push(filters);
  return conjuncts;
}

/** Bind the complete selector to values captured by its planning read. */
export function capturedSelectorWhere(
  scope: { model: Model<any> },
  where: Record<string, unknown>,
  captured: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const { entries } = partitionWhereUnique(scope, where);
  const selectorFields = new Set(entries.map((entry) => entry.fieldName));
  const conjuncts = uniqueSelectorConjuncts(scope, where);
  for (const [field, value] of Object.entries(captured)) {
    if (!selectorFields.has(field)) {
      conjuncts.push({ [field]: { equals: value } });
    }
  }
  return {
    AND: conjuncts,
  };
}

export type ExecutionMode = "transaction" | "batch";

/**
 * Pick the compile-time execution substrate from driver capability. A driver
 * with neither substrate gets the nominal `"transaction"` mode rather than a
 * throw here: a **single-statement** operation (a read, a scalar bulk write)
 * runs directly with no atomic envelope on any driver (V1's statement-atomicity),
 * so it must be constructible. The executor enforces the capability requirement
 * for a **multi-statement** operation, failing closed with V1's byte-identical
 * {@link TransactionError} (see `OperationExecutor.execute`).
 */
export function selectExecutionMode(
  engine: QueryEngine,
  _operation: string
): ExecutionMode {
  if (engine.driver.supportsBatch && !engine.driver.supportsTransactions) {
    return "batch";
  }
  return "transaction";
}

/**
 * V1's byte-identical "no atomic substrate" failure, raised by the executor when
 * a multi-statement operation cannot run (a single-statement one runs directly).
 */
export function noAtomicSubstrateError(
  driverName: string,
  operation: string
): TransactionError {
  return new TransactionError(
    `Driver '${driverName}' supports neither transactions nor atomic batch execution.`,
    { meta: { driver: driverName, operation } }
  );
}

/**
 * Thrown by a concrete operation's constructor when the requested payload shape is
 * outside V2's supported family (a wrong argument key, an unsupported relation kind, a
 * compound key or a non-literal fold at a documented boundary, …). **Post-P6 there is no V1
 * and no fallback:** this error PROPAGATES as a typed refusal — the pre-P6 framing (the P2a
 * proxy switched on it to "let V1 handle this whole tree") describes a mechanism deleted at
 * P6. Every shape that raises it is either a PARITY REFUSAL V1 also rejected, or a DOCUMENTED
 * narrower boundary reached by no conformance scenario (route-inventory category iii); the
 * decline-surface gate proves no accept-and-execute shape raises it. Any other construction
 * error (a `ValidationError` from the parse boundary, the own-write preflight rejection) is a
 * real failure the schema / preflight raises and likewise propagates.
 *
 * The class itself lives in `src/errors/query.ts` (public surface: its own
 * `diagnosticName` and `V8003 UNSUPPORTED_OPERATION` code, exported from the
 * package root so users can `instanceof` a deliberate capability boundary
 * instead of seeing a `V9001` engine crash); re-exported here so every engine
 * throw site and test keeps one import home.
 */
export { UnsupportedOperationError } from "@errors";

export function getStepModelName(model: Model<any>, fallback: string): string {
  return model["~"].names.ts ?? model["~"].names.sql ?? fallback;
}

import type { DatabaseAdapter } from "@adapters/database-adapter";
import type { AnyDriver } from "@drivers/driver";
/**
 * What writes a write in SQL. {@link OperationContext} owns what a write means
 * and how it is run; a statement in this language is written here, and another
 * language answers the same abstract members. See
 * `docs/architecture/query-backend-frontier.md`.
 */

import { batchMayContainAssertionCollision } from "@drivers/error-mapping";
import type { QueryResult, SqlDialect } from "@drivers/types";
import {
  isVibORMError,
  NESTED_WRITE_ASSERTION_FLOOR_MESSAGE,
  NestedWriteAssertionError,
  NestedWriteError,
  retainWriteOutcomeFailure,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import { type AnyModel, getModelKeyCatalog } from "@schema/model";
import { Sql, sql } from "@sql";
import type { PreparedBatchGuard, PreparedGuardFailure } from "../../types";
import { InsertValue } from "./insert-value";
import {
  type Member,
  MUTATION_ANSWER,
  MUTATION_ROWS,
  NO_CONTINUATIONS,
  NO_SCRATCH_CARRY,
  OperationContext,
  type ScratchCarry,
} from "./operation-context";
import {
  type PreparedProjection,
  Queries,
  type Query,
  refusesWhileDecoding,
  returningSafeProjection,
  throughDerived,
} from "./query";
import type { RowJudgement } from "./row-scope";
import type { Input } from "./schema";
import { SqlQueries } from "./sql-queries";

export class SqlOperationContext extends OperationContext {
  declare readonly queries: SqlQueries;
  declare readonly driver: AnyDriver & { readonly adapter: DatabaseAdapter };

  protected override createQueries(
    ...args: ConstructorParameters<typeof SqlQueries>
  ): SqlQueries {
    return new SqlQueries(...args);
  }
  /** {@link answersInStatement}'s projections over a write. */
  #overWrites:
    | WeakMap<
        PreparedProjection,
        { readonly answer: Sql; readonly folds: boolean }
      >
    | undefined;
  /**
   * Does this statement ask about a value THIS unit produced?
   *
   * It binds this UNIT's batch reference, so it reads the scratch through it,
   * and the rolled-back transaction takes that scratch with it: the attribution
   * ladder cannot ask it again ({@link submit}). Both halves of the fact — the
   * reference's identity and the statement that reads it — are here and only
   * here, for the premises {@link statePremise} states AND for the continuation
   * guards {@link submit} builds. Since D-58 only a premise stated INSIDE the
   * unit that made the scratch can bind it — a guard rides a LATER segment, and
   * the value it re-pins crossed that boundary as a literal — so the guard is
   * still DERIVED here rather than asserted to read nothing, which is what
   * keeps the two halves of the fact in one place.
   */
  #readsBatchReference(query: Query): boolean {
    const reference = this.attemptStore?.scratchId;
    return reference !== undefined && query.sql.values.includes(reference);
  }
  /** Queue one premise's assertion and record what it requires of the batch. */
  protected override statePremise(
    query: Query,
    present: boolean,
    failure: Error
  ): void {
    const assertions = this.driver.adapter.assertions;
    this.attempt.assertPremise(
      this.queue(
        present ? assertions.exists(query.sql) : assertions.notExists(query.sql)
      ),
      {
        query,
        present,
        failure,
        readsBatchReference: this.#readsBatchReference(query),
      }
    );
  }
  protected override async submit(
    publishingGeneratedOutput = false,
    member?: Member
  ) {
    if (this.ownership === "batch-preparation") {
      throw this.incompletePreparation;
    }
    this.submissions_++;
    const attempt = this.attempt;
    this.atomicAssertionRejection = undefined;
    attempt.rejectedInsert = undefined;
    const precedingSegments = this.committedSegments;
    const declared = this.continuationList;
    const continuations = declared
      ? declared.filter((continuation) => !continuation.declaring)
      : NO_CONTINUATIONS;
    if (declared)
      for (const continuation of declared) continuation.declaring = false;
    // A guard's query is STATED here, where the guard is built: it re-pins a
    // row an EARLIER segment wrote, and a value that segment produced reached
    // this one as a literal (D-58), so a query stated at declaration time would
    // name a scratch that no longer exists. The premise it raises is derived at
    // the same point, while this unit's scratch is still the one in hand.
    const guards = continuations.map((continuation) => {
      const query = (continuation.query ??= continuation.state());
      const context = this.statementContext(continuation.model, this.operation);
      return {
        statement: {
          ...this.transport._prepare(
            this.driver.adapter.assertions.exists(query.sql),
            context
          ),
          context,
        },
        premise: {
          query,
          present: true,
          failure: continuation.failure(),
          readsBatchReference: this.#readsBatchReference(query),
        },
      };
    });
    // D-58: this unit's scratch ends with this unit. Every value it stored is
    // read back inside the same batch, at its end, and the table is dropped
    // with the unit that made it — so the next unit binds LITERALS and creates
    // its own scratch for whatever it produces itself.
    const carryIndex = guards.length + attempt.pending.length;
    const carried = this.#carryScratch();
    this.closeScratch();
    const statements = [
      ...guards.map((guard) => guard.statement),
      ...attempt.pending.splice(0),
    ];
    const insertProducers = attempt.drainInsertProducers();
    const assertionFailures = attempt.drainAssertedPremises();
    const judgedWrites = attempt.drainJudgedWrites();
    for (const { statement, premise } of guards)
      assertionFailures.set(statement, premise);
    const members = attempt.drainMembers();
    const acknowledged = async () => {
      if (members.length === 0) return;
      this.committedSegments++;
      const committed = (this.committedMemberSet ??= new Set());
      for (const member of members) committed.add(member);
      // This transport acknowledges before it has decoded anything, so the
      // listener's failure is HELD rather than thrown: the operation's own
      // answer is still to come, and it stays primary if it fails too
      // ({@link heldOutcomeFailure}, released by {@link settleSubmitted}).
      try {
        await this.writeOutcome?.committedSegment?.();
      } catch (failure) {
        this.heldOutcomeFailure = { failure };
      }
    };
    let responses: QueryResult<Input>[];
    try {
      responses = await this.dispatch(statements.length, false, () =>
        this.transport._executeBatch<Input>(
          statements,
          undefined,
          this.attribution,
          this.driver.supportsOrderedCommittedSegments
            ? acknowledged
            : undefined
        )
      );
      if (!this.driver.supportsOrderedCommittedSegments) await acknowledged();
    } catch (error) {
      // A listener that failed while this batch acknowledged is composed with
      // the batch's own failure, which stays primary, and the uncertain-outcome
      // arm below is not reached: a segment that acknowledged is known to have
      // committed. Shipped states both at the same point of its own catch
      // (`write-engine/OperationExecutor.ts:1306-1309`).
      const acknowledgedOutcomeFailure = this.heldOutcomeFailure;
      this.heldOutcomeFailure = undefined;
      if (acknowledgedOutcomeFailure)
        throw this.answered(
          retainWriteOutcomeFailure(error, acknowledgedOutcomeFailure.failure)
        );
      // Atomic rejection is retryable only with exact effect attribution and a
      // direct provider cause. Cleanup aggregation retains an extra cause link.
      // And only while no dynamic member has been admitted: THIS route's
      // recovery is the interpreter's in-place REPLAY of the tree that ran
      // ({@link replaysInPlace}, the only arm reachable where the operation
      // opened no region), which a dynamically admitted member makes impossible
      // — its defaults and transforms already ran once against a row this
      // attempt read, and admitted values are never produced twice (rule 10).
      // The bound belongs to the site that RECORDS the producer, which is why
      // {@link recoveryRejection} asks about attribution and progress alone.
      // The non-batch attribution in {@link insert} carries no such bound: the
      // recovery IT feeds re-enters a fresh region with a fresh plan (D-25).
      if (
        this.driver.supportsBatch &&
        !this.committedProgress &&
        !this.memberAdmissionStarted &&
        error instanceof UniqueConstraintError &&
        error.meta.commitCertainty === undefined &&
        error.originalCause &&
        error.originalCause.cause === undefined &&
        typeof error.meta.statementIndex === "number"
      ) {
        const producer = insertProducers.get(
          statements[error.meta.statementIndex]!
        );
        if (producer) attempt.rejectedInsert = { error, producer };
      }
      // A weak native batch cannot prove rollback merely by rejecting after
      // dispatch — but a batch that rejected AT A PREMISE, with nothing but
      // premises ahead of it, dispatched no write at all, and the provider said
      // where it stopped. There is nothing to roll back and nothing to be
      // uncertain about. It is the companion of Arnaud's D-29: a premise now
      // rides the unit it protects, so a unit that loses its race rejects at
      // the premise, ahead of its own first write. A rejection at a WRITE keeps
      // the uncertainty it always had, whatever its position
      // (`g4/unit02/uncertain-outcome-meta.test.ts` cell 2).
      // And it is asked only where it can DECIDE the allowance. An operation
      // that has already acknowledged a segment is refused its recovery by
      // progress alone (D-25), so the proof could buy it nothing — while the
      // uncertainty such an operation reports for a LATER batch is a separate
      // registered fact (`transitions/staleness-live-pg.ts`
      // `g2-pg-series-parent-reference-reused`: "the acknowledged prefix and
      // weak native dispatch uncertainty are distinct facts").
      let failure: Error | undefined;
      let attributedIndex: number | undefined;
      if (error instanceof NestedWriteAssertionError) {
        const statementIndex = error.meta.statementIndex;
        if (typeof statementIndex === "number") {
          const statement = statements[statementIndex]!;
          failure =
            assertionFailures.get(statement)?.failure ??
            judgedWrites.get(statement)?.refusal;
          attributedIndex = statementIndex;
        } else {
          // Fresh-state diagnostics after rollback refine the error, not its
          // original statement index: a premise found false NOW may have held
          // when the batch ran (state moved on between the abort and the
          // re-probe, DESIGN §7.3 step 4), so the position they name is a
          // sentence, and the position claim below is bounded by the LAST
          // premise instead. An unindexed native failure identifies our sole
          // guard only when ordinary SQL cannot collide with it.
          const mayCollide = batchMayContainAssertionCollision(
            statements,
            this.driver.dialect
          );
          const soleGuard =
            assertionFailures.size + judgedWrites.size === 1 && !mayCollide;

          // A premise about a value this unit PRODUCED is not re-probable at
          // all (the guide, "At the ladder, a premise stated BEHIND the unit's
          // own writes … is not re-probable after the rollback"): it reads the
          // batch reference scratch, which the rolled-back transaction took
          // with it, so the statement would raise an undefined-table error
          // where the ladder owes an attribution. The inference below is that
          // premise's whole answer, and the ladder does not ask it. Every other
          // premise is asked, because the position it holds is not the fact —
          // a unit that states two premises behind its first write keeps the
          // correlated identity of the one the re-probe contradicts (N1,
          // `g4/parity/ordered-observation.test.ts`).
          for (const [index, statement] of statements.entries()) {
            const assertion = assertionFailures.get(statement);
            if (failure || !assertion || assertion.readsBatchReference)
              continue;
            const present = (await this.read(assertion.query, true)).length > 0;
            if (present !== assertion.present || soleGuard) {
              failure = assertion.failure;
              attributedIndex = index;
              break;
            }
          }
          // A premise stated BEHIND the unit's own writes may be about what
          // those writes did (an ordered observation's requirement, N1); the
          // rollback that preceded the re-probe undid them, so its answer now
          // says nothing about the abort. When every premise ahead of the
          // writes holds now and exactly one premise stands behind them, that
          // one is the only candidate the re-probe could not clear — the sole
          // guard's inference, applied to the one premise the rollback hides.
          if (failure === undefined && !mayCollide) {
            const firstWrite = statements.findIndex(
              (statement) => !assertionFailures.has(statement)
            );
            const blind = [...statements.entries()].filter(
              ([index, statement]) =>
                firstWrite >= 0 &&
                index > firstWrite &&
                assertionFailures.has(statement)
            );
            if (blind.length === 1) {
              const [index, statement] = blind[0]!;
              failure = assertionFailures.get(statement)!.failure;
              attributedIndex = index;
            }
          }
          // Every premise holds now: a write that judged the row it
          // produces failed on its own assertion, before it wrote. The one
          // such write is it; of several, the first whose rows, read again
          // from the values it wrote, are refused now (the batch ran them in
          // order and stopped at the refusal). A write reading this unit's
          // scratch is not asked again: the rollback took the scratch.
          if (failure === undefined && !mayCollide) {
            if (judgedWrites.size === 1)
              for (const [statement, judged] of judgedWrites) {
                failure = judged.refusal;
                attributedIndex = statements.indexOf(statement);
              }
            else
              for (const [index, statement] of statements.entries()) {
                const probe = judgedWrites.get(statement)?.probe;
                if (probe === undefined) continue;
                try {
                  await this.transport._execute(probe, this.attribution);
                } catch (refused) {
                  if (!(refused instanceof NestedWriteAssertionError))
                    throw refused;
                  failure = judgedWrites.get(statement)!.refusal;
                  attributedIndex = index;
                  break;
                }
              }
          }
        }
      }
      const providerIndex =
        isVibORMError(error) && typeof error.meta.statementIndex === "number"
          ? error.meta.statementIndex
          : undefined;
      const rejectedIndex = providerIndex ?? attributedIndex;
      // Where the provider said where it stopped, that is the position. Where
      // only the re-probe did, the claim "nothing but premises ahead" must hold
      // for ANY premise that could have fired — the last one in the batch — so
      // a batch whose own committed write falsified an earlier premise is never
      // read as having dispatched no write. What the bound cannot see is an
      // ordinary statement arriving as the assertion class BEHIND the last
      // premise, with writes dispatched ahead of it: on the shipped index-free
      // transports (D1, Neon) the batch is atomic, so nothing survives that
      // abort; a transport that is neither atomic nor indexed owes its own
      // witness (D-53) before the claim is made there.
      let positionBound = rejectedIndex;
      if (providerIndex === undefined && typeof attributedIndex === "number") {
        let last = -1;
        for (const [index, statement] of statements.entries())
          if (assertionFailures.has(statement) || judgedWrites.has(statement))
            last = index;
        positionBound = last;
      }
      const rejectedBeforeAnyWrite =
        typeof rejectedIndex === "number" &&
        typeof positionBound === "number" &&
        this.committedSegments === 0 &&
        statements.every(
          (statement, index) =>
            index > positionBound ||
            assertionFailures.has(statement) ||
            (index === rejectedIndex && judgedWrites.has(statement))
        );
      if (
        members.length > 0 &&
        !rejectedBeforeAnyWrite &&
        !this.driver.supportsOrderedCommittedSegments &&
        this.committedSegments === precedingSegments &&
        !(error instanceof UniqueConstraintError)
      ) {
        this.mayHaveCommittedSegment = true;
        // Said where it is learned and BEFORE the failure is attributed or
        // published, which is the shipped order (`OperationExecutor.ts:1050-1058`
        // sets the same internal flag, notifies, and only then rethrows).
        // Whether the meta reports it is a separate question, answered once in
        // `failure()`; whether the listener's own failure may replace this
        // operation's is answered once in {@link stateWriteOutcome}.
        await this.stateWriteOutcome(this.writeOutcome?.mayBeVisible, error);
      }
      let attributedError = error;
      if (failure && error instanceof NestedWriteAssertionError) {
        attributedError = failure;
        if (
          this.driver.supportsBatch &&
          !this.committedProgress &&
          error.meta.commitCertainty === undefined &&
          // Only a premise its own owner declared RACEABLE may be answered by
          // another attempt. The mark is the estate's existing rule for
          // exactly this question ("the `raceable` mark is what lets the
          // routed retry re-plan and converge", `batch-error-attribution.ts`;
          // `errors/base.ts` "the retry layer … re-runs the SPECIFIC raceable
          // ones by their own marking"), and it is fixed by the guard's
          // premise class (`query-engine/types.ts`). A non-raceable premise —
          // the captured row's own presence — is a statement about IDENTITY:
          // re-planning it would retry against whatever row now answers the
          // selector, which is the one thing a captured-row replacement must
          // not do (`docs/architecture/retired/write-engine-ATOM.md` §"A conditional-skip batch arm",
          // `transitions/conditional-upsert.ts` "Captured-row replacement or
          // deletion must not permit a retry against another identity").
          isVibORMError(failure) &&
          failure.meta.raceable === true
        )
          this.atomicAssertionRejection = failure;
      } else if (error instanceof NestedWriteAssertionError) {
        // The un-attributable floor (N3a, the shipped `batch-error-attribution`
        // floor): a batch assertion the ladder cannot attribute surfaces as
        // the typed, non-raceable NestedWriteError carrying the assertion code
        // — never the driver-mapped internal class, never a retry.
        attributedError = new NestedWriteError(
          NESTED_WRITE_ASSERTION_FLOOR_MESSAGE,
          "",
          {
            code: VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED,
            cause: error,
          }
        );
      }
      // The same fact at the dispatch that fails: this submission belongs to a
      // record series when it PUBLISHED generated output, or when it carried a
      // continuation guard — a guard rides only a segment AFTER the one that
      // wrote what it re-pins, so its presence is the committed prefix itself.
      // A continuation still being declared carries no guard and says nothing.
      throw publishingGeneratedOutput || continuations.length > 0
        ? this.failure(
            attributedError,
            this.committedSegments > precedingSegments ? "result" : "member",
            member
          )
        : attributedError;
    }
    // The batch ANSWERED. A value this unit carries across its boundary is
    // decoded here, outside the transport's own catch: the statements all ran,
    // so a value the provider malformed is this operation's RESULT failure —
    // the same answer the terminal read gives for the same row — and never a
    // rejection of the unit that wrote it (D-58).
    //
    // It is the ONE throw that leaves a dispatch that SUCCEEDED, so it releases
    // the hold itself, exactly as the dispatch-failure arm above does: a
    // listener failure this batch HELD while it acknowledged would otherwise
    // reach no one — {@link settleSubmitted} captures the hold at its own entry,
    // which is after `submit` has already returned. The operation's own failure
    // stays primary, with the listener's retained beside it.
    try {
      for (const [offset, carry] of carried.entries())
        this.#settleCarry(carry, responses[carryIndex + offset]!, member);
    } catch (error) {
      const held = this.heldOutcomeFailure;
      this.heldOutcomeFailure = undefined;
      throw held
        ? this.answered(retainWriteOutcomeFailure(error, held.failure))
        : error;
    }
    this.takeCaptures(statements, responses);
    return responses.slice(guards.length);
  }
  /**
   * One premise a packaged operation states INSIDE the array's atomic unit:
   * the assertion is queued ahead of the statements it protects and declared
   * to the array owner, which aborts the whole batch and rebuilds `failure`
   * from the guard (`batch-error-attribution.ts`). An asserted premise
   * ({@link requireAbsent}) cannot ride a package, because only this
   * operation's own transport reads its answer.
   */
  override packageGuard(
    model: AnyModel,
    probe: Sql,
    premise: PreparedBatchGuard["premise"],
    failure: PreparedGuardFailure
  ): void {
    (this.preparedGuardList ??= []).push({
      queryIndex: this.queued.length,
      premise,
      probe,
      failure,
      model: model["~"].names.ts!,
      operation: this.operation,
    });
    const assertions = this.driver.adapter.assertions;
    this.queue(
      premise === "exists"
        ? assertions.exists(probe)
        : assertions.notExists(probe),
      this.statementContext(model, this.operation)
    );
  }
  /**
   * Lower one INSERT shape; callers own grouping, chunking, and output. A
   * `judged` create reads its rows from their own values under their
   * placement (R4, {@link Queries.producedSource}), in the same statement.
   */
  /**
   * `rows`, each {@link InsertValue} its stamps left replaced by what it
   * computes for these rows, now that every other value is final; `rows`
   * itself when none holds one. A value may `read` the database before
   * the write: on the operation's own transport, unless the caller gives its
   * own; never where the statements are prepared before any is sent.
   */
  async computed(
    model: AnyModel,
    rows: Input[],
    read: false | ((statement: Sql) => Promise<readonly Input[]>) = this
      .ownership !== "batch-preparation" &&
      (async (statement) =>
        (await this.answer({ sql: statement } as Query, false, model)).rows)
  ): Promise<Input[]> {
    let computed: Input[] | undefined;
    const fields = new Map<string, { value: InsertValue; at: number[] }>();
    for (const [index, row] of rows.entries())
      for (const [field, value] of Object.entries(row))
        if (value instanceof InsertValue) {
          const entry = fields.get(field) ?? { value, at: [] };
          entry.at.push(index);
          fields.set(field, entry);
        }
    for (const [field, { value, at }] of fields) {
      computed ??= rows.map((row) => ({ ...row }));
      const values = await value.compute(
        {
          model,
          rows: computed,
          field,
          queries: this.queries,
          dialect: this.driver.dialect as SqlDialect,
          ...(read && { read }),
        },
        at
      );
      for (const [position, index] of at.entries())
        computed[index]![field] = values[position];
    }
    return computed ?? rows;
  }
  override answersInStatement(
    model: AnyModel,
    projection: PreparedProjection,
    effect: "insert" | "update" | "delete",
    written?: Input
  ): boolean {
    const capabilities = this.driver.adapter.capabilities;
    if (!capabilities.supportsReturning) return false;
    if (returningSafeProjection(projection)) return true;
    // A refusal after the statement must roll the write back: a transaction.
    if (refusesWhileDecoding(projection)) return false;
    if (effect === "delete") return capabilities.supportsCteWithMutations;
    if (written !== undefined) {
      const keys = getModelKeyCatalog(model).referenceableKeys;
      if (
        keys.some((key) => key.some((field) => Object.hasOwn(written, field)))
      )
        return false;
    }
    return this.#overWrite(model, projection).folds;
  }
  /**
   * The projection read over the written row ({@link answersInStatement}),
   * and whether the write may answer it: not where it reads the written table
   * or, in a `RETURNING`, needs a `WITH` of its own. Lowered once per
   * projection: the plan asks before the statement exists.
   */
  #overWrite(
    model: AnyModel,
    projection: PreparedProjection
  ): { readonly answer: Sql; readonly folds: boolean } {
    const known = this.#overWrites?.get(projection);
    if (known !== undefined) return known;
    const a = this.driver.adapter;
    const table = model["~"].names.sql!;
    const name = Sql.leafText(a.identifiers.escape(table))!;
    let answer: Sql;
    let folds = true;
    if (a.capabilities.supportsCteWithMutations) {
      answer = this.queries.select(model, {}, undefined, {
        projection,
        source: MUTATION_ROWS,
      }).sql;
      // A read sharing its relation bodies states them in a `WITH` of its
      // own, and a statement has one: it reads from inside a derived table.
      if (a.cte.opens(answer))
        answer = throughDerived(a, answer, MUTATION_ANSWER);
    } else {
      answer = this.queries.sharing(() =>
        sql.join(this.queries.lowerProjection(projection, table), ", ")
      );
      // A `RETURNING` takes no `WITH`: a projection repeating a relation body
      // where the transport shares them keeps the re-read, which states each
      // body once.
      folds = !a.cte.opens(answer);
    }
    // In FROM position, not as the correlation `"<table>".` names the row by.
    folds &&= !Sql.peek(answer).strings.some((text) => {
      for (
        let at = text.indexOf(name);
        at !== -1;
        at = text.indexOf(name, at + 1)
      )
        if (text[at + name.length] !== ".") return true;
      return false;
    });
    const over = { answer, folds };
    (this.#overWrites ??= new WeakMap()).set(projection, over);
    return over;
  }
  /** `statement` answering with `projection` ({@link answersInStatement}). */
  answering(
    model: AnyModel,
    statement: Sql,
    projection: PreparedProjection,
    extra: Sql[] = []
  ): Sql {
    const a = this.driver.adapter;
    if (returningSafeProjection(projection))
      return sql`${statement} ${a.mutations.returning(
        sql.join([...this.queries.lowerProjection(projection), ...extra], ", ")
      )}`;
    const { answer } = this.#overWrite(model, projection);
    if (!a.capabilities.supportsCteWithMutations)
      return sql`${statement} ${a.mutations.returning(answer)}`;
    return sql`${a.cte.with([
      {
        name: MUTATION_ROWS,
        query: sql`${statement} ${a.mutations.returning(sql.raw("*"))}`,
      },
    ])} ${answer}`;
  }
  /**
   * A value this unit PRODUCED, read back at the unit's boundary so the next
   * one binds it as a literal (D-58).
   *
   * One SELECT per value stored, at the end of the batch that stored it and
   * inside it — the scratch is alive exactly there — through the SAME owner
   * that reads a produced value back anywhere else
   * ({@link Queries.scalarQuery}), so the literal arrives through the field's
   * own codec and binds exactly as a spelled key would. A unit with no next —
   * the operation's terminal statements, and the one unit a prepared package IS
   * — has closed its scratch already ({@link finishTerminals}) and reads
   * nothing back: there is no later statement to bind it.
   */
  #carryScratch(): readonly ScratchCarry[] {
    const attempt = this.attemptStore;
    if (attempt?.scratchId === undefined) return NO_SCRATCH_CARRY;
    const carried: ScratchCarry[] = [];
    for (const publication of attempt.drainScratchPublications()) {
      const query = this.queries.scalarQuery(
        publication.model,
        publication.field,
        publication.expression
      );
      this.queue(query.sql);
      carried.push({ query, publication });
    }
    return carried;
  }
  /**
   * The literal one read-back answered, held where the scratch id is held.
   *
   * Exactly one row, by construction: the read-back is
   * {@link Queries.scalarQuery}'s projection-only `SELECT <expression>` — no
   * FROM, no cardinality of its own — so every provider answers it with one
   * row, and the assertion is the statement of that. A guard here would be a
   * check whose unique coverage cannot be named, and it would fail in the one
   * way this unit exists to prevent: an uncarried value leaves the NEXT unit
   * binding a scratch its own segment never created.
   */
  #settleCarry(
    carry: ScratchCarry,
    response: QueryResult<Input>,
    member?: Member
  ): void {
    let row: Input;
    try {
      row = this.queries.decodeQuery(carry.query, response.rows, true)[0]!;
    } catch (error) {
      throw this.failure(error, "result", member);
    }
    this.attempt.carryScratchValue(
      carry.publication.expression,
      row[carry.publication.field]
    );
  }
  /**
   * The refusal of a write of `model` whose statement refused the row it
   * would produce: the root's own, or `refusal` for a nested write.
   */
  refused(
    model: AnyModel,
    judgement?: RowJudgement,
    refusal = this.#updateRefusal(model, judgement)
  ): Error {
    return this.refusal({ model, refusal });
  }
  /**
   * PROTOTYPE: what a root write of `model` reports where its statement
   * refuses the row it would produce, as the data a unit's owner rebuilds
   * the error from.
   */
  refusalOf(model: AnyModel, judgement?: RowJudgement): PreparedGuardFailure {
    return this.#updateRefusal(model, judgement);
  }
  /** A root write's refusal of the row it produces (§5.3). */
  get #forbidden(): PreparedGuardFailure {
    return {
      kind: "forbidden",
      message: `${this.operation} produced a row that is not permitted.`,
      raceable: false,
    };
  }
  /**
   * A root update's refusal of the row it produces, naming the fields it
   * writes that a layer's `moves` judges again: the cause the operation does
   * not show where a nested write wrote them (a to-one `delete: true` clears
   * the key it holds). The plain refusal where it writes none.
   */
  #updateRefusal(
    model: AnyModel,
    judgement: RowJudgement | undefined
  ): PreparedGuardFailure {
    const layers =
      judgement && this.scope?.rows.domain.verbs?.get(model["~"].names.ts!);
    if (!(judgement && layers)) return this.#forbidden;
    const moved = judgement.writes.filter((field) =>
      layers.some((layer) => layer?.moves.has(field) === true)
    );
    if (moved.length === 0) return this.#forbidden;
    // The relations, among the fields written, whose key holds a moved one.
    const relations = model["~"].state.relations;
    const through = judgement.writes.filter(
      (field) =>
        Object.hasOwn(relations, field) &&
        relations[field]!["~"].state.foreignKey?.fields.some((key) =>
          moved.includes(key)
        ) === true
    );
    return {
      ...this.#forbidden,
      reason: `the row it would leave, judged again because it writes ${moved.join(", ")}${through.length > 0 ? ` (through ${through.join(", ")})` : ""}, is refused`,
    };
  }
}

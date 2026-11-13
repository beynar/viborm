import type { DatabaseAdapter } from "@adapters/database-adapter";
import type { AnyDriver } from "@drivers/driver";
/**
 * What writes a write in SQL. {@link OperationContext} owns what a write means
 * and how it is run; a statement in this language is written here, and another
 * language answers the same abstract members. See
 * `docs/architecture/query-backend-frontier.md`.
 */

import {
  assembleAdapterSelect,
  getAdapterInternals,
} from "@adapters/adapter-internals";
import { batchMayContainAssertionCollision } from "@drivers/error-mapping";
import type {
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
  SqlDialect,
} from "@drivers/types";
import {
  isVibORMError,
  NESTED_WRITE_ASSERTION_FLOOR_MESSAGE,
  NestedWriteAssertionError,
  NestedWriteError,
  QueryEngineError,
  retainWriteOutcomeFailure,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
  VibORMErrorCode,
} from "@errors";
import { type AnyModel, getModelKeyCatalog } from "@schema/model";
import { Sql, sql } from "@sql";
import {
  compileBindBudgetChunks,
  normalizedBindParameterLimit,
} from "../../bind-budget";
import type { PreparedBatchGuard, PreparedGuardFailure } from "../../types";
import { writeSinks } from "../../write-sinks";
import { InsertValue, JoinedValue } from "./insert-value";
import {
  type JudgedWrite,
  type Member,
  type MembershipParent,
  MUTATION_ANSWER,
  MUTATION_ROWS,
  NO_CONTINUATIONS,
  NO_SCRATCH_CARRY,
  nestedRefusal,
  OperationContext,
  type ScratchCarry,
  type SpentSlots,
  type StatementAnswer,
  type WriteOutcomeSeam,
} from "./operation-context";
import {
  type PreparedProjection,
  type PreparedSelector,
  type ProjectionShape,
  Queries,
  type Query,
  refusesWhileDecoding,
  returningSafeProjection,
  throughDerived,
  wholeValue,
} from "./query";
import type { RowJudgement } from "./row-scope";
import { type Input, record } from "./schema";
import { SqlQueries } from "./sql-queries";
import {
  linkJudgement,
  linkMembers,
  type Membership,
  physicalField,
} from "./storage";

export class SqlOperationContext extends OperationContext {
  declare readonly queries: SqlQueries;
  declare readonly driver: AnyDriver & { readonly adapter: DatabaseAdapter };

  protected override createQueries(
    ...args: ConstructorParameters<typeof SqlQueries>
  ): SqlQueries {
    return new SqlQueries(...args);
  }

  /** Generated-output continuations declared so far; none until one is. */
  get #continuationCount(): number {
    return this.continuationList?.length ?? 0;
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
   * The same premise as {@link published}'s missing-row failure, moved INSIDE
   * the atomic unit for a packaged operation.
   *
   * `published` is a JavaScript postcondition, and a packaged operation only
   * reaches its parser after the array's one batch has committed — so a missing
   * row would raise the right error while every sibling member stayed durable.
   * A batch has no JS postcondition available, so the premise becomes a
   * statement: one `assertions.exists` over the same selector, queued ahead of
   * the mutation and declared to the array owner, which aborts the whole batch
   * and reconstructs this operation's own `NotFoundError` from the guard's
   * model and verb. This is exactly the shipped fold's batch shape
   * (`DeleteOperation` `foldGuard`/`buildRootPresenceGuard`, `UpdateOperation`'s
   * equivalent): `[presence guard, mutation … RETURNING]`, one round trip.
   */
  #packagedPresence(
    model: AnyModel,
    selector: PreparedSelector,
    single?: () => Error
  ): void {
    if (!single || this.ownership !== "batch-preparation") return;
    const probe = this.queries.select(
      model,
      {
        select: Object.fromEntries(
          this.schema.keys(model).map((field) => [field, true])
        ),
      },
      undefined,
      { selector }
    );
    this.packageGuard(model, probe.sql, "exists", {
      kind: "notFound",
      // Never user-facing: `createFailureError` ignores this message for
      // `kind: "notFound"` and rebuilds the shipped sentence from the guard's
      // model and verb. It is read only by `sameAttribution`
      // (`batch-error-attribution.ts`), where being CONSTANT per model and
      // verb is what makes two guards of the same shape agree.
      message: `${this.operation} found no '${model["~"].names.ts!}' row matching its unique selector.`,
      raceable: false,
    });
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
  async #setMutation(
    statement: Sql,
    context: QueryExecutionContext,
    parse: (result: QueryResult<unknown>) => unknown,
    judged?: JudgedWrite
  ): Promise<unknown> {
    return this.setMutations(
      [{ sql: statement, context }],
      (results) => {
        const result = results[0];
        if (!result)
          throw new TransactionError(
            `Driver '${this.driver.driverName}' omitted the result for operation '${this.operation}'.`,
            { meta: this.errorMeta }
          );
        return parse(result);
      },
      judged
    );
  }
  private async setMutations(
    statements: readonly {
      readonly sql: Sql;
      readonly context: QueryExecutionContext;
      /** A judged statement's own judgement, asked again after a rollback ({@link submit}). */
      readonly probe?: Sql | undefined;
    }[],
    parse: (results: readonly QueryResult<unknown>[]) => unknown,
    judged?: JudgedWrite
  ): Promise<unknown> {
    if (this.ownership === "batch-preparation") {
      const firstResult = this.queued.length;
      for (const statement of statements)
        this.#queueJudged(statement.sql, statement.context, undefined, judged);
      this.preparedParser = (results) => {
        const window = results.slice(
          firstResult,
          firstResult + statements.length
        );
        if (window.length !== statements.length) {
          // One sentence for one condition: `publish` and
          // `decodeTerminalResults` state it the same way, and a root write now
          // reaches this owner through the fold.
          throw new TransactionError(
            `Driver '${this.driver.driverName}' omitted the prepared result for operation '${this.operation}'.`,
            { meta: this.errorMeta }
          );
        }
        return parse(window);
      };
      return undefined;
    }
    // ONE rule for the physical envelope, asked here of this owner's two
    // transports: a set statement that is the operation's ONLY statement needs
    // no envelope, so it takes the plain execute path on a batch-only driver
    // exactly as on every other. That is the shipped transport rule — the same
    // `runStatementAtomic` condition {@link run} already restates for the
    // envelope (`write-engine/OperationExecutor.ts` `canExecuteDirectly` at
    // `:241` and its `:346-357` call site), which sends this shape through
    // `_execute` and never through `_executeBatch`. Arnaud's D-7 decision
    // (2026-09-15) is to take it exactly: a ONE-STATEMENT BATCH is what makes
    // the driver seam attribute `statementIndex: 0` to a rejection the shipped
    // engine attributes no index to (`drivers/driver-diagnostics.ts:35-36`),
    // for the folded root write and for every relation-free bulk verb alike.
    //
    // Each conjunct is a different way of not being the only statement: a plan
    // of several statements; something already queued on this attempt that
    // would ride the same batch (`requireAbsent`/`requirePresent`); a
    // generated-output continuation whose guard must precede the mutation
    // inside one atomic unit ({@link submit}).
    const lone =
      statements.length === 1 &&
      this.queued.length === 0 &&
      this.#continuationCount === 0;
    if (this.usesBatch && !lone) {
      const windowMember: Member = {};
      this.setWindow = windowMember;
      // A premise queued ahead rides the same batch and answers first: the
      // window is these statements' own positions.
      const first = this.queued.length;
      for (const statement of statements)
        this.#queueJudged(
          statement.sql,
          statement.context,
          windowMember,
          judged,
          statement.probe
        );
      const results = await this.submit(true, windowMember);
      return this.settleSubmitted(() => {
        try {
          return parse(results.slice(first, first + statements.length));
        } catch (error) {
          throw this.failure(error, "result", windowMember);
        }
      });
    }
    // Awaited, not returned: the envelope sentinel rejects this promise before
    // any I/O, and an `async` frame would adopt it a microtask later, which
    // workerd's process emulation reports as unhandled ({@link answer}).
    return await this.dispatchSetMutations(statements, parse, judged);
  }
  /**
   * The operation's own set-oriented statements on the plain execute path, and
   * the durable phase of the write it just made.
   *
   * This is the shipped `runBorrowedStatementAtomic` situation
   * (`write-engine/OperationExecutor.ts:1558-1645`): no envelope, so this
   * transport is the only one that learns whether the write became durable, and
   * it says so on the same rail {@link submit} uses ({@link WriteOutcomeSeam}) —
   * `mayBeVisible` when its statement fails without proving rollback, and
   * `committedSegment` once its statement has returned, whether or not the
   * result then decodes. Only a STANDALONE operation running outside any region
   * owns that answer: a borrowed operation's caller owns the scope (the shipped
   * `runLinearOn` notifies nothing), and this operation's own region answers
   * with its rollback.
   */
  private dispatchSetMutations(
    statements: readonly {
      readonly sql: Sql;
      readonly context: QueryExecutionContext;
    }[],
    parse: (results: readonly QueryResult<unknown>[]) => unknown,
    judged?: JudgedWrite
  ): Promise<unknown> {
    return this.dispatch(statements.length, true, async () => {
      const owned = this.ownership === "standalone" && !this.ownRegionOpen;
      const results: QueryResult<unknown>[] = [];
      try {
        for (const statement of statements)
          results.push(
            await this.#judging(judged, () =>
              this.transport._execute(statement.sql, statement.context)
            )
          );
      } catch (error) {
        // The same sentence {@link submit}'s catch states about its batch: a
        // dispatched write whose rollback the transport cannot prove may be
        // visible, and a unique rejection is the one class that proves it.
        if (owned && !(error instanceof UniqueConstraintError))
          await this.stateWriteOutcome(this.writeOutcome?.mayBeVisible, error);
        throw error;
      }
      let decoded: { readonly failure: unknown } | { readonly value: unknown };
      try {
        decoded = { value: parse(results) };
      } catch (error) {
        // Translated HERE, once, so the one value this arm holds is the one the
        // caller would have received: {@link run}'s catch is the only other
        // translator of a decoding failure, and it no longer recognises this
        // one once {@link stateWriteOutcome} has composed it with a listener's.
        // The registered malformed-scalar refusal must stay primary, so the
        // public failure — not the internal `InvalidScalarResult` — is what is
        // both published to the cache seam and thrown.
        decoded = { failure: this.failure(error, "result") };
      }
      if (owned)
        await this.stateWriteOutcome(
          this.writeOutcome?.committedSegment,
          "failure" in decoded ? decoded.failure : undefined
        );
      if ("failure" in decoded) throw decoded.failure;
      return decoded.value;
    });
  }
  /**
   * Lower one INSERT shape; callers own grouping, chunking, and output. A
   * `judged` create reads its rows from their own values under their
   * placement (R4, {@link Queries.producedSource}), in the same statement.
   */
  /**
   * `rows`, each {@link InsertValue} its stamps left replaced by what it
   * computes for these rows, now that every other value is final; `rows`
   * itself when none holds one.
   */
  async #computed(model: AnyModel, rows: Input[]): Promise<Input[]> {
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
          ...(this.ownership !== "batch-preparation" && {
            read: async (statement: Sql) =>
              (await this.answer({ sql: statement } as Query, false, model))
                .rows,
          }),
        },
        at
      );
      for (const [position, index] of at.entries())
        computed[index]![field] = values[position];
    }
    return computed ?? rows;
  }
  /** An update's `values`, each InsertValue replaced by its expression. */
  async #settled(model: AnyModel, given: Input): Promise<Input> {
    return Object.values(given).some((value) => value instanceof InsertValue)
      ? (await this.#computed(model, [given]))[0]!
      : given;
  }
  #insertStatement(
    model: AnyModel,
    columns: readonly string[],
    rows: readonly Input[],
    skipDuplicates = false,
    judged?: PreparedSelector
  ): Sql {
    const q = this.queries;
    const mutations = this.driver.adapter.mutations;
    if (columns.length === 0) {
      // A row of defaults only has no value to judge before it is written.
      if (judged)
        throw new UnsupportedOperationError(
          `Cannot create a '${model["~"].names.ts!}' row that writes no field: its placement is judged on the values it writes.`
        );
      return mutations.insertDefault(q.table(model));
    }
    const duplicate = skipDuplicates
      ? mutations.skipDuplicates(q.columnName(model, columns[0]!))
      : undefined;
    const select = judged && q.producedSource(model, columns, rows, judged);
    const statement = mutations.insert(
      q.table(model),
      columns.map((field) => q.columnName(model, field)),
      select
        ? { select }
        : rows.map((row) =>
            columns.map((field) => q.fieldValue(model, field, row[field]))
          ),
      duplicate?.prefix
    );
    return duplicate?.suffix
      ? sql`${statement} ${duplicate.suffix}`
      : statement;
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
  /**
   * One `RETURNING` list for several projections over the same row, each
   * field once: the first projection to name a field lowers it.
   */
  #returned(projections: readonly (PreparedProjection | undefined)[]): Sql[] {
    const named = new Set<string>();
    const columns: Sql[] = [];
    for (const projection of projections) {
      if (projection === undefined) continue;
      const lowered = this.queries.lowerProjection(projection);
      for (const [index, field] of projection.fields.entries()) {
        if (named.has(field.name)) continue;
        named.add(field.name);
        columns.push(lowered[index]!);
      }
    }
    return columns;
  }
  /** `statement` answering with `projection` ({@link answersInStatement}). */
  #answering(
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
   * `statement`, an `UPDATE` or `DELETE` without `RETURNING`, and how the
   * number of rows it wrote is read: the provider's affected count, or where
   * that count also counts the rows a foreign key's cascade changed
   * (`capabilities.countsCascadedChanges`, D1), one returned marker per row
   * the statement itself wrote.
   */
  #counted(statement: Sql): {
    readonly statement: Sql;
    readonly count: (response: QueryResult<unknown>) => number;
  } {
    const a = this.driver.adapter;
    if (!a.capabilities.countsCascadedChanges)
      return { statement, count: (response) => response.rowCount };
    return {
      statement: sql`${statement} ${a.mutations.returning(sql.raw("1"))}`,
      count: (response) => response.rows.length,
    };
  }
  /**
   * Complete one set mutation through its single count/projection tail.
   * `marked`: a column the statement returns beside a scalar projection,
   * read off each row.
   */
  #completeSetMutation(
    model: AnyModel,
    statement: Sql,
    projection?: PreparedProjection,
    single?: () => Error,
    judged?: JudgedWrite,
    marked?: { readonly column: Sql; readonly read: (row: Input) => void }
  ): Promise<unknown> {
    const counted = projection ? undefined : this.#counted(statement);
    const output = projection
      ? this.#answering(model, statement, projection, marked && [marked.column])
      : counted!.statement;
    return this.#setMutation(
      output,
      this.statementContext(model, this.operation),
      (result) => {
        if (!projection) return { count: counted!.count(result) };
        const rows = result.rows.map(record);
        if (marked) for (const row of rows) marked.read(row);
        return this.published(
          this.publishedProjection(projection.shape, rows),
          single
        );
      },
      judged
    );
  }
  override createMany(
    model: AnyModel,
    rows: Input[],
    projection?: undefined,
    skipDuplicates?: boolean,
    single?: () => Error,
    refusal?: PreparedGuardFailure
  ): Promise<{ count: number }>;
  override createMany(
    model: AnyModel,
    rows: Input[],
    projection?: PreparedProjection,
    skipDuplicates?: boolean,
    single?: () => Error,
    refusal?: PreparedGuardFailure
  ): Promise<unknown>;
  /**
   * `refusal`: what a refused row reports (R4); a root write's
   * {@link forbidden} by default.
   */
  override async createMany(
    model: AnyModel,
    given: Input[],
    projection?: PreparedProjection,
    skipDuplicates = false,
    single?: () => Error,
    refusal?: PreparedGuardFailure
  ): Promise<unknown> {
    // A DIRECT empty `createMany` is Prisma's documented `{ count: 0 }` no-op.
    // A batch-PREPARED one is a different question, and the shipped engine
    // refused it: `$transaction([createMany({ data: [] })])` built its plan
    // during array preparation and `buildCreateManyPlan` raised "No data to
    // insert for createMany." there (`assertBatchPreparable`). The mode is the
    // fact, and this is the owner that holds it — admission cannot, because the
    // same payload is admitted on both routes.
    if (given.length === 0) {
      if (this.ownership === "batch-preparation")
        throw new QueryEngineError("No data to insert for createMany.");
      return this.emptyBulkResult(projection);
    }
    const rows = await this.#computed(model, given);
    const q = this.queries;
    const adapter = this.driver.adapter;
    const placed = this.#produced(model);
    const judged = placed && { model, refusal: refusal ?? this.#forbidden };
    const recoverableSkip =
      skipDuplicates &&
      adapter.mutations.skipDuplicatesStrategy === "recoverableUniqueError";
    // Without RETURNING, rows whose keys are all known before the INSERT are
    // inserted together and read back by those keys; a generated key, or a
    // duplicate that may be skipped, needs each row's own statement.
    const rereads =
      projection !== undefined &&
      !adapter.capabilities.supportsReturning &&
      !skipDuplicates &&
      this.ownership !== "batch-preparation" &&
      rows.every((row) =>
        this.schema.keys(model).every((key) => row[key] !== undefined)
      );
    if (
      recoverableSkip ||
      (projection && !adapter.capabilities.supportsReturning && !rereads)
    ) {
      if (this.ownership === "batch-preparation")
        throw this.incompletePreparation;
      const suppress =
        recoverableSkip && this.admitsSuppression("duplicate rows");
      const identityPlans = projection
        ? rows.map((row) => {
            const missing = this.schema
              .keys(model)
              .filter((field) => row[field] === undefined);
            const generated = this.#insertIdField(model, missing);
            if (missing.length > 0 && generated === undefined)
              throw new TransactionError(
                `Driver '${this.driver.driverName}' cannot locate one selected createMany row after insertion.`,
                { meta: this.errorMeta }
              );
            return generated;
          })
        : undefined;
      const members = this.prepareMembers(() => rows);
      const identities: Input[] = [];
      let count = 0;
      for (const [index, row] of members.entries()) {
        const columns = Object.keys(row);
        // A skipped duplicate inserts nothing and locates nothing.
        const statement = this.#insertStatement(
          model,
          columns,
          [row],
          skipDuplicates && !recoverableSkip,
          placed
        );
        const context = this.statementContext(model, this.operation);
        let response: QueryResult<unknown> | undefined;
        if (suppress) {
          response = await this.executeMember(async () => {
            try {
              return await this.dispatch(1, false, () =>
                this.withMemberRollback((driver) =>
                  this.#judging(judged, () =>
                    driver._execute(statement, context)
                  )
                )
              );
            } catch (error) {
              if (error instanceof UniqueConstraintError) return undefined;
              throw error;
            }
          }, row);
        } else {
          response = await this.executeMember(
            () =>
              this.dispatch(1, false, () =>
                this.#judging(judged, () =>
                  this.transport._execute(statement, context)
                )
              ),
            row
          );
        }
        if (!response?.rowCount) continue;
        count += response.rowCount;
        if (!identityPlans) continue;
        const generated = identityPlans[index];
        if (generated && response.insertId === undefined)
          throw new QueryEngineError(
            "INSERT did not produce the required record identity"
          );
        identities.push({
          ...this.schema.identity(model, row),
          ...(generated ? { [generated]: response.insertId } : {}),
        });
      }
      if (!projection) return { count };
      return identities.length
        ? this.finishTerminals(
            this.seriesQueries(projection, identities),
            (published) => this.published(published, single)
          )
        : this.published([], single);
    }
    // A relation projection reaches here only where the write's own statement
    // answers it (`Commands.rootCreate`, one row): each statement answers.
    const returning =
      projection && !rereads
        ? (mutation: Sql) => this.#answering(model, mutation, projection)
        : undefined;
    const groups: { readonly columns: string[]; readonly rows: Input[] }[] = [];
    for (const row of rows) {
      const columns = Object.keys(row);
      const preceding = groups.at(-1);
      if (
        columns.length === 0 ||
        !preceding ||
        preceding.columns.length !== columns.length ||
        columns.some((column, index) => preceding.columns[index] !== column)
      )
        groups.push({ columns, rows: [row] });
      else preceding.rows.push(row);
    }
    const limit = normalizedBindParameterLimit(
      this.driver.maxBindParametersPerStatement
    );
    const statements: {
      sql: Sql;
      context: QueryExecutionContext;
      probe?: Sql | undefined;
    }[] = [];
    for (const group of groups) {
      if (group.columns.length === 0) {
        for (const _row of group.rows) {
          let statement = this.#insertStatement(
            model,
            [],
            [_row],
            false,
            placed
          );
          if (returning) statement = returning(statement);
          statements.push({
            sql: statement,
            context: this.statementContext(model, this.operation),
          });
        }
        continue;
      }
      const chunks = compileBindBudgetChunks(
        group.rows.length,
        limit,
        (start, end) => {
          const mutation = this.#insertStatement(
            model,
            group.columns,
            group.rows.slice(start, end),
            skipDuplicates,
            placed
          );
          return returning ? returning(mutation) : mutation;
        }
      );
      // A batch that rolls back on one chunk's refusal names that chunk by
      // asking each its SELECT again, as a lone create does ({@link submit}).
      for (const chunk of chunks)
        statements.push({
          sql: chunk.statement,
          context: this.statementContext(model, this.operation),
          probe:
            placed && this.usesBatch
              ? q.producedSource(
                  model,
                  group.columns,
                  group.rows.slice(chunk.start, chunk.end),
                  placed
                )
              : undefined,
        });
    }
    const inserted = this.setMutations(
      statements,
      (results) => {
        const written = results.reduce(
          (count, result) => count + result.rowCount,
          0
        );
        // Triggers may legitimately suppress rows. The provider's affected count
        // is the completed write's answer, never a reason to fail after commit.
        if (!projection || rereads) return { count: written };
        const raw: Input[] = [];
        for (const result of results) raw.push(...result.rows.map(record));
        // A grouped insert split by the provider's bind budget answers in
        // several windows of the SAME projection and carries no per-window row
        // count of its own — the shortfall above is this fold's own contract.
        return this.published(
          this.publishedProjection(projection.shape, raw),
          single
        );
      },
      judged
    );
    if (!rereads) return inserted;
    await inserted;
    return this.finishTerminals(
      this.seriesQueries(
        projection,
        rows.map((row) => this.schema.identity(model, row))
      ),
      (published) => this.published(published, single)
    );
  }
  /**
   * A top-level upsert as ONE statement — the shipped engine's first upsert
   * path ("an eligible `ON CONFLICT` fold has no planning read", the retired
   * `write-engine/ATOM.md` §15, `operations/upsert.ts` `buildUpsert`): the
   * create's INSERT, the adapter's conflict clause over the addressed unique
   * key carrying the update language's assignments, and the projection's
   * RETURNING. The plan admits it only where the conditional form cannot run
   * at all — the array route, which can issue no planning read (D-46) — so
   * every other route keeps the conditional form and its pins. Zero rows back
   * is a provider anomaly, not a premise: `single` throws it.
   *
   * Each assignment is the payload's value over the CONFLICTING row's own
   * column, named through its table (`Queries.updateValue`): a counter reads
   * `"<table>"."visits" + $n`, because PostgreSQL also sees `excluded` there
   * and refuses a bare column as ambiguous.
   */
  override async upsertOne(
    model: AnyModel,
    given: Input,
    updates: Input,
    target: readonly string[],
    projection?: PreparedProjection,
    single?: () => Error,
    upserted?: (created: boolean) => void,
    found?: Query
  ): Promise<unknown> {
    const q = this.queries;
    const adapter = this.driver.adapter;
    const row = (await this.#computed(model, [given]))[0]!;
    const columns = Object.keys(row);
    const placed = this.#produced(model);
    const insert = this.#insertStatement(model, columns, [row], false, placed);
    const table = model["~"].names.sql!;
    const conflict = adapter.mutations.onConflict(
      sql.join(
        target.map((field) =>
          adapter.identifiers.escape(q.columnName(model, field))
        ),
        ", "
      ),
      adapter.mutations.onConflictUpdate(
        sql.join(
          Object.entries(updates).map(([field, value]) =>
            adapter.set.assign(
              q.column(model, field),
              q.updateValue(model, field, value, q.column(model, field, table))
            )
          ),
          ", "
        )
      )
    );
    const judged = placed && { model, refusal: this.#forbidden };
    // Without a marker, the arm is the probe of the key the statement
    // conflicts on, read in the same unit just before it.
    if (found)
      return this.setMutations(
        [
          {
            sql: found.sql,
            context: this.statementContext(model, this.operation),
          },
          {
            sql: this.#answering(
              model,
              sql`${insert} ${conflict}`,
              projection!
            ),
            context: this.statementContext(model, this.operation),
          },
        ],
        ([probe, written]) => {
          upserted!(probe!.rows.length === 0);
          return this.published(
            this.publishedProjection(
              projection!.shape,
              written!.rows.map(record)
            ),
            single
          );
        },
        judged
      );
    const marker = upserted && adapter.mutations.upserted;
    // The arm the statement took rides its RETURNING beside the row.
    const flag = "__viborm_inserted";
    return this.#completeSetMutation(
      model,
      sql`${insert} ${conflict}`,
      projection,
      single,
      judged,
      marker && {
        column: adapter.identifiers.aliased(marker, flag),
        read: (row) => {
          upserted!(row[flag] === true);
          delete row[flag];
        },
      }
    );
  }
  /**
   * @param captured The keys of the rows to write, already read under lock
   * by the caller: the capture this update would otherwise take.
   */
  override async updateMany(
    model: AnyModel,
    selector: PreparedSelector,
    given: Input,
    limit?: number,
    projection?: PreparedProjection,
    single?: () => Error,
    captured?: readonly Input[]
  ): Promise<unknown> {
    const values = await this.#settled(model, given);
    const q = this.queries;
    const adapter = this.driver.adapter;
    const assignments = this.#updateAssignments(model, values);
    // The rows this update produces, judged at the predicates that judged
    // its candidates (R4); a tombstone's are a delete's, and none.
    const produced = (target: PreparedSelector, limited?: number) =>
      this.#produce(
        model,
        values,
        selector.judgement,
        (alias) => q.lowerSelector(target, alias),
        limited
      );
    const judged = {
      model,
      refusal: this.#updateRefusal(model, selector.judgement),
    };
    // A value read from a table the UPDATE joins (`JoinedValue`): only the
    // rows the join names are written, so only they are captured.
    const joined = Object.values(given).find(
      (value): value is JoinedValue => value instanceof JoinedValue
    );
    const write = (where: Sql | undefined) => {
      const sets = sql.join(assignments, ", ");
      const join = joined?.join(q, model["~"].names.sql!);
      return join
        ? adapter.mutations.updateFrom(
            q.table(model),
            sets,
            q.settleRows(join.source),
            join.on,
            where
          )
        : adapter.mutations.update(q.table(model), sets, where);
    };
    // A relation carrier reads other rows, which no RETURNING can carry: the
    // post-image is re-read by identity, as without RETURNING, unless the
    // write's own statement can read them (`answersInStatement`).
    if (
      projection &&
      !this.answersInStatement(model, projection, "update", values)
    ) {
      const named =
        joined &&
        ((alias: string) => {
          const join = joined.join(q, alias);
          return q.settleRows(
            adapter.filters.some(
              adapter.subqueries.existsCheck(join.source, join.on)
            )
          );
        });
      const identities =
        captured ??
        (await this.captureMutationIdentities(
          model,
          selector,
          limit,
          undefined,
          undefined,
          named
        ));
      if (identities.length === 0) return this.published([], single);
      const judgedTarget = produced(
        q.andSelectors(model, [
          selector,
          q.includeIdentities(model, identities),
        ])
      );
      await this.#capturedMutation(
        model,
        selector,
        identities,
        limit,
        (target) => write(judgedTarget ?? target),
        // A delete that writes a tombstone still answers as a delete.
        this.operation === "delete" || this.operation === "deleteMany"
          ? "deleteMany"
          : "updateMany",
        judgedTarget && judged,
        named
      );
      return this.finishTerminals(
        this.seriesQueries(
          projection,
          identities.map((identity) =>
            this.#updatedIdentity(model, identity, values)
          ),
          "updateMany"
        ),
        (published) => this.published(published, single)
      );
    }
    this.#packagedPresence(model, selector, single);
    let where: Sql | undefined;
    const statement = q.sharing(() => {
      where = produced(selector, limit);
      const limited = where
        ? { where }
        : q.lowerMutationLimit(model, selector, limit);
      const mutation = write(limited.where);
      return limited.suffix ? sql`${mutation} ${limited.suffix}` : mutation;
    });
    return this.#completeSetMutation(
      model,
      statement,
      projection,
      single,
      where && judged
    );
  }
  override async deleteMany(
    model: AnyModel,
    selector: PreparedSelector,
    limit?: number,
    projection?: PreparedProjection,
    single?: () => Error
  ): Promise<unknown> {
    const q = this.queries;
    const adapter = this.driver.adapter;
    // A relation carrier reads rows a DELETE is removing, so it can never ride
    // that statement's RETURNING: the row's shape is captured BEFORE the
    // removal, under the same locked capture the non-returning branch owns,
    // unless the write's own statement can read it (`answersInStatement`).
    if (projection && !this.answersInStatement(model, projection, "delete")) {
      const rows: Input[] = [];
      // A scalar projection naming every key is captured and read in ONE
      // locked statement; any other is read by the captured keys.
      const captured = returningSafeProjection(projection) && projection;
      const identities = await this.captureMutationIdentities(
        model,
        selector,
        limit,
        captured,
        rows
      );
      if (rows.length < identities.length)
        for (const query of this.seriesQueries(projection, identities))
          rows.push(...(await this.read(query, false, false, model)));
      if (identities.length === 0) return this.published([], single);
      await this.#capturedMutation(
        model,
        selector,
        identities,
        limit,
        (target) => adapter.mutations.delete(q.table(model), target),
        "deleteMany"
      );
      return this.published(rows, single);
    }
    this.#packagedPresence(model, selector, single);
    const statement = q.sharing(() => {
      const limited = q.lowerMutationLimit(model, selector, limit);
      const mutation = adapter.mutations.delete(q.table(model), limited.where);
      return limited.suffix ? sql`${mutation} ${limited.suffix}` : mutation;
    });
    return this.#completeSetMutation(model, statement, projection, single);
  }
  private async captureMutationIdentities(
    model: AnyModel,
    selector: PreparedSelector,
    limit: number | undefined,
    projection?: PreparedProjection | false,
    read?: Input[],
    condition?: (alias: string) => Sql
  ): Promise<Input[]> {
    if (this.ownership === "batch-preparation")
      throw this.incompletePreparation;
    const keys = this.schema.keys(model);
    // A projection naming every key is the capture itself on an interactive
    // session: its rows land in `read`, read under the same lock.
    const whole =
      projection &&
      !this.usesBatch &&
      keys.every((key) => projection.fields.some((f) => f.name === key));
    const query = this.queries.select(
      model,
      {
        ...(whole
          ? {}
          : { select: Object.fromEntries(keys.map((field) => [field, true])) }),
        take: limit,
      },
      undefined,
      {
        selector,
        condition,
        forUpdate: !this.usesBatch,
        ...(whole && { projection }),
      }
    );
    // An interactive session takes `FOR UPDATE`, so the ROWS IT CAPTURED
    // cannot change underneath it until the mutation. A row that JOINS the
    // selection afterwards is a different guarantee, which no row lock gives —
    // and it is not this mutation's row: the captured set is the set this
    // statement is about (D-65). A batch-only transport holds nothing across
    // two statements, so N4 (plan §4, D-52) gives the capture the shape the
    // series capture already has: it is a SEGMENT OF ITS OWN — the barrier
    // submits whatever this unit has queued and reads in the same native
    // batch — and the premises {@link requireCapturedSet} states inside the
    // MUTATION's batch are what protect it there. No lock is claimed where
    // none exists.
    if (whole) {
      const response = await this.answer(query, false, model);
      read!.push(...this.queries.decodeProjection(query.shape, response.rows));
      return this.queries
        .decodeQuery(query, response.rows, true)
        .map((row) => this.schema.identity(model, row));
    }
    const rows = this.usesBatch
      ? await this.flush(query)
      : await this.read(query, true, false, model);
    return rows.map((row) => this.schema.identity(model, row));
  }
  /**
   * What the captured set claims, asserted inside the batch that mutates it.
   *
   * The capture named the rows that matched when it ran, and rule 5 forbids
   * treating an observed set as a lasting truth. So the mutation's own batch
   * carries the claim as statements AHEAD OF THE WRITE: as the unit begins,
   * every captured row is present and a member of the selection, and — when
   * the capture took the whole selection rather than a limited slice — no row
   * has joined it. A capture already stale there aborts the atomic unit before
   * anything is written, which is what a count after the mutation cannot do.
   *
   * These premises answer WHERE THEY STAND and claim nothing about the effect:
   * between the last of them and the write a row can still stop matching, as
   * `g4/release/closure/fcpg/` measured on native PostgreSQL. That window
   * belongs to the write, which carries the selector itself
   * ({@link capturedTarget}, D-65) — such a row is not mutated, and the
   * cardinality sentence is the answer for it.
   *
   * Only on the batch route: an interactive session captured `FOR UPDATE`.
   */
  private async requireCapturedSet(
    model: AnyModel,
    selector: PreparedSelector,
    identities: readonly Input[],
    limit: number | undefined,
    changed: () => Error,
    condition?: (alias: string) => Sql
  ): Promise<void> {
    if (!this.usesBatch) return;
    const q = this.queries;
    for (const identity of identities)
      this.requirePresent(
        q.select(model, { take: 1 }, undefined, {
          selector,
          identity,
          condition,
        }),
        changed()
      );
    // A LIMITED capture took one valid slice of the selection; another row
    // joining it does not make that slice the wrong answer, so the complement
    // is claimed only for a capture that took the whole set.
    if (limit !== undefined) return;
    await this.requireAbsent(
      q.select(model, { take: 1 }, undefined, {
        selector: q.andSelectors(model, [
          selector,
          q.excludeIdentities(model, identities),
        ]),
        condition,
      }),
      changed()
    );
  }
  /**
   * A root selected UPDATE/DELETE over the set {@link captureMutationIdentities}
   * captured: the premises that set owes, its own statement, and the one
   * judgement of the row count it affected, on either transport. On the batch
   * route the statement rides the same batch its premises are in, so the write
   * never runs when a premise disagrees. What the two verbs do NOT share stays
   * with them: an UPDATE reads its final rows after this returns, a DELETE
   * read them before calling it.
   *
   * ONE fact at two positions, and the count is how the second one is read.
   * The premises {@link requireCapturedSet} queues ahead of the write say the
   * captured rows are still the selection AS THE UNIT BEGINS; the write's own
   * selector ({@link capturedTarget}, handed to the verb's `mutation`) says it
   * AT THE EFFECT (D-65). A captured row this statement did not match is a row
   * the operation was asked to change and did not — the verb's registered
   * cardinality sentence, never a silent success publishing the captured rows.
   * The verb is named, not read from {@link operation}: a root `delete` that
   * captures answers with `deleteMany`'s sentence, as it always has. The statement is built after the premises, where a lowered
   * target's aliases continue the last premise statement's scope.
   *
   * Failure and commit stay separate facts there. On an operation-owned
   * interactive transaction the owner rolls back; on a batch that already
   * ACKNOWLEDGED, what it committed stands and the sentence is a RESULT-phase
   * failure that says so ({@link failure}: `atomicity: "segment"` with this
   * operation's committed segments). It replays nothing and erases no
   * progress, because a check after dispatch cannot undo the batch it judges.
   *
   * The count is judged HERE, INSIDE {@link settleSubmitted}, because this is
   * the boundary at which the operation's answer to its batch is known. Read
   * one statement later it would be read after the hold was already released:
   * the batch acknowledged, a write-outcome listener that failed while it did
   * is HELD, and a settlement that saw only the decoded response would call
   * that an answer that SUCCEEDED and publish the listener's failure alone —
   * losing both the operation's own failure and the progress attached to it.
   * Transport success is not result success, and a settlement region holds
   * every judgement that can still turn this operation's answer into a failure
   * (repair prompt §3). The premises {@link requireCapturedSet} states owe the
   * same sentence.
   */
  async #capturedMutation(
    model: AnyModel,
    selector: PreparedSelector,
    identities: readonly Input[],
    limit: number | undefined,
    mutation: (target: Sql | undefined) => Sql,
    verb: "updateMany" | "deleteMany",
    judged?: JudgedWrite,
    condition?: (alias: string) => Sql
  ): Promise<void> {
    const changed = () =>
      new TransactionError(
        `${verb} selected-row cardinality changed during its locked mutation.`,
        { meta: this.errorMeta }
      );
    await this.requireCapturedSet(
      model,
      selector,
      identities,
      limit,
      changed,
      condition
    );
    const { statement, count } = this.#counted(
      this.queries.sharing(() =>
        mutation(this.capturedTarget(model, selector, identities))
      )
    );
    const context = this.statementContext(model, this.operation);
    const answered = (response: QueryResult<unknown>) => {
      if (count(response) !== identities.length)
        throw this.failure(changed(), "result");
    };
    if (!this.usesBatch) {
      answered(
        await this.dispatch(1, false, () =>
          this.#judging(judged, () =>
            this.transport._execute(statement, context)
          )
        )
      );
      return;
    }
    // Its own answer, by its own position: the batch also carries this
    // mutation's premises ahead of it, {@link submit} answers the queued
    // statements alone (its guards are sliced off), and the row count this
    // mutation reports is the one the captured set is judged against.
    const index = this.queued.length;
    // A set-oriented statement's window: a merely uncertain outcome is no
    // record series of its own ({@link failure}), as `setMutations` states it.
    const member: Member = {};
    this.setWindow = member;
    this.#queueJudged(statement, context, member, judged);
    const responses = await this.submit(true, member);
    await this.settleSubmitted(() => {
      const response = responses[index];
      if (!response)
        throw new TransactionError(
          `Driver '${this.driver.driverName}' omitted the prepared result for operation '${this.operation}'.`,
          { meta: this.errorMeta }
        );
      answered(response);
    });
  }
  /**
   * WHERE a captured root mutation writes: the rows the capture named, AND the
   * selector it captured them by (D-65).
   *
   * The identity set alone addresses a row by a key that WAS in the selection;
   * the selector is what that row must still satisfy for this statement to be
   * about it. Carrying both leaves a row that stopped matching alone — the
   * answer the interactive route's `FOR UPDATE` already gave, now given by the
   * statement itself on every route — and the row count each verb checks turns
   * the shortfall into its cardinality sentence. It is the prepared meaning the
   * capture already ran, composed at `Queries` and never respelled as public
   * syntax, in one statement: no lock, no protocol, no second reading.
   *
   * A `limit` is not restated here. The capture took that slice already
   * ({@link captureMutationIdentities}'s `take`), so the identity set IS the
   * bound, and a row that joined the selection since is outside this set.
   */
  private capturedTarget(
    model: AnyModel,
    selector: PreparedSelector,
    identities: readonly Input[]
  ): Sql | undefined {
    const q = this.queries;
    return q.lowerMutationLimit(
      model,
      q.andSelectors(model, [selector, q.includeIdentities(model, identities)]),
      undefined
    ).where;
  }
  #updatedIdentity(model: AnyModel, identity: Input, values: Input): Input {
    const q = this.queries;
    return Object.fromEntries(
      this.schema
        .keys(model)
        .map((field) => [
          field,
          Object.hasOwn(values, field)
            ? q.updateValue(
                model,
                field,
                values[field],
                q.fieldValue(model, field, identity[field])
              )
            : identity[field],
        ])
    );
  }
  /**
   * The scratch of the unit being assembled, made by the first statement that
   * stores into it.
   *
   * It belongs to the DISPATCHED UNIT and not to the attempt (D-58). Where the
   * transport admits temporaries the table is session-scoped, and a transport
   * that pins no session (Neon HTTP) ends its session with the batch, so a unit
   * that named a table an EARLIER segment created named nothing at all; where it
   * does not (D1) the adapter spells an ordinary table that outlives the batch.
   * Either way every unit that needs one mints its own batch id, and
   * {@link closeScratch} deletes that id's rows where the unit ends.
   */
  private ensureScratch(): string {
    const attempt = this.attempt;
    if (attempt.scratchId) return attempt.scratchId;
    const references = getAdapterInternals(this.driver.adapter).batchRefs;
    attempt.scratchId = crypto.randomUUID();
    for (const setup of references.setup(attempt.scratchId)) this.queue(setup);
    return attempt.scratchId;
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
   * The scratch dies with the unit that made it: its rows are deleted inside
   * that unit's own batch, and the id is spent, so the next unit that stores a
   * produced value creates its own ({@link ensureScratch}).
   */
  protected override closeScratch(): void {
    const attempt = this.attemptStore;
    if (attempt?.scratchId === undefined) return;
    this.queue(
      getAdapterInternals(this.driver.adapter).batchRefs.cleanup(
        attempt.scratchId
      )
    );
    attempt.scratchId = undefined;
  }
  #insertIdField(
    model: AnyModel,
    produced: readonly string[]
  ): string | undefined {
    if (produced.length !== 1) return undefined;
    const field = produced[0]!;
    return model["~"].state.scalars[field]!["~"].state.autoGenerate?.kind ===
      "increment"
      ? field
      : undefined;
  }
  override async insert(
    model: AnyModel,
    given: Input,
    demanded: ReadonlySet<string>,
    member: Member,
    operation = "create",
    producer?: object,
    membership?: MembershipParent,
    refusal?: PreparedGuardFailure,
    answer?: StatementAnswer
  ): Promise<Input> {
    const q = this.queries;
    const adapter = this.driver.adapter;
    const values = (await this.#computed(model, [given]))[0]!;
    const fields = Object.keys(values);
    const placed = this.#produced(model);
    const judged = placed && { model, refusal: refusal ?? this.#forbidden };
    let statement = this.#insertStatement(
      model,
      fields,
      [values],
      false,
      placed
    );
    // The SELECT the judged INSERT reads its row from: asked again after a
    // batch rolled back, it fails as the INSERT did ({@link submit}).
    const probe =
      placed && this.usesBatch && fields.length > 0
        ? q.producedSource(model, fields, [values], placed)
        : undefined;
    // A field an InsertValue computed in SQL holds its generating expression:
    // a consumer reads the stored value, from RETURNING on this route, by the
    // row's key on the batch route, never the expression evaluated again.
    const computed = Object.keys(given).filter(
      (field) =>
        given[field] instanceof InsertValue && values[field] instanceof Sql
    );
    const produced = [...demanded].filter(
      (field) =>
        values[field] === undefined ||
        (!this.usesBatch && computed.includes(field))
    );
    const context = this.statementContext(model, operation);
    if (!this.usesBatch) {
      const producedProjection = produced.length
        ? q.prepareProjection(
            model,
            {
              select: Object.fromEntries(
                produced.map((field) => [field, true])
              ),
            },
            true
          )
        : undefined;
      const insertIdField = adapter.capabilities.supportsReturning
        ? undefined
        : this.#insertIdField(model, produced);
      if (
        produced.length &&
        !adapter.capabilities.supportsReturning &&
        insertIdField === undefined
      )
        throw new Error(
          "Returning generated values requires RETURNING support or one generated increment field"
        );
      if (adapter.capabilities.supportsReturning) {
        const returned = this.#returned([
          answer?.projection,
          producedProjection,
        ]);
        if (returned.length)
          statement = sql`${statement} ${adapter.mutations.returning(
            sql.join(returned, ", ")
          )}`;
      }
      this.attempt.rejectedInsert = undefined;
      let response: QueryResult<Input>;
      try {
        response = await this.dispatch(1, false, () =>
          this.#judging(judged, () =>
            this.transport._execute<Input>(statement, context)
          )
        );
      } catch (error) {
        if (producer && error instanceof UniqueConstraintError)
          this.attempt.rejectedInsert = { error, producer };
        throw error;
      }
      const producedRows =
        insertIdField === undefined
          ? response.rows
          : response.insertId === undefined
            ? []
            : [{ [insertIdField]: response.insertId }];
      const producedValues = producedProjection
        ? q.decodeProjection(producedProjection.shape, producedRows, true)[0]
        : undefined;
      if (produced.length && producedValues === undefined)
        throw new QueryEngineError(
          "INSERT did not produce the required record"
        );
      if (answer) answer.row = response.rows[0];
      const written: Input = { ...values };
      for (const field of computed) delete written[field];
      return { ...written, ...producedValues };
    }
    // The row this one is a MEMBER of, re-pinned in every segment AFTER the one
    // that writes it. A membership correlates BY VALUE, so once another row
    // holds the parent's referenced value the correlation answers with IT — and
    // a segment that has committed cannot be taken back, so what the next one
    // trusts is re-read in it. Inside the segment that writes the membership
    // there is nothing to re-pin: the write is still this unit's own and its
    // rollback takes it back, which is what {@link Continuation.declaring}
    // says. The sentence and the query are the pair
    // `CommandExecution.captureSeries` states for the same fact on a captured
    // series — one owner, restated here for the row a continuation follows.
    if (membership)
      (this.continuationList ??= []).push({
        declaring: true,
        model: membership.model,
        state: () =>
          q.select(membership.model, {
            where: membership.where(),
            select: Object.fromEntries(
              this.schema.keys(membership.model).map((field) => [field, true])
            ),
          }),
        failure: () =>
          new NestedWriteError(
            `Cannot ${membership.verb} relation '${membership.relation}': parent record changed across a committed segment.`,
            membership.relation
          ),
      });
    const published: Input = { ...values };
    for (const field of computed) {
      delete published[field];
      if (!demanded.has(field)) continue;
      const keys = this.schema.keys(model);
      if (
        keys.some(
          (key) => values[key] === undefined || values[key] instanceof Sql
        )
      )
        throw new UnsupportedOperationError(
          `Cannot read '${model["~"].names.ts!}.${field}' back in this batch: the row's key is generated by the database.`
        );
      published[field] = adapter.subqueries.scalar(
        assembleAdapterSelect(adapter, {
          columns: q.column(model, field),
          from: q.table(model),
          where: adapter.operators.and(
            ...keys.map((key) =>
              adapter.operators.eq(
                q.column(model, key),
                q.fieldValue(model, key, values[key])
              )
            )
          ),
        })
      );
    }
    if (produced.length) {
      const references = getAdapterInternals(adapter).batchRefs;
      const insertIdField = this.#insertIdField(model, produced);
      // The exact identity scratch carries ONE generated increment key through
      // the batch: the dialect stores it from the statement that produced it —
      // its own RETURNING inside a data-modifying CTE where the provider can
      // mutate in one (PostgreSQL, D-50), or the statement-local last insert
      // id (SQLite, MySQL) — and every later statement reads the reference
      // back with the key's own width. How it is stored is the dialect's
      // (`batchRefs.storeInsertedKey`), not chosen here.
      const storeInsertedKey = references.storeInsertedKey;
      const carriesIdentity =
        insertIdField !== undefined && storeInsertedKey !== undefined;
      if (!carriesIdentity) {
        if (
          !adapter.capabilities.supportsReturning ||
          adapter.capabilities.supportsCteWithMutations
        )
          throw new Error(
            "The driver cannot return generated values for this atomic batch without an exact row identity"
          );
        // The next segment must prove the actual stored owner, including supplied row-key fields.
        const returned = [
          ...new Set([...this.schema.keys(model), ...demanded]),
        ];
        const select = Object.fromEntries(
          returned.map((field) => [field, true])
        );
        const projection = q.prepareProjection(model, { select }, true);
        const resultIndex = this.queued.length;
        const inserted = this.#queueJudged(
          sql`${statement} ${adapter.mutations.returning(
            sql.join(q.lowerProjection(projection), ", ")
          )}`,
          context,
          member,
          judged,
          probe
        );
        if (producer) this.attempt.recordInsertProducer(inserted, producer);
        const responses = await this.submit(true, member);
        const stored = await this.settleSubmitted(() => {
          try {
            const rows = q.decodeProjection(
              projection.shape,
              responses[resultIndex]!.rows,
              true
            );
            if (!rows[0])
              throw new TypeError(
                "INSERT RETURNING did not produce the required record"
              );
            return rows[0];
          } catch (error) {
            throw this.failure(error, "result", member);
          }
        });
        (this.continuationList ??= []).push({
          model,
          state: () =>
            q.select(model, {}, undefined, {
              projection,
              identity: stored,
            }),
          failure: () =>
            new TransactionError(
              `Created record '${model["~"].names.ts!}' changed across a generated-output segment boundary.`,
              { meta: { model: this.modelName, operation: this.operation } }
            ),
        });
        return { ...values, ...stored };
      }
      const scratchId = this.ensureScratch();
      const key = String(this.attempt.nextField++);
      const [producing, ...storing] = storeInsertedKey(
        scratchId,
        key,
        statement,
        adapter.identifiers.escape(q.columnName(model, insertIdField))
      );
      const inserted = this.#queueJudged(
        producing!,
        context,
        member,
        judged,
        probe
      );
      if (producer) this.attempt.recordInsertProducer(inserted, producer);
      for (const store of storing) this.queue(store);
      const expression = adapter.expressions.cast(
        references.read(scratchId, key),
        physicalField(this.schema, model, insertIdField).scalar["~"].state
          .type === "bigint"
          ? "bigint"
          : "integer"
      );
      this.attempt.publishScratchValue({
        model,
        field: insertIdField,
        expression,
      });
      published[insertIdField] = expression;
    } else {
      const inserted = this.#queueJudged(
        statement,
        context,
        member,
        judged,
        probe
      );
      if (producer) this.attempt.recordInsertProducer(inserted, producer);
    }
    return published;
  }
  /**
   * A located row's UPDATE that locates it ITSELF, on the interactive route:
   * the statement's WHERE is the `selector` the locating read would have
   * taken, and it returns the stored row that read would have bound
   * (`projection`), as the row leaves it. The UPDATE takes the row lock that
   * read's `FOR UPDATE` took and re-evaluates the selector over the row's
   * current version as it did, so a miss is the read's miss, `missing`. The
   * produced row is judged as {@link updateMany}'s single-row fold judges it:
   * the selector states the old row's judgement in this same statement.
   */
  override async updateLocated(
    model: AnyModel,
    selector: PreparedSelector,
    given: Input,
    projection: PreparedProjection,
    missing: () => Error,
    operation = "update",
    refusal?: PreparedGuardFailure,
    answer?: StatementAnswer
  ): Promise<Input> {
    const values = await this.#settled(model, given);
    const q = this.queries;
    const adapter = this.driver.adapter;
    let produced: Sql | undefined;
    const statement = q.sharing(() => {
      produced = this.#produce(model, values, selector.judgement, (alias) =>
        q.lowerSelector(selector, alias)
      );
      return adapter.mutations.update(
        q.table(model),
        sql.join(this.#updateAssignments(model, values), ", "),
        produced ?? q.lowerMutationLimit(model, selector, undefined).where
      );
    });
    const judged = produced
      ? {
          model,
          refusal: refusal ?? this.#updateRefusal(model, selector.judgement),
        }
      : undefined;
    const response = await this.dispatch(1, false, () =>
      this.#judging(judged, () =>
        this.transport._execute<Input>(
          sql`${statement} ${adapter.mutations.returning(
            sql.join(this.#returned([answer?.projection, projection]), ", ")
          )}`,
          this.statementContext(model, operation)
        )
      )
    );
    const row = q.decodeProjection(projection.shape, response.rows, true)[0];
    if (!row) throw missing();
    if (answer) answer.row = response.rows[0];
    return row;
  }
  /**
   * @param current The row's values as they stand NOW, before this statement:
   * its identity and every value an assignment of this update computes from.
   * ONE meaning answers all three of this path's questions — which row the
   * statement addresses, what the arithmetic starts from, and which row the
   * non-RETURNING readback names — because they are all the same row at the
   * same moment. A correlated arm may already have moved it (`ON UPDATE
   * CASCADE`) before this statement runs, and the caller's one reader of a
   * field's runtime value (`CommandAttempt.read`, D-58) answers the key the
   * cascade left it at. An address beside a STALE capture named two different
   * rows, and the readback then found none (FC-02A). The row's ORIGINAL
   * observation is a different fact and belongs to the consumers that need
   * what was SEEN — a choice's conditional skip, a captured junction row —
   * not to this statement.
   */
  override async update(
    model: AnyModel,
    current: Input,
    given: Input,
    member: Member,
    operation = "update",
    demanded: ReadonlySet<string> = new Set(),
    missing?: () => Error,
    judgement?: RowJudgement,
    refusal?: PreparedGuardFailure,
    answer?: StatementAnswer
  ): Promise<Input> {
    if (Object.keys(given).length === 0) return {};
    // A field an InsertValue computes holds its expression, read back after
    // the write, never published as the expression.
    const computed = Object.keys(given).filter(
      (field) => given[field] instanceof InsertValue
    );
    const values = await this.#settled(model, given);
    const q = this.queries;
    const adapter = this.driver.adapter;
    const identity = this.schema.identity(model, current);
    const written = { ...values };
    // What this update PUBLISHES to its dependents: the values it observed,
    // never the payload it submitted. The payload is the update language and
    // `Queries.prepareUpdate` is its one interpreter (U4); the question "which
    // value will this field hold?" is the key-reconciliation reader's, and
    // `CommandAttempt.read` already answers it from `Assignments.stated` for
    // every field this update does not observe.
    const published: Input = {};
    // The demanded fields whose value only the PROVIDER can compute and the
    // batch scratch cannot carry: the scratch reads back as an integer, so an
    // `int` field is the only domain that travels as an expression. N4 (plan
    // §4, D-52) stops refusing the rest — under N1 a value an earlier write of
    // this operation produces is taken as an ORDERED OBSERVATION of the row
    // AFTER that write, through the same barrier a dependent lookup uses
    // ({@link flush}: the queued unit and the read in one native batch, the
    // consumer's own write in the next). The scratch keeps carrying the
    // integer keys it carries today, and the observation owns nothing else:
    // it is the existing read, placed behind the existing write.
    const observed: string[] = [];
    if (this.usesBatch) {
      for (const field of demanded) {
        const value = values[field];
        // A payload that NAMES a value — a literal, a bound expression, or the
        // `{ set: … }` envelope — leaves nothing for the provider to evaluate,
        // so it needs no scratch and no capability refusal: the reader resolves
        // the same value the row's own write submits. Only an OPERATION
        // (`{ increment: 2 }`) has a value that exists after the provider
        // computes it, and only that value has to travel through the scratch.
        if (wholeValue(value) && !computed.includes(field)) continue;
        const state = physicalField(this.schema, model, field).scalar["~"]
          .state;
        // R-D3 (Arnaud, 2026-09-15) gave the batch-only publication gap a
        // public identity because the engine had no answer for it. N4 gives it
        // an answer instead: the value is OBSERVED after the write rather than
        // published through a scratch that cannot hold it. A package prepared
        // for the array owner can issue no read of its own, and {@link submit}
        // states that fact when the observation is flushed — this operation
        // requires dynamic execution (D-46), the array owner's control-flow
        // value, not a refusal the caller sees.
        if (state.type !== "int" || computed.includes(field)) {
          observed.push(field);
          continue;
        }
        const references = getAdapterInternals(adapter).batchRefs;
        const scratchId = this.ensureScratch();
        const key = String(this.attempt.nextField++);
        // The UPDATE and every consumer use this one evaluated value in the same batch.
        this.queue(
          references.store(
            scratchId,
            key,
            q.updateValue(
              model,
              field,
              value,
              q.fieldValue(model, field, current[field])
            )
          )
        );
        const expression = adapter.expressions.cast(
          references.read(scratchId, key),
          "integer"
        );
        this.attempt.publishScratchValue({ model, field, expression });
        written[field] = published[field] = expression;
      }
    }
    // The row this update produces, judged at the predicates that judged
    // the row it located (R4).
    // Its candidate is the identity alone: what judged the row it located
    // is stated again over the row it produces, in this statement.
    let produced: Sql | undefined;
    const statement = q.sharing(() => {
      produced = this.#produce(
        model,
        written,
        judgement,
        (alias) => q.lowerIdentity(model, identity, alias),
        undefined,
        false
      );
      return adapter.mutations.update(
        q.table(model),
        sql.join(this.#updateAssignments(model, written), ", "),
        produced ?? q.lowerIdentity(model, identity)
      );
    });
    const judged = produced
      ? { model, refusal: refusal ?? this.#updateRefusal(model, judgement) }
      : undefined;
    const context = this.statementContext(model, operation);
    const returns = adapter.capabilities.supportsReturning;
    if (!this.usesBatch && (demanded.size || (answer && !returns))) {
      const fields = [...demanded];
      const select = Object.fromEntries(fields.map((field) => [field, true]));
      const projection = q.prepareProjection(model, { select }, true);
      if (!returns) {
        await this.dispatch(1, false, () =>
          this.#judging(judged, () =>
            this.transport._execute(statement, context)
          )
        );
        if (answer) {
          // The read below answers the operation's result too, with the
          // columns a RETURNING would have carried: no read after it.
          const response = await this.answer(
            {
              sql: assembleAdapterSelect(adapter, {
                columns: sql.join(
                  this.#returned([
                    answer.projection,
                    fields.length > 0 ? projection : undefined,
                  ]),
                  ", "
                ),
                from: q.table(model),
                where: q.lowerIdentity(
                  model,
                  this.#updatedIdentity(model, identity, values)
                ),
                forUpdate: true,
              }),
            } as Query,
            false,
            model
          );
          if (!response.rows[0])
            throw (
              missing?.() ??
              new TypeError("UPDATE did not produce the required record")
            );
          answer.row = response.rows[0];
          return {
            ...published,
            ...(fields.length > 0
              ? q.decodeProjection(projection.shape, response.rows, true)[0]
              : {}),
          };
        }
        // This read answers "which row did the UPDATE just write?", and only a
        // CURRENT read can: under REPEATABLE READ a consistent read answers
        // from the snapshot this transaction opened plus its OWN changes, so a
        // statement that affected NO row leaves the snapshot's copy standing
        // and the check below sees a row that is not there. The lock is the
        // same one the UPDATE itself took on every row it did write, so on the
        // ordinary path it costs nothing and the comment it replaces — the
        // mutation's locked capture protects this read — becomes true of this
        // statement rather than of a plan-time probe that may no longer hold
        // it (`Selection.insertsWhenAbsent`).
        const rows = await this.read(
          q.select(model, {}, undefined, {
            forUpdate: true,
            projection,
            identity: this.#updatedIdentity(model, identity, values),
          }),
          true
        );
        if (!rows[0])
          throw (
            missing?.() ??
            new TypeError("UPDATE did not produce the required record")
          );
        return { ...published, ...rows[0] };
      }
      const response = await this.dispatch(1, false, () =>
        this.#judging(judged, () =>
          this.transport._execute<Input>(
            sql`${statement} ${adapter.mutations.returning(
              sql.join(this.#returned([answer?.projection, projection]), ", ")
            )}`,
            context
          )
        )
      );
      const rows = q.decodeProjection(projection.shape, response.rows, true);
      if (!rows[0])
        throw (
          missing?.() ??
          new TypeError("UPDATE RETURNING did not produce the required record")
        );
      if (answer) answer.row = response.rows[0];
      return { ...published, ...rows[0] };
    }
    if (answer && !this.usesBatch && adapter.capabilities.supportsReturning) {
      const response = await this.dispatch(1, false, () =>
        this.#judging(judged, () =>
          this.transport._execute<Input>(
            sql`${statement} ${adapter.mutations.returning(
              sql.join(this.#returned([answer.projection]), ", ")
            )}`,
            context
          )
        )
      );
      answer.row = response.rows[0];
      return published;
    }
    await this.#effect(statement, context, member, judged);
    if (observed.length === 0) return published;
    // The ordered observation: the write is queued, and the read that answers
    // the dependent rides the same native batch BEHIND it, so what it reads is
    // what this update wrote. The row is addressed by the identity this update
    // leaves it at — `updatedIdentity` names every key the payload changes —
    // and the value comes back decoded, a literal for the consumer's own write
    // in the next batch (D-51's succession of statements).
    const projection = q.prepareProjection(
      model,
      { select: Object.fromEntries(observed.map((field) => [field, true])) },
      true
    );
    const rows = await this.flush(
      q.select(model, {}, undefined, {
        projection,
        identity: this.#updatedIdentity(model, identity, values),
      }),
      member
    );
    if (!rows[0])
      throw new TypeError("UPDATE did not produce the required record");
    return { ...published, ...rows[0] };
  }
  /**
   * Several rows {@link update} would write one at a time with the same
   * `values` and nothing to return, as ONE statement per bind budget: the
   * rows `identities` names, judged as each one's own UPDATE judges it, so a
   * refused row refuses the statement as it refused its own.
   */
  override async updateRows(
    model: AnyModel,
    identities: readonly Input[],
    values: Input,
    member: Member,
    operation: string,
    judgement: RowJudgement | undefined,
    refusal: PreparedGuardFailure | undefined
  ): Promise<void> {
    const q = this.queries;
    const adapter = this.driver.adapter;
    // Whether the rows' produced values are judged is a fact of `values` and
    // `judgement`, the same for every chunk.
    let produced: Sql | undefined;
    const chunks = compileBindBudgetChunks(
      identities.length,
      normalizedBindParameterLimit(this.driver.maxBindParametersPerStatement),
      (start, end) => {
        const selector = q.includeIdentities(
          model,
          identities.slice(start, end)
        );
        return q.sharing(() => {
          produced = this.#produce(model, values, judgement, (alias) =>
            q.lowerSelector(selector, alias)
          );
          return adapter.mutations.update(
            q.table(model),
            sql.join(this.#updateAssignments(model, values), ", "),
            produced ?? q.lowerSelector(selector)!
          );
        });
      }
    );
    const judged = produced
      ? { model, refusal: refusal ?? this.#updateRefusal(model, judgement) }
      : undefined;
    for (const chunk of chunks)
      await this.#effect(
        chunk.statement,
        this.statementContext(model, operation),
        member,
        judged
      );
  }
  /**
   * Has this captured slot already been spent — and, if it had not, spend it.
   *
   * One walk down {@link SpentSlots}, so the ask and the record are one act:
   * no caller can spend a slot without asking, and none can ask without
   * spending. The leaf's presence IS the answer.
   */
  #spendSlot(table: string, values: readonly unknown[]): boolean {
    let level = (this.vacatedMemberships ??= new Map());
    const path: unknown[] = [table, ...values];
    let spent = true;
    for (const [index, key] of path.entries()) {
      const leaf = index === path.length - 1;
      let next = level.get(key);
      if (next === undefined) {
        spent = false;
        next = leaf ? true : new Map();
        level.set(key, next);
      }
      if (!leaf) level = next as SpentSlots;
    }
    return spent;
  }
  override async link(
    edge: Extract<Membership, { kind: "junction" }>,
    values: Input,
    member: Member,
    captured?: Input,
    written?: Input
  ): Promise<void> {
    const adapter = this.driver.adapter;
    const q = this.queries;
    const columns = linkMembers(edge).map(({ pair }) => pair.junctionField);
    if (captured) {
      if (columns.every((field) => Object.is(captured[field], values[field]))) {
        return;
      }
      // ONE captured pair is ONE slot transition. Entries that resolve to the
      // same target carry the SAME captured owner — the plan read the slot once
      // — so a second vacate would delete a row THIS operation already removed,
      // and the direct arm's postcondition would read its own effect as a
      // concurrent change. The transition is spent here, once per captured
      // pair, and the membership INSERT that follows is idempotent either way
      // (the conflict clause, or the anti-join select where the dialect has no
      // targeted upsert). The postcondition keeps the race it exists for: the
      // FIRST vacate of a pair another owner took.
      //
      // The spent pairs are a TREE keyed by the captured VALUES themselves —
      // the edge's table, then its columns in the edge's own order — because a
      // junction column carries whatever domain the referenced key carries. A
      // `Map` compares with SameValueZero, so a `bigint` key is compared as the
      // bigint it is; spelling the pair instead could not: `JSON.stringify`
      // THROWS on a `bigint` (`TypeError: Do not know how to serialize a
      // BigInt`, escaping this engine's error surface) and COLLIDES on a value
      // whose class carries no `toJSON`, where two distinct `decimal` pairs
      // both spell `{}` and the second would skip a vacate it never spent.
      // A value-keyed level compares two decoded objects by identity, which
      // errs the safe way: a pair the plan did not capture twice is vacated,
      // and the postcondition still guards that vacate.
      const slot = columns.map((field) => captured[field]);
      if (!this.#spendSlot(edge.table, slot)) {
        const remove = adapter.mutations.delete(
          adapter.identifiers.table(edge.table),
          q.junctionWhere(edge, captured)
        );
        const context = this.statementContext(edge.source, "update");
        if (this.usesBatch) this.queue(remove, context, member);
        else {
          const response = await this.dispatch(1, false, () =>
            this.transport._execute(remove, context)
          );
          if (response.rowCount !== 1) {
            const failure = new TransactionError(
              `Concurrent membership change on the singular polymorphic member of relation '${edge.name}': the captured owner's membership was already removed; retry to converge.`
            );
            failure.meta.raceable = true;
            throw failure;
          }
        }
      }
    }
    const operands = this.#linkOperands(edge, values, written);
    if (!adapter.capabilities.supportsTargetedUpsert) {
      const targetAlias = q.alias();
      const membershipAlias = q.alias();
      // The target membership is an outer join, not a target-table subquery.
      const select = assembleAdapterSelect(adapter, {
        columns: sql.join(operands, ", "),
        from: q.table(edge.target, targetAlias),
        joins: [
          adapter.joins.left(
            adapter.identifiers.table(edge.table, membershipAlias),
            q.junctionWhere(edge, values, membershipAlias)
          ),
        ],
        where: adapter.operators.and(
          ...edge.targetSide.members.map((pair) =>
            adapter.operators.eq(
              q.column(edge.target, pair.referencedField, targetAlias),
              q.fieldValue(
                edge.target,
                pair.referencedField,
                values[pair.junctionField]
              )
            )
          ),
          adapter.operators.isNull(
            adapter.identifiers.column(membershipAlias, columns[0]!)
          )
        ),
      });
      await this.#effect(
        adapter.mutations.insert(
          adapter.identifiers.table(edge.table),
          this.#linkColumns(edge, written),
          { select }
        ),
        this.statementContext(edge.source, "update"),
        member
      );
      // No targeted conflict update here, so a link that existed takes what
      // this call stated from a second statement, whichever one ran.
      const sets = this.#linkUpdates(edge, written);
      if (sets)
        await this.#effect(
          adapter.mutations.update(
            adapter.identifiers.table(edge.table),
            sets,
            q.junctionWhere(edge, values)
          ),
          this.statementContext(edge.source, "update"),
          member
        );
      return;
    }
    await this.#effect(
      this.#linkStatement(edge, [operands], written),
      this.statementContext(edge.source, "update"),
      member
    );
  }
  /**
   * Several memberships of one junction as ONE statement per bind budget: the
   * rows {@link link} inserts one at a time where it captured nothing, each
   * idempotent through the same conflict clause, so only where the dialect
   * has a targeted upsert (elsewhere {@link link} states each membership as
   * its own anti-join).
   */
  override async linkMany(
    edge: Extract<Membership, { kind: "junction" }>,
    rows: readonly Input[],
    member: Member
  ): Promise<void> {
    const operands = rows.map((values) => this.#linkOperands(edge, values));
    for (const chunk of compileBindBudgetChunks(
      operands.length,
      normalizedBindParameterLimit(this.driver.maxBindParametersPerStatement),
      (start, end) => this.#linkStatement(edge, operands.slice(start, end))
    ))
      await this.#effect(
        chunk.statement,
        this.statementContext(edge.source, "update"),
        member
      );
  }
  #linkOperands(
    edge: Extract<Membership, { kind: "junction" }>,
    values: Input,
    written?: Input
  ): Sql[] {
    const members = linkMembers(edge).map(({ side, pair }) =>
      this.queries.fieldValue(
        side.model,
        pair.referencedField,
        values[pair.junctionField]
      )
    );
    const declared = edge.declared;
    if (!declared) return members;
    const defaults = this.#linkDefaults(edge, written);
    const filled = this.schema.createValues(
      declared.model,
      Object.fromEntries(defaults.map((field) => [field, undefined]))
    );
    return [
      ...members,
      ...defaults.map((field) =>
        this.queries.fieldValue(declared.model, field, filled[field])
      ),
      ...Object.keys(written ?? {}).map((field) =>
        this.queries.fieldValue(declared.model, field, written![field])
      ),
    ];
  }
  /** The defaults {@link linkOperands} fills: a declared model's, but what's stated. */
  #linkDefaults(
    edge: Extract<Membership, { kind: "junction" }>,
    written?: Input
  ): readonly string[] {
    const defaults = this.schema.linkDefaults(
      edge.declared!.model,
      new Set(linkMembers(edge).map(({ pair }) => pair.junctionField))
    );
    return written
      ? defaults.filter((field) => !Object.hasOwn(written, field))
      : defaults;
  }
  /** The columns {@link linkOperands} supplies, in its order. */
  #linkColumns(
    edge: Extract<Membership, { kind: "junction" }>,
    written?: Input
  ): string[] {
    const members = linkMembers(edge).map(({ pair }) => pair.junctionField);
    const declared = edge.declared;
    if (!declared) return members;
    return [
      ...members,
      ...[
        ...this.#linkDefaults(edge, written),
        ...Object.keys(written ?? {}),
      ].map((field) => physicalField(this.schema, declared.model, field).name),
    ];
  }
  /**
   * What a link that already exists takes: the columns the call stated, and an
   * `updatedAt()` beside them, as a direct update of the row would. Nothing,
   * and so no statement, where the call stated nothing.
   */
  #linkUpdates(
    edge: Extract<Membership, { kind: "junction" }>,
    written: Input | undefined
  ): Sql | undefined {
    const declared = edge.declared;
    if (!(declared && written) || Object.keys(written).length === 0)
      return undefined;
    const q = this.queries;
    const model = declared.model;
    const stamped = Object.keys(model["~"].state.scalars).filter(
      (field) =>
        model["~"].state.scalars[field]!["~"].state.autoGenerate?.kind ===
          "updatedAt" && !Object.hasOwn(written, field)
    );
    const stamps = this.schema.createValues(
      model,
      Object.fromEntries(stamped.map((field) => [field, undefined]))
    );
    return sql.join(
      Object.entries({ ...written, ...stamps }).map(([field, value]) =>
        this.driver.adapter.set.assign(
          q.column(model, field),
          q.fieldValue(model, field, value)
        )
      ),
      ", "
    );
  }
  /** Junction rows inserted where absent, through the edge's own conflict target. */
  #linkStatement(
    edge: Extract<Membership, { kind: "junction" }>,
    rows: Sql[][],
    written?: Input
  ): Sql {
    const adapter = this.driver.adapter;
    const columns = this.#linkColumns(edge, written);
    const sets = this.#linkUpdates(edge, written);
    return sql`${adapter.mutations.insert(
      adapter.identifiers.table(edge.table),
      columns,
      rows
    )} ${adapter.mutations.onConflict(
      sql.join(
        (edge.declared?.key ?? columns).map((column) =>
          adapter.identifiers.escape(column)
        ),
        ", "
      ),
      sets
        ? adapter.mutations.onConflictUpdate(sets)
        : adapter.mutations.onConflictNothing!()
    )}`;
  }
  override async remove(
    edge: Membership,
    source: Input | undefined,
    target: Input | undefined,
    keep: Input[],
    member: Member
  ): Promise<void> {
    const a = this.driver.adapter;
    const q = this.queries;
    // A removal takes related rows whose link the call may write, as its
    // lookups do: a member it cannot see keeps its link. A clear refuses a
    // member it sees and may not unlink (R3), as a disconnect naming it does.
    const domain = q.domainOf(edge.target, "related", linkJudgement(edge));
    const visible = q.domainOf(edge.target, "related");
    const keeping = (alias?: string) =>
      keep.length
        ? a.operators.not(
            a.operators.or(
              ...keep.map((row) =>
                q.lowerIdentity(
                  edge.target,
                  this.schema.identity(edge.target, row),
                  alias
                )
              )
            )
          )
        : undefined;
    const kept = keeping();
    if (target === undefined && domain !== visible)
      await this.requireAbsent(
        q.select(
          edge.target,
          {
            take: 1,
            select: Object.fromEntries(
              this.schema.keys(edge.target).map((field) => [field, true])
            ),
          },
          { edge, parent: source! },
          { selector: visible, unless: domain, condition: kept }
        ),
        new NestedWriteError(
          `Cannot clear relation '${edge.name}': a connected record may not be disconnected by this call.`,
          edge.name
        )
      );
    if (edge.kind === "junction") {
      const statement = q.sharing(() => {
        const conditions: Sql[] = [];
        for (const [side, values] of [
          [edge.sourceSide, source],
          [edge.targetSide, target],
        ] as const) {
          if (!values) continue;
          conditions.push(...q.junctionSideConditions(side, undefined, values));
        }
        if (domain) {
          // The join row is the DELETE's own table: its columns are qualified
          // by that table's name, never left to resolve inside the subquery.
          const member = q.alias();
          conditions.push(
            a.operators.exists(
              a.subqueries.existsCheck(
                q.table(edge.target, member),
                a.operators.and(
                  ...edge.targetSide.members.map((pair) =>
                    a.operators.eq(
                      a.identifiers.column(edge.table, pair.junctionField),
                      q.column(edge.target, pair.referencedField, member)
                    )
                  ),
                  q.lowerSelector(domain, member)!
                )
              )
            )
          );
        }
        if (keep.length)
          conditions.push(
            a.operators.not(
              a.operators.or(
                ...keep.map((row) =>
                  a.operators.and(
                    ...q.junctionSideConditions(edge.targetSide, undefined, row)
                  )
                )
              )
            )
          );
        return a.mutations.delete(
          a.identifiers.table(edge.table),
          a.operators.and(...conditions)
        );
      });
      await this.#effect(
        statement,
        this.statementContext(edge.source, "update"),
        member
      );
      return;
    }
    // The rows it unlinks, addressed under `alias` (none: the UPDATE's own
    // table).
    const unlinked = (alias?: string) => {
      const others = keeping(alias);
      return a.operators.and(
        ...edge.pairs.map((pair) =>
          a.operators.eq(
            q.column(edge.target, pair.target, alias),
            q.fieldValue(edge.target, pair.target, source![pair.source])
          )
        ),
        ...(edge.discriminator
          ? [
              a.operators.eq(
                q.column(edge.target, edge.discriminator.field, alias),
                q.value(edge.discriminator.value)
              ),
            ]
          : []),
        ...(target
          ? [
              q.lowerIdentity(
                edge.target,
                this.schema.identity(edge.target, target),
                alias
              ),
            ]
          : []),
        ...(others ? [others] : []),
        ...(domain ? [q.lowerSelector(domain, alias)!] : [])
      );
    };
    const clearability = edge.clearability as Extract<
      Membership["clearability"],
      { kind: "columns" }
    >;
    const cleared = Object.fromEntries(
      clearability.fields.map((field) => [field, null])
    );
    // Each row it unlinks produces a row without the link, judged at what
    // judged its link (R4).
    await this.captureRows(
      edge.target,
      "update",
      { condition: unlinked() },
      cleared
    );
    let produced: Sql | undefined;
    const statement = q.sharing(() => {
      produced = this.#produce(
        edge.target,
        cleared,
        linkJudgement(edge),
        unlinked
      );
      return a.mutations.update(
        q.table(edge.target),
        sql.join(this.#updateAssignments(edge.target, cleared), ", "),
        produced ?? unlinked()
      );
    });
    await this.#effect(
      statement,
      this.statementContext(edge.target, "update"),
      member,
      produced
        ? {
            model: edge.target,
            refusal: nestedRefusal("disconnect", edge.name),
          }
        : undefined
    );
  }
  /** One admitted payload, one prepared update: `Queries` is the sole interpreter. */
  #updateAssignments(model: AnyModel, values: Input): Sql[] {
    return Object.entries(values).map(([field, value]) =>
      this.queries.updateAssignment(model, field, value)
    );
  }
  /**
   * What the row a write of `model` produces is judged at under this call's
   * domain (R4): its placement for a create (no `judgement`), the
   * predicates that judged its old row for an update. `undefined` where
   * nothing judges it.
   */
  #produced(
    model: AnyModel,
    judgement?: RowJudgement
  ): PreparedSelector | undefined {
    return this.queries.domain?.produced(model, judgement);
  }
  /**
   * The WHERE of an UPDATE of `model` that judges the rows it produces
   * (R4, {@link Queries.producedWhere}): the rows `candidates` selects (the
   * first `limit` in key order), each at the predicates that judged its old
   * row (`judgement`) and outside its own subtree for the acyclic relations
   * whose key it writes. `judgedCandidates`: `candidates` states the old
   * row's judgement in the same statement, so a judgement the write cannot
   * change is not stated again. `undefined` where nothing judges them: the
   * statement keeps its own WHERE and its bytes.
   */
  #produce(
    model: AnyModel,
    values: Input,
    judgement: RowJudgement | undefined,
    candidates: (alias: string) => Sql | undefined,
    limit?: number,
    judgedCandidates = true
  ): Sql | undefined {
    const domain = this.queries.domain;
    if (judgement === undefined || domain === undefined) return undefined;
    return this.queries.producedWhere(
      model,
      candidates,
      values,
      domain.produced(
        model,
        judgement,
        judgedCandidates ? Object.keys(values) : undefined
      ),
      domain.cycles(model, judgement),
      limit
    );
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
  /**
   * Dispatch one judged statement: its assertion failing is the write's
   * refusal, raised as `refusal` says, with nothing written.
   */
  async #judging<T>(
    judged: JudgedWrite | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    if (judged === undefined) return run();
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof NestedWriteAssertionError)) throw error;
      throw this.refusal(judged);
    }
  }
  /**
   * Queue one judged statement: the batch that carries it attributes its
   * assertion to `refusal` ({@link submit}); an array owner, to its packaged
   * guard at the same position.
   */
  #queueJudged(
    statement: Sql,
    context: QueryExecutionContext,
    member: Member | undefined,
    judged: JudgedWrite | undefined,
    probe?: Sql
  ): BatchQuery {
    if (judged === undefined) return this.queue(statement, context, member);
    if (this.ownership === "batch-preparation")
      (this.preparedGuardList ??= []).push({
        queryIndex: this.queued.length,
        premise: "exists",
        probe: this.driver.adapter.clauses.select(sql`1`),
        failure: judged.refusal,
        model: judged.model["~"].names.ts!,
        operation: this.operation,
      });
    const queued = this.queue(statement, context, member);
    const reference = this.attemptStore?.scratchId;
    this.attempt.judgeWrite(queued, {
      refusal: this.refusal(judged),
      ...(probe &&
        !(reference !== undefined && probe.values.includes(reference)) && {
          probe,
        }),
    });
    return queued;
  }
  /**
   * A nested `updateMany` / `deleteMany` as ONE correlated statement.
   *
   * The membership and the member filter are both predicates this statement
   * carries, so the operation needs no planning read: the provider answers
   * `WHERE fk = parent AND filter` after every earlier statement of the body
   * has run, which is the shipped `buildUpdateMany` / `buildDeleteMany` shape
   * (`write-engine/RelationWritePart.ts:484-504`, `:674-693`) and rule 6's
   * "keep scalar bulk work set-oriented". Zero matched rows is a silent
   * success, so there is no postcondition to state.
   */
  override async mutateMembers(
    edge: Membership,
    parent: Input,
    selector: PreparedSelector,
    values: Input | undefined,
    member: Member
  ): Promise<void> {
    const q = this.queries;
    const a = this.driver.adapter;
    const model = edge.target;
    let produced: Sql | undefined;
    const statement = q.sharing(() => {
      const filter = q.lowerMutationLimit(model, selector, undefined).where;
      // The rows it produces, judged at what judged them (R4).
      produced =
        values &&
        this.#produce(model, values, selector.judgement, (alias) =>
          a.operators.and(
            q.memberWhere(edge, parent, alias),
            ...(selector.predicate ? [q.lowerSelector(selector, alias)!] : [])
          )
        );
      const where = a.operators.and(
        // The target's own table name is the correlation alias, exactly as the
        // shipped builders passed `getTableName(childScope.model)`.
        q.memberWhere(edge, parent, model["~"].names.sql!),
        ...(filter ? [filter] : [])
      );
      return values
        ? a.mutations.update(
            q.table(model),
            sql.join(this.#updateAssignments(model, values), ", "),
            produced ?? where
          )
        : a.mutations.delete(q.table(model), where);
    });
    // Members a write hook wants come back from the statement itself: after
    // an update, before a delete (`Relations` captures them one by one where
    // the adapter has no RETURNING).
    const kind = values ? "update" : "delete";
    const name = model["~"].names.ts!;
    const sink = writeSinks.get(this.attribution);
    const projection = sink?.wants(name, kind)
      ? q.prepareProjection(model, {})
      : undefined;
    await this.#effect(
      projection
        ? sql`${statement} ${a.mutations.returning(
            sql.join(q.lowerProjection(projection), ", ")
          )}`
        : statement,
      this.statementContext(model, values ? "updateMany" : "deleteMany"),
      member,
      produced
        ? { model, refusal: nestedRefusal("updateMany", edge.name) }
        : undefined,
      projection && {
        shape: projection.shape,
        take: (rows) => sink!.wrote(name, kind, rows),
      }
    );
  }
  override async delete(
    model: AnyModel,
    row: Input,
    member: Member
  ): Promise<void> {
    await this.#effect(
      this.driver.adapter.mutations.delete(
        this.queries.table(model),
        this.queries.lowerIdentity(model, this.schema.identity(model, row))
      ),
      this.statementContext(model, "delete"),
      member
    );
  }
  async #effect(
    statement: Sql,
    context: QueryExecutionContext,
    member: Member,
    judged?: JudgedWrite,
    returned?: {
      readonly shape: ProjectionShape;
      readonly take: (rows: Input[]) => void;
    }
  ): Promise<void> {
    if (this.usesBatch) {
      const queued = this.#queueJudged(statement, context, member, judged);
      if (returned)
        (this.captures ??= []).push({
          statement: queued,
          read: returned,
          take: returned.take,
        });
      return;
    }
    const response = await this.dispatch(1, false, () =>
      this.#judging(judged, () => this.transport._execute(statement, context))
    );
    returned?.take(
      this.queries.decodeProjection(returned.shape, response.rows.map(record))
    );
  }
}

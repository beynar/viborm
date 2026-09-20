import {
  assembleAdapterSelect,
  getAdapterInternals
} from "@adapters/adapter-internals";
import type { AnyDriver } from "@drivers";
import { attachCommitCertainty } from "@drivers/driver-error-context";
import { batchMayContainAssertionCollision } from "@drivers/error-mapping";
import {
  bindExecutionTransactionPhases,
  deriveStatementExecutionContext
} from "@drivers/execution-context";
import { transferPreparedStatement } from "@drivers/prepared-statement-provenance";
import type {
  BatchQuery,
  QueryExecutionContext,
  QueryResult
} from "@drivers/types";
import {
  attachRecordSeriesProgress,
  isVibORMError,
  NESTED_WRITE_ASSERTION_FLOOR_MESSAGE,
  NestedWriteAssertionError,
  NestedWriteError,
  QueryEngineError,
  type RecordSeriesProgress,
  TransactionError,
  UniqueConstraintError,
  VibORMErrorCode
} from "@errors";
import type { AnyModel } from "@schema/model";
import { type Sql, sql } from "@sql";
import {
  compileBindBudgetChunks,
  normalizedBindParameterLimit
} from "../../bind-budget";
import type {
  PreparedBatchGuard,
  PreparedBatchOperation
} from "../../types";
import {
  InvalidScalarResult,
  Queries,
  type PreparedProjection,
  type PreparedSelector,
  type ProjectionShape,
  type Query,
  type Read,
  returningSafeProjection,
  wholeValue,
} from "./query";
import {
  type EngineSchema,
  type Input,
  isReadOperation,
  type Operation,
  record
} from "./schema";
import { type Membership, physicalField } from "./storage";
import { type ScratchPublication, TransportAttempt } from "./transport-attempt";

export type Member = object;

/**
 * The single-row mutations whose returned identity a batch-only, non-returning
 * driver cannot resolve inside its own atomic unit (the shipped
 * `ATOMIC_RESOLUTION_OPERATIONS`).
 */
const ATOMIC_RESOLUTION_OPERATIONS: ReadonlySet<string> = new Set([
  "update",
  "delete",
  "upsert"
]);

export type MemberRollback = <T>(
  execute: (driver: AnyDriver) => Promise<T>,
  context: QueryExecutionContext
) => Promise<T>;

/**
 * Where this operation publishes the DURABLE PHASE of its own writes.
 *
 * The transport is the only thing that knows it, so the transport says it — at
 * the moment it learns it, not afterwards from an error's published meta. That
 * is where the shipped executor says it too: `committedWriteSegment` from the
 * segment's own acknowledgement (`write-engine/OperationExecutor.ts:974-990`)
 * and `writeMayBeVisible` from the branch that records a dispatch it cannot
 * prove rolled back (`:1050-1058`), both before the driver's error is
 * rethrown. The candidate's two corresponding sites are in {@link submit}.
 *
 * `recordSeriesProgress` is therefore the PUBLIC report of a record series and
 * nothing else; no consumer reads a cache signal back out of it
 * (`g4/regression/note.md` "Seam round").
 */
export interface WriteOutcomeSeam {
  /** A write segment of this operation is durable. */
  readonly committedSegment?: () => Promise<void>;
  /** A dispatched write segment cannot be proven rolled back. */
  readonly mayBeVisible?: () => Promise<void>;
}

export type ExecutionBinding =
  | {
      readonly kind: "borrowed-transaction";
      readonly driver: AnyDriver;
      /** MEMBER isolation inside the caller's own scope (array fallback). */
      readonly memberRollback?: MemberRollback;
      /**
       * The caller transferred the OPERATION region: it opened none itself, and
       * the candidate opens exactly one when the operation needs more than one
       * statement. Supplied only by the callback-transaction route, never by
       * the array fallback, which mirrors the shipped `runLinearOn` and opens
       * no operation envelope at all (note §8.4, brief item 11 revision 4).
       */
      readonly operationRegion?: MemberRollback;
      readonly writeOutcome?: WriteOutcomeSeam;
    }
  /**
   * The root situation, stated by name: no borrowed driver and no grant, the
   * operation owns its own standalone envelope. It carries nothing but the
   * write-outcome seam, and an absent binding still means exactly this.
   */
  | { readonly kind: "standalone"; readonly writeOutcome?: WriteOutcomeSeam };

type ExecutionOwnership =
  | "standalone"
  | "borrowed-transaction"
  | "batch-preparation";

/** One member's place in its record series, as a failure reports it. */
type MemberAttribution = {
  readonly path: readonly number[];
  readonly totalMembers: number;
};

/** What an operation that has queued nothing has queued. */
const NO_QUEUED_STATEMENTS: readonly BatchQuery[] = Object.freeze([]);

/**
 * One premise a generated-output continuation re-states in EVERY later segment.
 *
 * A committed segment cannot be taken back, so what the next one trusts is
 * re-read in it: the created record's own identity, and the PARENT row whose
 * referenced value the membership correlates on — a membership is a VALUE, so
 * once another row holds that reference the correlation answers with it. Each
 * carries its own sentence, stated where the premise is declared.
 */
interface Continuation {
  readonly model: AnyModel;
  /**
   * The query this continuation's guard states, built when the GUARD is — a
   * LATER segment — and not when the continuation is declared. A parent whose
   * generated key this unit produced crosses the boundary as a LITERAL (D-58),
   * so a query built at declaration time would still name the spent scratch of
   * the unit that produced it. Stated once and kept ({@link query}).
   */
  readonly state: () => Query;
  query?: Query;
  readonly failure: () => Error;
  /**
   * Declared while THIS batch was being built: the segment that writes what it
   * re-pins has not committed yet, so there is nothing for it to say until the
   * next one ({@link OperationContext.submit} clears it as it dispatches).
   */
  declaring?: boolean;
}
/** What an operation that declared no generated-output continuation has. */
const NO_CONTINUATIONS: readonly Continuation[] = Object.freeze([]);
/**
 * One value a dispatched unit stored in its own scratch and reads back at its
 * boundary, with the projection that decodes it through the field's codec.
 */
type ScratchCarry = {
  readonly query: Query;
  readonly publication: ScratchPublication;
};
/** What a unit that stored no produced value carries across its boundary. */
const NO_SCRATCH_CARRY: readonly ScratchCarry[] = Object.freeze([]);
/**
 * The captured junction slots one attempt has already vacated, keyed by the
 * captured VALUES themselves: the edge's table, then its columns in the edge's
 * own order ({@link OperationContext.spendSlot}).
 */
type SpentSlots = Map<unknown, SpentSlots | true>;

/**
 * The row a created record is a MEMBER of, as its interpreter holds it: the
 * parent's identity AND the value the membership correlates on, which is what
 * separates "this parent" from "whatever row now answers the reference".
 */
export interface MembershipParent {
  readonly model: AnyModel;
  /**
   * The parent's identity and correlated value AS THEY STAND when the guard
   * asks: a key this operation produced is an expression inside the unit that
   * stored it and a literal in every unit after it (D-58), and the interpreter
   * that holds the row answers whichever it now is.
   */
  readonly where: () => Input;
  readonly relation: string;
  readonly verb: string;
}

/** One operation owns its SQL scopes, transport binding, and batch scratch lifetime. */
/**
 * What an ordered observation (N1) requires of the batch it reads in: a row
 * present, or no row outside a membership — asserted as a premise ahead of
 * the read, so the batch aborts before anything commits.
 */
export interface ObservationPremise {
  readonly query: Query;
  readonly present: boolean;
  readonly failure: () => Error;
}
export class OperationContext {
  readonly queries: Queries;
  readonly driver: AnyDriver;
  readonly usesBatch: boolean;
  private readonly ownership: ExecutionOwnership;
  /**
   * Whether this context PREPARES a package for the array owner instead of
   * executing: the one route that can issue no planning read of its own,
   * because every statement it produces rides the owner's batch. Read by the
   * plan to choose a form that needs no such read (D-46).
   */
  get preparesBatch(): boolean {
    return this.ownership === "batch-preparation";
  }
  private readonly memberRollback?: MemberRollback;
  private readonly operationRegion?: MemberRollback;
  /** Where this operation states its own durable write phase ({@link WriteOutcomeSeam}). */
  private readonly writeOutcome?: WriteOutcomeSeam;
  /** True only while the operation's OWN region is the current transport. */
  private ownRegionOpen = false;
  private transport: AnyDriver;
  private attemptStore?: TransportAttempt;
  /**
   * The operation's disposable transport attempt, built on its FIRST use.
   *
   * A read that executes queues nothing — it dispatches its one statement
   * directly ({@link read}) — so it never has an attempt at all, and the write
   * machinery below is the same story field by field: rule 7, a pure read
   * allocates none of it. Every reader that only asks whether this operation
   * has queued anything reads {@link queued}, which answers an empty list
   * without creating an attempt, so no reader can tell absent from empty.
   */
  private get attempt(): TransportAttempt {
    return (this.attemptStore ??= new TransportAttempt());
  }
  /** The statements queued on this operation's attempt; empty until one is. */
  private get queued(): readonly BatchQuery[] {
    return this.attemptStore?.pending ?? NO_QUEUED_STATEMENTS;
  }
  private committedMemberSet?: Set<Member>;
  private memberAttributionMap?: WeakMap<Member, MemberAttribution>;
  private continuationList?: Continuation[];
  /** The captured junction slots this attempt has already vacated ({@link link}). */
  private vacatedMemberships?: SpentSlots;
  /** Generated-output continuations declared so far; none until one is. */
  private get continuationCount(): number {
    return this.continuationList?.length ?? 0;
  }
  private committedSegments = 0;
  private mayHaveCommittedSegment: true | undefined;
  private completedMembers = 0;
  /**
   * The shipped `hasCommittedRecordSeriesProgress` (`write-engine/routing.ts:197`),
   * and the ONE fact the recovery allowance is refused on (Arnaud's D-25).
   *
   * An operation that has acknowledged nothing can be re-planned: a fresh
   * occurrence tree over the same ADMITTED values re-reads committed state and
   * converges. One that has, or may have, committed a segment cannot — a
   * re-plan would write it twice. Dynamic member ADMISSION is not progress:
   * nothing was acknowledged by admitting a member, and requiring it here is
   * what made a raceable assertion over a captured member set unrecoverable.
   */
  private get committedProgress(): boolean {
    return this.committedSegments > 0 || this.mayHaveCommittedSegment === true;
  }
  /**
   * Has this operation admitted a DYNAMIC member — one whose defaults and
   * transforms ran against a row this attempt read?
   *
   * It is not progress, and D-25 removed it from the progress rule above. It
   * still bounds the recovery that REPLAYS the tree that ran: a replayed
   * member would have to be admitted a second time, and admitted values are
   * never validated or transformed again (rule 10). The recovery that
   * RE-PLANS is not bounded by it — a fresh occurrence tree derives its
   * members from the committed state it re-reads.
   */
  private memberAdmissionStarted = false;
  /**
   * The transport window of the operation's OWN set-oriented statement, while
   * one is submitting ({@link setMutations}).
   *
   * A set mutation admits no member: it is the one atomic unit a folded root
   * write — or a relation-free bulk verb — issues on its own behalf, so its
   * window is a transport artifact and not a record-series member. That is the
   * one fact {@link failure} asks to decide whether an uncertain outcome is
   * PUBLIC progress or stays internal.
   */
  private setWindow?: Member;
  /**
   * A write-outcome listener that failed while {@link submit} acknowledged its
   * committed segment, HELD until the operation's own answer to that batch is
   * known ({@link settleSubmitted}).
   *
   * The batch transport acknowledges BEFORE its responses are decoded, so it is
   * the one site where the listener fails first. The shipped `runAtomicBatch`
   * holds it in exactly the same place (`write-engine/OperationExecutor.ts`
   * `committed()` at `:1277-1289` captures `outcomeFailure` instead of throwing
   * it) and composes only once `operation.parse` has answered (`:1332-1343`).
   */
  private heldOutcomeFailure?: { readonly failure: unknown };
  private atomicAssertionRejection?: unknown;
  private incompletePreparationSentinel?: Error;
  /**
   * The preparation sentinel, built on its FIRST use and never before.
   *
   * It is a control-flow value, not a diagnostic: it is compared by identity
   * ({@link isIncompletePreparation}) and thrown by the four preparation-only
   * refusals, and no caller ever sees it — `prepareBatch`
   * (`commands/index.ts:204`) turns it into `undefined`. Constructing it in the
   * field block cost a full V8 stack capture on EVERY operation, prepared or
   * not, which the G4 cutover diagnosis measured as the dominant share of the
   * preparation regression (`g4/cutover/perf-diagnosis.md` §4.1). It stays an
   * `Error` — a branded object would lose the `cause` link
   * `attachRecordSeriesProgress` attaches only to an `Error`
   * (`src/errors/record-series-progress.ts:26-28`) on the one path that wraps
   * it (a batch-preparation prefix flush, `commands/execution.ts:382`).
   */
  private get incompletePreparation(): Error {
    return (this.incompletePreparationSentinel ??= new Error(
      "Raptor 3 operation requires dynamic execution"
    ));
  }
  private preparedParser?: (results: QueryResult<unknown>[]) => unknown;
  private preparedGuardList?: PreparedBatchGuard[];
  /**
   * Failures this operation has ALREADY ANSWERED with, which {@link failure}
   * returns unchanged: the premise it raised about the world (see `published`),
   * and the write-outcome answers the batch transport states once its hold is
   * released ({@link settleSubmitted}, {@link submit}'s catch) — the shipped
   * `runAtomicBatch` throws those exactly as built
   * (`write-engine/OperationExecutor.ts:1306-1309`, `:1336-1343`), while the
   * progress-bearing aggregate of its PROGRESSIVE path is a different failure
   * that is attributed (`:1037-1046`) and is not marked here.
   */
  private answeredFailureSet?: WeakSet<object>;
  private correlationIdValue?: string;
  /**
   * This operation's correlation id, minted on its FIRST read and then stable
   * for the operation's life. The client route always hands its own trusted
   * execution context down ({@link attribution}), so a minted id is read only
   * by an error's `meta` and by a statement context the caller did not supply —
   * paying `crypto.randomUUID()` in the field block spent it on every operation
   * for the ones that never ask (rule 7).
   */
  private get correlationId(): string {
    return (this.correlationIdValue ??= crypto.randomUUID());
  }
  /**
   * The operation's physical envelope. `deferred` is the only state in which the
   * envelope has not been decided yet: it becomes `statement` when the operation
   * reaches its terminal statement without having issued any other, and `open`
   * when it does not (§ {@link run}).
   */
  private envelope: "open" | "deferred" | "statement" = "open";
  private performed = 0;
  private requiresEnvelopeSentinel?: Error;
  /**
   * The envelope sentinel, built on its FIRST use and never before — the same
   * control-flow value as {@link incompletePreparation} and for the same
   * reason. It is raised by {@link dispatch} and caught by its one reader
   * ({@link run}), which compares it by identity; a successful operation never
   * materialises it, and an operation that does pays for exactly one.
   */
  private get requiresEnvelope(): Error {
    return (this.requiresEnvelopeSentinel ??= new Error(
      "Raptor 3 operation requires its physical envelope"
    ));
  }
  constructor(
    readonly schema: EngineSchema,
    factoryDriver: AnyDriver,
    readonly modelName: string,
    readonly operation: Operation,
    binding?: ExecutionBinding,
    prepareBatch = false,
    /**
     * The caller's own trusted execution context. It already carries this
     * operation's model, verb, correlation id, instrumentation and resolved
     * extension chain, and the chain is held by the identity of that exact
     * object, so the candidate passes it through rather than minting a second
     * attribution (g4/unit03/note.md B-4).
     */
    private readonly callerAttribution?: QueryExecutionContext
  ) {
    this.ownership = prepareBatch
      ? "batch-preparation"
      : (binding?.kind ?? "standalone");
    this.driver =
      binding?.kind === "borrowed-transaction" ? binding.driver : factoryDriver;
    this.writeOutcome = binding?.writeOutcome;
    this.memberRollback =
      binding?.kind === "borrowed-transaction"
        ? binding.memberRollback
        : undefined;
    this.operationRegion =
      binding?.kind === "borrowed-transaction"
        ? binding.operationRegion
        : undefined;
    this.transport = this.driver;
    this.usesBatch =
      this.ownership === "batch-preparation" ||
      (this.ownership === "standalone" && !this.driver.supportsTransactions);
    this.queries = new Queries(schema, this.driver.adapter, this.driver.result);
  }
  get attribution(): QueryExecutionContext {
    return (
      this.callerAttribution ?? {
        model: this.modelName,
        operation: this.operation,
        correlationId: this.correlationId
      }
    );
  }
  /**
   * This operation's own facts for an error's meta. Attribution is the driver's
   * context (and may be the caller's trusted object); an error's meta is the
   * candidate's own record and keeps the exact fields it has always carried.
   */
  private get errorMeta(): Record<string, unknown> {
    return {
      model: this.modelName,
      operation: this.operation,
      correlationId: this.correlationId
    };
  }
  /**
   * The attribution ONE statement executes under. A statement compiled for a
   * nested record names that record's model, so a provider failure, a statement
   * transform and an observer name the model whose table the statement already
   * named. The rule: the operation's own context while the models agree, and
   * otherwise the SAME context re-attributed by the snapshot owner, which keeps
   * the correlation id, instrumentation and resolved extension chain
   * (`deriveStatementExecutionContext`). Without a caller context this engine
   * keeps its own minted attribution. (It is the V1 rule verbatim; V1 spelled it
   * in `statementExecutionContext`, retired with the pattern experiment under
   * D-15 and readable at `e8114ed9`.)
   */
  private statementContext(
    model: AnyModel,
    operation: string
  ): QueryExecutionContext {
    const name = model["~"].names.ts!;
    const caller = this.callerAttribution;
    if (!caller)
      return { model: name, operation, correlationId: this.correlationId };
    return caller.model === name
      ? caller
      : deriveStatementExecutionContext(caller, name);
  }
  private queue(
    statement: Sql,
    context: QueryExecutionContext = this.attribution,
    member?: Member
  ): BatchQuery {
    const prepared = this.transport._prepare(statement, context);
    // The DRIVER owns this query's identity. When observers are installed it
    // DEFERS the statement transform and registers the typed `Sql` against the
    // object it returned (`drivers/driver-transaction-base.ts:246-264`), which
    // the statement onion reads back before dispatch — so a snapshot that does
    // not carry the provenance silently drops every deferred transform.
    const query = transferPreparedStatement(prepared, {
      ...prepared,
      context
    });
    this.attempt.pending.push(query);
    if (member) this.attempt.recordMember(member);
    return query;
  }
  prepareMembers<T extends Member>(prepare: () => T[], parent?: Member): T[] {
    this.memberAdmissionStarted = true;
    try {
      const members = prepare();
      const path = parent
        ? (this.memberAttributionMap?.get(parent)?.path ?? [])
        : [];
      const attribution = (this.memberAttributionMap ??= new WeakMap());
      for (const [index, member] of members.entries())
        attribution.set(member, {
          path: [...path, index],
          totalMembers: members.length,
        });
      return members;
    } catch (error) {
      throw this.failure(error, "planning", parent);
    }
  }
  /**
   * A member's boundary is the MEMBER's, and a dispatch commits the whole queue.
   *
   * On a batch-only transport a dispatch is a COMMITTED SEGMENT, so a boundary
   * taken while an enclosing write is still waiting makes that write durable
   * too — a record this series owns no member of, whose own children are not
   * done. Measured: a nested `createMany` of two literal rows committed
   * [INSERT parent, INSERT child#1] at the first member, and the second row's
   * duplicate key then left both behind, where the interactive route rolls the
   * operation back. D-51 admits a succession of segments as PACKAGING only
   * while the two routes keep ONE result, so a member takes its boundary here
   * only where nothing but its own members' writes is waiting.
   *
   * Where an enclosing write IS waiting the boundary is DEFERRED, never
   * dropped: the pendency decides WHEN the series segments, never whether a
   * later member gets to see an earlier one. That is decided where a member
   * OBSERVES — a probe, a choose, a lookup, a capture answered outside this
   * queue ({@link answer}) — because a read outside the queue cannot see a
   * write the queue still holds, and the dependency pass cannot place it for
   * them: a series' members carry no write of EACH OTHER —
   * `Commands.isSeriesMember` stops the SIBLING scan at the series in both
   * pairing walks (they still continue above it), so no member's read is ever
   * placed against another member's write (FC-01 places a member's OWN reads
   * at their execution point; it does not pair them across members). So order
   * is not visibility here, and the member that observes claims the boundary
   * the earlier member earned. Measured without it: a second
   * `INSERT INTO "n5mb_authors"` for the row the first member had already
   * created, `UniqueConstraintError` where the interactive twin answers `ok`.
   *
   * A series whose members only WRITE observes nothing, claims nothing, and
   * stays one unit with its parent — which is the rollback above. Two
   * alternatives were falsified: taking no member boundary at all collapses the
   * per-member packaging `post-prep/g29-member-dependency` and
   * `g29-dependency-choices` pin (10 cells), and claiming the boundary at every
   * read rather than a member's splits the unit an ordered observation is
   * stated inside (`g4/parity/ordered-observation.test.ts` "nothing of the unit
   * commits", `lax-to-one.test.ts`, 8 cells).
   */
  private executingMember?: Member;
  async executeMember<T>(
    execute: () => Promise<T>,
    member?: Member
  ): Promise<T> {
    const enclosingWrite = this.attemptStore?.holdsWrite === true;
    const observing = this.executingMember;
    if (member) this.executingMember = member;
    try {
      const output = await execute();
      if (this.ownership !== "batch-preparation") {
        if (!enclosingWrite) await this.flush(undefined, member);
        this.completedMembers++;
      }
      return output;
    } catch (error) {
      throw this.failure(error, "member", member);
    } finally {
      this.executingMember = observing;
    }
  }
  async executeSkippableMember(
    execute: () => Promise<void>,
    rootProducer: object,
    member: Member
  ): Promise<boolean> {
    const refusal = this.suppressionRefusal();
    if (refusal) throw refusal;
    return this.executeMember(async () => {
      try {
        await this.withMemberRollback(async () => execute());
        return true;
      } catch (error) {
        if (
          error instanceof UniqueConstraintError &&
          this.rejectedProducer(error) === rootProducer
        )
          return false;
        throw error;
      }
    }, member);
  }
  private async withMemberRollback<T>(
    execute: (driver: AnyDriver) => Promise<T>
  ): Promise<T> {
    const outer = this.transport;
    const withinRollback = async (transaction: AnyDriver) => {
      this.transport = transaction;
      try {
        return await execute(transaction);
      } finally {
        this.transport = outer;
      }
    };
    // One rule: a member rollback opens inside whatever scope the operation is
    // CURRENTLY running in. While the operation holds a region of its own, the
    // caller's grant names the caller's scope, and re-entering it while this
    // nested one is active is the exact `TransactionError: … cannot be used
    // while its nested transaction is active` that note §8.4 measured.
    return this.memberRollback && !this.ownRegionOpen
      ? this.memberRollback(withinRollback, this.attribution)
      : outer.withTransaction(withinRollback, undefined, this.attribution);
  }
  suppressionRefusal(): TransactionError | undefined {
    return (this.ownership === "borrowed-transaction" && !this.memberRollback) ||
      this.ownership === "batch-preparation" ||
      this.usesBatch
      ? new TransactionError(
          "Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.",
          {
            meta: {
              driver: this.driver.driverName,
              model: this.modelName,
              operation: this.operation
            }
          }
        )
      : undefined;
  }
  requireSuppression(): void {
    const refusal = this.suppressionRefusal();
    if (refusal) throw refusal;
  }
  failure(
    error: unknown,
    phase: RecordSeriesProgress["phase"],
    member?: Member
  ): unknown {
    if (
      typeof error === "object" &&
      error !== null &&
      this.answeredFailureSet?.has(error)
    )
      return error;
    let failure = error;
    if (error instanceof InvalidScalarResult) {
      const driver = this.driver.driverName;
      const operation = this.operation;
      const scalarType = error.scalarType;
      failure = new QueryEngineError(
        `Driver "${driver}" returned a malformed ${scalarType} scalar for operation "${operation}": ${error.reason}.`,
        { meta: { driver, operation, scalarType } }
      );
    }
    const attribution = member
      ? this.memberAttributionMap?.get(member)
      : undefined;
    // A failure carries record-series progress only when it BELONGS to a record
    // series. A committed segment and a prefix phase are the series the
    // operation already has; an UNCERTAIN outcome is not one on its own, so a
    // set-oriented statement's window ({@link setWindow}) reports nothing while
    // its outcome is merely unknown. That unknown outcome stays internal — the
    // fact itself is unchanged, still gates recovery, and still reaches the
    // cache through the seam `submit` states it on ({@link WriteOutcomeSeam}) —
    // exactly as the shipped executor keeps `progress.mayHaveCommittedSegment`
    // internal for a single operation and rethrows the driver's own error
    // (`write-engine/OperationExecutor.ts:1031-1072`; `attachProgress` :2308
    // reaches only record-series member and invalidation failures).
    // The narrowing is only that arm: a set window whose segment DID commit is
    // a committed segment like any other and keeps publishing its progress,
    // pinned by `tests/raptor3/g4/unit02/malformed-result-cuts.test.ts` cell 1b
    // and `lone-statement-transport.test.ts` row 6.
    const setStatement = member !== undefined && member === this.setWindow;
    return this.usesBatch &&
      (phase === "prefix" ||
        this.committedSegments > 0 ||
        (this.mayHaveCommittedSegment && !setStatement))
      ? attachRecordSeriesProgress(failure, {
          atomicity: "segment",
          phase,
          committedSegments: this.committedSegments,
          committedWriteMembers: this.committedMemberSet?.size ?? 0,
          completedMembers: this.completedMembers,
          ...(attribution?.path.length ? { memberPath: attribution.path } : {}),
          ...(attribution ? { totalMembers: attribution.totalMembers } : {}),
          ...(this.mayHaveCommittedSegment
            ? { mayHaveCommittedSegment: this.mayHaveCommittedSegment }
            : {})
        })
      : failure;
  }
  /**
   * The operation's own region, or `undefined` when this ownership has none.
   *
   * A standalone operation on a transaction-capable driver owns one
   * transaction. A BORROWED operation owns one only when its caller SAID so, by
   * granting `operationRegion` — which the callback-transaction route supplies
   * because it opened no scope of its own. Without that grant a borrowed
   * operation owns none: its caller's scope is the unit, so every statement
   * runs directly on the borrowed driver and a failing one poisons that scope
   * exactly as the shipped `runStatementAtomic` and `runLinearOn` paths leave
   * it. The `memberRollback` grant is never mistaken for it — it is MEMBER
   * isolation only: `tests/raptor3/g3/suppression-retry-contract.test.ts` pins
   * one savepoint per suppressed member and none for the operation, and
   * `tests/raptor3/g3/scope-composition-native.test.ts` fails outright if this
   * operation opens a second scope on the caller's driver while that grant is
   * the array fallback's (note §8.4, measured).
   * An atomic batch and a batch preparation are already their own unit.
   */
  private region():
    | ((execute: (driver: AnyDriver) => Promise<unknown>) => Promise<unknown>)
    | undefined {
    if (this.usesBatch) return undefined;
    if (this.ownership === "borrowed-transaction") {
      const granted = this.operationRegion;
      return granted
        ? (execute) => granted(execute, this.attribution)
        : undefined;
    }
    if (this.ownership !== "standalone") return undefined;
    // This transaction is the ONLY place this operation can learn whether its
    // writes became durable, so the client's cache rail is bound to its phases
    // here — the five steps of the shipped `runTransactionScope`
    // (`write-engine/OperationExecutor.ts:1130-1187`), owned by the context
    // because only the context opens the region.
    const attribution = this.writeOutcome
      ? bindExecutionTransactionPhases(this.attribution, {
          readyToCommit: () => {
            this.regionPhase = "ready";
          },
          committed: () => {
            this.regionPhase = "committed";
          },
        })
      : this.attribution;
    return (execute) =>
      this.driver.withTransaction(execute, undefined, attribution);
  }
  /** How far the region this operation opened got, as its driver reported it. */
  private regionPhase: "pending" | "ready" | "committed" = "pending";
  private openRegionPhase(): void {
    this.regionPhase = "pending";
  }
  /** Run the operation inside the one region it owns. */
  private async withinRegion<T>(
    region: (execute: (driver: AnyDriver) => Promise<unknown>) => Promise<unknown>,
    body: () => Promise<T>
  ): Promise<T> {
    this.openRegionPhase();
    let value: T;
    try {
      value = (await region(async (transaction) => {
        this.transport = transaction;
        this.ownRegionOpen = true;
        try {
          return await body();
        } finally {
          this.transport = this.driver;
          this.ownRegionOpen = false;
        }
      })) as T;
    } catch (error) {
      // The phase the region REACHED is the certainty: a driver that never
      // separated commit from success reports none, and this operation then
      // says nothing rather than guessing.
      const certainty =
        this.regionPhase === "committed"
          ? "committed"
          : this.regionPhase === "ready"
            ? "may-have-committed"
            : undefined;
      if (!certainty) throw error;
      const primary = isVibORMError(error)
        ? attachCommitCertainty(error, certainty)
        : error;
      await this.stateWriteOutcome(
        this.regionPhase === "committed"
          ? this.writeOutcome?.committedSegment
          : this.writeOutcome?.mayBeVisible,
        primary
      );
      throw primary;
    }
    await this.stateWriteOutcome(this.writeOutcome?.committedSegment);
    return value;
  }
  /**
   * ONE rule for the physical envelope: it opens at the first statement that is
   * not the operation's only statement.
   *
   * An operation that reaches its terminal statement having issued no other runs
   * that statement directly — no BEGIN/COMMIT standalone, no savepoint inside a
   * borrowed transaction — which is the shipped `runStatementAtomic` condition
   * (empty planning, exactly one non-guard step: `OperationExecutor.ts`
   * `compileSingleStatementCandidate` + `canExecuteDirectly`) restated in this
   * engine's vocabulary. Any other operation raises {@link requiresEnvelope}
   * BEFORE its first round trip, and the body runs again inside the region;
   * nothing has reached the provider at that point.
   *
   * `single` is the constructed plan's ADMISSIBILITY, not its count
   * (`Commands.plan`): a form whose shape rules one statement out never enters
   * the deferred state, so it opens its region immediately and is constructed
   * exactly once. Every other form is admitted optimistically and the COUNT is
   * answered here, by the construction itself — which is why the rule can be
   * stated in one place and still be the operative decision. `createMany` is
   * the shape that makes the difference observable, and the observable split is
   * the BIND BUDGET, not the spelling of the rows: `schema.scalars` normalizes
   * every row to one column set first, so rows presenting different keys are
   * still one grouped INSERT with no envelope (measured — review follow-up N2),
   * while a batch whose placeholders exceed the provider's limit is constructed
   * twice and raises the sentinel exactly once
   * (`g4/unit02/physical-envelope.test.ts`: 2 statements, 1 transaction,
   * `restarts === 1`, every row written once).
   */
  async run<T>(body: () => Promise<T>, single = false): Promise<T> {
    try {
      if (this.ownership === "batch-preparation") return await body();
      if (isReadOperation(this.operation)) return await body();
      if (!single) this.requireAtomicUnit();
      const region = this.region();
      if (!region) return await this.batchAttempt(body);
      if (!single) return await this.regionAttempt(region, body);
      this.envelope = "deferred";
      try {
        return await body();
      } catch (error) {
        if (error !== this.requiresEnvelope) throw error;
      }
      this.restart();
      return await this.regionAttempt(region, body);
    } catch (error) {
      // A record series is a COMMITTED SEGMENT of this operation's own writes,
      // and nothing else asked here: a generated-output continuation is
      // declared behind the segment that published the identity it re-pins
      // ({@link insert}), so that segment is already counted, while a premise —
      // the parent a membership correlates on — is declared ahead of every
      // segment and is not a member of any series. Asking about continuations
      // instead published a series' progress for an ordinary UPDATE that had
      // committed nothing (`tests/raptor3/g2-transport.test.ts`, "An ordinary
      // UPDATE must retain only acknowledged progress").
      if (
        error instanceof InvalidScalarResult ||
        (this.usesBatch && this.committedSegments > 0)
      )
        throw this.failure(
          error,
          error instanceof InvalidScalarResult ? "result" : "member"
        );
      throw error;
    }
  }
  /**
   * The pre-dispatch capability gate, on the construction path and before the
   * operation's FIRST statement — the position of the shipped
   * `assertRoutedAtomicResolution` (`write-engine/routing.ts:104-164`).
   *
   * A form the physical-envelope rule has already ruled out of ONE statement
   * needs an atomic unit. A driver with neither transactions nor batch has
   * none, and a batch-only driver that cannot RETURN cannot resolve a
   * single-row mutation's identity inside its own unit — its public result is
   * parsed after the batch commits and that parse cannot be rolled back. Both
   * are one class and one `meta`, and neither reaches the provider: the
   * decision read of an `upsert` used to dispatch first and surface the
   * provider's own error instead of this refusal.
   */
  private requireAtomicUnit(): void {
    if (this.ownership !== "standalone") return;
    const driver = this.driver;
    const meta = { driver: driver.driverName, operation: this.operation };
    if (!(driver.supportsTransactions || driver.supportsBatch))
      throw new TransactionError(
        `Driver "${driver.driverName}" supports neither transactions nor atomic batch execution.`,
        { meta }
      );
    if (
      driver.supportsBatch &&
      !driver.supportsTransactions &&
      !driver.adapter.capabilities.supportsReturning &&
      ATOMIC_RESOLUTION_OPERATIONS.has(this.operation)
    )
      throw new TransactionError(
        this.operation === "upsert"
          ? "cannot execute non-returning upsert writes atomically because public result parsing cannot be rolled back after an atomic batch commits"
          : `Driver '${driver.driverName}' cannot execute '${this.operation}' because public result parsing cannot be rolled back.`,
        { meta }
      );
  }
  /**
   * Every provider round trip crosses here, so the envelope rule has exactly one
   * site. `terminal` marks the operation's result-publishing transport, which is
   * followed by nothing.
   */
  private async dispatch<T>(
    statements: number,
    terminal: boolean,
    execute: () => Promise<T>
  ): Promise<T> {
    if (this.envelope === "deferred") {
      if (!(terminal && statements === 1 && this.performed === 0))
        throw this.requiresEnvelope;
      this.envelope = "statement";
    }
    this.performed += statements;
    return execute();
  }
  /** Discard the un-executed plan so the body can be constructed again. */
  private restart(attempt = new TransportAttempt()): void {
    this.attemptStore = attempt;
    this.continuationList = undefined;
    this.vacatedMemberships = undefined;
    this.memberAdmissionStarted = false;
    this.envelope = "open";
  }
  /**
   * The command interpreter's ONE replacement of both attempt regions, held by
   * the owner that opens the region so it can spend the recovery allowance
   * without knowing how a command attempt is built. It answers the replacement
   * transport region once, and `undefined` ever after.
   */
  attachRecovery(replace: () => TransportAttempt | undefined): void {
    this.replaceAttempt = replace;
  }
  private replaceAttempt?: () => TransportAttempt | undefined;
  private recoverySpent = false;
  /**
   * The ONE recovery allowance, spent here and nowhere else.
   *
   * The interpreter owns HOW both attempt regions are replaced; this owner
   * states WHETHER they may be, because a recovery is a fact about the
   * operation, not about the interpreter that happens to be running it: a
   * re-plan builds a NEW interpreter (D-25), and a fresh interpreter must not
   * bring a fresh allowance with it.
   */
  spendRecovery(): TransportAttempt | undefined {
    if (this.recoverySpent) return undefined;
    const replacement = this.replaceAttempt?.();
    if (!replacement) return undefined;
    this.recoverySpent = true;
    return replacement;
  }
  /**
   * May a replacement attempt replay IN PLACE?
   *
   * Only where this operation opened no region of its own. A region the
   * rejection aborted answers no further statement, so there the recovery is
   * {@link run}'s — a FRESH region — and never a replay inside the failed one.
   */
  get replaysInPlace(): boolean {
    return !this.ownRegionOpen;
  }
  /**
   * The operation's region, and the ONE recovery allowance that belongs to the
   * owner that opens it.
   *
   * A lost create race destroys the region it was rejected in, so the recovery
   * cannot be a replay inside it: it is a fresh region running the same body,
   * which is exactly what the shipped `executeRoutedOperation` did
   * (`write-engine/routing.ts:180-208`, "Re-planning re-reads committed state,
   * so the loser now takes its adopt arm and converges"). The attribution and
   * the correlation id are this operation's own and do not change;
   * {@link recoveryRejection} has already answered that nothing was
   * acknowledged, and the interpreter answers the allowance exactly once.
   */
  private async regionAttempt<T>(
    region: (
      execute: (driver: AnyDriver) => Promise<unknown>
    ) => Promise<unknown>,
    body: () => Promise<T>
  ): Promise<T> {
    try {
      return await this.withinRegion(region, body);
    } catch (error) {
      if (this.recoveryRejection(error)?.kind !== "insert") throw error;
      const replacement = this.spendRecovery();
      if (!replacement) throw error;
      this.restart(replacement);
      return await this.withinRegion(region, body);
    }
  }
  /**
   * The batch route's own recovery: ONE re-plan, from the admitted values.
   *
   * A raceable atomic assertion aborted the whole unit before anything was
   * acknowledged, so this operation may be planned again — and it must be
   * planned AGAIN rather than replayed, because the tree that ran carries the
   * members it captured and a series occurrence is expanded exactly once. The
   * body re-derives the occurrence tree from the same ADMITTED arguments
   * (`commands/index.ts`), so nothing is re-validated and no transform runs
   * twice (rule 10), and the fresh plan-time read sees the committed state the
   * race produced and converges (Arnaud's D-25).
   *
   * An INSERT rejection is not this arm's: with no region open the interpreter
   * adopts the winner's row in place ({@link replaysInPlace}), which keeps "a
   * missing winner never authorises a new INSERT" where it is decided.
   */
  private async batchAttempt<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      if (this.recoveryRejection(error)?.kind !== "assertion") throw error;
      const replacement = this.spendRecovery();
      if (!replacement) throw error;
      this.restart(replacement);
      return await body();
    }
  }
  /**
   * The ONE sanctioned direct read at array-route preparation: the upsert
   * locate of {@link CommandPlanner.rootUpsert}'s probe-first path (D-46),
   * whose answer the arm's packaged premise re-asserts inside the batch. Every
   * other read keeps {@link read}'s refusal there, terminal or not: the
   * interpreter's planning reads would run before the earlier members of the
   * same array have executed and answer a false absence — measured by the
   * unit's review (a `connect` to a row an earlier member inserts).
   */
  async planningLocate(query: Query, model: AnyModel): Promise<Input[]> {
    const response = await this.answer(query, false, model);
    return this.queries.decodeQuery(query, response.rows, true);
  }
  /**
   * One read. `model` is the model the statement addresses when that is not the
   * operation's own — a nested locate names the nested record, exactly as the
   * shipped executor's per-step derivation does ({@link statementContext}).
   */
  async read(
    query: Query,
    internal = false,
    terminal = false,
    model?: AnyModel
  ): Promise<Input[]> {
    if (this.ownership === "batch-preparation") {
      throw this.incompletePreparation;
    }
    const response = await this.answer(query, terminal, model);
    return this.queries.decodeQuery(query, response.rows, internal);
  }
  /**
   * One statement's raw provider answer. The dispatcher both readers share, so
   * the terminal boundary ({@link publishedTerminal}) sees the rows the
   * provider handed back and an internal read sees the same rows decoded.
   *
   * It is also the ONE place this operation reads from OUTSIDE its own queue,
   * so it is where a member claims the boundary {@link executeMember} deferred:
   * a statement answered here cannot see a write the queue still holds. Only a
   * member claims it, and only for a write some OTHER record of the series left
   * waiting ({@link TransportAttempt.holdsOtherMemberWrite}). A read taken
   * outside every member is the record's OWN observation, and where it stands
   * relative to this unit's writes is the dependency pass's answer, not this
   * one's — an ordered observation is stated INSIDE the queued unit on purpose
   * (N1), and a boundary taken under it would commit the very writes its
   * premise exists to abort.
   */
  private async answer(
    query: Query,
    terminal: boolean,
    model?: AnyModel
  ): Promise<QueryResult<Input>> {
    const observer = this.executingMember;
    if (observer && this.attemptStore?.holdsOtherMemberWrite(observer))
      await this.flush();
    const context = model
      ? this.statementContext(model, this.operation)
      : this.attribution;
    return this.dispatch(1, terminal, () =>
      this.transport._execute<Input>(query.sql, context)
    );
  }
  /**
   * The operation's ONE result boundary: the raw rows one projection answered,
   * decoded through the driver's `parseResult` middleware and then the
   * adapter's ({@link Queries.decodeResult}, Arnaud's D-28).
   *
   * Asked once per operation by each route's publisher and never per member or
   * per statement: a publication split across several windows is a BIND-BUDGET
   * split of ONE projection, so the middleware is asked about the operation's
   * rows and the operation has one result whatever the provider's limit was. A
   * set mutation that publishes an affected-row COUNT instead of rows is not
   * asked at all: a row count is a fact of the transport, not a result window.
   */
  private publishedProjection(shape: ProjectionShape, rows: Input[]): Input[] {
    return this.queries.decodeResult(rows, this.operation, (raw) =>
      this.queries.decodeProjection(shape, raw)
    );
  }
  /**
   * The terminal boundary: one window per terminal statement, in dispatch
   * order, published as ONE result ({@link publishedProjection}).
   *
   * Every window of a terminal carries the same SHAPE ({@link seriesQueries}
   * hands each chunk `prepared.shape`), and none of them carries the
   * operation's row count: {@link Queries.selectSeries} stamps each window
   * with its own identity count and its own registered refusal. So that fact
   * is decided per window, on the rows the PROVIDER answered, before the
   * middleware is asked anything — a total over the concatenation would
   * compare a whole terminal with one window's count, and a middleware that
   * legitimately replaces the operation's rows must not be judged against a
   * physical window count at all.
   */
  private publishedTerminal(
    queries: readonly Query[],
    windows: readonly Input[][]
  ): Input[] {
    const terminal = queries[0];
    if (!terminal) return [];
    for (const [index, statement] of queries.entries())
      this.queries.assertExpectedRows(statement, windows[index]!.length);
    return this.publishedProjection(
      terminal.shape,
      windows.length === 1 ? windows[0]! : windows.flat()
    );
  }
  /**
   * One read's published result, live or packaged. A prepared read is one
   * statement plus the operation's own cardinality decision; packaging queues
   * that exact statement and installs the SAME decoder and cardinality as the
   * package's parser, so a read member is statically packageable and no second
   * projection or decoder exists (g4/unit03/note.md D-2).
   */
  async publish(read: Read, missing?: () => Error): Promise<unknown> {
    if (this.ownership === "batch-preparation")
      return this.publishPrepared(read, missing);
    const response = await this.answer(read.query, true);
    return this.decideRead(
      read,
      missing,
      this.publishedTerminal([read.query], [response.rows])
    );
  }
  /**
   * The batch-preparation arm of {@link publish}: queue this read's ONE
   * statement and state the parser for its one result. It reaches no driver,
   * so the package {@link preparedBatch} publishes is complete the moment this
   * returns — which is what lets a caller ask for a read's single prepared
   * query synchronously.
   */
  publishPrepared(read: Read, missing?: () => Error): undefined {
    const resultIndex = this.queued.length;
    this.queue(read.query.sql);
    this.preparedParser = (results) => {
      const response = results[resultIndex];
      if (!response)
        throw new TransactionError(
          `Driver '${this.driver.driverName}' omitted the prepared result for operation '${this.operation}'.`,
          { meta: this.errorMeta }
        );
      return this.decideRead(
        read,
        missing,
        this.publishedTerminal([read.query], [response.rows.map(record)])
      );
    };
    return undefined;
  }
  private decideRead(
    read: Read,
    missing: (() => Error) | undefined,
    rows: Input[]
  ): unknown {
    const value = read.result(rows);
    if (value === null && missing) throw missing();
    return value;
  }
  private referenceProjection(model: AnyModel, values: Input): Query {
    const adapter = this.driver.adapter;
    const select = Object.fromEntries(
      Object.keys(values).map((field) => [field, true])
    );
    const projection = this.queries.prepareProjection(model, { select });
    return {
      shape: projection.shape,
      sql: adapter.clauses.select(
        sql.join(this.queries.lowerProjectionValues(projection, values), ", ")
      )
    };
  }
  async flush(
    query?: Query,
    member?: Member,
    premise?: ObservationPremise
  ): Promise<Input[]>;
  async flush(queries: Query[], member?: Member): Promise<Input[][]>;
  async flush(
    query?: Query | Query[],
    member?: Member,
    premise?: ObservationPremise
  ): Promise<Input[] | Input[][]> {
    const projections = Array.isArray(query) ? query : query ? [query] : [];
    // Arnaud's D-29, stated where planning reads become batches. A planning
    // read is not the operation's atomic unit: it carries no premise of its
    // own, and it must not turn the unit's premises into a batch that runs
    // BEFORE the write they protect — which is exactly what closes the window
    // a staleness premise exists for before the write opens it. So the unit's
    // waiting premises step aside here, and the read travels with the unit
    // only while the unit is being dispatched anyway (the values it reads are
    // the ones those statements produce). With nothing else waiting it is what
    // it is: a read, through the one owner of reads.
    //
    // An ordered observation (N1) is the other caller: a read the queued unit's
    // own writes can answer. The trailing premises step aside for it exactly as
    // for a planning read — they protect writes not yet queued — while the
    // premises stated before the queued writes ride with them. Its `premise`
    // (the row the consumer needs, or no row outside its membership) is
    // asserted inside the same batch, behind the writes and ahead of the read,
    // so a target that is not what the consumer needs aborts the batch before
    // anything commits.
    // Stated once, for every boundary this owner takes: a read follows each of
    // them — the projections below, or the caller's own read outside the queue
    // — so the waiting premises step aside whatever the caller passes. It used
    // to be asked of the projection list, which made the rule depend on the
    // caller's shape: the `choose` arm carried its own reference read-back
    // until D-58 moved that to the boundary, and the rule must not change with
    // it. Measured inert on the packaging pins either way.
    this.attemptStore?.withholdPremises();
    try {
      if (!this.usesBatch || this.queued.length === 0) {
        // Nothing queued to ride with: an ABSENCE premise (no row outside the
        // membership) is checked here, at the observation, by its own read —
        // never left to a batch that will not run. A PRESENCE premise is the
        // observation itself: its query is the projection, and an empty answer
        // is the absence its consumer refuses.
        if (
          premise &&
          !premise.present &&
          (await this.read(premise.query, true)).length > 0
        )
          throw premise.failure();
        const rows: Input[][] = [];
        for (const projection of projections)
          rows.push(await this.read(projection, true));
        return Array.isArray(query) ? rows : (rows[0] ?? []);
      }
      return await this.flushQueued(projections, query, member, premise);
    } finally {
      this.attemptStore?.restorePremises();
    }
  }
  private async flushQueued(
    projections: Query[],
    query: Query | Query[] | undefined,
    member?: Member,
    premise?: ObservationPremise
  ): Promise<Input[] | Input[][]> {
    if (premise?.present) this.requirePresent(premise.query, premise.failure());
    else if (premise)
      await this.requireAbsent(premise.query, premise.failure());
    const resultIndex = this.queued.length;
    for (const projection of projections) this.queue(projection.sql);
    const responses = await this.submit(false, member);
    return this.settleSubmitted(() => {
      try {
        const rows = projections.map((projection, index) =>
          this.queries.decodeQuery(
            projection,
            responses[resultIndex + index]!.rows,
            true
          )
        );
        return Array.isArray(query) ? rows : (rows[0] ?? []);
      } catch (error) {
        throw this.failure(error, "result", member);
      }
    });
  }
  async requireAbsent(query: Query, failure: Error): Promise<void> {
    if (this.usesBatch) {
      this.statePremise(query, false, failure);
      return;
    }
    if ((await this.read(query, true)).length) throw failure;
  }
  requirePresent(query: Query, failure: Error): void {
    this.statePremise(query, true, failure);
  }
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
  private readsBatchReference(query: Query): boolean {
    const reference = this.attemptStore?.scratchId;
    return reference !== undefined && query.sql.values.includes(reference);
  }
  /** Queue one premise's assertion and record what it requires of the batch. */
  private statePremise(query: Query, present: boolean, failure: Error): void {
    const assertions = this.driver.adapter.assertions;
    this.attempt.assertPremise(
      this.queue(
        present ? assertions.exists(query.sql) : assertions.notExists(query.sql)
      ),
      {
        query,
        present,
        failure,
        readsBatchReference: this.readsBatchReference(query),
      }
    );
  }
  private async submit(publishingGeneratedOutput = false, member?: Member) {
    if (this.ownership === "batch-preparation") {
      throw this.incompletePreparation;
    }
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
          readsBatchReference: this.readsBatchReference(query),
        },
      };
    });
    // D-58: this unit's scratch ends with this unit. Every value it stored is
    // read back inside the same batch, at its end, and the table is dropped
    // with the unit that made it — so the next unit binds LITERALS and creates
    // its own scratch for whatever it produces itself.
    const carryIndex = guards.length + attempt.pending.length;
    const carried = this.carryScratch();
    this.closeScratch();
    const statements = [
      ...guards.map((guard) => guard.statement),
      ...attempt.pending.splice(0),
    ];
    const insertProducers = attempt.drainInsertProducers();
    const assertionFailures = attempt.drainAssertedPremises();
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
          this.driver.supportsOrderedCommittedSegments ? acknowledged : undefined
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
          this.retainOutcomeFailure(error, acknowledgedOutcomeFailure.failure)
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
          failure = assertionFailures.get(statements[statementIndex]!)?.failure;
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
          const soleGuard = assertionFailures.size === 1 && !mayCollide;
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
            if (!assertion || assertion.readsBatchReference) continue;
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
          if (assertionFailures.has(statement)) last = index;
        positionBound = last;
      }
      const rejectedBeforeAnyWrite =
        typeof rejectedIndex === "number" &&
        typeof positionBound === "number" &&
        this.committedSegments === 0 &&
        statements.every(
          (statement, index) =>
            index > positionBound || assertionFailures.has(statement)
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
            cause: error
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
        this.settleCarry(carry, responses[carryIndex + offset]!, member);
    } catch (error) {
      const held = this.heldOutcomeFailure;
      this.heldOutcomeFailure = undefined;
      throw held
        ? this.answered(this.retainOutcomeFailure(error, held.failure))
        : error;
    }
    return responses.slice(guards.length);
  }
  /**
   * The operation's own answer to a batch {@link submit} returned, composed
   * with a listener failure that batch HELD while it acknowledged
   * ({@link heldOutcomeFailure}).
   *
   * The shipped `runAtomicBatch` order exactly
   * (`write-engine/OperationExecutor.ts:1332-1343`): the answer is decoded
   * first, a decode failure stays primary with the listener's retained beside
   * it, and a listener that failed beside an answer that SUCCEEDED is published
   * alone. Every caller of {@link submit} decodes here, so the hold is released
   * exactly once per submission — and on the plain transport there is nothing
   * to hold, because {@link dispatchSetMutations} decodes and acknowledges in
   * one frame and states its primary directly.
   */
  private async settleSubmitted<T>(
    answer: () => T | PromiseLike<T>
  ): Promise<T> {
    const held = this.heldOutcomeFailure;
    this.heldOutcomeFailure = undefined;
    let value: T;
    try {
      value = await answer();
    } catch (failure) {
      throw held
        ? this.answered(this.retainOutcomeFailure(failure, held.failure))
        : failure;
    }
    if (held) throw this.answered(held.failure);
    return value;
  }
  rejectedProducer(error: unknown): object | undefined {
    const rejected = this.attemptStore?.rejectedInsert;
    return rejected && rejected.error === error ? rejected.producer : undefined;
  }
  recoveryRejection(
    error: unknown
  ):
    | { readonly kind: "assertion" }
    | { readonly kind: "insert"; readonly producer: object }
    | undefined {
    // Rule 10: authority is not capability. The allowance asks who was rejected
    // and how far this operation got — never which transport carried it, which
    // is what let the shipped `routing.ts:180-208` replace a region the
    // transport opened. Attribution and progress are ALL it asks (Arnaud's
    // D-25): whether a rejected INSERT may be answered at all is decided where
    // the producer is RECORDED — bounded by member admission on the route whose
    // recovery REPLAYS in place ({@link submit}), unbounded on the route that
    // RE-PLANS ({@link insert}), which is what D-25 allows.
    if (this.ownership !== "standalone") return undefined;
    if (this.committedProgress) return undefined;
    // An ATOMIC ASSERTION is answered by a fresh PLAN over the same admitted
    // arguments, which re-reads committed state (D-25), so dynamic member
    // admission does not bound it: the new tree admits its own members.
    if (this.atomicAssertionRejection === error) return { kind: "assertion" };
    const producer = this.rejectedProducer(error);
    return producer ? { kind: "insert", producer } : undefined;
  }
  get transportAttempt(): TransportAttempt {
    return this.attempt;
  }
  restartRejectedInsert(attempt: TransportAttempt): void {
    this.attemptStore = attempt;
    this.atomicAssertionRejection = undefined;
  }
  /**
   * The operation's own cardinality over the rows a set-oriented mutation
   * published. A bulk verb publishes the set; a root single-row verb publishes
   * one row and owns the missing-row failure. The decision is stated here, in
   * the same closure that decodes, so a packaged operation states it too.
   */
  private published(rows: Input[], single?: () => Error): unknown {
    if (!single) return rows;
    const row = rows[0];
    if (!row) {
      // The operation's own PREMISE failed: the row it addressed is not there.
      // That is a statement about the world, not a report about the transport,
      // so it carries no record-series progress — the shipped engine's
      // `NotFoundError` meta for the same request is exactly
      // `{model, operation}` on every driver. A provider ANOMALY raised from
      // the same place (an INSERT that answered no row) throws from inside
      // `single()` instead of returning, is never marked, and keeps the
      // progress record its transport owes it.
      throw this.answered(single());
    }
    return row;
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
  private packagedPresence(
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
        )
      },
      undefined,
      { selector }
    );
    (this.preparedGuardList ??= []).push({
      queryIndex: this.queued.length,
      premise: "exists",
      probe: probe.sql,
      failure: {
        kind: "notFound",
        // Never user-facing: `createFailureError` ignores this message for
        // `kind: "notFound"` and rebuilds the shipped sentence from the model
        // and verb below. It is read only by `sameAttribution`
        // (`batch-error-attribution.ts`), where being CONSTANT per model and
        // verb is what makes two guards of the same shape agree.
        message: `Raptor 3 ${this.operation} located no '${model["~"].names.ts!}' row for its unique where.`,
        raceable: false
      },
      model: model["~"].names.ts!,
      operation: this.operation
    });
    this.queue(
      this.driver.adapter.assertions.exists(probe.sql),
      this.statementContext(model, this.operation)
    );
  }
  emptyBulkResult(projection?: PreparedProjection): unknown {
    const result = () => (projection ? [] : { count: 0 });
    if (this.ownership === "batch-preparation") {
      this.preparedParser = result;
      return undefined;
    }
    return result();
  }
  seriesQueries(
    projection: PreparedProjection,
    identities: Input[],
    operation: "createMany" | "updateMany" = "createMany"
  ): Query[] {
    if (identities.length === 0) return [];
    const limit = normalizedBindParameterLimit(
      this.driver.maxBindParametersPerStatement
    );
    const preparedQueries = new WeakMap<Sql, Query>();
    const chunks = compileBindBudgetChunks(
      identities.length,
      limit,
      (start, end) => {
        const query = this.queries.selectSeries(
          projection,
          identities.slice(start, end),
          operation
        );
        preparedQueries.set(query.sql, query);
        return query.sql;
      }
    );
    return chunks.map(({ statement }) => preparedQueries.get(statement)!);
  }
  finish(): Promise<void> {
    return this.finishValue(undefined);
  }
  finishValue<T>(value: T): Promise<T> {
    return this.finishTerminals([], () => value);
  }
  finishOne(query: Query): Promise<Input | undefined> {
    return this.finishTerminals([query], (rows) => rows[0]);
  }
  finishMany(queries: readonly Query[]): Promise<Input[]> {
    return this.finishTerminals(queries, (rows) => rows);
  }
  private decodeTerminalResults(
    queries: readonly Query[],
    results: readonly QueryResult<unknown>[],
    resultIndex: number
  ): Input[] {
    const windows: Input[][] = [];
    for (const offset of queries.keys()) {
      const response = results[resultIndex + offset];
      if (!response)
        throw new TransactionError(
          `Driver '${this.driver.driverName}' omitted the ${this.ownership === "batch-preparation" ? "prepared" : "terminal"} result for operation '${this.operation}'.`,
          { meta: this.errorMeta }
        );
      windows.push(response.rows.map(record));
    }
    return this.publishedTerminal(queries, windows);
  }
  private async finishTerminals<T>(
    queries: readonly Query[],
    result: (rows: Input[]) => T
  ): Promise<T> {
    if (!this.usesBatch) {
      const windows: Input[][] = [];
      for (const terminal of queries)
        windows.push(
          (await this.answer(terminal, queries.length === 1)).rows.map(record)
        );
      return result(this.publishedTerminal(queries, windows));
    }
    const resultIndex = this.queued.length;
    for (const terminal of queries) this.queue(terminal.sql);
    // The operation's last unit — and the ONE unit a prepared package is —
    // ends here, so its scratch is dropped here and nothing is read back out
    // of it: no statement follows that could bind the value (D-58).
    this.closeScratch();
    if (this.ownership === "batch-preparation") {
      this.preparedParser = (results) =>
        result(this.decodeTerminalResults(queries, results, resultIndex));
      return result([]);
    }
    if (this.queued.length === 0) return result([]);
    const responses = await this.submit();
    return this.settleSubmitted(() => {
      try {
        return result(
          this.decodeTerminalResults(queries, responses, resultIndex)
        );
      } catch (error) {
        throw queries.length ? this.failure(error, "result") : error;
      }
    });
  }
  isIncompletePreparation(error: unknown): boolean {
    return error === this.incompletePreparation;
  }
  preparedBatch(): PreparedBatchOperation<unknown> | undefined {
    if (this.preparedParser === undefined) return undefined;
    if (this.attemptStore?.hasAssertedPremises) return undefined;
    return {
      queries: this.queued.map((query) =>
        transferPreparedStatement(query, {
          sql: query.sql,
          params: query.params ?? [],
          context: query.context ?? this.attribution
        })
      ),
      ...(this.preparedGuardList?.length
        ? { guards: this.preparedGuardList }
        : {}),
      parseResult: this.preparedParser
    };
  }
  private async setMutation(
    statement: Sql,
    context: QueryExecutionContext,
    parse: (result: QueryResult<unknown>) => unknown
  ): Promise<unknown> {
    return this.setMutations([{ sql: statement, context }], (results) => {
      const result = results[0];
      if (!result)
        throw new TransactionError(
          `Driver '${this.driver.driverName}' omitted the result for operation '${this.operation}'.`,
          { meta: this.errorMeta }
        );
      return parse(result);
    });
  }
  private async setMutations(
    statements: readonly {
      readonly sql: Sql;
      readonly context: QueryExecutionContext;
    }[],
    parse: (results: readonly QueryResult<unknown>[]) => unknown
  ): Promise<unknown> {
    if (this.ownership === "batch-preparation") {
      const firstResult = this.queued.length;
      for (const statement of statements)
        this.queue(statement.sql, statement.context);
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
      this.continuationCount === 0;
    if (this.usesBatch && !lone) {
      const windowMember: Member = {};
      this.setWindow = windowMember;
      for (const statement of statements)
        this.queue(statement.sql, statement.context, windowMember);
      const results = await this.submit(true, windowMember);
      return this.settleSubmitted(() => {
        try {
          return parse(results);
        } catch (error) {
          throw this.failure(error, "result", windowMember);
        }
      });
    }
    return this.dispatchSetMutations(statements, parse);
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
    parse: (results: readonly QueryResult<unknown>[]) => unknown
  ): Promise<unknown> {
    return this.dispatch(statements.length, true, async () => {
      const owned = this.ownership === "standalone" && !this.ownRegionOpen;
      const results: QueryResult<unknown>[] = [];
      try {
        for (const statement of statements)
          results.push(
            await this.transport._execute(statement.sql, statement.context)
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
   * Say ONE durable write phase on the client's cache rail, keeping the
   * OPERATION's own failure primary when the client's listener throws.
   *
   * The shipped engine composed the two exactly this way —
   * `retainWriteOutcomeFailure` (`src/extensions/query.ts:859`) at every
   * executor site that notified while holding a failure. It was restated here
   * rather than imported because `@extensions/query` then imported
   * `write-engine/routing` and with it every shipped operation class — the one
   * import this engine may not have. C-01 deleted those classes and re-pointed
   * that import at `@query-engine/routed-operations`, so the hazard is gone and
   * the restatement is simply this engine's own composition. `primary` absent
   * means the operation has not failed, which was the shipped
   * `throw outcomeFailure` arm.
   */
  private async stateWriteOutcome(
    say: (() => Promise<void>) | undefined,
    primary?: unknown
  ): Promise<void> {
    if (!say) return;
    try {
      await say();
    } catch (outcomeFailure) {
      if (primary === undefined) throw outcomeFailure;
      throw this.answered(this.retainOutcomeFailure(primary, outcomeFailure));
    }
  }
  /** Mark a failure as this operation's own answer ({@link answeredFailures}). */
  private answered<T>(failure: T): T {
    if (typeof failure === "object" && failure !== null)
      (this.answeredFailureSet ??= new WeakSet()).add(failure);
    return failure;
  }
  /**
   * ONE composition of the two failures, wherever the operation's own failure
   * becomes known: it stays primary and every listener failure is retained
   * beside it. {@link stateWriteOutcome} composes when the primary is already
   * in hand; {@link settleSubmitted} composes when the batch transport learned
   * the listener's failure FIRST and held it.
   */
  private retainOutcomeFailure(
    primary: unknown,
    outcomeFailure: unknown
  ): AggregateError {
    return new AggregateError(
      [
        primary,
        ...(outcomeFailure instanceof AggregateError
          ? outcomeFailure.errors
          : [outcomeFailure])
      ],
      "Query execution and write-outcome publication both failed.",
      { cause: primary }
    );
  }
  async createMany(
    model: AnyModel,
    rows: Input[],
    projection?: PreparedProjection,
    skipDuplicates = false,
    single?: () => Error
  ): Promise<unknown> {
    // A DIRECT empty `createMany` is Prisma's documented `{ count: 0 }` no-op.
    // A batch-PREPARED one is a different question, and the shipped engine
    // refused it: `$transaction([createMany({ data: [] })])` built its plan
    // during array preparation and `buildCreateManyPlan` raised "No data to
    // insert for createMany." there (`assertBatchPreparable`). The mode is the
    // fact, and this is the owner that holds it — admission cannot, because the
    // same payload is admitted on both routes.
    if (rows.length === 0) {
      if (this.ownership === "batch-preparation")
        throw new QueryEngineError("No data to insert for createMany.");
      return this.emptyBulkResult(projection);
    }
    const q = this.queries;
    const adapter = this.driver.adapter;
    const buildInsert = (
      columns: readonly string[],
      members: readonly Input[],
      applySqlSkip: boolean
    ) => {
      if (columns.length === 0)
        return adapter.mutations.insertDefault(q.table(model));
      const duplicate = applySqlSkip
        ? adapter.mutations.skipDuplicates(q.columnName(model, columns[0]!))
        : undefined;
      const mutation = adapter.mutations.insert(
        q.table(model),
        columns.map((field) => q.columnName(model, field)),
        members.map((row) =>
          columns.map((field) => q.fieldValue(model, field, row[field]))
        ),
        duplicate?.prefix
      );
      return duplicate?.suffix
        ? sql`${mutation} ${duplicate.suffix}`
        : mutation;
    };
    const recoverableSkip =
      skipDuplicates &&
      adapter.mutations.skipDuplicatesStrategy === "recoverableUniqueError";
    if (
      recoverableSkip ||
      (projection && !adapter.capabilities.supportsReturning)
    ) {
      if (this.ownership === "batch-preparation") throw this.incompletePreparation;
      if (recoverableSkip) this.requireSuppression();
      const identityPlans = projection
        ? rows.map((row) => {
            const missing = this.schema
              .keys(model)
              .filter((field) => row[field] === undefined);
            const generated = this.insertIdField(model, missing);
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
        const statement = buildInsert(columns, [row], false);
        const context = this.statementContext(model, this.operation);
        let response: QueryResult<unknown> | undefined;
        if (recoverableSkip) {
          response = await this.executeMember(async () => {
            try {
              return await this.dispatch(1, false, () =>
                this.withMemberRollback((driver) =>
                  driver._execute(statement, context)
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
                this.transport._execute(statement, context)
              ),
            row
          );
        }
        if (!response) continue;
        count += response.rowCount;
        if (!identityPlans) continue;
        const generated = identityPlans[index];
        if (generated && response.insertId === undefined)
          throw new TypeError("INSERT did not produce the required record identity");
        identities.push({
          ...this.schema.identity(model, row),
          ...(generated ? { [generated]: response.insertId } : {})
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
    const returning = projection
      ? adapter.mutations.returning(
          sql.join(q.lowerProjection(projection).columns, ", ")
        )
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
    const statements: { sql: Sql; context: QueryExecutionContext }[] = [];
    for (const group of groups) {
      if (group.columns.length === 0) {
        for (const _row of group.rows) {
          let statement = adapter.mutations.insertDefault(q.table(model));
          if (returning) statement = sql`${statement} ${returning}`;
          statements.push({
            sql: statement,
            context: this.statementContext(model, this.operation)
          });
        }
        continue;
      }
      const chunks = compileBindBudgetChunks(
        group.rows.length,
        limit,
        (start, end) => {
          const mutation = buildInsert(
            group.columns,
            group.rows.slice(start, end),
            skipDuplicates
          );
          return returning ? sql`${mutation} ${returning}` : mutation;
        }
      );
      for (const chunk of chunks)
        statements.push({
          sql: chunk.statement,
          context: this.statementContext(model, this.operation)
        });
    }
    return this.setMutations(statements, (results) => {
      const written = results.reduce(
        (count, result) => count + result.rowCount,
        0
      );
      // An affected-row count is EXECUTION semantics, not a provider opinion
      // this operation forwards: a driver that acknowledges FEWER rows than
      // were submitted has not written the request, and the operation says so
      // instead of publishing the shortfall as its answer. `skipDuplicates` is
      // the one admitted shape whose shortfall IS the answer. A count ABOVE the
      // submitted rows is not this owner's to refuse — MySQL's duplicate clause
      // counts two per replaced row and a trigger inflates the same number —
      // and the estate pins that a driver's own window survives unchanged
      // (`query-interceptors-array.core.test.ts` "preserves single,
      // multi-statement, guard, and raw result windows").
      if (!skipDuplicates && written < rows.length)
        throw new TransactionError(
          `Driver '${this.driver.driverName}' reported ${written} of ${rows.length} inserted rows for operation '${this.operation}'.`,
          { meta: this.errorMeta }
        );
      if (!projection) return { count: written };
      const raw: Input[] = [];
      for (const result of results) raw.push(...result.rows.map(record));
      // A grouped insert split by the provider's bind budget answers in
      // several windows of the SAME projection and carries no per-window row
      // count of its own — the shortfall above is this fold's own contract.
      return this.published(
        this.publishedProjection(projection.shape, raw),
        single
      );
    });
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
   */
  async upsertOne(
    model: AnyModel,
    row: Input,
    updates: Input,
    target: readonly string[],
    projection?: PreparedProjection,
    single?: () => Error
  ): Promise<unknown> {
    const q = this.queries;
    const adapter = this.driver.adapter;
    const columns = Object.keys(row);
    const insert =
      columns.length === 0
        ? adapter.mutations.insertDefault(q.table(model))
        : adapter.mutations.insert(
            q.table(model),
            columns.map((field) => q.columnName(model, field)),
            [columns.map((field) => q.fieldValue(model, field, row[field]))]
          );
    const conflict = adapter.mutations.onConflict(
      sql.join(
        target.map((field) =>
          adapter.identifiers.escape(q.columnName(model, field))
        ),
        ", "
      ),
      adapter.mutations.onConflictUpdate(
        sql.join(this.updateAssignments(model, updates), ", ")
      )
    );
    let statement = sql`${insert} ${conflict}`;
    if (projection)
      statement = sql`${statement} ${adapter.mutations.returning(
        sql.join(q.lowerProjection(projection).columns, ", ")
      )}`;
    return this.setMutation(
      statement,
      this.statementContext(model, this.operation),
      (result) =>
        projection
          ? this.published(
              this.publishedProjection(
                projection.shape,
                result.rows.map(record)
              ),
              single
            )
          : { count: result.rowCount }
    );
  }
  async updateMany(
    model: AnyModel,
    selector: PreparedSelector,
    values: Input,
    limit?: number,
    projection?: PreparedProjection,
    single?: () => Error
  ): Promise<unknown> {
    const q = this.queries;
    const adapter = this.driver.adapter;
    const assignments = this.updateAssignments(model, values);
    if (projection && !adapter.capabilities.supportsReturning) {
      const identities = await this.captureMutationIdentities(
        model,
        selector,
        limit
      );
      if (identities.length === 0) return this.published([], single);
      const statement = adapter.mutations.update(
        q.table(model),
        sql.join(assignments, ", "),
        adapter.operators.or(
          ...identities.map((identity) => q.lowerIdentity(model, identity))
        )
      );
      // ONE fact, two consumers: the premises state "the rows this mutation
      // selected are still the rows it is about to mutate" inside the batch,
      // before the write; the row count states the same fact after it, as the
      // detection it always was. Same sentence, same class.
      const changed = () =>
        new TransactionError(
          "updateMany selected-row cardinality changed during its locked mutation.",
          { meta: this.errorMeta }
        );
      await this.requireCapturedSet(
        model,
        selector,
        identities,
        limit,
        changed
      );
      const response = await this.capturedMutation(
        statement,
        this.statementContext(model, this.operation)
      );
      if (response.rowCount !== identities.length) throw changed();
      return this.finishTerminals(
        this.seriesQueries(
          projection,
          identities.map((identity) =>
            this.updatedIdentity(model, identity, values)
          ),
          "updateMany"
        ),
        (published) => this.published(published, single)
      );
    }
    this.packagedPresence(model, selector, single);
    const limited = q.lowerMutationLimit(model, selector, limit);
    const mutation = adapter.mutations.update(
      q.table(model),
      sql.join(assignments, ", "),
      limited.where
    );
    let statement = limited.suffix
      ? sql`${mutation} ${limited.suffix}`
      : mutation;
    if (projection)
      statement = sql`${statement} ${adapter.mutations.returning(
        sql.join(q.lowerProjection(projection).columns, ", ")
      )}`;
    return this.setMutation(
      statement,
      this.statementContext(model, this.operation),
      (result) =>
        projection
          ? this.published(
              this.publishedProjection(
                projection.shape,
                result.rows.map(record)
              ),
              single
            )
          : { count: result.rowCount }
    );
  }
  async deleteMany(
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
    // removal, under the same locked capture the non-returning branch owns.
    if (
      projection &&
      !(
        adapter.capabilities.supportsReturning &&
        returningSafeProjection(projection)
      )
    ) {
      const identities = await this.captureMutationIdentities(
        model,
        selector,
        limit
      );
      if (identities.length === 0) return this.published([], single);
      const rows: Input[] = [];
      for (const query of this.seriesQueries(projection, identities))
        rows.push(...(await this.read(query, false, false, model)));
      const changed = () =>
        new TransactionError(
          "deleteMany selected-row cardinality changed during its locked mutation.",
          { meta: this.errorMeta }
        );
      await this.requireCapturedSet(
        model,
        selector,
        identities,
        limit,
        changed
      );
      const response = await this.capturedMutation(
        adapter.mutations.delete(
          q.table(model),
          adapter.operators.or(
            ...identities.map((identity) => q.lowerIdentity(model, identity))
          )
        ),
        this.statementContext(model, this.operation)
      );
      if (response.rowCount !== identities.length) throw changed();
      return this.published(rows, single);
    }
    this.packagedPresence(model, selector, single);
    const limited = q.lowerMutationLimit(model, selector, limit);
    const mutation = adapter.mutations.delete(
      q.table(model),
      limited.where
    );
    let statement = limited.suffix
      ? sql`${mutation} ${limited.suffix}`
      : mutation;
    if (projection)
      statement = sql`${statement} ${adapter.mutations.returning(
        sql.join(q.lowerProjection(projection).columns, ", ")
      )}`;
    return this.setMutation(
      statement,
      this.statementContext(model, this.operation),
      (result) =>
        projection
          ? this.published(
              this.publishedProjection(
                projection.shape,
                result.rows.map(record)
              ),
              single
            )
          : { count: result.rowCount }
    );
  }
  private async captureMutationIdentities(
    model: AnyModel,
    selector: PreparedSelector,
    limit: number | undefined
  ): Promise<Input[]> {
    if (this.ownership === "batch-preparation")
      throw this.incompletePreparation;
    const keys = this.schema.keys(model);
    const query = this.queries.select(
      model,
      {
        select: Object.fromEntries(keys.map((field) => [field, true])),
        take: limit
      },
      undefined,
      { selector, forUpdate: !this.usesBatch }
    );
    // An interactive session takes `FOR UPDATE` and the capture is protected
    // by the lock it holds until the mutation. A batch-only transport holds
    // nothing across two statements, so N4 (plan §4, D-52) gives the capture
    // the shape the series capture already has: it is a SEGMENT OF ITS OWN —
    // the barrier submits whatever this unit has queued and reads in the same
    // native batch — and the premises {@link requireCapturedSet} states inside
    // the MUTATION's batch are what protect it. No lock is claimed where none
    // exists.
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
   * carries the claim as statements ahead of the write: every captured row is
   * STILL PRESENT and STILL A MEMBER of the selection, and — when the capture
   * took the whole selection rather than a limited slice — no row has JOINED
   * it. A stale observation aborts the atomic unit before anything is written,
   * which is what the row-count check after the mutation could not do.
   *
   * Only on the batch route: an interactive session captured `FOR UPDATE`.
   */
  private async requireCapturedSet(
    model: AnyModel,
    selector: PreparedSelector,
    identities: readonly Input[],
    limit: number | undefined,
    changed: () => Error
  ): Promise<void> {
    if (!this.usesBatch) return;
    const q = this.queries;
    for (const identity of identities)
      this.requirePresent(
        q.select(model, { take: 1 }, undefined, { selector, identity }),
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
          q.prepareSelector(model, { NOT: { OR: [...identities] } })
        ])
      }),
      changed()
    );
  }
  /**
   * The captured mutation's own statement and the row count it affected, on
   * either transport. On the batch route it rides the same batch its premises
   * are in, so the write never runs when a premise disagrees.
   */
  private async capturedMutation(
    statement: Sql,
    context: QueryExecutionContext
  ): Promise<QueryResult<unknown>> {
    if (!this.usesBatch)
      return await this.dispatch(1, false, () =>
        this.transport._execute(statement, context)
      );
    // Its own answer, by its own position: the batch also carries this
    // mutation's premises ahead of it, {@link submit} answers the queued
    // statements alone (its guards are sliced off), and the row count this
    // mutation reports is the one the captured set is judged against.
    const index = this.queued.length;
    // A set-oriented statement's window: a merely uncertain outcome is no
    // record series of its own ({@link failure}), as `setMutations` states it.
    const member: Member = {};
    this.setWindow = member;
    this.queue(statement, context, member);
    const responses = await this.submit(true, member);
    return this.settleSubmitted(() => {
      const response = responses[index];
      if (!response)
        throw new TransactionError(
          `Driver '${this.driver.driverName}' omitted the prepared result for operation '${this.operation}'.`,
          { meta: this.errorMeta }
        );
      return response;
    });
  }
  private updatedIdentity(
    model: AnyModel,
    identity: Input,
    values: Input
  ): Input {
    const q = this.queries;
    return Object.fromEntries(
      this.schema.keys(model).map((field) => [
        field,
        Object.hasOwn(values, field)
          ? q.updateValue(
              model,
              field,
              values[field],
              q.fieldValue(model, field, identity[field])
            )
          : identity[field]
      ])
    );
  }
  /**
   * The scratch of the unit being assembled, made by the first statement that
   * stores into it.
   *
   * It belongs to the DISPATCHED UNIT and not to the attempt (D-58): the table
   * is a session-scoped temporary, and a transport that pins no session — Neon
   * HTTP, D1 — ends its session with the batch, so a unit that named a table an
   * EARLIER segment created named nothing at all. Every unit that needs one
   * makes its own, and {@link closeScratch} drops it where the unit ends.
   */
  private ensureScratch(): string {
    const attempt = this.attempt;
    if (attempt.scratchId) return attempt.scratchId;
    const references = getAdapterInternals(this.driver.adapter).batchRefs;
    attempt.scratchId = crypto.randomUUID();
    for (const setup of references.setup(attempt.scratchId)) this.queue(setup);
    this.queue(references.clear(attempt.scratchId));
    return attempt.scratchId;
  }
  /**
   * A value this unit PRODUCED, read back at the unit's boundary so the next
   * one binds it as a literal (D-58).
   *
   * One SELECT per value stored, at the end of the batch that stored it and
   * inside it — the scratch is alive exactly there — through the SAME owner
   * that reads a produced value back anywhere else
   * ({@link referenceProjection}), so the literal arrives through the field's
   * own codec and binds exactly as a spelled key would. A unit with no next —
   * the operation's terminal statements, and the one unit a prepared package IS
   * — has closed its scratch already ({@link finishTerminals}) and reads
   * nothing back: there is no later statement to bind it.
   */
  private carryScratch(): readonly ScratchCarry[] {
    const attempt = this.attemptStore;
    if (attempt?.scratchId === undefined) return NO_SCRATCH_CARRY;
    const carried: ScratchCarry[] = [];
    for (const publication of attempt.drainScratchPublications()) {
      const query = this.referenceProjection(publication.model, {
        [publication.field]: publication.expression,
      });
      this.queue(query.sql);
      carried.push({ query, publication });
    }
    return carried;
  }
  /**
   * The literal one read-back answered, held where the scratch id is held.
   *
   * Exactly one row, by construction: the read-back is
   * {@link referenceProjection}'s projection-only `SELECT <expression>` — no
   * FROM, no cardinality of its own — so every provider answers it with one
   * row, and the assertion is the statement of that. A guard here would be a
   * check whose unique coverage cannot be named, and it would fail in the one
   * way this unit exists to prevent: an uncarried value leaves the NEXT unit
   * binding a scratch its own segment never created.
   */
  private settleCarry(
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
  private closeScratch(): void {
    const attempt = this.attemptStore;
    if (attempt?.scratchId === undefined) return;
    this.queue(
      getAdapterInternals(this.driver.adapter).batchRefs.cleanup(
        attempt.scratchId
      )
    );
    attempt.scratchId = undefined;
  }
  private insertIdField(
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
  async insert(
    model: AnyModel,
    values: Input,
    demanded: ReadonlySet<string>,
    member: Member,
    operation = "create",
    producer?: object,
    membership?: MembershipParent
  ): Promise<Input> {
    const q = this.queries;
    const adapter = this.driver.adapter;
    const fields = Object.keys(values);
    let statement = fields.length
      ? adapter.mutations.insert(
          q.table(model),
          fields.map((field) => q.columnName(model, field)),
          [fields.map((field) => q.fieldValue(model, field, values[field]))]
        )
      : adapter.mutations.insertDefault(q.table(model));
    const produced = [...demanded].filter(
      (field) => values[field] === undefined
    );
    const context = this.statementContext(model, operation);
    if (!this.usesBatch) {
      const producedProjection = produced.length
        ? q.prepareProjection(model, {
            select: Object.fromEntries(produced.map((field) => [field, true]))
          })
        : undefined;
      const insertIdField = adapter.capabilities.supportsReturning
        ? undefined
        : this.insertIdField(model, produced);
      if (
        produced.length &&
        !adapter.capabilities.supportsReturning &&
        insertIdField === undefined
      )
        throw new Error(
          "Raptor 3 interactive output requires RETURNING or one generated increment field"
        );
      if (producedProjection && adapter.capabilities.supportsReturning)
        statement = sql`${statement} ${adapter.mutations.returning(
          sql.join(q.lowerProjection(producedProjection).columns, ", ")
        )}`;
      this.attempt.rejectedInsert = undefined;
      let response: QueryResult<Input>;
      try {
        response = await this.dispatch(1, false, () =>
          this.transport._execute<Input>(statement, context)
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
        throw new TypeError("INSERT did not produce the required record");
      return {
        ...values,
        ...producedValues
      };
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
    if (produced.length) {
      const references = getAdapterInternals(adapter).batchRefs;
      const insertIdField = this.insertIdField(model, produced);
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
            "Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING"
          );
        // The next segment must prove the actual stored owner, including supplied row-key fields.
        const returned = [
          ...new Set([...this.schema.keys(model), ...demanded])
        ];
        const select = Object.fromEntries(
          returned.map((field) => [field, true])
        );
        const projection = q.prepareProjection(model, { select });
        const resultIndex = this.queued.length;
        const inserted = this.queue(
          sql`${statement} ${adapter.mutations.returning(
            sql.join(q.lowerProjection(projection).columns, ", ")
          )}`,
          context,
          member
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
      const inserted = this.queue(producing!, context, member);
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
      const inserted = this.queue(statement, context, member);
      if (producer) this.attempt.recordInsertProducer(inserted, producer);
    }
    return published;
  }
  async update(
    model: AnyModel,
    where: Input,
    values: Input,
    member: Member,
    operation = "update",
    demanded: ReadonlySet<string> = new Set(),
    captured: Input = where
  ): Promise<Input> {
    if (Object.keys(values).length === 0) return {};
    const q = this.queries;
    const adapter = this.driver.adapter;
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
        if (wholeValue(value)) continue;
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
        if (state.type !== "int") {
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
              q.fieldValue(model, field, captured[field])
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
    const assignments = Object.entries(written).map(([field, value]) =>
      q.updateAssignment(model, field, value)
    );
    const statement = adapter.mutations.update(
      q.table(model),
      sql.join(assignments, ", "),
      q.lowerIdentity(model, where)
    );
    const context = this.statementContext(model, operation);
    if (!this.usesBatch && demanded.size) {
      const fields = [...demanded];
      const select = Object.fromEntries(fields.map((field) => [field, true]));
      const projection = q.prepareProjection(model, { select });
      if (!adapter.capabilities.supportsReturning) {
        await this.dispatch(1, false, () =>
          this.transport._execute(statement, context)
        );
        // The mutation's locked capture remains protected through this stored-row read.
        const rows = await this.read(
          q.select(model, {}, undefined, {
            projection,
            identity: this.updatedIdentity(model, captured, values),
          }),
          true
        );
        if (!rows[0])
          throw new TypeError("UPDATE did not produce the required record");
        return { ...published, ...rows[0] };
      }
      const response = await this.dispatch(1, false, () =>
        this.transport._execute<Input>(
          sql`${statement} ${adapter.mutations.returning(
            sql.join(q.lowerProjection(projection).columns, ", ")
          )}`,
          context
        )
      );
      const rows = q.decodeProjection(projection.shape, response.rows, true);
      if (!rows[0])
        throw new TypeError(
          "UPDATE RETURNING did not produce the required record"
        );
      return { ...published, ...rows[0] };
    }
    await this.effect(statement, context, member);
    if (observed.length === 0) return published;
    // The ordered observation: the write is queued, and the read that answers
    // the dependent rides the same native batch BEHIND it, so what it reads is
    // what this update wrote. The row is addressed by the identity this update
    // leaves it at — `updatedIdentity` names every key the payload changes —
    // and the value comes back decoded, a literal for the consumer's own write
    // in the next batch (D-51's succession of statements).
    const projection = q.prepareProjection(model, {
      select: Object.fromEntries(observed.map((field) => [field, true]))
    });
    const rows = await this.flush(
      q.select(model, {}, undefined, {
        projection,
        identity: this.updatedIdentity(model, captured, values)
      }),
      member
    );
    if (!rows[0])
      throw new TypeError("UPDATE did not produce the required record");
    return { ...published, ...rows[0] };
  }
  async associate(
    edge: Membership,
    source: Input,
    target: Input,
    member: Member
  ): Promise<void> {
    if (edge.kind === "reference") {
      const model = edge.owner === "source" ? edge.source : edge.target;
      const row = edge.owner === "source" ? source : target;
      const values = Object.fromEntries(
        edge.pairs.map((pair) =>
          edge.owner === "source"
            ? [pair.source, target[pair.target]]
            : [pair.target, source[pair.source]]
        )
      );
      await this.update(
        model,
        this.schema.identity(model, row),
        values,
        member
      );
      return;
    }
    await this.link(
      edge,
      Object.fromEntries([
        ...edge.sourceSide.members.map((pair) => [
          pair.junctionField,
          source[pair.referencedField]
        ]),
        ...edge.targetSide.members.map((pair) => [
          pair.junctionField,
          target[pair.referencedField]
        ])
      ]),
      member
    );
  }
  /**
   * Has this captured slot already been spent — and, if it had not, spend it.
   *
   * One walk down {@link SpentSlots}, so the ask and the record are one act:
   * no caller can spend a slot without asking, and none can ask without
   * spending. The leaf's presence IS the answer.
   */
  private spendSlot(table: string, values: readonly unknown[]): boolean {
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
  async link(
    edge: Extract<Membership, { kind: "junction" }>,
    values: Input,
    member: Member,
    captured?: Input
  ): Promise<void> {
    const adapter = this.driver.adapter;
    const q = this.queries;
    const columns = [
      ...edge.sourceSide.members,
      ...edge.targetSide.members
    ].map((pair) => pair.junctionField);
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
      if (!this.spendSlot(edge.table, slot)) {
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
    const operands = [edge.sourceSide, edge.targetSide].flatMap((side) =>
      side.members.map((pair) =>
        q.fieldValue(
          side.model,
          pair.referencedField,
          values[pair.junctionField]
        )
      )
    );
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
          )
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
        )
      });
      await this.effect(
        adapter.mutations.insert(
          adapter.identifiers.table(edge.table),
          columns,
          { select }
        ),
        this.statementContext(edge.source, "update"),
        member
      );
      return;
    }
    const insert = adapter.mutations.insert(
      adapter.identifiers.table(edge.table),
      columns,
      [operands]
    );
    await this.effect(
      sql`${insert} ${adapter.mutations.onConflict(
        sql.join(
          columns.map((column) => adapter.identifiers.escape(column)),
          ", "
        ),
        sql`NOTHING`
      )}`,
      this.statementContext(edge.source, "update"),
      member
    );
  }
  async captureMembership(
    edge: Extract<Membership, { kind: "junction" }>,
    addressed: Input
  ): Promise<Input | undefined> {
    const query = this.queries.junction(edge, addressed, !this.usesBatch);
    const rows = await this.read(query, true);
    const captured = rows[0] ? { ...addressed, ...rows[0] } : undefined;
    if (this.usesBatch) {
      const failure = new NestedWriteError(
        `Concurrent membership change on the singular polymorphic member of relation '${edge.name}': ${captured ? "the captured membership is gone" : "another owner holds the target"}; retry to converge.`,
        edge.name
      );
      // One sentence, one raceability answer (Arnaud's D-32). Both arms state
      // a MEMBERSHIP fact this operation OBSERVED — the pair it captured is
      // gone, or the slot it read empty is now held — and neither states an
      // identity the caller named: the two rows this write connects are the
      // ones the arguments spell, and the membership row is state the plan
      // discovered. So the loss of an observed membership is a race like any
      // other (rule 5, "initial absence and loss after observation are distinct
      // failure roles" — distinct ROLES, one raceability): the unit aborts, the
      // operation re-plans ONCE from the admitted values, and the fresh capture
      // reads the membership the race produced and converges. A repeated race
      // propagates this sentence, which is what it says to do.
      failure.meta.raceable = true;
      if (captured)
        this.requirePresent(this.queries.junction(edge, captured), failure);
      else await this.requireAbsent(query, failure);
    }
    return captured;
  }
  async remove(
    edge: Membership,
    source: Input | undefined,
    target: Input | undefined,
    keep: Input[],
    member: Member
  ): Promise<void> {
    const a = this.driver.adapter;
    const q = this.queries;
    if (edge.kind === "junction") {
      const conditions: Sql[] = [];
      for (const [side, values] of [
        [edge.sourceSide, source],
        [edge.targetSide, target]
      ] as const) {
        if (!values) continue;
        for (const pair of side.members)
          conditions.push(
            a.operators.eq(
              a.identifiers.escape(pair.junctionField),
              q.fieldValue(
                side.model,
                pair.referencedField,
                values[pair.referencedField]
              )
            )
          );
      }
      if (keep.length)
        conditions.push(
          a.operators.not(
            a.operators.or(
              ...keep.map((row) =>
                q.junctionWhere(
                  edge,
                  Object.fromEntries(
                    edge.targetSide.members.map((pair) => [
                      pair.junctionField,
                      row[pair.referencedField]
                    ])
                  )
                )
              )
            )
          )
        );
      await this.effect(
        a.mutations.delete(
          a.identifiers.table(edge.table),
          a.operators.and(...conditions)
        ),
        this.statementContext(edge.source, "update"),
        member
      );
      return;
    }
    const where = a.operators.and(
      ...edge.pairs.map((pair) =>
        a.operators.eq(
          q.column(edge.target, pair.target),
          q.fieldValue(edge.target, pair.target, source![pair.source])
        )
      ),
      ...(edge.discriminator
        ? [
            a.operators.eq(
              q.column(edge.target, edge.discriminator.field),
              q.value(edge.discriminator.value)
            )
          ]
        : []),
      ...(target
        ? [
            q.lowerIdentity(
              edge.target,
              this.schema.identity(edge.target, target)
            ),
          ]
        : []),
      ...(keep.length
        ? [
            a.operators.not(
              a.operators.or(
                ...keep.map(
                  (row) =>
                    q.lowerIdentity(
                      edge.target,
                      this.schema.identity(edge.target, row)
                    )
                )
              )
            )
          ]
        : [])
    );
    const clearability = edge.clearability as Extract<
      Membership["clearability"],
      { kind: "columns" }
    >;
    const values = clearability.fields.map((field) =>
      a.set.assign(q.column(edge.target, field), a.literals.null())
    );
    await this.effect(
      a.mutations.update(q.table(edge.target), sql.join(values, ", "), where),
      this.statementContext(edge.target, "update"),
      member
    );
  }
  /** One admitted payload, one prepared update: `Queries` is the sole interpreter. */
  private updateAssignments(model: AnyModel, values: Input): Sql[] {
    return Object.entries(values).map(([field, value]) =>
      this.queries.updateAssignment(model, field, value)
    );
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
  async mutateMembers(
    edge: Membership,
    parent: Input,
    selector: PreparedSelector,
    values: Input | undefined,
    member: Member
  ): Promise<void> {
    const q = this.queries;
    const a = this.driver.adapter;
    const model = edge.target;
    const filter = q.lowerMutationLimit(model, selector, undefined).where;
    const where = a.operators.and(
      // The target's own table name is the correlation alias, exactly as the
      // shipped builders passed `getTableName(childScope.model)`.
      q.memberWhere(edge, parent, model["~"].names.sql!),
      ...(filter ? [filter] : [])
    );
    await this.effect(
      values
        ? a.mutations.update(
            q.table(model),
            sql.join(this.updateAssignments(model, values), ", "),
            where
          )
        : a.mutations.delete(q.table(model), where),
      this.statementContext(model, values ? "updateMany" : "deleteMany"),
      member
    );
  }
  async delete(model: AnyModel, row: Input, member: Member): Promise<void> {
    await this.effect(
      this.driver.adapter.mutations.delete(
        this.queries.table(model),
        this.queries.lowerIdentity(model, this.schema.identity(model, row))
      ),
      this.statementContext(model, "delete"),
      member
    );
  }
  private async effect(
    statement: Sql,
    context: QueryExecutionContext,
    member: Member
  ): Promise<void> {
    if (this.usesBatch) this.queue(statement, context, member);
    else
      await this.dispatch(1, false, () =>
        this.transport._execute(statement, context)
      );
  }
}

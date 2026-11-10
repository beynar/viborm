import { attachCommitCertainty } from "@drivers/driver-error-context";
import {
  bindExecutionTransactionPhases,
  deriveStatementExecutionContext,
} from "@drivers/execution-context";
import type { AnyDriver } from "@drivers/exports";
import {
  borrowPositionalResult,
  resolvePositionalResultDriver,
} from "@drivers/positional-result";
import { transferPreparedStatement } from "@drivers/prepared-statement-provenance";
import type {
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers/types";
import {
  attachRecordSeriesProgress,
  isVibORMError,
  NestedWriteError,
  QueryError,
  type RecordSeriesProgress,
  retainWriteOutcomeFailure,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
  VibORMErrorCode,
} from "@errors";
import type { AnyModel } from "@schema/model";
import type { Sql } from "@sql";
import { createFailureError } from "../../batch-error-attribution";
import {
  compileBindBudgetChunks,
  normalizedBindParameterLimit,
} from "../../bind-budget";
import type {
  PreparedBatchGuard,
  PreparedBatchOperation,
  PreparedGuardFailure,
} from "../../types";
import { type WriteKind, writeSinks } from "../../write-sinks";
import {
  GatedFieldRefusal,
  InvalidScalarResult,
  type PreparedProjection,
  type PreparedSelector,
  type ProjectionShape,
  type Queries,
  type Query,
  type Read,
  RecursiveOutputOverBudget,
  refusesWhileDecoding,
  returningSafeProjection,
} from "./query";
import type { CallScope, RowJudgement } from "./row-scope";
import {
  type EngineSchema,
  type Input,
  isReadOperation,
  type Operation,
  record,
} from "./schema";
import type { Membership } from "./storage";
import { type ScratchPublication, TransportAttempt } from "./transport-attempt";

export type Member = object;

/**
 * The rows a write answering a relation projection returns, named in its own
 * statement ({@link OperationContext.answersInStatement}); reserved-prefixed,
 * as every engine-owned name is, so no table a projection reads is shadowed.
 */
export const MUTATION_ROWS = "__viborm_mutation";
/** The derived table a projection sharing relation bodies is read through. */
export const MUTATION_ANSWER = "__viborm_answer";

/**
 * The single-row mutations whose returned identity a batch-only, non-returning
 * driver cannot resolve inside its own atomic unit (the shipped
 * `ATOMIC_RESOLUTION_OPERATIONS`).
 */
const ATOMIC_RESOLUTION_OPERATIONS: ReadonlySet<string> = new Set([
  "update",
  "delete",
  "upsert",
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
export interface Continuation {
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
export const NO_CONTINUATIONS: readonly Continuation[] = Object.freeze([]);
/**
 * One value a dispatched unit stored in its own scratch and reads back at its
 * boundary, with the projection that decodes it through the field's codec.
 */
export type ScratchCarry = {
  readonly query: Query;
  readonly publication: ScratchPublication;
};
/** What a unit that stored no produced value carries across its boundary. */
export const NO_SCRATCH_CARRY: readonly ScratchCarry[] = Object.freeze([]);
/**
 * The captured junction slots one attempt has already vacated, keyed by the
 * captured VALUES themselves: the edge's table, then its columns in the edge's
 * own order ({@link OperationContext.spendSlot}).
 */
export type SpentSlots = Map<unknown, SpentSlots | true>;

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
/**
 * The operation's result, asked of the root record's own INSERT or UPDATE on
 * the interactive route: `projection` rides that statement's `RETURNING` and
 * `row` holds what it answered, undecoded, for {@link OperationContext.finishAnswered}.
 * Asked only where nothing after that statement can change the row
 * (`CommandExecution.complete`); a statement that is never issued leaves `row`
 * unset, and the operation reads its result as before.
 */
export interface StatementAnswer {
  readonly projection: PreparedProjection;
  row?: Input;
}
/** A nested write's refusal of the row it produces (§5.3, R4). */
export function nestedRefusal(
  verb: string,
  relation: string
): PreparedGuardFailure {
  return {
    kind: "nestedWrite",
    relation,
    message: `Cannot ${verb} relation '${relation}': the record it writes is not permitted.`,
    raceable: false,
  };
}
/**
 * A write whose statement judges the row it produces (R4): its model, and
 * what it reports when its assertion fails, before it writes.
 */
export interface JudgedWrite {
  readonly model: AnyModel;
  readonly refusal: PreparedGuardFailure;
}
export abstract class OperationContext {
  readonly queries: Queries;
  readonly driver: AnyDriver;
  readonly usesBatch: boolean;
  protected readonly ownership: ExecutionOwnership;
  /**
   * Whether this context PREPARES a package for the array owner instead of
   * executing: the one route that can issue no planning read of its own,
   * because every statement it produces rides the owner's batch. Read by the
   * plan to choose a form that needs no such read (D-46).
   */
  get preparesBatch(): boolean {
    return this.ownership === "batch-preparation";
  }
  readonly #memberRollback: MemberRollback | undefined;
  readonly #operationRegion: MemberRollback | undefined;
  /** Where this operation states its own durable write phase ({@link WriteOutcomeSeam}). */
  protected readonly writeOutcome: WriteOutcomeSeam | undefined;
  /** True only while the operation's OWN region is the current transport. */
  protected ownRegionOpen = false;
  protected transport: AnyDriver;
  protected attemptStore: TransportAttempt | undefined;
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
  protected get attempt(): TransportAttempt {
    return (this.attemptStore ??= new TransportAttempt());
  }
  /** The statements queued on this operation's attempt; empty until one is. */
  protected get queued(): readonly BatchQuery[] {
    return this.attemptStore?.pending ?? NO_QUEUED_STATEMENTS;
  }
  protected committedMemberSet: Set<Member> | undefined;
  #memberAttributionMap: WeakMap<Member, MemberAttribution> | undefined;
  protected continuationList: Continuation[] | undefined;
  /** The captured junction slots this attempt has already vacated ({@link link}). */
  protected vacatedMemberships: SpentSlots | undefined;
  /** The rows write hooks wait for on the batch route ({@link captureRows}). */
  protected captures:
    | {
        readonly statement: BatchQuery;
        readonly read: { readonly shape: ProjectionShape };
        readonly take: (rows: Input[]) => void;
      }[]
    | undefined;
  protected committedSegments = 0;
  protected mayHaveCommittedSegment: true | undefined;
  #completedMembers = 0;
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
  protected get committedProgress(): boolean {
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
  protected memberAdmissionStarted = false;
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
  protected setWindow: Member | undefined;
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
  protected heldOutcomeFailure?: { readonly failure: unknown };
  protected atomicAssertionRejection: unknown | undefined;
  #incompletePreparationSentinel: Error | undefined;
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
  protected get incompletePreparation(): Error {
    return (this.#incompletePreparationSentinel ??= new Error(
      "This operation requires dynamic execution"
    ));
  }
  protected preparedParser:
    | ((results: QueryResult<unknown>[]) => unknown)
    | undefined;
  protected preparedGuardList: PreparedBatchGuard[] | undefined;
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
  #answeredFailureSet: WeakSet<object> | undefined;
  #correlationIdValue: string | undefined;
  /**
   * This operation's correlation id, minted on its FIRST read and then stable
   * for the operation's life. The client route always hands its own trusted
   * execution context down ({@link attribution}), so a minted id is read only
   * by an error's `meta` and by a statement context the caller did not supply —
   * paying `crypto.randomUUID()` in the field block spent it on every operation
   * for the ones that never ask (rule 7).
   */
  get #correlationId(): string {
    return (this.#correlationIdValue ??= crypto.randomUUID());
  }
  /**
   * The operation's physical envelope. `deferred` is the only state in which the
   * envelope has not been decided yet: it becomes `statement` when the operation
   * reaches its terminal statement without having issued any other, and `open`
   * when it does not (§ {@link run}).
   */
  #envelope: "open" | "deferred" | "statement" = "open";
  #performed = 0;
  #requiresEnvelopeSentinel: Error | undefined;
  /**
   * The envelope sentinel, built on its FIRST use and never before — the same
   * control-flow value as {@link incompletePreparation} and for the same
   * reason. It is raised by {@link dispatch} and caught by its one reader
   * ({@link run}), which compares it by identity; a successful operation never
   * materialises it, and an operation that does pays for exactly one.
   */
  protected get requiresEnvelope(): Error {
    return (this.#requiresEnvelopeSentinel ??= new Error(
      "This operation must execute through its driver context"
    ));
  }
  readonly schema: EngineSchema;
  /** The call's row facts and instant; absent on a client without them. */
  readonly scope: CallScope | undefined;
  readonly modelName: string;
  readonly operation: Operation;
  /**
   * The caller's own trusted execution context. It already carries this
   * operation's model, verb, correlation id, instrumentation and resolved
   * extension chain, and the chain is held by the identity of that exact
   * object, so the candidate passes it through rather than minting a second
   * attribution (g4/unit03/note.md B-4).
   */
  readonly #callerAttribution: QueryExecutionContext | undefined;
  constructor(
    schema: EngineSchema,
    factoryDriver: AnyDriver,
    modelName: string,
    operation: Operation,
    binding?: ExecutionBinding,
    prepareBatch = false,
    callerAttribution?: QueryExecutionContext,
    scope?: CallScope
  ) {
    this.scope = scope;
    this.schema = schema;
    this.modelName = modelName;
    this.operation = operation;
    this.#callerAttribution = callerAttribution;
    this.ownership = prepareBatch
      ? "batch-preparation"
      : (binding?.kind ?? "standalone");
    this.driver =
      binding?.kind === "borrowed-transaction" ? binding.driver : factoryDriver;
    this.writeOutcome = binding?.writeOutcome;
    this.#memberRollback =
      binding?.kind === "borrowed-transaction"
        ? binding.memberRollback
        : undefined;
    this.#operationRegion =
      binding?.kind === "borrowed-transaction"
        ? binding.operationRegion
        : undefined;
    this.transport = this.driver;
    this.usesBatch =
      this.ownership === "batch-preparation" ||
      (this.ownership === "standalone" && !this.driver.supportsTransactions);
    this.queries = this.createQueries(
      schema,
      this.driver.adapter,
      this.driver.result,
      scope?.domain,
      scope
    );
  }
  /** What writes this context's statements, in its language. */
  protected abstract createQueries(
    ...args: ConstructorParameters<typeof Queries>
  ): Queries;
  get attribution(): QueryExecutionContext {
    return (
      this.#callerAttribution ?? {
        model: this.modelName,
        operation: this.operation,
        correlationId: this.#correlationId,
      }
    );
  }
  /**
   * This operation's own facts for an error's meta. Attribution is the driver's
   * context (and may be the caller's trusted object); an error's meta is the
   * candidate's own record and keeps the exact fields it has always carried.
   */
  protected get errorMeta(): Record<string, unknown> {
    return {
      model: this.modelName,
      operation: this.operation,
      correlationId: this.#correlationId,
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
  protected statementContext(
    model: AnyModel,
    operation: string
  ): QueryExecutionContext {
    const name = model["~"].names.ts!;
    const caller = this.#callerAttribution;
    if (!caller)
      return { model: name, operation, correlationId: this.#correlationId };
    return caller.model === name
      ? caller
      : deriveStatementExecutionContext(caller, name);
  }
  protected queue(
    statement: Sql,
    context: QueryExecutionContext = this.attribution,
    member?: Member
  ): BatchQuery {
    const prepared = this.transport._prepare(statement, context);
    // The DRIVER owns this query's identity. It defers the statement transform
    // and registers the typed `Sql` against the
    // object it returned (`drivers/driver-transaction-base.ts:246-264`), which
    // the statement onion reads back before dispatch — so a snapshot that does
    // not carry the provenance silently drops every deferred transform.
    const query = transferPreparedStatement(prepared, {
      ...prepared,
      context,
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
        ? (this.#memberAttributionMap?.get(parent)?.path ?? [])
        : [];
      const attribution = (this.#memberAttributionMap ??= new WeakMap());
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
  #executingMember: Member | undefined;
  async executeMember<T>(
    execute: () => Promise<T>,
    member?: Member
  ): Promise<T> {
    const enclosingWrite = this.attemptStore?.holdsWrite === true;
    const observing = this.#executingMember;
    if (member) this.#executingMember = member;
    try {
      const output = await execute();
      if (this.ownership !== "batch-preparation") {
        if (!enclosingWrite) await this.flush(undefined, member);
        this.#completedMembers++;
      }
      return output;
    } catch (error) {
      throw this.failure(error, "member", member);
    } finally {
      this.#executingMember = observing;
    }
  }
  async executeSkippableMember(
    execute: () => Promise<void>,
    rootProducer: object,
    member: Member
  ): Promise<boolean> {
    this.admitsSuppression("rows involving nested writes");
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
  protected async withMemberRollback<T>(
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
    return this.#memberRollback && !this.ownRegionOpen
      ? this.#memberRollback(withinRollback, this.attribution)
      : outer.withTransaction(withinRollback, undefined, this.attribution);
  }
  /** Member suppression requires rollback ownership before any provider effects. */
  admitsSuppression(rows: string): true {
    if (
      (this.ownership === "borrowed-transaction" && !this.#memberRollback) ||
      this.usesBatch
    )
      throw new UnsupportedOperationError(
        `skipDuplicates cannot skip ${rows} on driver '${this.driver.driverName}' in this scope; a member savepoint is required.`,
        { meta: { model: this.modelName, operation: this.operation } }
      );
    return true;
  }
  failure(
    error: unknown,
    phase: RecordSeriesProgress["phase"],
    member?: Member
  ): unknown {
    if (
      typeof error === "object" &&
      error !== null &&
      this.#answeredFailureSet?.has(error)
    )
      return error;
    let failure = error;
    if (error instanceof InvalidScalarResult) {
      const driver = this.driver.driverName;
      const model = this.modelName;
      const operation = this.operation;
      const { scalarType, reason } = error;
      failure = new QueryError(
        `The "${operation}" result is incompatible with the ${scalarType} scalar domain: ${reason}.`,
        {
          code: VibORMErrorCode.QUERY_RESULT_INVALID,
          meta: { driver, model, operation, scalarType, reason },
        }
      );
    }
    if (
      error instanceof RecursiveOutputOverBudget ||
      error instanceof GatedFieldRefusal
    )
      failure = error.refusal(this.operation, this.modelName);
    const attribution = member
      ? this.#memberAttributionMap?.get(member)
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
          completedMembers: this.#completedMembers,
          ...(attribution?.path.length ? { memberPath: attribution.path } : {}),
          ...(attribution ? { totalMembers: attribution.totalMembers } : {}),
          ...(this.mayHaveCommittedSegment
            ? { mayHaveCommittedSegment: this.mayHaveCommittedSegment }
            : {}),
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
  #region():
    | ((execute: (driver: AnyDriver) => Promise<unknown>) => Promise<unknown>)
    | undefined {
    if (this.usesBatch) return undefined;
    if (this.ownership === "borrowed-transaction") {
      const granted = this.#operationRegion;
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
            this.#regionPhase = "ready";
          },
          committed: () => {
            this.#regionPhase = "committed";
          },
        })
      : this.attribution;
    return (execute) =>
      this.driver.withTransaction(execute, undefined, attribution);
  }
  /** How far the region this operation opened got, as its driver reported it. */
  #regionPhase: "pending" | "ready" | "committed" = "pending";
  #openRegionPhase(): void {
    this.#regionPhase = "pending";
  }
  /** Run the operation inside the one region it owns. */
  async #withinRegion<T>(
    region: (
      execute: (driver: AnyDriver) => Promise<unknown>
    ) => Promise<unknown>,
    body: () => Promise<T>
  ): Promise<T> {
    this.#openRegionPhase();
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
        this.#regionPhase === "committed"
          ? "committed"
          : this.#regionPhase === "ready"
            ? "may-have-committed"
            : undefined;
      if (!certainty) throw error;
      const primary = isVibORMError(error)
        ? attachCommitCertainty(error, certainty)
        : error;
      await this.stateWriteOutcome(
        this.#regionPhase === "committed"
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
   * every row written once).
   */
  async run<T>(body: () => Promise<T>, single = false): Promise<T> {
    if (
      !(
        this.ownership === "batch-preparation" ||
        isReadOperation(this.operation)
      )
    )
      return await this.#runWrite(body, single);
    try {
      return await body();
    } catch (error) {
      throw this.#runFailure(error);
    }
  }
  /** A write's envelope, out of line from reads, which need none. */
  async #runWrite<T>(body: () => Promise<T>, single: boolean): Promise<T> {
    try {
      if (!single) this.#requireAtomicUnit();
      const region = this.#region();
      if (!region) return await this.#batchAttempt(body);
      if (!single) return await this.#regionAttempt(region, body);
      this.#envelope = "deferred";
      try {
        return await body();
      } catch (error) {
        if (error !== this.requiresEnvelope) throw error;
      }
      this.#restart();
      return await this.#regionAttempt(region, body);
    } catch (error) {
      throw this.#runFailure(error);
    }
  }
  /** What {@link run} raises for a failure of its body. */
  #runFailure(error: unknown): unknown {
    // A record series is a COMMITTED SEGMENT of this operation's own writes,
    // and nothing else asked here: a generated-output continuation is
    // declared behind the segment that published the identity it re-pins
    // ({@link insert}), so that segment is already counted, while a premise —
    // the parent a membership correlates on — is declared ahead of every
    // segment and is not a member of any series. Asking about continuations
    // instead published a series' progress for an ordinary UPDATE that had
    // committed nothing (`tests/raptor3/g2-transport.test.ts`, "An ordinary
    // UPDATE must retain only acknowledged progress").
    const decoding =
      error instanceof InvalidScalarResult ||
      error instanceof RecursiveOutputOverBudget ||
      error instanceof GatedFieldRefusal;
    if (decoding || (this.usesBatch && this.committedSegments > 0))
      return this.failure(error, decoding ? "result" : "member");
    return error;
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
  #requireAtomicUnit(): void {
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
  protected dispatch<T>(
    statements: number,
    terminal: boolean,
    execute: () => Promise<T>
  ): Promise<T> {
    try {
      if (this.#envelope === "deferred") {
        if (!(terminal && statements === 1 && this.#performed === 0))
          throw this.requiresEnvelope;
        this.#envelope = "statement";
      }
      this.#performed += statements;
      return execute();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  /** Discard the un-executed plan so the body can be constructed again. */
  #restart(attempt = new TransportAttempt()): void {
    this.attemptStore = attempt;
    this.continuationList = undefined;
    this.vacatedMemberships = undefined;
    this.memberAdmissionStarted = false;
    this.#envelope = "open";
  }
  /**
   * The command interpreter's ONE replacement of both attempt regions, held by
   * the owner that opens the region so it can spend the recovery allowance
   * without knowing how a command attempt is built. It answers the replacement
   * transport region once, and `undefined` ever after.
   */
  attachRecovery(
    replace: () => TransportAttempt | undefined,
    acceptsInsert: (error: unknown) => boolean
  ): void {
    this.#replaceAttempt = replace;
    this.#acceptInsertRecovery = acceptsInsert;
  }
  #replaceAttempt: (() => TransportAttempt | undefined) | undefined;
  #acceptInsertRecovery: ((error: unknown) => boolean) | undefined;
  #recoverySpent = false;
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
    if (this.#recoverySpent) return undefined;
    const replacement = this.#replaceAttempt?.();
    if (!replacement) return undefined;
    this.#recoverySpent = true;
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
    return this.ownership === "standalone" && !this.ownRegionOpen;
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
  async #regionAttempt<T>(
    region: (
      execute: (driver: AnyDriver) => Promise<unknown>
    ) => Promise<unknown>,
    body: () => Promise<T>
  ): Promise<T> {
    try {
      return await this.#withinRegion(region, body);
    } catch (error) {
      if (
        this.recoveryRejection(error)?.kind !== "insert" ||
        !this.#acceptInsertRecovery?.(error)
      )
        throw error;
      const replacement = this.spendRecovery();
      if (!replacement) throw error;
      this.#restart(replacement);
      return await this.#withinRegion(region, body);
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
  async #batchAttempt<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      if (this.recoveryRejection(error)?.kind !== "assertion") throw error;
      const replacement = this.spendRecovery();
      if (!replacement) throw error;
      this.#restart(replacement);
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
   * Internal reads in ONE native batch, each answered as {@link read} answers
   * it, under its own model's statement context: the batch route's planning
   * reads taken together (`CommandExecution.readAhead`). They commit nothing,
   * so the batch is a read like any other, outside the queue.
   */
  async readTogether(
    reads: readonly { readonly query: Query; readonly model: AnyModel }[]
  ): Promise<Input[][]> {
    if (this.ownership === "batch-preparation") {
      throw this.incompletePreparation;
    }
    const statements = reads.map(({ query, model }) => {
      const context = this.statementContext(model, this.operation);
      const prepared = this.transport._prepare(query.sql, context);
      return transferPreparedStatement(prepared, { ...prepared, context });
    });
    const responses = await this.dispatch(statements.length, false, () =>
      this.transport._executeBatch<Input>(
        statements,
        undefined,
        this.attribution
      )
    );
    return reads.map(({ query }, index) =>
      this.queries.decodeQuery(query, responses[index]!.rows, true)
    );
  }
  /**
   * The boundary a read outside the queue claims: a statement answered there
   * cannot see a write the queue still holds, so this is where a member claims
   * the boundary {@link executeMember} deferred. Only a member claims it, and
   * only for a write some OTHER record of the series left waiting
   * ({@link TransportAttempt.holdsOtherMemberWrite}). A read taken outside
   * every member is the record's OWN observation, and where it stands relative
   * to this unit's writes is the dependency pass's answer, not this one's — an
   * ordered observation is stated INSIDE the queued unit on purpose (N1), and a
   * boundary taken under it would commit the very writes its premise exists to
   * abort.
   */
  async claimMemberBoundary(): Promise<void> {
    const observer = this.#executingMember;
    if (observer && this.attemptStore?.holdsOtherMemberWrite(observer))
      await this.flush();
  }
  /**
   * One statement's raw provider answer. The dispatcher both readers share, so
   * the terminal boundary ({@link publishedTerminal}) sees the rows the
   * provider handed back and an internal read sees the same rows decoded.
   */
  protected async answer(
    query: Query,
    terminal: boolean,
    model?: AnyModel
  ): Promise<QueryResult<Input>> {
    await this.claimMemberBoundary();
    const context = model
      ? this.statementContext(model, this.operation)
      : this.attribution;
    // Awaited, not returned: an `async` frame adopts a returned promise a
    // microtask later, and workerd's process emulation reports one rejected in
    // between (a pre-I/O refusal such as V8003) as unhandled
    // (`nodejs-compat-rejections.test.ts`).
    return await this.dispatch(1, terminal, () =>
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
  protected publishedProjection(
    shape: ProjectionShape,
    rows: Input[]
  ): Input[] {
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
    const positional =
      this.ownership === "standalone" && read.value.kind === "collection"
        ? resolvePositionalResultDriver(this.transport)
        : undefined;
    if (positional) return this.#publishPositional(read, missing, positional);
    const response = await this.answer(read.query, true);
    return this.#decideRead(
      read,
      missing,
      this.publishedTerminal([read.query], [response.rows])
    );
  }
  /** A collection read over the positional transport, out of line. */
  async #publishPositional(
    read: Read,
    missing: (() => Error) | undefined,
    positional: NonNullable<ReturnType<typeof resolvePositionalResultDriver>>
  ): Promise<unknown> {
    const response = await this.dispatch(1, true, () =>
      positional(read.query.sql, this.attribution)
    );
    if (
      response.kind === "positional" &&
      resolvePositionalResultDriver(this.transport) === positional
    ) {
      this.queries.assertExpectedRows(read.query, response.rows.length);
      return this.#decideRead(
        read,
        missing,
        this.queries.decodeProjection(
          read.query.shape,
          response.rows,
          false,
          response.columns
        )
      );
    }
    const borrowed =
      response.kind === "borrowed"
        ? response.result
        : borrowPositionalResult(response);
    return this.#decideRead(
      read,
      missing,
      this.publishedTerminal([read.query], [borrowed.rows.map(record)])
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
      return this.#decideRead(
        read,
        missing,
        this.publishedTerminal([read.query], [response.rows.map(record)])
      );
    };
    return undefined;
  }
  #decideRead(
    read: Read,
    missing: (() => Error) | undefined,
    rows: Input[]
  ): unknown {
    const value = read.result(rows);
    if (value === null && missing) throw missing();
    return value;
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
      return await this.#flushQueued(projections, query, member, premise);
    } finally {
      this.attemptStore?.restorePremises();
    }
  }
  async #flushQueued(
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
   * The row a lookup would read, where this context knows it without reading and
   * checks it in its next statement instead, in order with the writes around it.
   */
  pin(_lookup: object): Input | undefined {
    return;
  }
  protected abstract statePremise(
    query: Query,
    present: boolean,
    failure: Error
  ): void;
  /**
   * How many units this operation has submitted: a read outside the queue
   * sees what the last one left, so an answer taken at one count is the
   * answer at any point before the next.
   */
  get submissions(): number {
    return this.submissions_;
  }
  protected submissions_ = 0;
  protected abstract submit(
    publishingGeneratedOutput?: boolean,
    member?: Member
  ): Promise<QueryResult<Input>[]>;
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
  protected async settleSubmitted<T>(
    answer: () => T | PromiseLike<T>
  ): Promise<T> {
    const held = this.heldOutcomeFailure;
    this.heldOutcomeFailure = undefined;
    let value: T;
    try {
      value = await answer();
    } catch (failure) {
      throw held
        ? this.answered(retainWriteOutcomeFailure(failure, held.failure))
        : failure;
    }
    if (held) throw this.answered(held.failure);
    return value;
  }
  /** An INSERT a backend saw rejected without a failing statement. */
  protected rejectInsert(error: UniqueConstraintError, producer: object): void {
    this.attempt.rejectedInsert = { error, producer };
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
    if (
      this.ownership !== "standalone" &&
      !(this.ownership === "borrowed-transaction" && this.#operationRegion)
    )
      return undefined;
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
  protected published(rows: Input[], single?: () => Error): unknown {
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
  abstract packageGuard(
    model: AnyModel,
    probe: Sql,
    premise: PreparedBatchGuard["premise"],
    failure: PreparedGuardFailure
  ): void;
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
  /** The result the root's own statement answered ({@link StatementAnswer}). */
  finishAnswered(answer: StatementAnswer): Promise<Input | undefined> {
    return this.finishTerminals(
      [],
      () => this.publishedProjection(answer.projection.shape, [answer.row!])[0]
    );
  }
  finishMany(queries: readonly Query[]): Promise<Input[]> {
    return this.finishTerminals(queries, (rows) => rows);
  }
  #decodeTerminalResults(
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
  protected async finishTerminals<T>(
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
        result(this.#decodeTerminalResults(queries, results, resultIndex));
      return result([]);
    }
    if (this.queued.length === 0) return result([]);
    const responses = await this.submit();
    return this.settleSubmitted(() => {
      try {
        return result(
          this.#decodeTerminalResults(queries, responses, resultIndex)
        );
      } catch (error) {
        throw queries.length ? this.failure(error, "result") : error;
      }
    });
  }
  isIncompletePreparation(error: unknown): boolean {
    return error === this.incompletePreparation;
  }
  /**
   * A write hook wants the rows a nested write `kind`s on `model`
   * ({@link WriteSink}): read them in this operation's own unit — at once on
   * the interactive route, queued beside the write on the batch route and
   * decoded with its batch's answer. `change`: what the write itself sets on
   * rows read before it (a cleared foreign key); an interactive session reads
   * those `FOR UPDATE`, so they cannot change before the write. Nothing where
   * no hook wants them.
   */
  async captureRows(
    model: AnyModel,
    kind: WriteKind,
    where: { readonly identity?: Input; readonly condition?: Sql },
    change?: Input
  ): Promise<void> {
    const sink = writeSinks.get(this.attribution);
    const name = model["~"].names.ts!;
    if (!sink?.wants(name, kind)) return;
    const q = this.queries;
    const read = q.select(model, {}, undefined, {
      ...where,
      forUpdate: change !== undefined && !this.usesBatch,
      projection: q.prepareProjection(model, {}),
    });
    const take = (rows: Input[]) =>
      sink.wrote(
        name,
        kind,
        change ? rows.map((row) => ({ ...row, ...change })) : rows
      );
    if (!this.usesBatch)
      return take(await this.read(read, false, false, model));
    (this.captures ??= []).push({
      statement: this.queue(
        read.sql,
        this.statementContext(model, this.operation)
      ),
      read,
      take,
    });
  }
  /** The captures among `statements`, each decoded from its own answer. */
  protected takeCaptures(
    statements: readonly BatchQuery[],
    results: readonly QueryResult<unknown>[]
  ): void {
    const captures = this.captures;
    if (captures === undefined) return;
    this.captures = captures.filter((capture) => {
      const at = statements.indexOf(capture.statement);
      if (at === -1) return true;
      capture.take(
        this.queries.decodeProjection(
          capture.read.shape,
          results[at]!.rows.map(record)
        )
      );
      return false;
    });
  }
  preparedBatch(): PreparedBatchOperation<unknown> | undefined {
    const parse = this.preparedParser;
    if (parse === undefined) return undefined;
    if (this.attemptStore?.hasAssertedPremises) return undefined;
    return {
      queries: this.queued.map((query) =>
        transferPreparedStatement(query, {
          sql: query.sql,
          params: query.params ?? [],
          context: query.context ?? this.attribution,
        })
      ),
      ...(this.preparedGuardList?.length
        ? { guards: this.preparedGuardList }
        : {}),
      parseResult: (results) => {
        try {
          this.takeCaptures(this.queued, results);
          return parse(results);
        } catch (error) {
          throw this.failure(error, "result");
        }
      },
    };
  }
  /**
   * Say ONE durable write phase on the client's cache rail, keeping the
   * OPERATION's own failure primary when the client's listener throws.
   *
   * The composition itself is not this engine's rule to state: it belongs to
   * `retainWriteOutcomeFailure` (`@errors`), the ONE owner the client, the
   * deferred operation and this context all reach — the primary stays primary
   * and `cause`, and the listener failures are flattened out of the publication
   * owner's aggregate and retained beside it, in registration order. It was
   * restated here while it lived in `@extensions/query`, an import this engine
   * does not take: no file under `raptor3/**` imports `@extensions/*` today,
   * and importing the publication owner would add `src/extensions/query.ts`
   * and `src/query-engine/routed-operations.ts` to this file's runtime closure
   * (181 → 183). A directory cycle is not what that avoids — the shipped
   * `query-engine/pending-operation.ts` already holds the engine→extensions
   * runtime edge. FC-05 moved the pure rule to the boundary both layers
   * already depend on and deleted the restatement.
   * `primary` absent means the operation has not failed, which was the shipped
   * `throw outcomeFailure` arm.
   */
  protected async stateWriteOutcome(
    say: (() => Promise<void>) | undefined,
    primary?: unknown
  ): Promise<void> {
    if (!say) return;
    try {
      await say();
    } catch (outcomeFailure) {
      if (primary === undefined) throw outcomeFailure;
      throw this.answered(retainWriteOutcomeFailure(primary, outcomeFailure));
    }
  }
  /** Mark a failure as this operation's own answer ({@link answeredFailures}). */
  protected answered<T>(failure: T): T {
    if (typeof failure === "object" && failure !== null)
      (this.#answeredFailureSet ??= new WeakSet()).add(failure);
    return failure;
  }
  /**
   * Whether a write of `model`'s rows answers with `projection` out of its OWN
   * statement, so no locate, capture or re-read is sent. A RETURNING-safe
   * projection rides the `RETURNING` ({@link returningSafeProjection}). Any
   * other reads other rows, lowered by the read owner over the written row
   * (`#overWrite`), in one of two spellings:
   *
   * - where a `WITH` may write (PostgreSQL), over the write's own rows,
   *
   *     WITH "__viborm_mutation" AS (<write> RETURNING *)
   *     SELECT <projection> FROM "__viborm_mutation" AS "q0"
   *
   *   and every part of one statement reads the snapshot taken BEFORE it: the
   *   written row through the `WITH`, every table as it was;
   * - elsewhere (SQLite) in the `RETURNING` itself, correlated to the written
   *   row by its table's name (an aliased target is not visible there), each
   *   subquery reading the database as the write left it, the referential
   *   actions it fired included.
   *
   * Neither can roll the write back, so a projection whose decoding may
   * refuse the row ({@link refusesWhileDecoding}) keeps the transactional
   * route. Either is the answer the route it replaces gives, under two
   * conditions:
   *
   * - a DELETE: that route read the projection BEFORE removing the row, which
   *   is what a snapshot reads (self-relations and the rows the delete
   *   cascades to included) and what a live read does not, so a DELETE folds
   *   only into a snapshot;
   * - an INSERT or UPDATE: no table the projection reads may change but the
   *   written one, which an UPDATE can only do through a referential action
   *   it fires by rewriting a column a foreign key references, one of the
   *   model's referenceable keys (a foreign key targets nothing else); and
   *   the projection's statement may not read the written table at all (a
   *   self-relation, a filter or a policy reaching it), which every such read
   *   spells as its identifier in FROM position, so the text is the sound
   *   test and a name that merely contains it only costs the fold.
   *
   * A user trigger that writes OTHER tables is the one change neither sees,
   * as the scalar fold's `RETURNING` never saw a trigger's own row changes.
   *
   * `written`: an UPDATE's assignments; absent for an INSERT and a DELETE.
   */
  /**
   * May a root UPDATE without RETURNING answer `projection` from the read
   * that confirms it ({@link update})? Its columns alone, as a RETURNING's.
   */
  answersAfterUpdate(projection: PreparedProjection): boolean {
    return (
      !(this.usesBatch || this.driver.adapter.capabilities.supportsReturning) &&
      returningSafeProjection(projection) &&
      !refusesWhileDecoding(projection)
    );
  }
  abstract answersInStatement(
    model: AnyModel,
    projection: PreparedProjection,
    effect: "insert" | "update" | "delete",
    written?: Input
  ): boolean;
  /** Child-free inserts may share a statement inside this operation's own region. */
  async insertMany(
    model: AnyModel,
    rows: () => Input[],
    refusal?: PreparedGuardFailure
  ): Promise<number | undefined> {
    if (!this.ownRegionOpen || this.usesBatch) return undefined;
    return (
      (await this.createMany(
        model,
        rows(),
        undefined,
        false,
        undefined,
        refusal
      )) as { count: number }
    ).count;
  }
  abstract createMany(
    model: AnyModel,
    given: Input[],
    projection?: PreparedProjection,
    skipDuplicates?: boolean,
    single?: () => Error,
    refusal?: PreparedGuardFailure
  ): Promise<unknown>;
  abstract upsertOne(
    model: AnyModel,
    given: Input,
    updates: Input,
    target: readonly string[],
    projection?: PreparedProjection,
    single?: () => Error,
    upserted?: (created: boolean) => void,
    found?: Query
  ): Promise<unknown>;
  abstract updateMany(
    model: AnyModel,
    selector: PreparedSelector,
    given: Input,
    limit?: number,
    projection?: PreparedProjection,
    single?: () => Error,
    captured?: readonly Input[]
  ): Promise<unknown>;
  abstract deleteMany(
    model: AnyModel,
    selector: PreparedSelector,
    limit?: number,
    projection?: PreparedProjection,
    single?: () => Error
  ): Promise<unknown>;
  protected abstract closeScratch(): void;
  abstract insert(
    model: AnyModel,
    given: Input,
    demanded: ReadonlySet<string>,
    member: Member,
    operation?: string,
    producer?: object,
    membership?: MembershipParent,
    refusal?: PreparedGuardFailure,
    answer?: StatementAnswer
  ): Promise<Input>;
  abstract updateLocated(
    model: AnyModel,
    selector: PreparedSelector,
    given: Input,
    projection: PreparedProjection,
    missing: () => Error,
    operation?: string,
    refusal?: PreparedGuardFailure,
    answer?: StatementAnswer
  ): Promise<Input>;
  abstract update(
    model: AnyModel,
    current: Input,
    given: Input,
    member: Member,
    operation?: string,
    demanded?: ReadonlySet<string>,
    missing?: () => Error,
    judgement?: RowJudgement,
    refusal?: PreparedGuardFailure,
    answer?: StatementAnswer
  ): Promise<Input>;
  abstract updateRows(
    model: AnyModel,
    identities: readonly Input[],
    values: Input,
    member: Member,
    operation: string,
    judgement: RowJudgement | undefined,
    refusal: PreparedGuardFailure | undefined
  ): Promise<void>;
  abstract link(
    edge: Extract<Membership, { kind: "junction" }>,
    values: Input,
    member: Member,
    captured?: Input,
    written?: Input
  ): Promise<void>;
  abstract linkMany(
    edge: Extract<Membership, { kind: "junction" }>,
    rows: readonly Input[],
    member: Member
  ): Promise<void>;
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
  abstract remove(
    edge: Membership,
    source: Input | undefined,
    target: Input | undefined,
    keep: Input[],
    member: Member
  ): Promise<void>;
  protected refusal({ model, refusal }: JudgedWrite): Error {
    return createFailureError(refusal, model["~"].names.ts!, this.operation);
  }
  abstract mutateMembers(
    edge: Membership,
    parent: Input,
    selector: PreparedSelector,
    values: Input | undefined,
    member: Member
  ): Promise<void>;
  abstract delete(model: AnyModel, row: Input, member: Member): Promise<void>;
}

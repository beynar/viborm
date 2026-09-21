import type { AnyModel } from "@schema/model";
import type {
  PreparedProjection,
  PreparedSelector,
  SelectorFacts,
} from "../shared/query";
import type { Input } from "../shared/schema";
import type { Membership } from "../shared/storage";
import { storedFields } from "../shared/storage";
import { Assignments, type Origin } from "./assignments";
import type { CommandExecution } from "./execution";

export interface BoundMembership {
  readonly edge: Membership;
  readonly parent: Assignments;
}
/**
 * A failure a PLAN knows how to build, not one it owns.
 *
 * Every one of these sentences is a pure function of construction-time facts —
 * the verb and the relation name — so the plan carries the recipe and the one
 * site that actually raises it builds it. Constructing them while nothing has
 * failed ran the whole `VibORMError` constructor (two stack captures, two
 * metadata sanitisations) on the success path of every nested write, which the
 * G4 cutover diagnosis measured (`g4/cutover/perf-diagnosis.md` §4.1, cause
 * 1b). The thunk is called EXACTLY where the old value was raised or handed to
 * an assertion, so the error a caller sees is byte-identical.
 */
export type DeferredFailure = () => Error;
export type SelectionSource =
  | {
      readonly kind: "query";
      readonly where?: Input;
      /**
       * `where` was admitted as a UNIQUE selector whose shipped counterpart is
       * `buildWhereUnique`, so its addressable entries name the row through the
       * constraint (`Queries.prepareSelector`). The root verbs' lookups state
       * it themselves; for a nested write's target the one owner of the answer
       * is {@link nestedTargetAddressesConstraint}. A bulk member's `where`
       * (`updateMany` / `deleteMany`) is a filter by contract and never asks.
       * Ignored when the caller prepares `selector` itself.
       */
      readonly unique?: boolean;
      readonly selector?: PreparedSelector;
      readonly membership?: BoundMembership;
    }
  | {
      readonly kind: "producer";
      readonly where?: Input;
      readonly unique?: boolean;
      readonly selector?: PreparedSelector;
      readonly producer: Assignments;
    };

/**
 * The nested verbs that address a single target row, spelled as the case labels
 * of `RelationBody.relation`'s own switch. The type is the wiring: a nested verb
 * added to the filter family that forgets to consult the predicate below is a
 * typecheck error at its call site, not a silent "discriminator" default.
 */
export type NestedTargetVerb =
  | "connect"
  | "connectOrCreate"
  | "delete"
  | "disconnect"
  | "set"
  | "update"
  | "upsert";

/**
 * Whether a nested write's unique target selector names its row through the
 * constraint. The shipped engine answers this from the EDGE's own compiler,
 * not from the verb alone:
 *
 * - a JUNCTION target is a discriminator in both phases. Its planning probe is
 *   `buildFindUnique` (`write-engine/RelationJunctionPart.ts:1509`, `:1629`,
 *   `:1663`) and its batch statement passes the selector as `whereUnique`
 *   (`:1698`, `:2146`, `:2259`), which `JunctionStatements.ts:322-323`
 *   compiles with `buildWhereUnique` — whichever verb addressed it.
 * - a REFERENCE-held target of `disconnect` / `delete` / `update` is the one
 *   family the shipped engine recombines as `{ field: { equals: value } }`
 *   through `uniqueSelectorConjuncts` (`write-engine/shared.ts:671`, reached
 *   from `RelationWritePart.ts:987`, `UpdateOperation.ts:469` and
 *   `RecordUpdateCompiler.ts:3722`) and hands to `buildWhere`, so it is a
 *   FILTER and keeps the engine's case-sensitivity contract.
 */
export function nestedTargetAddressesConstraint(
  edge: Membership,
  verb: NestedTargetVerb
): boolean {
  return (
    edge.kind === "junction" ||
    (verb !== "disconnect" && verb !== "delete" && verb !== "update")
  );
}

export function membershipFields(edge: Membership): string[] {
  return edge.kind === "reference"
    ? [
        ...edge.pairs.map((pair) => pair.source),
        ...(edge.discriminator?.side === "source"
          ? [edge.discriminator.field]
          : []),
      ]
    : edge.sourceSide.members.map((pair) => pair.referencedField);
}

/** A prepared row selection; observations and transport values belong to execution. */
export class Selection {
  readonly kind = "lookup";
  readonly fields: Assignments;
  readonly facts: SelectorFacts;
  readonly selector: PreparedSelector;
  private readonly rowProjection: PreparedProjection;
  private readonly identityProjection: PreparedProjection;
  origin?: Origin;
  retained?: DeferredFailure;
  membershipOnly?: boolean;
  /**
   * The answer depends on an earlier write of this operation (N1): the read is
   * taken at its execution point, after that write — on the batch route through
   * the barrier that submits the queued unit with its premises and reads in the
   * same native batch ({@link OperationContext.flush}), never the raw read that
   * would race a queued write.
   */
  dependent?: boolean;
  /**
   * THIS operation inserts the key this selector names when the row is absent:
   * the missing arm of an `upsert` or a `connectOrCreate`. Such a probe reads
   * without locking — the PROBE alone ({@link query}); the other reads this
   * selection answers keep the lock their own answer earns.
   *
   * A locking read cannot protect an absence, and asking for one costs the
   * operation its own convergence. MySQL answers a miss on a unique index with
   * a gap lock over the index supremum; the two racers hold that same gap lock
   * AT ONCE (gap locks do not exclude each other), and the insert-intention
   * each of them then requests waits for the other's gap — a cycle InnoDB
   * breaks by aborting one whole transaction (`ER_LOCK_DEADLOCK`). Measured
   * both ways under `r2c/receipts/`: with the lock, two `X GRANTED` gaps on the
   * supremum pseudo-record and a deadlock; without it, no lock at all, and the
   * loser's INSERT is refused by the unique constraint.
   *
   * That refusal is the arbiter the create arm already relies on (Pin Rule 2:
   * no `notExists` premise precedes the create INSERT), and the retryable
   * signal {@link CommandExecution.recover} converges on. PostgreSQL locks
   * nothing for a miss and the batch route asks for no lock at all, so an
   * unlocked probe is the answer the other two routes already give.
   */
  insertsWhenAbsent?: boolean;

  constructor(
    private readonly execution: CommandExecution,
    readonly model: AnyModel,
    readonly source: SelectionSource,
    readonly required?: DeferredFailure,
    facts?: SelectorFacts
  ) {
    const queries = execution.context.queries;
    this.fields = new Assignments(model, "select");
    this.selector =
      source.selector ??
      queries.prepareSelector(model, source.where, source.unique === true);
    this.facts = facts ?? queries.selectorFacts(this.selector);
    this.rowProjection = queries.prepareProjection(model, {
      select: Object.fromEntries(
        storedFields(execution.context.schema, model).map((field) => [
          field,
          true,
        ]),
      ),
    });
    this.identityProjection = queries.prepareProjection(model, {
      select: Object.fromEntries(
        execution.context.schema.keys(model).map((field) => [field, true]),
      ),
    });
  }
  membership() {
    return this.source.kind === "query" ? this.source.membership : undefined;
  }
  private bindMembership(membership: BoundMembership | undefined) {
    return (
      membership && {
        edge: membership.edge,
        parent: this.execution.attempt.select(
          membership.parent,
          membershipFields(membership.edge)
        ),
      }
    );
  }
  private rowQuery(
    selector: PreparedSelector,
    membership: BoundMembership | undefined,
    identity?: Input,
    unlocked = false,
  ) {
    const ctx = this.execution.context;
    return ctx.queries.select(
      this.model,
      {
        take: 1,
      },
      this.bindMembership(membership),
      {
        forUpdate: !(ctx.usesBatch || unlocked),
        identity,
        projection: this.rowProjection,
        selector,
      },
    );
  }
  /**
   * The CURRENT, protected confirmation of a row this selection FOUND: a read
   * whose answer is the row this operation is about to consume, so it keeps its
   * lock whatever the PROBE of the same selection does ({@link insertsWhenAbsent}
   * reaches {@link query} alone).
   *
   * It is the membership confirmation a correlated nested `upsert` already
   * issued, with the two facts that were that arm's own turned into arguments —
   * the MEMBERSHIP it proves, and the CONDITION it proves (this selection's own
   * selector, the narrowing selector of a probe taken over it, or the
   * conjunction of every such probe's, which is why the argument is prepared
   * MEANING and not another selection). The three facts that make it a
   * confirmation rather than a second lookup are fixed: it addresses the
   * located row by IDENTITY, so it can adopt no replacement record; it keeps
   * `forUpdate`, so the requirement it proves survives into the effect that
   * spends it; and it returns the whole stored row, which is the authoritative
   * binding of every value that row supplies
   * ({@link CommandExecution.confirmFound}).
   */
  confirm(
    membership: BoundMembership | undefined,
    condition: PreparedSelector = this.selector
  ) {
    return this.rowQuery(
      condition,
      membership,
      this.execution.identity(this.fields)
    );
  }
  /**
   * This located row, holding NULL in ONE component the consumer is about to
   * spend: the complement premise of the reference fold
   * ({@link CommandExecution.folded}).
   *
   * Where the value is folded it is a sub-select, so the literal the probe read
   * exists nowhere after and the shared representability requirement
   * ({@link CommandExecution.requireRepresentable}) can only be asked of the
   * capture. This states the same requirement of the row the fold will READ,
   * inside the unit that spends it, and states it as an ABSENCE so a row that
   * has GONE satisfies it — that loss is the presence premise's, with the
   * sentence that premise owns, and this one keeps the field-exact attribution
   * its own sentence names. One component per premise, for the same reason.
   */
  unrepresentable(field: string) {
    const ctx = this.execution.context;
    return ctx.queries.select(
      this.model,
      { take: 1 },
      undefined,
      {
        condition: ctx.driver.adapter.operators.isNull(
          ctx.queries.column(this.model, field),
        ),
        identity: this.execution.identity(this.fields),
        projection: this.identityProjection,
      },
    );
  }
  /**
   * The rows the selector names OUTSIDE the membership: a batch premise of
   * the observation that finds this row (N1) — absent, the row is either not
   * there or a member, which is what a found requirement asks.
   */
  outsideMembership(membership: BoundMembership) {
    const bound = this.bindMembership(membership);
    return this.execution.context.queries.select(
      this.model,
      { take: 1 },
      bound && { ...bound, outside: true },
      { projection: this.identityProjection, selector: this.selector },
    );
  }
  query() {
    const identity =
      this.source.kind === "producer"
        ? this.execution.identity(this.source.producer)
        : undefined;
    return this.rowQuery(
      this.selector,
      this.membership(),
      identity,
      this.insertsWhenAbsent,
    );
  }
  /**
   * The premise that states a requirement this operation still owns: the
   * located row, addressed by its IDENTITY, under the membership it is
   * consumed through and the condition it matched.
   *
   * `held` is what makes it PROTECT that requirement rather than merely
   * observe it. A premise and the effect it stands in front of are two
   * statements, and a batch is one transaction, not one statement: under READ
   * COMMITTED every statement takes its own snapshot, so a commit landing
   * between them is visible to the second and the first has already answered.
   * A held read keeps the row for the rest of the transaction, which is where
   * the consuming effect is ({@link CommandExecution.holdMember}).
   */
  captured(
    condition: Selection = this,
    membership: BoundMembership | undefined = condition.membership(),
    take?: 1,
    held = false
  ) {
    const ctx = this.execution.context;
    return ctx.queries.select(
      this.model,
      {
        take,
      },
      this.bindMembership(membership),
      {
        forUpdate: held,
        identity: this.execution.identity(this.fields),
        projection: this.identityProjection,
        selector: condition.selector,
      },
    );
  }
}

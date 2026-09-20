import type { BatchQuery } from "@drivers/types";
import type { UniqueConstraintError } from "@errors";
import type { AnyModel } from "@schema";
import { Sql } from "@sql";
import type { Member } from "./operation-context";
import type { Query } from "./query";

/**
 * One assertion this attempt raises if its statement disagrees with the world.
 *
 * `readsBatchReference` states whether it asks about a value this unit
 * PRODUCED, read back from the batch reference scratch: the one premise a
 * rollback leaves unaskable, because the transaction took the scratch with it.
 * The attribution ladder reads it to know which premise it cannot re-probe.
 */
type AssertedPremise = {
  query: Query;
  present: boolean;
  failure: Error;
  readsBatchReference: boolean;
};

/**
 * One value this unit PRODUCED and stored in its own batch scratch: the
 * expression every statement of that unit binds it by, and the model field
 * whose codec reads it back at the unit's boundary (D-58).
 */
export type ScratchPublication = {
  readonly model: AnyModel;
  readonly field: string;
  readonly expression: Sql;
};

const NO_PUBLICATIONS: readonly ScratchPublication[] = Object.freeze([]);

/**
 * Disposable batch construction and rejection evidence; never committed progress.
 *
 * Only {@link pending} belongs to every attempt. The three evidence collections
 * exist from the first fact each one records, because an operation that records
 * none — every read, prepared or executed — would otherwise pay two `Map`s and a
 * `Set` per operation for collections nothing ever reads (rule 7,
 * `g4/perf2/note.md` §2). An absent collection IS empty: the drain accessors
 * below answer an empty copy, and {@link hasAssertedPremises} answers `false`,
 * so no reader can tell absent from empty.
 */
export class TransportAttempt {
  readonly pending: BatchQuery[] = [];
  rejectedInsert?: { error: UniqueConstraintError; producer: object };
  /**
   * The scratch of the unit being assembled — the DISPATCHED UNIT's, not this
   * attempt's (D-58). It is minted by the first statement that stores into it
   * and cleared where the unit ends, so the next unit that needs one makes its
   * own and no statement ever names a table its own segment did not create.
   */
  scratchId?: string;
  nextField = 0;
  private publications?: ScratchPublication[];
  private carriedValues?: Map<Sql, unknown>;
  private producers?: Map<BatchQuery, object>;
  private premises?: Map<BatchQuery, AssertedPremise>;
  private members?: Set<Member>;
  /** Record one produced value this unit stored in its scratch (D-58). */
  publishScratchValue(publication: ScratchPublication): void {
    (this.publications ??= []).push(publication);
  }
  /** The values this unit stored; the attempt keeps none of them. */
  drainScratchPublications(): readonly ScratchPublication[] {
    const published = this.publications ?? NO_PUBLICATIONS;
    this.publications = undefined;
    return published;
  }
  /** The literal one published expression was read back as at the boundary. */
  carryScratchValue(expression: Sql, value: unknown): void {
    (this.carriedValues ??= new Map()).set(expression, value);
  }
  /**
   * One field's value as it stands NOW: the literal a segment boundary read
   * back for the expression that published it, or the value itself.
   *
   * A published expression names the scratch of the unit that stored it, and
   * that scratch dies with its unit — so once the boundary has read the value
   * back, the expression is spent and the literal is the value (D-58). Asked by
   * the estate's one reader of a field's runtime value, `CommandAttempt.read`.
   */
  carried(value: unknown): unknown {
    if (!(value instanceof Sql)) return value;
    const carried = this.carriedValues;
    return carried?.has(value) ? carried.get(value) : value;
  }
  /** Attribute one queued INSERT to the producer whose row it writes. */
  recordInsertProducer(insert: BatchQuery, producer: object): void {
    (this.producers ??= new Map()).set(insert, producer);
  }
  /** Record the failure one queued assertion raises when it disagrees. */
  assertPremise(assertion: BatchQuery, premise: AssertedPremise): void {
    (this.premises ??= new Map()).set(assertion, premise);
  }
  /** Declare one queued statement as belonging to a record-series member. */
  recordMember(member: Member): void {
    (this.members ??= new Set()).add(member);
  }
  /** Whether any assertion has been recorded, without creating the map. */
  get hasAssertedPremises(): boolean {
    return this.premises !== undefined && this.premises.size > 0;
  }
  /**
   * Is a WRITE waiting, or only premises?
   *
   * Two kinds of statement wait here before a dispatch: the premises a unit
   * proves, which commit nothing on their own, and the writes they protect.
   * A caller asking whether dispatching NOW would make someone else's write
   * durable asks this, and nothing finer.
   */
  get holdsWrite(): boolean {
    return this.pending.some((statement) => !this.premises?.has(statement));
  }
  /**
   * Is a write of a record OTHER than this one's waiting?
   *
   * Every record's write is declared with the record it belongs to
   * ({@link recordMember}); a premise and the batch scratch's own statements
   * are declared with none. So a member asking this asks the one question its
   * boundary answers: has some other record of this series left an effect in
   * the queue that a read taken OUTSIDE the queue cannot see
   * ({@link OperationContext.executeMember})?
   */
  holdsOtherMemberWrite(member: Member): boolean {
    if (!this.members) return false;
    for (const queued of this.members) if (queued !== member) return true;
    return false;
  }
  /** The producers recorded so far; this attempt keeps none of them. */
  drainInsertProducers(): Map<BatchQuery, object> {
    const producers = this.producers ?? new Map<BatchQuery, object>();
    this.producers = undefined;
    return producers;
  }
  /**
   * The premises the next dispatch does not carry the write for.
   *
   * A premise is proved inside the atomic unit that contains the write it
   * protects, never in an earlier planning batch (Arnaud's D-29): proved early
   * it would close the window it exists for before the write opens it. The
   * queue's TRAILING premises are exactly those — nothing queued after them is
   * theirs to protect yet — so they step out of this dispatch and lead the
   * next one, in the order they were stated.
   */
  withholdPremises(): void {
    const premises = this.premises;
    if (!premises) return;
    let first = this.pending.length;
    while (first > 0 && premises.has(this.pending[first - 1]!)) first--;
    this.withheld.push(...this.pending.splice(first));
  }
  /** The withheld premises, back at the head of the queue that stated them. */
  restorePremises(): void {
    if (this.withheld.length > 0)
      this.pending.unshift(...this.withheld.splice(0));
  }
  private readonly withheld: BatchQuery[] = [];
  /**
   * The assertions recorded so far; this attempt keeps none of them, except a
   * withheld premise's own, which travels with it to the dispatch that proves
   * it.
   */
  drainAssertedPremises(): Map<BatchQuery, AssertedPremise> {
    const premises = this.premises ?? new Map<BatchQuery, AssertedPremise>();
    const kept = new Map<BatchQuery, AssertedPremise>();
    for (const statement of this.withheld) {
      const premise = premises.get(statement);
      if (!premise) continue;
      kept.set(statement, premise);
      premises.delete(statement);
    }
    this.premises = kept.size > 0 ? kept : undefined;
    return premises;
  }
  /** The members declared so far; this attempt keeps none of them. */
  drainMembers(): Member[] {
    const members = this.members ? [...this.members] : [];
    this.members = undefined;
    return members;
  }
}

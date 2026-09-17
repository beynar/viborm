import type { BatchQuery } from "@drivers/types";
import type { UniqueConstraintError } from "@errors";
import type { Member } from "./operation-context";
import type { Query } from "./query";

/** One assertion this attempt raises if its statement disagrees with the world. */
type AssertedPremise = { query: Query; present: boolean; failure: Error };

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
  scratchId?: string;
  nextField = 0;
  private producers?: Map<BatchQuery, object>;
  private premises?: Map<BatchQuery, AssertedPremise>;
  private members?: Set<Member>;
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

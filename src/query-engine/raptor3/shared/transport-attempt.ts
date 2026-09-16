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
  /** The assertions recorded so far; this attempt keeps none of them. */
  drainAssertedPremises(): Map<BatchQuery, AssertedPremise> {
    const premises = this.premises ?? new Map<BatchQuery, AssertedPremise>();
    this.premises = undefined;
    return premises;
  }
  /** The members declared so far; this attempt keeps none of them. */
  drainMembers(): Member[] {
    const members = this.members ? [...this.members] : [];
    this.members = undefined;
    return members;
  }
}

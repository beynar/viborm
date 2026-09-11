import type { BatchQuery } from "@drivers/types";
import type { UniqueConstraintError } from "@errors";
import type { Member } from "./operation-context";
import type { Query } from "./query";

/** Disposable batch construction and rejection evidence; never committed progress. */
export class TransportAttempt {
  readonly pending: BatchQuery[] = [];
  readonly insertProducers = new Map<BatchQuery, object>();
  rejectedInsert?: { error: UniqueConstraintError; producer: object };
  readonly assertionFailures = new Map<
    BatchQuery,
    { query: Query; present: boolean; failure: Error }
  >();
  readonly pendingMembers = new Set<Member>();
  scratchId?: string;
  nextField = 0;
}

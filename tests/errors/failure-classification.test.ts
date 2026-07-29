/**
 * The one classification seam (plan T1-U3).
 *
 * `classifyFailure` answers the question the executor and the routed retry policy both need:
 * is this throwable something a caller was meant to receive (an EXPECTED failure — the database
 * refused, the payload was refused, a documented capability boundary was reached), or is it a
 * DEFECT (the engine broke its own invariant, or something that is not a VibORM error at all
 * escaped)?
 *
 * The answer is read off the CODE, never the class, and that is the point. V8003
 * (`UnsupportedOperationError`) is a documented shape refusal that happens to EXTEND
 * `QueryEngineError`; V9001 (a bare `QueryEngineError`) is a crash. An `instanceof
 * QueryEngineError` check calls both a crash — which is exactly the mistake that surfaced 77
 * capability refusals as INTERNAL_ERROR for weeks.
 *
 * The switch behind it is exhaustive with a `never` guard, so adding a `VibORMErrorCode`
 * without giving it a disposition does not compile. That is the W5-U2 bug class — a lane built
 * blind to an error-code change — moved from "an audit finds it" to "the build stops".
 */

import {
  CacheInvalidTTLError,
  CheckConstraintError,
  ClientInitializationError,
  ConnectionError,
  classifyFailure,
  FeatureNotSupportedError,
  ForeignKeyError,
  InvalidTransactionInputError,
  isRetryableError,
  MigrationError,
  NestedWriteAssertionError,
  NestedWriteError,
  NotFoundError,
  NotNullConstraintError,
  PendingOperationError,
  QueryEngineError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
  ValidationError,
  ValueTooLongError,
  VibORMError,
  VibORMErrorCode,
} from "@errors";
import { expectTypeOf } from "vitest";
import {
  isRetryableRace,
  markRaceable,
} from "../../src/query-engine-v2/race-retry";

/**
 * The census. Every concrete class, with the disposition the taxonomy claims for it. A class
 * added without a row here is invisible to this suite, which is what T7's registry gate is for;
 * what this table pins is that each row's CLAIM matches what `classifyFailure` answers.
 */
const CENSUS: Array<{
  label: string;
  error: unknown;
  kind: "failure" | "defect";
  retryable: boolean;
}> = [
  // Constraint failures — the database's own rules. Never retryable.
  {
    label: "UniqueConstraintError",
    error: new UniqueConstraintError("u"),
    kind: "failure",
    retryable: false,
  },
  {
    label: "ForeignKeyError",
    error: new ForeignKeyError("f"),
    kind: "failure",
    retryable: false,
  },
  {
    label: "NotNullConstraintError",
    error: new NotNullConstraintError("n"),
    kind: "failure",
    retryable: false,
  },
  {
    label: "CheckConstraintError",
    error: new CheckConstraintError("c"),
    kind: "failure",
    retryable: false,
  },
  {
    label: "ValueTooLongError",
    error: new ValueTooLongError("v"),
    kind: "failure",
    retryable: false,
  },
  // Contention — the two the database itself asks you to re-run.
  {
    label: "TransactionError (deadlock)",
    error: new TransactionError("d", { code: VibORMErrorCode.DEADLOCK }),
    kind: "failure",
    retryable: true,
  },
  {
    label: "TransactionError (serialization)",
    error: new TransactionError("s", {
      code: VibORMErrorCode.SERIALIZATION_FAILURE,
    }),
    kind: "failure",
    retryable: true,
  },
  {
    label: "TransactionError (plain)",
    error: new TransactionError("t"),
    kind: "failure",
    retryable: false,
  },
  {
    label: "ConnectionError (timeout)",
    error: new ConnectionError("ct", {
      code: VibORMErrorCode.CONNECTION_TIMEOUT,
    }),
    kind: "failure",
    retryable: true,
  },
  {
    label: "ConnectionError (refused)",
    error: new ConnectionError("cf"),
    kind: "failure",
    retryable: false,
  },
  {
    label: "QueryError (timeout)",
    error: new QueryError("qt", { code: VibORMErrorCode.QUERY_TIMEOUT }),
    kind: "failure",
    retryable: true,
  },
  {
    label: "QueryError (plain)",
    error: new QueryError("q"),
    kind: "failure",
    retryable: false,
  },
  // Refusals aimed at the caller.
  {
    label: "ValidationError",
    error: new ValidationError("findMany", [{ path: "where", message: "no" }]),
    kind: "failure",
    retryable: false,
  },
  {
    label: "NotFoundError",
    error: new NotFoundError("user", "findUniqueOrThrow"),
    kind: "failure",
    retryable: false,
  },
  {
    label: "NestedWriteError",
    error: new NestedWriteError("nw", "posts"),
    kind: "failure",
    retryable: false,
  },
  {
    label: "NestedWriteAssertionError",
    error: new NestedWriteAssertionError("a"),
    kind: "failure",
    retryable: false,
  },
  {
    label: "InvalidTransactionInputError",
    error: new InvalidTransactionInputError(),
    kind: "failure",
    retryable: false,
  },
  {
    label: "PendingOperationError",
    error: PendingOperationError.clientMismatch("user", "findMany"),
    kind: "failure",
    retryable: false,
  },
  {
    label: "FeatureNotSupportedError",
    error: new FeatureNotSupportedError("vector", "l2"),
    kind: "failure",
    retryable: false,
  },
  {
    label: "ClientInitializationError",
    error: new ClientInitializationError("no driver"),
    kind: "failure",
    retryable: false,
  },
  {
    label: "CacheInvalidTTLError",
    error: new CacheInvalidTTLError("ttl"),
    kind: "failure",
    retryable: false,
  },
  {
    label: "MigrationError",
    error: new MigrationError("m"),
    kind: "failure",
    retryable: false,
  },
  // The V8003 / V9001 pair — the reason this seam exists.
  {
    label: "UnsupportedOperationError (V8003 refusal)",
    error: new UnsupportedOperationError("shape not expressed"),
    kind: "failure",
    retryable: false,
  },
  {
    label: "QueryEngineError (V9001 defect)",
    error: new QueryEngineError("invariant broken"),
    kind: "defect",
    retryable: false,
  },
  // Not VibORM errors at all.
  {
    label: "a raw Error",
    error: new Error("raw"),
    kind: "defect",
    retryable: false,
  },
  { label: "a thrown string", error: "boom", kind: "defect", retryable: false },
  { label: "undefined", error: undefined, kind: "defect", retryable: false },
];

describe("classifyFailure", () => {
  for (const row of CENSUS) {
    it(`classifies ${row.label} as a ${row.kind}`, () => {
      const classified = classifyFailure(row.error);
      expect(classified.kind).toBe(row.kind);
      if (classified.kind === "failure") {
        expect(classified.retryable).toBe(row.retryable);
        expect(classified.error).toBe(row.error);
      }
    });
  }

  it("separates the V8003 refusal from its V9001 parent class", () => {
    const refusal = new UnsupportedOperationError("shape not expressed");
    const defect = new QueryEngineError("invariant broken");
    // Both answer TRUE to the instanceof check that used to decide this.
    expect(refusal).toBeInstanceOf(QueryEngineError);
    expect(defect).toBeInstanceOf(QueryEngineError);
    // The code tells them apart, and so does the classifier.
    expect(classifyFailure(refusal).kind).toBe("failure");
    expect(classifyFailure(defect).kind).toBe("defect");
  });

  it("narrows the classified error to a VibORMError on the failure arm", () => {
    const classified = classifyFailure(new UniqueConstraintError("u"));
    if (classified.kind === "failure") {
      expectTypeOf(classified.error).toEqualTypeOf<VibORMError>();
      expect(classified.error.code).toBe(VibORMErrorCode.UNIQUE_CONSTRAINT);
    } else {
      expectTypeOf(classified.error).toEqualTypeOf<unknown>();
      throw new Error("expected the failure arm");
    }
  });
});

describe("the retry policy reads the same switch", () => {
  it("agrees with isRetryableError on every code in the taxonomy", () => {
    // The bidirectional pin: `VibORMError.isRetryable()` no longer keeps its own list, it reads
    // `verdictFor`. If someone re-introduces a second list, one of these codes disagrees.
    for (const code of Object.values(VibORMErrorCode)) {
      const error = new VibORMError("probe", code);
      const classified = classifyFailure(error);
      const retryable =
        classified.kind === "failure" ? classified.retryable : false;
      expect(retryable).toBe(error.isRetryable());
      expect(retryable).toBe(isRetryableError(error));
    }
  });

  it("keeps the retryable set at exactly the four codes it has always been", () => {
    const retryable = Object.values(VibORMErrorCode).filter((code) =>
      new VibORMError("probe", code).isRetryable()
    );
    expect(retryable.sort()).toEqual(
      [
        VibORMErrorCode.CONNECTION_TIMEOUT,
        VibORMErrorCode.QUERY_TIMEOUT,
        VibORMErrorCode.DEADLOCK,
        VibORMErrorCode.SERIALIZATION_FAILURE,
      ].sort()
    );
  });
});

describe("the routed race retry, now stated in classification terms", () => {
  it("still retries a self-declared raceable guard abort", () => {
    // The only errors that actually carry meta.raceable: guard aborts raised as
    // NestedWriteError (failureError, batch-error-attribution.ts). They classify as expected.
    const abort = new NestedWriteError("premise changed", "posts");
    abort.meta.raceable = true;
    expect(classifyFailure(abort).kind).toBe("failure");
    expect(isRetryableRace(abort)).toBe(true);
  });

  it("still retries an error the executor pinned, and nothing else", () => {
    const pinned = new UniqueConstraintError("lost the create race");
    expect(isRetryableRace(pinned)).toBe(false);
    markRaceable(pinned);
    expect(isRetryableRace(pinned)).toBe(true);
    expect(isRetryableRace(new UniqueConstraintError("unrelated"))).toBe(false);
  });

  it("never retries a defect, whatever metadata it wears", () => {
    // Not reachable today — nothing raises a V9001 with meta.raceable — but the disposition is
    // now explicit rather than incidental: a broken invariant is not a race.
    const defect = new QueryEngineError("invariant broken");
    defect.meta.raceable = true;
    expect(classifyFailure(defect).kind).toBe("defect");
    expect(isRetryableRace(defect)).toBe(false);
  });

  it("never retries a raw throwable", () => {
    expect(isRetryableRace(new Error("raw"))).toBe(false);
    expect(isRetryableRace("boom")).toBe(false);
  });
});

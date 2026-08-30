/**
 * The ONE rule for combining a primary failure with a cleanup failure.
 *
 * Every pinned migration session ends with cleanup — the unlock, then the
 * provider's own release of the reserved producer — and that cleanup runs while
 * a failure is often already propagating. The rule this suite pins is total:
 * the original failure stays PRIMARY and stays UNCHANGED, the cleanup failure
 * stays inspectable beside it, and nothing in the recording can itself throw,
 * whatever either value is made of.
 *
 * The two owners that apply it are `Driver._withPinnedSession`, whose release
 * runs after the body, and the migration lock's `releaseAfterFailure`. This
 * suite owns the driver half and the rule itself; the migration half is pinned
 * by `tests/unit/migrations/pinned-migration-session.core.test.ts`.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { Driver } from "@drivers/driver";
import {
  type PinnedSessionReservation,
  readSuppressedFailures,
  withSuppressedFailure,
} from "@drivers/shared";
import type { QueryResult } from "@drivers/types";
import { describe, expect, it } from "vitest";

/**
 * A driver whose reserved producer fails to come back.
 *
 * The reservation is what a provider hands over, so its `release` is the one
 * seam that can fail AFTER the body has already decided the command's outcome.
 */
class ReleaseFailingDriver extends Driver<{ tag: "client" }, { tag: "tx" }> {
  readonly adapter: DatabaseAdapter = new PostgresAdapter();
  /** Every reservation and how it ended. */
  readonly sessions: string[] = [];
  /** What the provider's release rejects with. */
  private readonly releaseFailure: unknown;

  constructor(releaseFailure: unknown) {
    super("postgresql", "release-failing");
    this.releaseFailure = releaseFailure;
  }

  protected initClient(): Promise<{ tag: "client" }> {
    return Promise.resolve({ tag: "client" });
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(): Promise<QueryResult<T>> {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected executeRaw<T>(): Promise<QueryResult<T>> {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected transaction<T>(
    _client: unknown,
    fn: (tx: { tag: "tx" }) => Promise<T>
  ): Promise<T> {
    return fn({ tag: "tx" });
  }

  protected override pinnedSession(): Promise<
    PinnedSessionReservation<{ tag: "client" } | { tag: "tx" }>
  > {
    this.sessions.push("reserve");
    const failure = this.releaseFailure;
    return Promise.resolve({
      session: { tag: "tx" },
      release: (discard) => {
        this.sessions.push(discard ? "destroy" : "release");
        return Promise.reject(failure);
      },
    });
  }
}

/** The value a settled promise rejected with, or a marker for a resolution. */
function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => new Error("the pinned session was expected to fail"),
    (error: unknown) => error
  );
}

/**
 * Decorates a failure with something that LOOKS like this module's evidence and
 * refuses to be read.
 *
 * The property name is public and the array is the caller's, so a failure
 * arriving at the recorder can already carry one — from a library that names
 * its own field the same way, or from code that means harm. Iterating it is
 * running the caller's code at the exact moment a migration failure is
 * propagating, and a throw there does not merely lose the cleanup evidence: it
 * REPLACES the primary with a `TypeError` about an iterator.
 */
function plantHostileSuppressedFailures(carrier: object): unknown[] {
  const planted: unknown[] = [];
  Object.defineProperty(planted, Symbol.iterator, {
    value: () => {
      throw new Error("this array refuses to be iterated");
    },
  });
  Object.defineProperty(carrier, "suppressedFailures", {
    configurable: true,
    enumerable: false,
    value: planted,
    writable: true,
  });
  return planted;
}

describe("the one shared suppressed-failure combination rule", () => {
  it("returns the primary itself, carrying the cleanup beside it", () => {
    const primary = new Error("the estate half-dropped");
    const cleanup = new Error("the lock could not be released");

    const combined = withSuppressedFailure(primary, cleanup);

    expect(combined).toBe(primary);
    expect(primary.message).toBe("the estate half-dropped");
    expect(readSuppressedFailures(combined)).toEqual([cleanup]);
    // The evidence is carried, not printed into the error: an enumerable
    // property would end up in every structured log and every snapshot of it.
    expect(Object.keys(primary)).toEqual([]);
    // The property MIRRORS the record for whoever opens the error in a
    // debugger. It is written, never read back.
    expect(
      Object.getOwnPropertyDescriptor(primary, "suppressedFailures")
    ).toMatchObject({ enumerable: false, value: [cleanup] });
  });

  it("records past planted `suppressedFailures` that refuses to be read", () => {
    // Recording is the last thing that runs while a migration failure is
    // propagating, so it has to be TOTAL: reading the caller's array to extend
    // it is the one step that could throw, and its throw becomes the failure
    // the caller is told about instead of the estate's.
    const primary = new Error("the estate half-dropped");
    const planted = plantHostileSuppressedFailures(primary);
    const cleanup = new Error("the lock could not be released");

    const combined = withSuppressedFailure(primary, cleanup);

    expect(combined).toBe(primary);
    expect(primary.message).toBe("the estate half-dropped");
    expect(
      Object.getOwnPropertyDescriptor(primary, "suppressedFailures")?.value
    ).toBe(planted);
    expect(readSuppressedFailures(combined)).toEqual([cleanup]);
  });

  it("never answers from `suppressedFailures` the caller wrote", () => {
    // Evidence means "this module recorded it". A property anyone can define
    // before, and redefine after, answers a different question entirely.
    const primary = new Error("the estate half-dropped");
    const fabricated = ["a cleanup failure that never happened"];
    Object.defineProperty(primary, "suppressedFailures", {
      configurable: true,
      enumerable: false,
      value: fabricated,
      writable: true,
    });

    expect(readSuppressedFailures(primary)).toEqual([]);

    const cleanup = new Error("the lock could not be released");
    const combined = withSuppressedFailure(primary, cleanup);
    Object.defineProperty(primary, "suppressedFailures", {
      configurable: true,
      value: fabricated,
    });

    expect(readSuppressedFailures(combined)).toEqual([cleanup]);
  });

  it("records evidence a LYING `defineProperty` silently drops", () => {
    // A Proxy trap that answers `true` without defining anything is the one
    // refusal that does not announce itself: the write appeared to succeed, so
    // the cleanup failure was neither on the error nor anywhere else.
    const primary = new Error("the estate half-dropped");
    const hostile = new Proxy(primary, { defineProperty: () => true });
    const cleanup = new Error("the lock could not be released");

    const combined = withSuppressedFailure(hostile, cleanup);

    expect(combined).toBe(hostile);
    expect(
      Object.getOwnPropertyDescriptor(hostile, "suppressedFailures")
    ).toBeUndefined();
    expect(readSuppressedFailures(combined)).toEqual([cleanup]);
  });

  it("keeps the evidence readable after the primary is REVOKED", () => {
    // A revoked proxy answers no introspection at all, so anything derived
    // from the error's own shape is gone. The record is not derived from it.
    const { proxy, revoke } = Proxy.revocable(
      new Error("the estate half-dropped"),
      {}
    );
    const cleanup = new Error("the lock could not be released");

    const combined = withSuppressedFailure(proxy, cleanup);
    revoke();

    expect(combined).toBe(proxy);
    expect(readSuppressedFailures(combined)).toEqual([cleanup]);
  });

  it("carries evidence on a FROZEN primary without writing to it", () => {
    const primary = Object.freeze(new Error("the estate half-dropped"));
    const cleanup = new Error("the lock could not be released");

    const combined = withSuppressedFailure(primary, cleanup);

    expect(combined).toBe(primary);
    expect(primary.message).toBe("the estate half-dropped");
    expect(Object.isFrozen(primary)).toBe(true);
    expect(readSuppressedFailures(combined)).toEqual([cleanup]);
  });

  it("carries evidence past a primary whose properties REFUSE writes", () => {
    const primary = new Error("placeholder");
    Object.defineProperty(primary, "message", {
      configurable: true,
      get: () => "the estate half-dropped",
      set: () => {
        throw new Error("this error's message is not writable");
      },
    });
    const cleanup = new Error("the lock could not be released");

    const combined = withSuppressedFailure(primary, cleanup);

    expect(combined).toBe(primary);
    expect(primary.message).toBe("the estate half-dropped");
    expect(readSuppressedFailures(combined)).toEqual([cleanup]);
  });

  it("keeps BOTH reachable when the primary is not an object at all", () => {
    const cleanup = new Error("the lock could not be released");

    const combined = withSuppressedFailure("the estate half-dropped", cleanup);

    // A string carries nothing, so the thrown value becomes the one shape that
    // can carry both — and the primary is still the first thing in it.
    expect(combined).toBeInstanceOf(AggregateError);
    expect(combined instanceof AggregateError ? combined.errors : []).toEqual([
      "the estate half-dropped",
      cleanup,
    ]);
    expect(
      combined instanceof AggregateError ? combined.cause : undefined
    ).toBe("the estate half-dropped");
    expect(readSuppressedFailures(combined)).toEqual([cleanup]);
  });

  it("records a cleanup value nothing can render, without rendering it", () => {
    const primary = new Error("the estate half-dropped");
    const cleanup = Symbol("no string form");

    const combined = withSuppressedFailure(primary, cleanup);

    expect(combined).toBe(primary);
    expect(primary.message).toBe("the estate half-dropped");
    expect(readSuppressedFailures(combined)).toEqual([cleanup]);
  });

  it("accumulates the cleanup failures of both owners, in order", () => {
    const primary = new Error("the estate half-dropped");
    const unlock = new Error("the lock could not be released");
    const release = new Error("the producer could not be returned");

    const combined = withSuppressedFailure(
      withSuppressedFailure(primary, unlock),
      release
    );

    expect(combined).toBe(primary);
    expect(readSuppressedFailures(combined)).toEqual([unlock, release]);
  });

  it("reads nothing from a value that carries nothing", () => {
    expect(readSuppressedFailures(new Error("plain"))).toEqual([]);
    expect(readSuppressedFailures("a string")).toEqual([]);
    expect(readSuppressedFailures(undefined)).toEqual([]);
  });
});

describe("a pinned session's release failure never replaces the body's", () => {
  it("keeps the body failure primary and the release failure beside it", async () => {
    const releaseFailure = new Error("the producer could not be returned");
    const driver = new ReleaseFailingDriver(releaseFailure);
    const bodyFailure = new Error("the estate half-dropped");

    const thrown = await rejection(
      driver._withPinnedSession(() => Promise.reject(bodyFailure))
    );

    expect(thrown).toBe(bodyFailure);
    expect(bodyFailure.message).toBe("the estate half-dropped");
    expect(readSuppressedFailures(thrown)).toEqual([releaseFailure]);
    // A body that threw condemns its producer, release failure or not.
    expect(driver.sessions).toEqual(["reserve", "destroy"]);
  });

  it("keeps a DECORATED body failure primary through the real release", async () => {
    // The rule on the path that produced it. The body's failure already
    // carries `suppressedFailures` of someone else's making, and the release
    // fails on top of it: a recorder that read that array would throw inside
    // the driver's own catch, and the caller of a reset that dropped half an
    // estate would be told about an iterator.
    const releaseFailure = new Error("the producer could not be returned");
    const driver = new ReleaseFailingDriver(releaseFailure);
    const bodyFailure = new Error("the estate half-dropped");
    plantHostileSuppressedFailures(bodyFailure);

    const thrown = await rejection(
      driver._withPinnedSession(() => Promise.reject(bodyFailure))
    );

    expect(thrown).toBe(bodyFailure);
    expect(bodyFailure.message).toBe("the estate half-dropped");
    expect(readSuppressedFailures(thrown)).toEqual([releaseFailure]);
    expect(driver.sessions).toEqual(["reserve", "destroy"]);
  });

  it("surfaces the release failure when the body SUCCEEDED", async () => {
    const releaseFailure = new Error("the producer could not be returned");
    const driver = new ReleaseFailingDriver(releaseFailure);

    const thrown = await rejection(
      driver._withPinnedSession(() => Promise.resolve("done"))
    );

    // Nothing else failed, so the cleanup failure IS the failure — hiding it
    // would return a producer nobody knows the state of and say nothing.
    expect(thrown).toBe(releaseFailure);
    expect(driver.sessions).toEqual(["reserve", "release"]);
  });
});

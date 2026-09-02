import {
  type ArrayAdmissionSlot,
  admitArrayQueries,
  createArrayDeferred,
  readArrayQuery,
} from "@extensions/array-admission";
import { TransactionWriteOutcomes } from "@extensions/query";
import { describe, expect, test, vi } from "vitest";

function createSlot(): ArrayAdmissionSlot {
  return {
    admitted: false,
    child: createArrayDeferred<unknown>(),
  };
}

describe("array query admission", () => {
  test("starts every query before releasing the coordinated array", async () => {
    const first = createSlot();
    const second = createSlot();
    const slots = [first, second];
    const started: ArrayAdmissionSlot[] = [];
    const admission = admitArrayQueries(
      slots,
      new TransactionWriteOutcomes(),
      (slot, child) => {
        started.push(slot);
        return child();
      }
    );

    await expect(admission).resolves.toBeUndefined();
    expect(started).toEqual(slots);
    expect(slots.every(({ admitted }) => admitted)).toBe(true);

    first.child.resolve("first");
    second.child.resolve("second");
    await expect(Promise.all(slots.map(readArrayQuery))).resolves.toEqual([
      "first",
      "second",
    ]);
  });

  test("discards staged outcomes and rejects every child on admission failure", async () => {
    const failure = new Error("first admission failed");
    const first = createSlot();
    const second = createSlot();
    const slots = [first, second];
    const outcomes = new TransactionWriteOutcomes();
    const discardAll = vi.spyOn(outcomes, "discardAll");

    await expect(
      admitArrayQueries(slots, outcomes, (slot, child, control) => {
        if (slot === first) {
          control.reportAdmissionFailure?.(failure);
          throw failure;
        }
        return child();
      })
    ).resolves.toEqual([failure]);

    expect(discardAll).toHaveBeenCalledOnce();
    await expect(first.child.promise).rejects.toBe(failure);
    await expect(second.child.promise).rejects.toBe(failure);
  });

  test("mirrors the query outcome only when an observation rail exists", async () => {
    const slot = createSlot();
    slot.observation = createArrayDeferred<unknown>();
    const admission = admitArrayQueries(
      [slot],
      new TransactionWriteOutcomes(),
      (_slot, child) => {
        // biome-ignore lint/complexity/noVoid: the child promise is deliberately left floating; the discard marks that
        void child();
        return Promise.resolve("observed query");
      }
    );

    await expect(admission).resolves.toBeUndefined();
    await expect(slot.observation.promise).resolves.toBe("observed query");
    slot.child.resolve("child");
  });

  test("captures a query rejection that follows admission in the same turn", async () => {
    const failure = new Error("query failed after admission");
    const slot = createSlot();
    slot.observation = createArrayDeferred<unknown>();

    await expect(
      admitArrayQueries(
        [slot],
        new TransactionWriteOutcomes(),
        (_slot, child) => {
          // biome-ignore lint/complexity/noVoid: the child promise is deliberately left floating; the discard marks that
          void child();
          return Promise.reject(failure);
        }
      )
    ).resolves.toEqual([failure]);

    await expect(slot.observation.promise).rejects.toBe(failure);
    await expect(slot.child.promise).rejects.toBe(failure);
  });

  test("retains distinct admission failures in reporting order", async () => {
    const firstFailure = new Error("first admission failure");
    const secondFailure = new Error("second admission failure");
    const slot = createSlot();

    await expect(
      admitArrayQueries(
        [slot],
        new TransactionWriteOutcomes(),
        (_slot, child, control) => {
          control.reportAdmissionFailure?.(firstFailure);
          control.reportAdmissionFailure?.(secondFailure);
          return child();
        }
      )
    ).resolves.toEqual([firstFailure, secondFailure]);
  });

  test("settles each private deferred exactly once", async () => {
    const fulfilled = createArrayDeferred<string>();
    fulfilled.resolve("first");
    fulfilled.reject(new Error("late rejection"));
    await expect(fulfilled.promise).resolves.toBe("first");

    const failure = new Error("first rejection");
    const rejected = createArrayDeferred<string>();
    rejected.reject(failure);
    rejected.resolve("late fulfillment");
    await expect(rejected.promise).rejects.toBe(failure);
  });
});

describe("coverage low value", () => {
  test("admits an empty internal slot list", async () => {
    await expect(
      admitArrayQueries([], new TransactionWriteOutcomes(), () =>
        Promise.resolve(undefined)
      )
    ).resolves.toBeUndefined();
  });

  test("reads the child rail before a query promise is attached", async () => {
    const slot = createSlot();
    const childPromise = readArrayQuery(slot);
    slot.child.resolve("child");

    await expect(childPromise).resolves.toBe("child");
  });

  test("omits a non-admitting query that fulfilled before another member failed", async () => {
    const failure = new Error("other member failed");
    const fulfilled = createSlot();
    const failed = createSlot();

    await expect(
      admitArrayQueries(
        [fulfilled, failed],
        new TransactionWriteOutcomes(),
        (slot, _child, control) => {
          if (slot === failed) {
            control.reportAdmissionFailure?.(failure);
            return Promise.reject(failure);
          }
          return Promise.resolve("detached result");
        }
      )
    ).resolves.toEqual([failure]);
  });
});

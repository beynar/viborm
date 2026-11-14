import {
  type ArraySlot,
  createArrayDeferred,
  memberValue,
} from "@client/array-transaction";
import {
  type AdmissionSlot,
  admitArray,
  admitArrayQueries,
} from "@extensions/array-admission";
import { describe, expect, test } from "vitest";

function createSlot(): AdmissionSlot {
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
    const started: AdmissionSlot[] = [];
    const admission = admitArrayQueries(slots, (slot, child) => {
      started.push(slot);
      return child();
    });

    await expect(admission).resolves.toBeUndefined();
    expect(started).toEqual(slots);
    expect(slots.every(({ admitted }) => admitted)).toBe(true);

    first.child.resolve("first");
    second.child.resolve("second");
    await expect(Promise.all(slots.map(memberValue))).resolves.toEqual([
      "first",
      "second",
    ]);
  });

  test("rejects every child on admission failure", async () => {
    const failure = new Error("first admission failed");
    const first = createSlot();
    const second = createSlot();
    const slots = [first, second];
    await expect(
      admitArrayQueries(slots, (slot, child, control) => {
        if (slot === first) {
          control.reportAdmissionFailure?.(failure);
          throw failure;
        }
        return child();
      })
    ).resolves.toEqual([failure]);

    await expect(first.child.promise).rejects.toBe(failure);
    await expect(second.child.promise).rejects.toBe(failure);
  });

  test("makes the handlers' outcome the member's value once admitted", async () => {
    const slot = createSlot();
    const admission = admitArrayQueries([slot], (_slot, child) => {
      // biome-ignore lint/complexity/noVoid: the child promise is deliberately left floating; the discard marks that
      void child();
      return Promise.resolve("observed query");
    });

    await expect(admission).resolves.toBeUndefined();
    await expect(memberValue(slot)).resolves.toBe("observed query");
    slot.child.resolve("child");
  });

  test("captures a query rejection that follows admission in the same turn", async () => {
    const failure = new Error("query failed after admission");
    const slot = createSlot();

    await expect(
      admitArrayQueries([slot], (_slot, child) => {
        // biome-ignore lint/complexity/noVoid: the child promise is deliberately left floating; the discard marks that
        void child();
        return Promise.reject(failure);
      })
    ).resolves.toEqual([failure]);

    await expect(memberValue(slot)).rejects.toBe(failure);
    await expect(slot.child.promise).rejects.toBe(failure);
  });

  test("retains distinct admission failures in reporting order", async () => {
    const firstFailure = new Error("first admission failure");
    const secondFailure = new Error("second admission failure");
    const slot = createSlot();

    await expect(
      admitArrayQueries([slot], (_slot, child, control) => {
        control.reportAdmissionFailure?.(firstFailure);
        control.reportAdmissionFailure?.(secondFailure);
        return child();
      })
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
      admitArrayQueries([], () => Promise.resolve(undefined))
    ).resolves.toBeUndefined();
  });

  test("reads the child rail before a query promise is attached", async () => {
    const slot = createSlot();
    const childPromise = memberValue(slot);
    slot.child.resolve("child");

    await expect(childPromise).resolves.toBe("child");
  });

  test("omits a non-admitting query that fulfilled before another member failed", async () => {
    const failure = new Error("other member failed");
    const fulfilled = createSlot();
    const failed = createSlot();

    await expect(
      admitArrayQueries([fulfilled, failed], (slot, _child, control) => {
        if (slot === failed) {
          control.reportAdmissionFailure?.(failure);
          return Promise.reject(failure);
        }
        return Promise.resolve("detached result");
      })
    ).resolves.toEqual([failure]);
  });

  test("admits without a collector where the chain has no write rail", async () => {
    const failure = new Error("refused without a collector");
    const slot = createSlot();

    await expect(
      admitArrayQueries([slot], () => Promise.reject(failure))
    ).resolves.toEqual([failure]);
    await expect(slot.child.promise).rejects.toBe(failure);
  });

  test("starts a member's listener in a scope with no collector yet", async () => {
    const registration = { extension: "listener", listener: () => undefined };
    const slot: ArraySlot = {
      operation: {},
      // A member whose owner only answers what admission reads of it.
      owner: {
        interception: () => ({
          context: undefined,
          handlers: undefined,
          write: true,
          registration,
        }),
      } as unknown as ArraySlot["owner"],
      child: createArrayDeferred<unknown>(),
    };
    const collectors: unknown[] = [];
    const execute: Parameters<typeof admitArray>[2] = (
      _context,
      _handlers,
      child,
      _write,
      scope
    ) => {
      collectors.push(scope?.outcomes);
      return child();
    };

    await expect(
      admitArray([slot], { parent: undefined, root: {} }, execute)
    ).resolves.toBeUndefined();
    expect(collectors).toEqual([undefined]);
  });
});

import {
  createExecutionContext,
  snapshotExecutionContext,
} from "@drivers/execution-context";
import { describe, expect, it } from "vitest";

describe("driver execution-context snapshots", () => {
  it("keeps correlation lazy while trusted snapshots reuse identity", () => {
    let generated = 0;
    const context = createExecutionContext(
      { model: "user", operation: "create" },
      () => {
        generated += 1;
        return "lazy-correlation";
      }
    );

    expect(generated).toBe(0);
    expect(snapshotExecutionContext(context, undefined, "execute")).toBe(
      context
    );
    expect(snapshotExecutionContext(undefined, context, "execute")).toBe(
      context
    );
    expect(generated).toBe(0);
    expect(context.correlationId).toBe("lazy-correlation");
    expect(context.correlationId).toBe("lazy-correlation");
    expect(generated).toBe(1);
  });

  it("copies one lazy correlation getter when effective facts change", () => {
    let generated = 0;
    const context = createExecutionContext({ operation: "create" }, () => {
      generated += 1;
      return "shared-correlation";
    });
    const snapshot = snapshotExecutionContext({ model: "user" }, context);

    // Compare booleans so the assertion renderer cannot inspect the enumerable
    // lazy accessor and accidentally force the value under test.
    expect(snapshot === context).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(generated).toBe(0);
    expect(snapshot.correlationId).toBe("shared-correlation");
    expect(context.correlationId).toBe("shared-correlation");
    expect(generated).toBe(1);
  });

  it("carries a call's `named`, its own before its bound context's", () => {
    const bound = createExecutionContext(
      { operation: "findMany", named: true },
      () => "id"
    );
    expect(bound.named).toBe(true);
    // A context without it keeps exactly its keys (a pinned public shape).
    expect(
      Reflect.ownKeys(createExecutionContext({ model: "user" }, () => "id"))
    ).toEqual(["model", "operation", "correlationId"]);
    expect(snapshotExecutionContext({ model: "user" }, bound).named).toBe(true);
    expect(
      snapshotExecutionContext({ model: "user", named: false }, bound).named
    ).toBe(false);
  });

  it("reads external context members once into a stable immutable snapshot", () => {
    const reads = { correlationId: 0, model: 0, named: 0, operation: 0 };
    const external = Object.defineProperties(
      {},
      {
        correlationId: {
          get() {
            reads.correlationId += 1;
            return reads.correlationId === 1 ? "first" : "changed";
          },
        },
        model: {
          get() {
            reads.model += 1;
            return "user";
          },
        },
        operation: {
          get() {
            reads.operation += 1;
            return "findMany";
          },
        },
        named: {
          get() {
            reads.named += 1;
            return true;
          },
        },
      }
    );

    const snapshot = snapshotExecutionContext(external);

    expect(reads).toEqual({
      correlationId: 1,
      model: 1,
      named: 1,
      operation: 1,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual({
      correlationId: "first",
      model: "user",
      named: true,
      operation: "findMany",
    });
    expect(snapshot.correlationId).toBe("first");
    expect(reads.correlationId).toBe(1);
  });
});

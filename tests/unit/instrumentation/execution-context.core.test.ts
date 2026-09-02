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
      undefined,
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
    const context = createExecutionContext(
      { operation: "create" },
      undefined,
      () => {
        generated += 1;
        return "shared-correlation";
      }
    );
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

  it("reads external context members once into a stable immutable snapshot", () => {
    const reads = { correlationId: 0, model: 0, operation: 0 };
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
      }
    );

    const snapshot = snapshotExecutionContext(external);

    expect(reads).toEqual({ correlationId: 1, model: 1, operation: 1 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual({
      correlationId: "first",
      model: "user",
      operation: "findMany",
    });
    expect(snapshot.correlationId).toBe("first");
    expect(reads.correlationId).toBe(1);
  });
});

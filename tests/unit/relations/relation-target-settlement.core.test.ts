/**
 * The source-independent target once-cell.
 *
 * A raw getter stays lazy, but a declaration denotes ONE target for its
 * lifetime: the first resolution settles the return or one normalized `Error`,
 * and every later consumer — including a second schema graph reusing the same
 * immutable terminal — observes that same outcome. A resolver-local cache alone
 * would let a stateful getter give validation, migrations and the query engine
 * different declaration truth.
 *
 * Plan §5.1 (once-cell), §7.3 (thrown getters), falsifier §11.1.16.
 */

import { s } from "@src/schema";
import { describe, expect, it } from "vitest";

const target = s.model({ id: s.string().id() });
const other = s.model({ id: s.string().id() });

describe("factory dispatch", () => {
  it("invokes no target getter", () => {
    let calls = 0;
    const counting = () => {
      calls += 1;
      return target;
    };

    s.toOne(counting);
    s.toMany(counting);
    s.toOne({ post: counting, video: counting });
    s.toMany({ post: counting, video: counting }, undefined);

    expect(calls).toBe(0);
  });

  it("invokes no getter while the chain is configured", () => {
    let calls = 0;
    const counting = () => {
      calls += 1;
      return target;
    };

    s.toOne(counting).name("Author").fields("targetId").references("id");
    s.toMany(counting).through("source_targets").source("sourceId");
    s.toOne({ post: counting }).optional().name("Subject");
    s.toMany({ post: counting }).through({
      post: { table: "t", source: "s", target: "g" },
    });

    expect(calls).toBe(0);
  });
});

describe("settlement", () => {
  it("settles a model target once for every later consumer", () => {
    let calls = 0;
    const relation = s.toOne(() => {
      calls += 1;
      return target;
    });

    expect(relation["~"].settleTarget()).toBe(target);
    expect(relation["~"].settleTarget()).toBe(target);
    expect(calls).toBe(1);
  });

  it("settles each variant independently and touches no sibling", () => {
    let postCalls = 0;
    let videoCalls = 0;
    const relation = s.toMany({
      post: () => {
        postCalls += 1;
        return target;
      },
      video: () => {
        videoCalls += 1;
        return other;
      },
    });

    expect(relation["~"].settleTarget("post")).toBe(target);
    expect(relation["~"].settleTarget("post")).toBe(target);
    expect(postCalls).toBe(1);
    expect(videoCalls).toBe(0);

    expect(relation["~"].settleTarget("video")).toBe(other);
    expect(videoCalls).toBe(1);
  });

  it("shows both schema contexts the same settled return", () => {
    let calls = 0;
    const shared = s.toOne(() => {
      calls += 1;
      return target;
    });
    const first = s.model({ id: s.string().id(), slot: shared });
    const second = s.model({ id: s.string().id(), reused: shared });

    const fromFirst = first["~"].state.relations.slot["~"].settleTarget();
    const fromSecond = second["~"].state.relations.reused["~"].settleTarget();

    expect(fromFirst).toBe(fromSecond);
    expect(calls).toBe(1);
  });

  it("keeps a thrown Error identity-equal across every consumer", () => {
    const failure = new Error("target is not available");
    let calls = 0;
    const relation = s.toOne(() => {
      calls += 1;
      throw failure;
    });

    const first = captureThrow(() => relation["~"].settleTarget());
    const second = captureThrow(() => relation["~"].settleTarget());

    expect(first).toBe(failure);
    expect(second).toBe(failure);
    expect(calls).toBe(1);
  });

  it("normalizes a non-Error throw exactly once", () => {
    let calls = 0;
    const nonError: unknown = "not an error";
    const relation = s.toOne({
      post: () => {
        calls += 1;
        throw nonError;
      },
    });

    const first = captureThrow(() => relation["~"].settleTarget("post"));
    const second = captureThrow(() => relation["~"].settleTarget("post"));

    expect(first).toBeInstanceOf(Error);
    expect(first).toBe(second);
    expect(calls).toBe(1);
  });

  it("renders a thrown symbol instead of stringifying it into a TypeError", () => {
    // `String(symbol)` throws; only `.toString()` renders one. The normalizer
    // owns that difference, so a hostile getter cannot replace the declaration
    // failure with a TypeError from the reporting path itself.
    const nonError: unknown = Symbol("no target here");
    const relation = s.toOne(() => {
      throw nonError;
    });

    expect(thrownError(() => relation["~"].settleTarget()).message).toBe(
      "Relation target getter threw a non-Error value: Symbol(no target here)"
    );
  });

  it("caches one total normalization when a non-Error cannot be rendered", () => {
    let calls = 0;
    const nonError = Object.create(null);
    const relation = s.toMany(() => {
      calls += 1;
      throw nonError;
    });

    const first = thrownError(() => relation["~"].settleTarget());
    const second = thrownError(() => relation["~"].settleTarget());

    expect(first.message).toBe(
      "Relation target getter threw a non-Error value: <unrenderable non-Error value>"
    );
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it("settles a variant asked without a key, or with an unknown one, as one shared failure", () => {
    let calls = 0;
    const relation = s.toMany({
      post: () => {
        calls += 1;
        return target;
      },
    });

    // A variant declaration denotes one target PER VARIANT, so there is nothing
    // for an unkeyed ask to settle. It settles as a failure rather than
    // returning `undefined`, which would let a consumer treat "no such variant"
    // as a resolved target — and the getter it never named stays uninvoked.
    const unkeyed = thrownError(() => relation["~"].settleTarget());
    const unknown = thrownError(() => relation["~"].settleTarget("audio"));

    expect(unkeyed.message).toBe("Relation target getter is not a function");
    expect(unknown.message).toBe(unkeyed.message);
    expect(unkeyed).toBe(thrownError(() => relation["~"].settleTarget()));
    expect(calls).toBe(0);
  });
});

function captureThrow(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The same capture, narrowed where the settled outcome must BE an `Error`. */
function thrownError(read: () => unknown): Error {
  const thrown = captureThrow(read);
  if (thrown instanceof Error) return thrown;
  throw new Error(`Expected a settled Error, received ${String(thrown)}`);
}

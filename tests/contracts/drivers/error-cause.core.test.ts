/**
 * The ONE total normalizer every driver boundary hands a thrown value to.
 *
 * Three boundaries promised a typed error with the thrown value preserved as
 * its cause, and each wrote its own `thrown instanceof Error` to keep that
 * promise. `instanceof` is not a total test: it walks the prototype chain
 * through `[[GetPrototypeOf]]`, so a Proxy trap that throws makes the TEST fail
 * rather than the value — inside the very `catch` that was building the typed
 * error. The typed boundary is then replaced by the trap's own error.
 *
 * `errorCause` is that test done once, for every consumer: `src/drivers/shared`
 * owns it, the option boundary and the pinned session read it here, and the
 * migration reset half consumes this exact export. One owner, one spelling —
 * a second predicate is a second thing to get wrong.
 */

import { errorCause } from "@drivers/shared/driver-options";
import { describe, expect, it } from "vitest";

/**
 * A value whose `instanceof Error` test itself throws.
 *
 * Nothing else about it is hostile: the trap is the whole point, because it is
 * the one shape that turns a normalizer into a thrower.
 */
function prototypeTrapProxy(): unknown {
  return new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("prototype trap");
      },
    }
  );
}

describe("the one total error normalizer", () => {
  it("returns a thrown Error at its exact identity", () => {
    const thrown = new RangeError("the provider gave up");

    expect(errorCause(thrown)).toBe(thrown);
  });

  it("keeps a non-Error as the cause, without rendering it", () => {
    const hostile = {
      toString() {
        throw new Error("a hostile value was rendered");
      },
    };

    const normalized = errorCause(hostile);

    expect(normalized).toBeInstanceOf(Error);
    expect(normalized.message).toBe("A non-Error value was thrown.");
    expect(normalized.cause).toBe(hostile);
  });

  it("normalizes a value whose instanceof test throws, instead of throwing", () => {
    const hostile = prototypeTrapProxy();

    const normalized = errorCause(hostile);

    expect(normalized).toBeInstanceOf(Error);
    expect(normalized.message).toBe("A non-Error value was thrown.");
    // The evidence is kept, not discarded: what was thrown is what a caller
    // needs, and the only thing this module refused to do is ASK the value
    // whether it is an Error.
    expect(normalized.cause).toBe(hostile);
  });

  it("normalizes the values that carry no cause of their own", () => {
    for (const thrown of [undefined, null, "a string", Symbol("s"), 7]) {
      const normalized = errorCause(thrown);
      expect(normalized).toBeInstanceOf(Error);
      expect(normalized.cause).toBe(thrown);
    }
  });
});

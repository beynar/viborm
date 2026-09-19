import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { readValidationFailureCause } from "@validation/parse-failure";
import { describe, expect, test } from "vitest";

/**
 * The public parse boundary: `parse()` and the failure it hands back.
 *
 * `parse` is the ONE place a foreign StandardSchema is called, so it is also
 * the one place a foreign schema's misbehaviour is contained. Three shapes are
 * containable — an async result, a result that is not a result at all, and a
 * throw — and the containment must never leak: the caller always receives a
 * `{ issues }` failure, never a rejected promise and never the throw.
 *
 * The neighbouring arms are pinned where their own schema lives: the async
 * refusal in `string.core.test.ts`, a `null` result in `decimal.core.test.ts`,
 * and an Error thrown by a constraint accessor in `object.core.test.ts`. What
 * is pinned HERE is the rest of the boundary: the malformed shapes those three
 * do not spell, and the sanitized cause `parse` retains for the engine's error
 * boundaries to attach ({@link readValidationFailureCause}, read by
 * `query-engine/cache-flow.ts` and `write-engine/parse-boundary.ts`).
 */

const MALFORMED = "Schema returned a malformed validation result";

const foreignSchema = (
  validate: StandardSchemaV1["~standard"]["validate"]
): StandardSchemaV1 => ({
  "~standard": { version: 1, vendor: "parse-boundary-test", validate },
});

describe("parse containment", () => {
  test("issues that are not an array are a malformed result, not a failure", () => {
    // `issues` is present, so the schema CLAIMS a refusal — but a refusal the
    // caller cannot iterate is not one. Passing it on would hand `.map` a
    // string and turn a validation failure into a TypeError somewhere else.
    const schema = foreignSchema(
      () => ({ issues: "nope" }) as unknown as StandardSchemaV1.Result<unknown>
    );
    expect(parse(schema, "x")).toEqual({ issues: [{ message: MALFORMED }] });
  });

  test("a result with neither issues nor a value is malformed", () => {
    const schema = foreignSchema(
      () => ({}) as unknown as StandardSchemaV1.Result<unknown>
    );
    expect(parse(schema, "x")).toEqual({ issues: [{ message: MALFORMED }] });
  });

  test("an explicitly undefined value is a success, not a malformed result", () => {
    // The distinction the `"value" in result` test exists to make: a schema
    // that legitimately produces `undefined` still spells the key.
    const result = parse(
      foreignSchema(() => ({ value: undefined })),
      "x"
    );
    expect(result.issues).toBeUndefined();
    expect("value" in result).toBe(true);
    expect((result as { value: unknown }).value).toBeUndefined();
  });
});

describe("parse failure cause", () => {
  test("an Error thrown by a foreign schema is retained as the cause", () => {
    const thrown = new Error("foreign schema exploded");
    const failure = parse(
      foreignSchema(() => {
        throw thrown;
      }),
      "x"
    );

    expect(failure.issues).toEqual([
      { message: "Schema validation failed unexpectedly" },
    ]);
    // The retained evidence is a SANITIZED copy: an Error with no stack and a
    // redacted message, never the foreign schema's own object.
    const cause = readValidationFailureCause(failure);
    expect(cause).toBeInstanceOf(Error);
    expect(cause).not.toBe(thrown);
    expect(cause?.stack).toBeUndefined();
  });

  test("a non-Error thrown by a foreign schema is normalized into one", () => {
    // Nothing guarantees a `throw` carries an Error. The boundary normalizes
    // it rather than storing a bare string as a cause.
    const failure = parse(
      foreignSchema(() => {
        // biome-ignore lint/style/useThrowOnlyError: a non-Error throw is the point
        throw "a string, not an Error";
      }),
      "x"
    );

    // A thrown string is neither retained raw nor dropped: it is normalized
    // into an Error first, which is what the sanitizer can contain.
    expect(failure.issues).toEqual([
      { message: "Schema validation failed unexpectedly" },
    ]);
    expect(readValidationFailureCause(failure)).toBeInstanceOf(Error);
  });

  test("an ordinary refusal retains no cause", () => {
    // The common case at every call site: a plain validation failure carries
    // no retained throw, and the error boundary must attach `undefined`
    // rather than invent one.
    const failure = parse(v.string(), 42);
    expect(failure.issues).toBeDefined();
    expect(readValidationFailureCause(failure)).toBeUndefined();
  });
});

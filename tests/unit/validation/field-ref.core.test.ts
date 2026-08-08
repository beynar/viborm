import { type AnyFieldRef, FIELD_REF_BRAND } from "@schema/field-ref";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

/**
 * `v.noFieldRef` — the wrapper that RE-CLOSES a schema which transitively
 * opened a field-reference operand (today: `having`, which reuses the model's
 * own interned scalar filter).
 *
 * These pin the SCANNER itself, independently of any filter shape: the wrapper
 * is only as good as its ability to find a token wherever the validated value
 * put it. It shipped with a four-level depth cap, which a five-deep `not` chain
 * walked straight past — see the depth sweep in
 * {@link file://../query-engine/field-reference-sql.test.ts} for the same
 * property pinned end-to-end through `groupBy`.
 *
 * The synthesis trick: `v.coerce` lets a trivial input produce an ARBITRARY
 * validated output, so the scan can be handed shapes (cycles, shared nodes,
 * 500-deep chains) that no real filter schema would ever emit — which is
 * exactly the point, since the guarantee must not depend on the shape.
 */

const ref = (field: string): AnyFieldRef =>
  Object.freeze({
    [FIELD_REF_BRAND]: Object.freeze({
      model: "Post",
      field,
      type: "int" as const,
      list: false,
    }),
  });

/** A schema whose validated OUTPUT is `value`, re-closed by `noFieldRef`. */
const closedOver = (value: unknown) =>
  v.noFieldRef(
    v.coerce(v.literal("go"), () => value),
    "'having'"
  );

const scan = (value: unknown) => parse(closedOver(value), "go");

const REFUSAL = "Field reference 'Post.likes' is not supported in 'having'.";

function nest(depth: number, leaf: unknown): unknown {
  let out = leaf;
  for (let i = 0; i < depth; i++) out = { not: out };
  return out;
}

describe("noFieldRef", () => {
  test.each([
    0, 1, 3, 4, 5, 6, 50, 500,
  ])("finds a reference nested %i levels deep", (depth) => {
    const result = scan(nest(depth, { gt: ref("likes") }));
    expect(result.issues?.[0]?.message).toBe(REFUSAL);
  });

  test("finds a reference inside nested arrays", () => {
    const result = scan({ AND: [{ OR: [[{ gt: ref("likes") }]] }] });
    expect(result.issues?.[0]?.message).toBe(REFUSAL);
  });

  test("terminates on a cyclic value and still finds the reference", () => {
    const cycle: Record<string, unknown> = { name: "root" };
    cycle.self = cycle;
    cycle.deep = nest(20, { gt: ref("likes"), back: cycle });

    const result = scan(cycle);
    expect(result.issues?.[0]?.message).toBe(REFUSAL);
  });

  test("terminates on a cyclic value that holds no reference", () => {
    const cycle: Record<string, unknown> = { gt: 3 };
    cycle.self = cycle;
    cycle.sibling = { parent: cycle, list: [cycle, cycle] };

    const result = scan(cycle);
    expect(result.issues).toBeUndefined();
    expect((result as { value: unknown }).value).toBe(cycle);
  });

  test("a shared subgraph is not mistaken for a reference", () => {
    const shared = { gt: 1, lt: 2 };
    const result = scan({ a: shared, b: shared, c: [shared, shared] });
    expect(result.issues).toBeUndefined();
  });

  test("binary operands pass through untouched", () => {
    const result = scan({ equals: new Uint8Array([1, 2, 3, 4]) });
    expect(result.issues).toBeUndefined();
  });

  test("the wrapped schema's own failure is passed through unchanged", () => {
    const bare = parse(v.number(), "nope");
    const wrapped = parse(v.noFieldRef(v.number(), "'having'"), "nope");
    expect(wrapped.issues?.[0]?.message).toBe(bare.issues?.[0]?.message);
  });

  test("an ordinary value keeps its validated output identity", () => {
    const result = parse(v.noFieldRef(v.number(), "'having'"), 42);
    expect(result.issues).toBeUndefined();
    expect((result as { value: number }).value).toBe(42);
  });
});

describe("the token's type surface", () => {
  test("a reference exposes ONLY the brand symbol — no string keys to complete", () => {
    // The lived wart: when the token carried string-keyed members (`model`,
    // `field`, `type`, `list`), every filter object literal that admits a
    // reference in its operand union offered them as editor completions —
    // `field` showed up inside `where: { id: { … } }`. The payload lives under
    // the brand now; this pin fails if anyone ever puts a string key back.
    type StringKeys = Extract<keyof AnyFieldRef, string>;
    expectTypeOf<StringKeys>().toBeNever();
    expectTypeOf<keyof AnyFieldRef>().toEqualTypeOf<typeof FIELD_REF_BRAND>();
  });
});

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { generateCacheKey } from "@cache/key";
import { createClient } from "@client/client";
import { CacheInvalidKeyError } from "@errors";
import { sql } from "@sql";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { fieldRefSchema } from "@tests/fixtures/field-ref-schema";
import type { OperandCtx } from "@validation/primitives/operand";
import { describe, expect, test } from "vitest";

/**
 * Cache keys and operand callbacks (W8-A Unit 3).
 *
 * A cache key is computed from the payload that will RUN, and a payload may
 * carry a callback — a function has no stable serialization, so keying has to
 * wait for validation to resolve it. These pin both halves: the raw payload is
 * NOT keyable (the falsification), and two spellings of the same comparison
 * land on one key (the property).
 */

const schema = fieldRefSchema;

type PostCtx = OperandCtx<typeof schema.post>;

const makeClient = () =>
  createClient({
    schema,
    driver: new SqlOnlyDriver(new PostgresAdapter(), "postgresql"),
  });

describe("keying a payload that carries an operand callback", () => {
  test("the raw payload is not keyable — which is why keying waits for validation", () => {
    // The falsification. If the cache flow keyed the caller's args, THIS is what
    // every callback payload would do.
    expect(() =>
      generateCacheKey("post", "findMany", {
        where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
      })
    ).toThrow(CacheInvalidKeyError);
  });
});

describe("keying a fragment operand", () => {
  const keyFor = (fragment: unknown) =>
    generateCacheKey("post", "findMany", {
      where: { views: { gt: fragment } },
    });

  test("two identical fragments key identically", () => {
    expect(keyFor(sql`${1} + ${2}`)).toBe(keyFor(sql`${1} + ${2}`));
  });

  test("an interpolated value is part of the key", () => {
    expect(keyFor(sql`${1} + ${2}`)).not.toBe(keyFor(sql`${1} + ${3}`));
  });

  test("the fragment's text is part of the key", () => {
    expect(keyFor(sql`${1} + ${2}`)).not.toBe(keyFor(sql`${1} - ${2}`));
  });

  test("a fragment keys the same before and after it has been compiled", () => {
    // An `Sql` memoizes its flattened text on first read. A key that enumerated
    // instance fields would drift the moment anything compiled the fragment.
    const fragment = sql`${1} + ${2}`;
    const before = keyFor(fragment);
    fragment.toStatement("$n");
    expect(keyFor(fragment)).toBe(before);
  });

  test("a field reference keys by what it names", () => {
    const key = generateCacheKey("post", "findMany", {
      where: {
        views: {
          gt: { model: "post", field: "likes", type: "int", list: false },
        },
      },
    });
    expect(key).toContain("post:findMany:");
  });
});

describe("batch preparation sees the resolved payload", () => {
  test("the raw payload keeps the function; the compiled statement does not", () => {
    const client = makeClient();
    const pending = client.post.findMany({
      where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
    });

    // Construction is lazy, so the caller's payload is untouched…
    expect(typeof (pending.getArgs() as any).where.views.gt).toBe("function");
    // …and what compiles is the resolved column comparison.
    const statement = pending.buildStatement()?.toStatement("$n") ?? "";
    expect(statement).toContain(`"likes"`);
    expect(statement).toContain(`"views"`);
  });
});

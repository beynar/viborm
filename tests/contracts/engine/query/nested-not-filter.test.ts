import { createClient, type VibORMClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { windowUserPostSchema } from "@tests/fixtures/user-post-schema";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * Arbitrarily nested `not` (Prisma parity).
 *
 * The where-builder has always recursed through `not` without a depth cap —
 * its `not` branch calls straight back into `buildScalarFilterObject`
 * ({@link file://../../src/query-engine/builders/where-builder.ts}). Validation
 * used to cap nesting at ONE level, so `not: { not: … }` was rejected before
 * the engine ever saw it. `not` is now lazily self-referential
 * ({@link file://../../src/validation/scalars/negatable-filter.ts}) and the
 * two agree.
 *
 * These run real SQL rather than asserting on generated text, because the
 * point is the TRUTH TABLE: double negation must round-trip to the positive
 * set, and every depth must keep SQL's three-valued logic — `NOT NULL` is
 * NULL, not TRUE, so a NULL row is matched by neither a filter nor its
 * negation, at any nesting depth. That is Prisma's behavior and it is what a
 * text-only assertion cannot catch.
 */

const schema = windowUserPostSchema;

type NotFilterClient = VibORMClient<{
  schema: typeof schema;
  driver: PGliteDriver;
}>;

// The client's own `where` type — so every literal below is checked against
// the public TS surface, not just the runtime validator. A depth cap in the
// schema types would fail `pnpm test:types` here.
type UserWhere = NonNullable<
  NonNullable<Parameters<NotFilterClient["user"]["findMany"]>[0]>["where"]
>;

describe("nested not filters", () => {
  let client: NotFilterClient;

  beforeAll(async () => {
    client = createClient({ schema, driver: new PGliteDriver() });
    await syncLiveSchema(client);
    await client.user.createMany({
      data: [
        { id: "alpha", name: "alpha one", email: "a@example.com", age: 20 },
        { id: "beta", name: "beta two", email: "b@example.com", age: 40 },
        { id: "gamma", name: "gamma three", email: "g@example.com", age: 60 },
        // NULL in both filtered columns — never matched by a predicate OR its
        // negation, at any depth.
        { id: "nameless", name: null, email: "n@example.com", age: null },
      ],
    });
  });

  const findIds = async (where: UserWhere) => {
    const rows = await client.user.findMany({ where });
    return rows.map((row) => row.id).sort();
  };

  // ---------------------------------------------------------------------------
  // Double negation collapses to the positive set
  // ---------------------------------------------------------------------------

  test("not: { not: { contains } } matches exactly the plain contains set", async () => {
    const plain = await findIds({ name: { contains: "alpha" } });
    const doubled = await findIds({
      name: { not: { not: { contains: "alpha" } } },
    });

    expect(plain).toEqual(["alpha"]);
    expect(doubled).toEqual(plain);
  });

  test("single not is the complement — and excludes the NULL row", async () => {
    // `NOT (NULL LIKE '%alpha%')` is NULL, not TRUE: 'nameless' is absent from
    // BOTH the positive set and its negation.
    expect(await findIds({ name: { not: { contains: "alpha" } } })).toEqual([
      "beta",
      "gamma",
    ]);
  });

  test("triple nesting collapses to the single-not set", async () => {
    const single = await findIds({ name: { not: { contains: "alpha" } } });
    const tripled = await findIds({
      name: { not: { not: { not: { contains: "alpha" } } } },
    });

    expect(tripled).toEqual(single);
    expect(tripled).not.toContain("nameless");
  });

  test("five-deep nesting still collapses by parity", async () => {
    const odd = await findIds({
      name: { not: { not: { not: { not: { not: { contains: "alpha" } } } } } },
    });
    const even = await findIds({
      name: {
        not: { not: { not: { not: { not: { not: { contains: "alpha" } } } } } },
      },
    });

    expect(odd).toEqual(["beta", "gamma"]);
    expect(even).toEqual(["alpha"]);
  });

  test("nested not works on non-string scalars", async () => {
    const plain = await findIds({ age: { gt: 30 } });
    const doubled = await findIds({ age: { not: { not: { gt: 30 } } } });

    expect(plain).toEqual(["beta", "gamma"]);
    expect(doubled).toEqual(plain);
    // NULL age is matched by neither `gt: 30` nor its double negation.
    expect(doubled).not.toContain("nameless");
  });

  test("shorthand equals at the leaf of a nested not", async () => {
    expect(await findIds({ name: { not: { not: "alpha one" } } })).toEqual([
      "alpha",
    ]);
    expect(
      await findIds({ name: { not: { not: { not: "alpha one" } } } })
    ).toEqual(["beta", "gamma"]);
  });

  test("nested not composes with sibling operators in the same filter", async () => {
    // `contains: "a"` AND `NOT NOT (gte "beta")` — both arms apply.
    expect(
      await findIds({
        name: { contains: "a", not: { not: { gte: "beta" } } },
      })
    ).toEqual(["beta", "gamma"]);
  });

  // ---------------------------------------------------------------------------
  // Under the boolean wrappers
  // ---------------------------------------------------------------------------

  test("nested not under AND", async () => {
    expect(
      await findIds({
        AND: [
          { name: { not: { not: { contains: "a" } } } },
          { age: { not: { not: { lt: 50 } } } },
        ],
      })
    ).toEqual(["alpha", "beta"]);
  });

  test("nested not under OR", async () => {
    expect(
      await findIds({
        OR: [
          { name: { not: { not: { contains: "alpha" } } } },
          { name: { not: { not: { contains: "gamma" } } } },
        ],
      })
    ).toEqual(["alpha", "gamma"]);
  });

  test("nested not under NOT", async () => {
    // NOT( NOT NOT contains "alpha" ) === NOT( contains "alpha" ).
    const wrapped = await findIds({
      NOT: { name: { not: { not: { contains: "alpha" } } } },
    });

    expect(wrapped).toEqual(
      await findIds({ name: { not: { contains: "alpha" } } })
    );
    expect(wrapped).toEqual(["beta", "gamma"]);
  });

  test("nested not under NOT/AND/OR together", async () => {
    expect(
      await findIds({
        NOT: {
          OR: [
            { name: { not: { not: { contains: "alpha" } } } },
            {
              AND: [
                { age: { not: { not: { gte: 60 } } } },
                { name: { not: { not: { contains: "gamma" } } } },
              ],
            },
          ],
        },
      })
    ).toEqual(["beta"]);
  });

  // ---------------------------------------------------------------------------
  // Explicit null at depth keeps meaning IS NULL / IS NOT NULL
  // ---------------------------------------------------------------------------

  test("not: null at depth stays a null-check, not a comparison", async () => {
    expect(await findIds({ name: { not: null } })).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    // NOT (name IS NOT NULL) === name IS NULL — the only row is the NULL one.
    expect(await findIds({ name: { not: { not: null } } })).toEqual([
      "nameless",
    ]);
  });
});

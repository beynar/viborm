import { createClient } from "@client/client";
import { ValidationError } from "@errors";
import { s } from "@schema";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, expect, test } from "vitest";

/**
 * A client's validation refusal names its model (types-11).
 *
 * A tenant API built on an untyped client forwards these refusals to its own
 * callers, who cannot tell which model a bare `create` refused. Every refusal
 * the engine's parse boundary raises carries the model in `meta.model`, in its
 * `source`, and in its message subject (`user.create`), and a nested refusal
 * names the member path that refused, not the union that held it.
 *
 * The planning driver has no database: every case is refused before dispatch.
 */

const user = s.model({
  id: s.int().id(),
  email: s.string(),
  age: s.int().nullable(),
  role: s.enum(["a", "b"]),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.int().id(),
  title: s.string(),
  authorId: s.int(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});

async function refusalOf(
  run: () => Promise<unknown>
): Promise<ValidationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("expected a validation refusal");
}

describe("a client validation refusal names its model", () => {
  const client = createClient({
    schema: { user, post },
    driver: new PlanningDriver("sqlite"),
  });
  const db = client as unknown as Record<
    "user",
    Record<string, (args: unknown) => Promise<unknown>>
  >;

  const cases: readonly [string, () => Promise<unknown>, string][] = [
    [
      "wrong type",
      () => db.user.create!({ data: { id: 2, email: 5, role: "a" } }),
      "Validation failed for user.create: data.email: Expected string",
    ],
    [
      "int as string in where",
      () => db.user.findMany!({ where: { age: { gt: "3" } } }),
      "Validation failed for user.findMany: where.age.gt: Expected integer",
    ],
    [
      "operator typo beside a real operator",
      () =>
        db.user.findMany!({
          where: { email: { contains: "x", mdoe: "insensitive" } },
        }),
      "Validation failed for user.findMany: where.email.mdoe: Unknown key: mdoe",
    ],
    [
      "nested update typo",
      () =>
        db.user.update!({
          where: { id: 1 },
          data: {
            posts: {
              update: { where: { id: 1 }, data: { title: "x", titel: "y" } },
            },
          },
        }),
      "Validation failed for user.update: data.posts.update.data.titel: Unknown key: titel",
    ],
    [
      "upsert create arm",
      () =>
        db.user.upsert!({
          where: { id: 1 },
          create: { id: 1, email: 5, role: "a" },
          update: {},
        }),
      "Validation failed for user.upsert: create.email: Expected string",
    ],
    [
      "empty unique selector",
      () => db.user.findUniqueOrThrow!({ where: {} }),
      "Validation failed for user.findUnique: where: whereUnique requires at least one unique discriminator.",
    ],
  ];

  for (const [label, run, message] of cases) {
    test(label, async () => {
      const refusal = await refusalOf(run);
      expect(refusal.code).toBe("V4001");
      expect(refusal.meta.model).toBe("user");
      expect(refusal.source).toMatchObject({
        kind: "operation",
        model: "user",
      });
      expect(refusal.message).toBe(message);
    });
  }

  test("a refused orderBy direction names the field, not the union", async () => {
    const refusal = await refusalOf(() =>
      db.user.findMany!({ orderBy: { email: "up" } })
    );
    expect(refusal.meta.model).toBe("user");
    expect(refusal.issues[0]?.path).toBe("orderBy.email");
    expect(refusal.message).not.toContain("did not match any union member");
  });
});

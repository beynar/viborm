/**
 * One-to-One Uniqueness - PGlite provider tests
 *
 * The owning side of a 1:1 relation must be unique at the DB level, matching
 * Prisma. Before the serializer emitted a unique constraint on the FK column,
 * two profiles could point at the same user and include returned an
 * arbitrary row.
 */

import { createClient as PGliteCreateClient } from "@drivers/pglite";

import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const User = s
  .model({
    id: s.string().id(),
    name: s.string(),
    profile: s.toOne(() => Profile),
  })
  .map("o2o_users");

// userId is deliberately NOT .unique(): the constraint must come from the
// serializer's 1:1 FK handling (FK008 flags this shape at validate time,
// but the DDL is safe either way)
const Profile = s
  .model({
    id: s.string().id(),
    bio: s.string(),
    userId: s.string(),
    user: s
      .toOne(() => User)
      .fields("userId")
      .references("id"),
  })
  .map("o2o_profiles");

const schema = { user: User, profile: Profile };

const UNIQUE_VIOLATION = /unique|duplicate/i;

let client: Awaited<
  ReturnType<
    typeof PGliteCreateClient<typeof schema, { schema: typeof schema }>
  >
>;
let pglite: import("@electric-sql/pglite").PGlite;

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  pglite = new PGlite();
  client = await PGliteCreateClient({ schema, client: pglite });
  // skipValidation: FK008 flags the deliberately-missing .unique() above;
  // this suite exists to prove the serializer emits the constraint anyway.
  await syncLiveSchema(client, { skipValidation: true });
});

afterAll(async () => {
  try {
    await client.$disconnect();
  } finally {
    await pglite.close();
  }
});

describe("one-to-one uniqueness", () => {
  test("rejects a second profile pointing at the same user", async () => {
    await client.user.create({ data: { id: "u1", name: "Alice" } });
    await client.profile.create({
      data: { id: "p1", bio: "first", userId: "u1" },
    });

    await expect(
      client.profile.create({ data: { id: "p2", bio: "second", userId: "u1" } })
    ).rejects.toThrow(UNIQUE_VIOLATION);
  });

  test("still allows one profile per user", async () => {
    await client.user.create({ data: { id: "u2", name: "Bob" } });
    const profile = await client.profile.create({
      data: { id: "p3", bio: "bob's", userId: "u2" },
    });
    expect(profile.userId).toBe("u2");
  });
});

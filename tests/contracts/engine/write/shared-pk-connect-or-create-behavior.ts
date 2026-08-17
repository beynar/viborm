import { UnsupportedOperationError } from "@errors";
import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/** Shared-primary-key create roots consume the exact key of the selected relation arm.
 * Found arms use the planning probe's captured referenced tuple; missing arms use the
 * created target's published value. The root INSERT is the single publication point
 * consumed by descendants and terminal selection on every substrate. */
export const sharedPkConnectOrCreateSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      profile: s.oneToOne(() => profile).optional(),
    })
    .map("e63_users");
  const profile = s
    .model({
      // Shared primary key: `userId` is this row's identity AND its foreign key.
      userId: s.string().id(),
      bio: s.string(),
      user: s
        .oneToOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("e63_profiles");
  return { profile, user };
})();

hydrateSchemaNames(sharedPkConnectOrCreateSchema);

/** Two live users and a live profile, none of which the absorbed shapes may answer
 *  with. `decoy` holds a profile row so a read that took "some profile" answers wrong;
 *  `other` is a second user so a key re-derived from "some user" answers wrong too. */
async function seed(client: any): Promise<void> {
  await client.profile.deleteMany({});
  await client.user.deleteMany({});
  await client.user.createMany({
    data: [
      { id: "u1", email: "u1@x", name: "seed" },
      { id: "decoy", email: "decoy@x", name: "decoy" },
      { id: "other", email: "other@x", name: "other" },
    ],
  });
  await client.profile.createMany({
    data: [{ userId: "decoy", bio: "decoy" }],
  });
}

export function registerSharedPkConnectOrCreateBehavior(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe
): void {
  register(`E6.3 shared-PK connectOrCreate (${name})`, () => {
    test("the FOUND arm writes and reads back the where's key, not a decoy's", async () => {
      const client = await connect();
      await seed(client);

      expect(
        await client.profile.create({
          data: {
            bio: "found",
            user: {
              connectOrCreate: {
                where: { id: "u1" },
                create: { id: "u1", email: "unused@x", name: "unused" },
              },
            },
          },
          select: { userId: true, bio: true },
        })
      ).toEqual({ userId: "u1", bio: "found" });

      // The found arm wrote no user, and the decoy profile is untouched.
      expect(await client.user.count()).toBe(3);
      expect(
        await client.profile.findMany({
          orderBy: { userId: "asc" },
          select: { userId: true, bio: true },
        })
      ).toEqual([
        { userId: "decoy", bio: "decoy" },
        { userId: "u1", bio: "found" },
      ]);
    });

    test("the CREATE arm makes the target and keys the record by the same value", async () => {
      const client = await connect();
      await seed(client);

      expect(
        await client.profile.create({
          data: {
            bio: "made",
            user: {
              connectOrCreate: {
                where: { id: "fresh" },
                create: { id: "fresh", email: "fresh@x", name: "fresh" },
              },
            },
          },
          select: { userId: true, bio: true },
        })
      ).toEqual({ userId: "fresh", bio: "made" });

      expect(
        await client.user.findUnique({
          where: { id: "fresh" },
          select: { email: true },
        })
      ).toEqual({ email: "fresh@x" });
      expect(await client.profile.count()).toBe(2);
    });

    test("a connect by a non-referenced unique publishes the captured key", async () => {
      const client = await connect();
      await seed(client);

      expect(
        await client.profile.create({
          data: { bio: "connected", user: { connect: { email: "u1@x" } } },
          select: { userId: true, bio: true },
        })
      ).toEqual({ userId: "u1", bio: "connected" });
    });

    test("an explicit shared-key scalar cannot disagree with the selected relation", async () => {
      const client = await connect();
      await seed(client);

      const rejection = await client.profile
        .create({
          data: {
            userId: "other",
            bio: "contradiction",
            user: { connect: { email: "u1@x" } },
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(rejection).toBeInstanceOf(UnsupportedOperationError);
      expect((rejection as Error).message).toContain(
        "conflicting final assignments"
      );
      expect(await client.profile.count()).toBe(1);
    });

    test("an explicit shared-key scalar cannot disagree with a literal relation key", async () => {
      const client = await connect();
      await seed(client);

      const rejection = await client.profile
        .create({
          data: {
            userId: "other",
            bio: "literal contradiction",
            user: { connect: { id: "u1" } },
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(rejection).toBeInstanceOf(UnsupportedOperationError);
      expect((rejection as Error).message).toContain(
        "conflicting final assignments"
      );
      expect(await client.profile.count()).toBe(1);
    });

    test("a connectOrCreate missing arm may publish a key different from its selector", async () => {
      const client = await connect();
      await seed(client);

      expect(
        await client.profile.create({
          data: {
            bio: "selected missing",
            user: {
              connectOrCreate: {
                where: { id: "fresh" },
                create: { id: "elsewhere", email: "e@x", name: "e" },
              },
            },
          },
          select: { userId: true },
        })
      ).toEqual({ userId: "elsewhere" });
      expect(await client.user.count()).toBe(4);
    });

    test("a connectOrCreate found by a non-referenced unique publishes the captured key", async () => {
      const client = await connect();
      await seed(client);

      expect(
        await client.profile.create({
          data: {
            bio: "selected found",
            user: {
              connectOrCreate: {
                where: { email: "u1@x" },
                create: { id: "u1", email: "u1@x", name: "n" },
              },
            },
          },
          select: { userId: true },
        })
      ).toEqual({ userId: "u1" });
      expect(await client.user.count()).toBe(3);
    });

    test("THE COLLATION PROBE: the arm decision and the constraint agree on this dialect", async () => {
      // The plan's rule for this row. The absorbed shape writes the `where`'s
      // COMPILE-KNOWN literal as the record's shared primary key, so the arm probe's
      // comparison must not be LOOSER than the referenced constraint's: a probe that
      // answered "found" about a row whose key differs from the literal would key the
      // record by a value the target does not hold. `U1` is live; the `where` spells
      // `u1`. If the two agree (both case-sensitive) the CREATE arm runs and there are
      // two users; a looser probe would take the FOUND arm and leave one.
      const client = await connect();
      await client.profile.deleteMany({});
      await client.user.deleteMany({});
      await client.user.createMany({
        data: [{ id: "U1", email: "U1@x", name: "upper" }],
      });

      expect(
        await client.profile.create({
          data: {
            bio: "cased",
            user: {
              connectOrCreate: {
                where: { id: "u1" },
                create: { id: "u1", email: "u1@x", name: "lower" },
              },
            },
          },
          select: { userId: true },
        })
      ).toEqual({ userId: "u1" });

      // Measured on every leg (PGlite, better-sqlite3, Docker MySQL, Docker
      // PostgreSQL): AGREE. MySQL is the one dialect whose server default collation is
      // case-INSENSITIVE, and viborm's own DDL pins its string columns to
      // `utf8mb4_0900_bin` — so no per-dialect carve-out is owed here. This assertion
      // is what makes that a ratchet rather than a note.
      expect(await client.user.count()).toBe(2);
      expect(
        (
          await client.user.findUnique({
            where: { id: "U1" },
            select: { name: true },
          })
        )?.name
      ).toBe("upper");
    });

    test("a NON-shared to-one connectOrCreate is unaffected by the widening", async () => {
      const client = await connect();
      await seed(client);
      // The same kind on an edge whose foreign key is NOT the record's primary key:
      // `resolveSharedPkIdentity` never looks at it, and it behaves as it always did.
      expect(
        await client.user.create({
          data: { id: "plain", email: "plain@x", name: "plain" },
          select: { id: true },
        })
      ).toEqual({ id: "plain" });
    });
  });
}

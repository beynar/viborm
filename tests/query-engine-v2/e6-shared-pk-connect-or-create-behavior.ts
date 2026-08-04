import { UnsupportedOperationError } from "@errors";
import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * E6.3 — **the shared-primary-key edge under a CREATE root: `connectOrCreate` absorbed,
 * `connect` by a non-referenced unique re-filed (b) with the consumer that stops it.**
 *
 * The plan's premise for this row was that the two remaining sub-kinds REACH
 * `CreateOperation`'s shared-primary-key refusal. Measured at 8c2908d, through the
 * public client, that premise was FALSE and what stood in its place was a defect:
 *
 *  · **`s.int().id()` shared key** — `planNestedCreateIdentity` refuses first, upstream
 *    of the census site: `NestedWriteError: Nested create requires primary key field
 *    'userId' to be known before execution.` Nothing is written. Both sub-kinds, and
 *    `connectOrCreate` on both arms.
 *  · **`s.string().id()` shared key** — `.id()` implies `autoGenerate: "ulid"` and a
 *    `defaultUlid()` DEFAULT, so the parse MATERIALIZES a key into the record's scalar
 *    data. The arm's own foreign-key assignment then overwrites that column, but the
 *    identity kept the phantom, so NEITHER refusal fired and the operation RAN:
 *
 *      transaction: SELECT "t0"."id" … FROM users WHERE "t0"."email" = $1 LIMIT 1 FOR UPDATE
 *                   INSERT INTO profiles ("userId","bio") VALUES ((SELECT … WHERE email = $1), $2)
 *                   SELECT … FROM profiles WHERE "userId" = $1   -- $1 = '01KZ7DQM8DE3K763QA1K7RKAQC'
 *                   → TransactionError: query-engine-v2 create terminal read expected exactly one row.
 *                     (the unit aborts; profiles=[] afterwards)
 *
 *      atomic batch: the same three statements, the write inside the batch
 *                   → QueryEngineError: Driver "pglite" returned a malformed result for
 *                     operation "create": expected exactly one row but received 0.
 *                     **and the batch had COMMITTED**: profiles=[{userId:"u1",bio:"b"}]
 *                     (for the connectOrCreate create arm, users gained "u9" as well).
 *
 * A committed write reported as an internal error is the defect this unit closes. The
 * decision moved to where the shared key's source is manufactured
 * (`resolveSharedPkIdentity`, D3's placement rule), so the phantom default can never
 * stand in for the edge's value — and the refusal that remains is the typed one, raised
 * before any statement runs.
 *
 * **What is absorbed.** `connectOrCreate` whose `where` spells the referenced column and
 * whose `create` spells the SAME value: both arms leave the record holding one
 * compile-known key (the found arm's foreign key IS that `where` literal; the create
 * arm's is the created target's own referenced value), so the identity is that key on
 * either arm — one provenance, the probe deciding only which statement puts the row
 * there.
 *
 * **What stays refused, and why.** A `connect` by a NON-referenced unique resolves its
 * foreign key through a lookup SUBQUERY; re-evaluating that expression for the identity
 * is a second evaluation of one expression. The planning probe the arm already runs
 * could supply the value, but only at COMPILE — and the record identity is consumed at
 * CONSTRUCTION by `planNestedCreateIdentity`, by `freshReferenced` (sibling edges,
 * junction parent sources) and by `CreateOperation.freshRootReferenced`, a PUBLIC seam
 * an enclosing `UpdateOperation` reads while building its own SET, with no `known` at
 * the call site and no deferral in the `FreshReferenced` union. A `connectOrCreate`
 * whose arms name DIFFERENT keys is the same fact one step on: two arms, two keys, no
 * identity.
 */
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

    test("a connect by a NON-referenced unique refuses typed, and writes nothing", async () => {
      const client = await connect();
      await seed(client);

      const rejection = await client.profile
        .create({ data: { bio: "no", user: { connect: { email: "u1@x" } } } })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(rejection).toBeInstanceOf(UnsupportedOperationError);
      expect((rejection as Error).message).toContain(
        "shared-primary-key connect on relation 'user'"
      );
      // THE DEFECT THIS CLOSES: before E6.3 the atomic batch COMMITTED this write and
      // then reported an internal QueryEngineError.
      expect(await client.profile.count()).toBe(1);
    });

    test("a connectOrCreate whose arms name different keys refuses typed, and writes nothing", async () => {
      const client = await connect();
      await seed(client);

      const rejection = await client.profile
        .create({
          data: {
            bio: "no",
            user: {
              connectOrCreate: {
                where: { id: "fresh" },
                create: { id: "elsewhere", email: "e@x", name: "e" },
              },
            },
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(rejection).toBeInstanceOf(UnsupportedOperationError);
      expect((rejection as Error).message).toContain(
        "shared-primary-key connectOrCreate on relation 'user'"
      );
      expect(await client.profile.count()).toBe(1);
      expect(await client.user.count()).toBe(3);
    });

    test("a connectOrCreate by a NON-referenced unique refuses typed, and writes nothing", async () => {
      const client = await connect();
      await seed(client);

      const rejection = await client.profile
        .create({
          data: {
            bio: "no",
            user: {
              connectOrCreate: {
                where: { email: "u1@x" },
                create: { id: "u1", email: "u1@x", name: "n" },
              },
            },
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(rejection).toBeInstanceOf(UnsupportedOperationError);
      expect((rejection as Error).message).toContain(
        "shared-primary-key connectOrCreate on relation 'user'"
      );
      expect(await client.profile.count()).toBe(1);
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

import { NotFoundError } from "@errors";
import {
  makeClient,
  runDelete,
  runUpdate,
} from "@tests/contracts/engine/write/staleness-injection-fixtures";
import { updateFamilySchema } from "@tests/contracts/engine/write/update-family-behavior";
import {
  closeTestPGlite,
  openTestPGlite as openBorrowedPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// The two premise families that belong to the root LOCATE rather than to a
// relation kind: an extended unique `where` (its filter half and its
// discriminator half) and the located-parent Ref a non-PK unique produces. Both
// run on `updateFamilySchema` through the same before-batch driver as the
// premise-class slice, and both are answered by the SAME root-presence guard —
// which is why they are read together and split from the kind-indexed classes.
// The shared drivers and runners live in `staleness-injection-fixtures.ts`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// W4-U1 — the EXTENDED unique `where` (Prisma >= 4.5).
//
// Two premises, injected separately, because they are pinned by different
// machinery and must both hold:
//
//  - the FILTER half. Planning locates `K ∧ filters`; the hook makes the filter
//    stop matching. The root-presence guard carries the WHOLE selector — filter
//    included — into the atomic unit, so a stale filter must abort the batch
//    typed, not fall through to an UPDATE that matches zero rows and silently
//    reports success. (The UPDATE itself addresses the captured PK, which is
//    exactly why the guard, not the write's WHERE, has to hold the filter.)
//  - the DISCRIMINATOR half. The existing protection (a concurrent delete) must
//    fire exactly as it does for a plain `where` — extending the selector must
//    not have loosened it.
//
// The falsification for the Pin Rule lives with the pins themselves
// (extended-where-unique.test.ts asserts the create-arm racePin is present for a
// plain `where` and withheld for an extended one, and the conformance suite
// proves a filter naming the referenced parent column pins nothing).
// ---------------------------------------------------------------------------

describe("write engine staleness injection (extended whereUnique)", () => {
  test("filter premise (update): a stale extra filter aborts the batch typed", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "f@x", count: 5 } });

    // Planning matches `email = 'f@x' AND count > 0`; the hook drives count to 0
    // before the batch. The row still EXISTS on the discriminator — only the
    // filter went stale — so this is precisely the case a discriminator-only
    // guard would miss.
    const injector = makeClient(db);
    const rejected = await runUpdate(
      db,
      async () => {
        await injector.user.update({
          where: { email: "f@x" },
          data: { count: { set: 0 } },
        });
      },
      "user",
      updateFamilySchema.user,
      {
        where: { email: "f@x", count: { gt: 0 } },
        data: { count: { increment: 10 } },
        select: { email: true, count: true },
      }
    ).catch((error) => error);
    expect(rejected).toBeInstanceOf(NotFoundError);

    // The batch aborted whole: the injector's 0 stands, our +10 never landed.
    await expect(
      client.user.findUnique({
        where: { email: "f@x" },
        select: { count: true },
      })
    ).resolves.toEqual({ count: 0 });
    await client.$disconnect();
    await closeTestPGlite(db);
  });

  test("filter premise (delete): a stale extra filter aborts the batch typed", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "fd@x", count: 5 } });

    const injector = makeClient(db);
    const rejected = await runDelete(
      db,
      async () => {
        await injector.user.update({
          where: { email: "fd@x" },
          data: { count: { set: 0 } },
        });
      },
      "user",
      updateFamilySchema.user,
      { where: { email: "fd@x", count: { gt: 0 } }, select: { email: true } }
    ).catch((error) => error);
    expect(rejected).toBeInstanceOf(NotFoundError);

    // The row survives — a stale filter must not delete the row it no longer
    // describes.
    await expect(
      client.user.findUnique({
        where: { email: "fd@x" },
        select: { count: true },
      })
    ).resolves.toEqual({ count: 0 });
    await client.$disconnect();
    await closeTestPGlite(db);
  });

  test("discriminator premise still fires under an extended where", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "fk@x", count: 5 } });

    const injector = makeClient(db);
    const rejected = await runUpdate(
      db,
      async () => {
        await injector.user.delete({ where: { email: "fk@x" } });
      },
      "user",
      updateFamilySchema.user,
      {
        where: { email: "fk@x", count: { gt: 0 } },
        data: { count: { increment: 1 } },
        select: { email: true, count: true },
      }
    ).catch((error) => error);
    expect(rejected).toBeInstanceOf(NotFoundError);

    await expect(client.user.findMany()).resolves.toEqual([]);
    await client.$disconnect();
    await closeTestPGlite(db);
  });
});

// ---------------------------------------------------------------------------
// N1-U1 — the located-parent Ref's race story. The Ref carries a value read at
// planning, OUTSIDE the atomic batch, into a write INSIDE it. The premise it
// depends on is the one the root-presence guard already pins: the located parent
// still exists when the unit runs. These two injections prove that premise is
// enforced for the Ref path specifically — a concurrent delete of the located
// parent aborts the batch typed, with no orphaned child row left behind — and
// that the pin is the EXISTING guard, not a new one (the Ref is dataflow; the
// Pin Rule's race classification is untouched by it).
// ---------------------------------------------------------------------------

describe("write engine staleness injection (located-parent Ref)", () => {
  test("nested create by a non-PK unique: a concurrent parent delete aborts the batch typed", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "ref@x", count: 0 } });

    const injector = makeClient(db);
    await expect(
      runUpdate(
        db,
        async () => {
          await injector.user.delete({ where: { email: "ref@x" } });
        },
        "user",
        updateFamilySchema.user,
        {
          where: { email: "ref@x" },
          data: { posts: { create: { id: 90, title: "raced", slug: "s90" } } },
          select: { email: true },
        }
      )
    ).rejects.toBeInstanceOf(NotFoundError);

    // No child rode a foreign key to a parent that no longer exists.
    await expect(client.post.findMany()).resolves.toEqual([]);
    await client.$disconnect();
    await closeTestPGlite(db);
  });

  test("nested createMany by a non-PK unique: a concurrent parent delete aborts the batch typed", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "refm@x", count: 0 } });

    const injector = makeClient(db);
    await expect(
      runUpdate(
        db,
        async () => {
          await injector.user.delete({ where: { email: "refm@x" } });
        },
        "user",
        updateFamilySchema.user,
        {
          where: { email: "refm@x" },
          data: {
            posts: {
              createMany: {
                data: [
                  { id: 91, title: "a", slug: "s91" },
                  { id: 92, title: "b", slug: "s92" },
                ],
              },
            },
          },
          select: { email: true },
        }
      )
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(client.post.findMany()).resolves.toEqual([]);
    await client.$disconnect();
    await closeTestPGlite(db);
  });
});

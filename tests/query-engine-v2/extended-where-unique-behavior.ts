import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import {
  NotFoundError,
  UniqueConstraintError,
  ValidationError,
  VibORMErrorCode,
} from "@errors";
import { push } from "@migrations";
import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * W4-U1 — the EXTENDED unique `where` (Prisma >= 4.5).
 *
 * `findUnique` / `findUniqueOrThrow` / `update` / `delete` / `upsert` accept a
 * `where` that mixes the unique discriminator with ordinary non-unique scalar
 * filters and `AND` / `OR` / `NOT`. The discriminator is still required, and it
 * is still the ONLY half anything compile-time reads: pins, `racePin`
 * attribution, and identity never see the filters.
 *
 * The four semantics this suite pins, on every driver and both substrates:
 *  1. a matching filter is transparent — same answer as the plain `where`;
 *  2. an EXCLUDING filter makes `update` / `delete` a NOT-FOUND (V6001) with
 *     state unchanged, and `findUnique` a `null` (`…OrThrow` a NotFoundError);
 *  3. an excluding filter sends `upsert` down its CREATE arm, whose unique
 *     violation surfaces as a UniqueConstraintError (V3001) — a genuine
 *     conflict, not a race; and whose terminal read-back returns the row that
 *     arm actually INSERTED, addressed by the identity of that insert and never
 *     by the `where` (`ticket`, whose DB-generated PK forces the capture);
 *  4. a nested create under an extended `where` takes its parent column from the
 *     DISCRIMINATOR or, since N1-U1, from the LOCATED ROW — never from the filter
 *     half, which narrows which row is touched and names none.
 */
export const extendedWhereUniqueSchema = (() => {
  const account = s
    .model({
      id: s.int().id(),
      email: s.string().unique(),
      status: s.string(),
      score: s.int(),
      logins: s.oneToMany(() => login),
    })
    .map("ext_wu_accounts");
  const login = s
    .model({
      id: s.int().id(),
      label: s.string(),
      accountId: s.int().nullable(),
      account: s
        .manyToOne(() => account)
        .fields("accountId")
        .references("id")
        .optional(),
    })
    .map("ext_wu_logins");
  // Same shape as `account` but with a DB-GENERATED primary key: the create data
  // cannot carry the PK, so upsert's create arm addresses the created row by the
  // OTHER complete unique its `create` supplies — `email`. `account`'s
  // caller-supplied `id` addresses the created row by its primary key instead.
  const ticket = s
    .model({
      id: s.int().id().increment(),
      email: s.string().unique(),
      status: s.string(),
      score: s.int(),
    })
    .map("ext_wu_tickets");
  // The third identity source: a DB-generated primary key AND no other unique
  // constraint at all, so the create data can spell no identity of its own and the
  // INSERT must CAPTURE what the database assigned (`… RETURNING id`, or the
  // driver's insert id). `ticket` no longer reaches that branch — its `create`
  // carries `email` — so this model is what keeps it witnessed.
  const note = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      status: s.string(),
      score: s.int(),
    })
    .map("ext_wu_notes");
  return { account, login, note, ticket };
})();

hydrateSchemaNames(extendedWhereUniqueSchema);

type ExtendedWhereUniqueClient = ReturnType<typeof makeClient>;

function makeClient(driver: AnyDriver) {
  return createClient({ schema: extendedWhereUniqueSchema, driver });
}

export function runExtendedWhereUniqueBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}): void {
  describe(`${options.name} extended whereUnique`, () => {
    const setup = async () => {
      const driver = options.createDriver();
      const client = makeClient(driver);
      await push(client, { force: true });
      await client.account.create({
        data: { id: 1, email: "live@x", status: "active", score: 10 },
      });
      await client.account.create({
        data: { id: 2, email: "gone@x", status: "archived", score: 20 },
      });
      await client.ticket.create({
        data: { email: "seed@x", status: "active", score: 7 },
      });
      await client.note.create({
        data: { label: "seed", status: "active", score: 7 },
      });
      return {
        client,
        dispose: () => client.$disconnect(),
      };
    };

    const run = (
      body: (client: ExtendedWhereUniqueClient) => Promise<void>
    ): (() => Promise<void>) => {
      return async () => {
        const { client, dispose } = await setup();
        try {
          await body(client);
        } finally {
          await dispose();
        }
      };
    };

    // -- 1. reads -----------------------------------------------------------

    test(
      "findUnique: matching filter is transparent",
      { timeout: 30_000 },
      run(async (client) => {
        const row = await client.account.findUnique({
          where: { email: "live@x", status: "active" },
          select: { id: true, score: true },
        });
        expect(row).toEqual({ id: 1, score: 10 });
      })
    );

    test(
      "findUnique: excluding filter yields null",
      { timeout: 30_000 },
      run(async (client) => {
        const row = await client.account.findUnique({
          where: { email: "gone@x", status: "active" },
          select: { id: true },
        });
        expect(row).toBeNull();
      })
    );

    test(
      "findUnique: AND / OR / NOT compile into the read",
      { timeout: 30_000 },
      run(async (client) => {
        const matched = await client.account.findUnique({
          where: {
            id: 1,
            AND: [{ score: { gte: 5 } }],
            NOT: { status: "archived" },
            OR: [{ email: "live@x" }, { email: "nobody@x" }],
          },
          select: { id: true },
        });
        expect(matched).toEqual({ id: 1 });

        const excluded = await client.account.findUnique({
          where: { id: 1, NOT: { status: "active" } },
          select: { id: true },
        });
        expect(excluded).toBeNull();
      })
    );

    test(
      "findUniqueOrThrow: excluding filter throws NotFound (V6001)",
      { timeout: 30_000 },
      run(async (client) => {
        const rejection = await client.account
          .findUniqueOrThrow({
            where: { email: "gone@x", status: "active" },
            select: { id: true },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(rejection).toBeInstanceOf(NotFoundError);
        expect((rejection as NotFoundError).code).toBe(
          VibORMErrorCode.RECORD_NOT_FOUND
        );
      })
    );

    // -- 2. update ----------------------------------------------------------

    test(
      "update: matching filter updates the discriminated row",
      { timeout: 30_000 },
      run(async (client) => {
        const updated = await client.account.update({
          where: { email: "live@x", status: "active" },
          data: { score: { increment: 5 } },
          select: { id: true, score: true },
        });
        expect(updated).toEqual({ id: 1, score: 15 });
      })
    );

    test(
      "update: excluding filter is NOT-FOUND and leaves the row untouched",
      { timeout: 30_000 },
      run(async (client) => {
        const rejection = await client.account
          .update({
            where: { email: "gone@x", status: "active" },
            data: { score: { increment: 5 } },
            select: { id: true },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(rejection).toBeInstanceOf(NotFoundError);
        expect((rejection as NotFoundError).code).toBe(
          VibORMErrorCode.RECORD_NOT_FOUND
        );
        // State unchanged: the excluded row kept its score AND its status.
        expect(
          await client.account.findUnique({
            where: { id: 2 },
            select: { score: true, status: true },
          })
        ).toEqual({ score: 20, status: "archived" });
      })
    );

    // -- 3. delete ----------------------------------------------------------

    test(
      "delete: matching filter deletes the discriminated row",
      { timeout: 30_000 },
      run(async (client) => {
        const deleted = await client.account.delete({
          where: { email: "live@x", score: { gt: 5 } },
          select: { id: true },
        });
        expect(deleted).toEqual({ id: 1 });
        expect(
          await client.account.findUnique({ where: { id: 1 } })
        ).toBeNull();
      })
    );

    test(
      "delete: excluding filter is NOT-FOUND and leaves the row present",
      { timeout: 30_000 },
      run(async (client) => {
        const rejection = await client.account
          .delete({
            where: { email: "gone@x", score: { gt: 100 } },
            select: { id: true },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(rejection).toBeInstanceOf(NotFoundError);
        expect((rejection as NotFoundError).code).toBe(
          VibORMErrorCode.RECORD_NOT_FOUND
        );
        expect(
          await client.account.findUnique({
            where: { id: 2 },
            select: { id: true },
          })
        ).toEqual({ id: 2 });
      })
    );

    // -- 4. upsert ----------------------------------------------------------

    test(
      "upsert: matching filter takes the update arm",
      { timeout: 30_000 },
      run(async (client) => {
        const result = await client.account.upsert({
          where: { email: "live@x", status: "active" },
          create: { id: 9, email: "live@x", status: "fresh", score: 0 },
          update: { score: { increment: 1 } },
          select: { id: true, score: true },
        });
        expect(result).toEqual({ id: 1, score: 11 });
      })
    );

    test(
      "upsert: no row at all takes the create arm",
      { timeout: 30_000 },
      run(async (client) => {
        const result = await client.account.upsert({
          where: { email: "new@x", status: "active" },
          create: { id: 9, email: "new@x", status: "active", score: 3 },
          update: { score: { increment: 1 } },
          select: { id: true, email: true, score: true },
        });
        expect(result).toEqual({ id: 9, email: "new@x", score: 3 });
      })
    );

    test(
      "upsert: excluding filter takes the CREATE arm and surfaces V3001",
      { timeout: 30_000 },
      run(async (client) => {
        // The row exists on the unique key but the filter excludes it, so the
        // locate finds nothing and the create arm runs — straight into the
        // constraint the discriminator names. That is a genuine conflict (a
        // re-plan would read the same excluded row and create again), so it
        // surfaces as a unique violation rather than being retried as a race.
        const rejection = await client.account
          .upsert({
            where: { email: "gone@x", status: "active" },
            create: { id: 9, email: "gone@x", status: "active", score: 0 },
            update: { score: { increment: 1 } },
            select: { id: true },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(rejection).toBeInstanceOf(UniqueConstraintError);
        expect((rejection as UniqueConstraintError).code).toBe(
          VibORMErrorCode.UNIQUE_CONSTRAINT
        );
        // Nothing was written: no id 9, and the excluded row is unchanged.
        expect(
          await client.account.findUnique({ where: { id: 9 } })
        ).toBeNull();
        expect(
          await client.account.findUnique({
            where: { id: 2 },
            select: { score: true, status: true },
          })
        ).toEqual({ score: 20, status: "archived" });
      })
    );

    // -- 4b. the create arm's terminal read: three identity sources ----------
    //
    // The create arm addresses the row it INSERTED, decided from the CREATE DATA
    // alone. Three sources can name that row, and this block witnesses each one
    // separately — a witness that only passes because ANOTHER source happens to
    // agree with the `where` proves nothing:
    //
    //   (1) literal primary key   — `account` (caller-supplied `id`);
    //   (2) a complete unique constraint the create data carries — `ticket`
    //       (DB-generated `id`, but `create` supplies the unique `email`);
    //   (3) a CAPTURED DB-generated identity — `note` (DB-generated `id` and no
    //       other unique at all, so the INSERT must capture what the database
    //       assigned: `… RETURNING id`, or the driver's insert id).
    //
    // The `where` is never an option for any of them. Prisma does not require
    // `create` to satisfy `where`, so the two can name different rows, and an
    // extended `where` is what makes that divergence reachable at all: the unique
    // half matched a live row that the filter EXCLUDED, so reading back by it
    // returns a row this upsert never wrote. Every test below is one witness —
    // the created row must come back, whatever the `where` says.

    test(
      "upsert (1) literal PK: the CREATED row comes back, not the where's row",
      { timeout: 30_000 },
      run(async (client) => {
        // `account`'s create data carries the whole primary key, so the read-back
        // targets `id: 9` — a source (1) witness, and the only one for it. Every
        // other `account` upsert above happens to write a `create` that reproduces
        // the `where`'s discriminator, so a read-back through the `where` would
        // agree with the right answer and they would all still pass. Here it
        // cannot: the discriminator `email: "live@x"` names the SEEDED row (id 1,
        // which the filter excludes), and `create` writes a different PK and a
        // different email. Reading back by the `where` hands back row 1.
        const created = await client.account.upsert({
          where: { email: "live@x", status: "archived" },
          create: { id: 9, email: "fresh@x", status: "brand-new", score: 42 },
          update: { score: { increment: 100 } },
          select: { id: true, email: true, status: true, score: true },
        });
        expect(created).toEqual({
          id: 9,
          email: "fresh@x",
          status: "brand-new",
          score: 42,
        });
        // The row the `where`'s discriminator names was never touched.
        expect(
          await client.account.findUnique({
            where: { id: 1 },
            select: { email: true, status: true, score: true },
          })
        ).toEqual({ email: "live@x", status: "active", score: 10 });
      })
    );

    test(
      "upsert (2) unique from create data: the CREATED row comes back",
      { timeout: 30_000 },
      run(async (client) => {
        // `ticket`'s PK is DB-generated, so source (1) is unavailable and the
        // create arm addresses its row by the complete unique its `create` DOES
        // carry — `email: "other@x"`. That constraint names exactly the row this
        // INSERT wrote, and it is derived from the create data, so it stays right
        // while the `where` names a different LIVE row: the discriminator
        // `email: "seed@x"` matches the seeded ticket and the filter excludes it.
        // Reading back through the `where` — by its discriminator or by the
        // create-data unique's column read out of the `where` — returns the seeded
        // row instead, with a different status and score.
        const created = await client.ticket.upsert({
          where: { email: "seed@x", status: "archived" },
          create: { email: "other@x", status: "fresh", score: 1 },
          update: { score: { increment: 100 } },
          select: { email: true, status: true, score: true },
        });
        expect(created).toEqual({
          email: "other@x",
          status: "fresh",
          score: 1,
        });
        expect(
          await client.ticket.findUnique({
            where: { email: "seed@x" },
            select: { status: true, score: true },
          })
        ).toEqual({ status: "active", score: 7 });
      })
    );

    test(
      "upsert (3) captured generated identity: the CREATED row comes back",
      { timeout: 30_000 },
      run(async (client) => {
        // `note` has a DB-generated PK and NO other unique constraint, so the
        // create data can spell no identity at all and the INSERT has to capture
        // the one the database assigned. The `where` names the generated PK
        // itself — a value the create data cannot reproduce — so the row written
        // gets a different id than the one asked for, and the captured identity is
        // the only thing that can address it.
        const created = await client.note.upsert({
          where: { id: 999 },
          create: { label: "captured", status: "fresh", score: 1 },
          update: { score: { increment: 100 } },
          select: { label: true, status: true, score: true },
        });
        expect(created).toEqual({
          label: "captured",
          status: "fresh",
          score: 1,
        });
        expect(await client.note.count()).toBe(2);
        expect(
          await client.note.findMany({
            select: { label: true, score: true },
            orderBy: { label: "asc" },
          })
        ).toEqual([
          { label: "captured", score: 1 },
          { label: "seed", score: 7 },
        ]);
      })
    );

    test(
      "upsert: create arm returns the row it CREATED, not the one the where names",
      { timeout: 30_000 },
      run(async (client) => {
        // The discriminator matches the seeded row and the filter excludes it, so
        // the create arm runs — and it inserts a DIFFERENT unique value, so the
        // `where` names a live row that is not the created one. Reading back by
        // that `where` (in any of its halves) hands back the seeded row untouched.
        const created = await client.ticket.upsert({
          where: { email: "seed@x", status: "archived" },
          create: { email: "other@x", status: "fresh", score: 1 },
          update: { score: { increment: 100 } },
          select: { email: true, status: true, score: true },
        });
        expect(created).toEqual({
          email: "other@x",
          status: "fresh",
          score: 1,
        });
        // The insert itself was always right; only the read-back was wrong. The
        // seeded row keeps its own values — no update ran on it.
        expect(
          await client.ticket.findMany({
            select: { email: true, status: true, score: true },
            orderBy: { email: "asc" },
          })
        ).toEqual([
          { email: "other@x", status: "fresh", score: 1 },
          { email: "seed@x", status: "active", score: 7 },
        ]);
      })
    );

    test(
      "upsert: create arm returns the created row for a PLAIN where too",
      { timeout: 30_000 },
      run(async (client) => {
        // No extended `where` at all: the discriminator names no row, so the
        // create arm runs and inserts a different unique value. The created row
        // is still the answer — a read-back by `where` would find nothing.
        const created = await client.ticket.upsert({
          where: { email: "absent@x" },
          create: { email: "other@x", status: "fresh", score: 1 },
          update: { score: { increment: 100 } },
          select: { email: true, status: true, score: true },
        });
        expect(created).toEqual({
          email: "other@x",
          status: "fresh",
          score: 1,
        });
        expect(
          await client.ticket.findUnique({ where: { email: "absent@x" } })
        ).toBeNull();
      })
    );

    test(
      "upsert: create-arm read-back ignores a filter smuggled through AND",
      { timeout: 30_000 },
      run(async (client) => {
        // Same claim, but the excluding filter arrives as a boolean combinator
        // rather than a bare scalar — the arm taken and the row returned are the
        // same either way.
        const created = await client.ticket.upsert({
          where: { email: "seed@x", AND: [{ status: "archived" }] },
          create: { email: "other@x", status: "fresh", score: 1 },
          update: { score: { increment: 100 } },
          select: { email: true, status: true, score: true },
        });
        expect(created).toEqual({
          email: "other@x",
          status: "fresh",
          score: 1,
        });
      })
    );

    test(
      "upsert: create arm returns the created row when the where names the PK",
      { timeout: 30_000 },
      run(async (client) => {
        // The `where` names the DB-generated primary key itself. The create data
        // cannot carry it, so the row the INSERT writes gets a different id than
        // the one asked for — the created row, addressed by the unique its
        // `create` data carries, is still what comes back.
        const created = await client.ticket.upsert({
          where: { id: 999 },
          create: { email: "other@x", status: "fresh", score: 1 },
          update: { score: { increment: 100 } },
          select: { email: true, status: true, score: true },
        });
        expect(created).toEqual({
          email: "other@x",
          status: "fresh",
          score: 1,
        });
        expect(await client.ticket.count()).toBe(2);
      })
    );

    test(
      "upsert: a matching filter still takes the UPDATE arm on a generated PK",
      { timeout: 30_000 },
      run(async (client) => {
        // The falsification for every case above: addressing the created row
        // by the INSERT's own identity must not turn every extended-`where`
        // upsert into a create — a matching filter still locates and updates.
        const updated = await client.ticket.upsert({
          where: { email: "seed@x", status: "active" },
          create: { email: "seed@x", status: "fresh", score: 0 },
          update: { score: { increment: 1 } },
          select: { email: true, status: true, score: true },
        });
        expect(updated).toEqual({
          email: "seed@x",
          status: "active",
          score: 8,
        });
        expect(await client.ticket.count()).toBe(1);
      })
    );

    // -- 4c. the array form: `$transaction([…])` -----------------------------
    //
    // `$transaction([…])` runs its operations as ONE unit: a real transaction on a
    // transactional driver, one SHARED driver batch on a batch-only one (the
    // D1/Neon class — the batch-only PGlite leg is the stand-in here). The shared
    // merge cannot isolate an operation's `insertId` scratch, so an upsert whose
    // create arm needs a CAPTURED identity is refused from it — data-dependently,
    // since only the create arm carries the capture. That is exactly why the
    // capture-free identity is preferred: `ticket` needs none (its `create`
    // carries the unique `email`, which names the inserted row on its own), so
    // both arms merge on every substrate. The refusal that legitimately REMAINS —
    // a create arm with no capture-free identity, i.e. `note` — is pinned in
    // extended-where-unique.test.ts, where the batch-only driver is in scope.

    test(
      "$transaction([…]): the upsert CREATE arm merges and returns the created row",
      { timeout: 30_000 },
      run(async (client) => {
        const [created] = await client.$transaction([
          client.ticket.upsert({
            where: { email: "seed@x", status: "archived" },
            create: { email: "batched@x", status: "fresh", score: 1 },
            update: { score: { increment: 100 } },
            select: { email: true, status: true, score: true },
          }),
        ]);
        expect(created).toEqual({
          email: "batched@x",
          status: "fresh",
          score: 1,
        });
        expect(await client.ticket.count()).toBe(2);
      })
    );

    test(
      "$transaction([…]): the upsert UPDATE arm merges and returns the updated row",
      { timeout: 30_000 },
      run(async (client) => {
        const [updated] = await client.$transaction([
          client.ticket.upsert({
            where: { email: "seed@x", status: "active" },
            create: { email: "batched@x", status: "fresh", score: 1 },
            update: { score: { increment: 5 } },
            select: { email: true, status: true, score: true },
          }),
        ]);
        expect(updated).toEqual({
          email: "seed@x",
          status: "active",
          score: 12,
        });
        expect(await client.ticket.count()).toBe(1);
      })
    );

    test(
      "$transaction([…]): a multi-operation array runs as one unit, in order",
      { timeout: 30_000 },
      run(async (client) => {
        const [created, updated, read] = await client.$transaction([
          client.account.create({
            data: { id: 7, email: "seven@x", status: "active", score: 1 },
            select: { id: true, email: true },
          }),
          client.account.update({
            where: { id: 1 },
            data: { score: { increment: 5 } },
            select: { id: true, score: true },
          }),
          client.account.findUnique({
            where: { id: 2 },
            select: { id: true, score: true },
          }),
        ]);
        expect(created).toEqual({ id: 7, email: "seven@x" });
        expect(updated).toEqual({ id: 1, score: 15 });
        expect(read).toEqual({ id: 2, score: 20 });
        expect(await client.account.count()).toBe(3);
      })
    );

    // -- 5. the Pin Rule ----------------------------------------------------

    test(
      "nested create pins the parent column from the DISCRIMINATOR",
      { timeout: 30_000 },
      run(async (client) => {
        const result = await client.account.update({
          where: { id: 1, status: "active" },
          data: { logins: { create: { id: 100, label: "first" } } },
          select: {
            id: true,
            logins: { select: { id: true, accountId: true } },
          },
        });
        expect(result).toEqual({
          id: 1,
          logins: [{ id: 100, accountId: 1 }],
        });
      })
    );

    // DELIBERATE RETARGET (N1-U1). This case used to pin an
    // `UnsupportedOperationError`: with `id` named only by the AND branch, no
    // compile-time literal held the referenced column, and the nested create
    // refused. That refusal was literal-only propagation, not the Pin Rule, and
    // N1 removed its cause — the locate now SELECTS the referenced column and the
    // create reads it from the located row. What the Pin Rule actually forbids is
    // unchanged and still witnessed here: nothing is read FROM the filter half.
    // `resolveCreateParent` consults `getWhereUniqueEntries` — the discriminator
    // alone — and when that does not name the referenced column it goes to the
    // LOCATED ROW, never to the AND branch. The second case is the falsification:
    // a filter naming a referenced value that excludes the discriminator's row
    // must produce NOT-FOUND with nothing written; an implementation that read
    // the filter as a pin would insert a login against it.
    test(
      "a filter naming the referenced column pins NOTHING — the value comes from the located row",
      { timeout: 30_000 },
      run(async (client) => {
        const result = await client.account.update({
          where: { email: "live@x", AND: [{ id: 1 }] },
          data: { logins: { create: { id: 101, label: "not smuggled" } } },
          select: {
            id: true,
            logins: { select: { id: true, accountId: true } },
          },
        });
        expect(result).toEqual({
          id: 1,
          logins: [{ id: 101, accountId: 1 }],
        });
      })
    );

    test(
      "a filter naming another row's referenced value is NOT-FOUND, never a pin",
      { timeout: 30_000 },
      run(async (client) => {
        // `live@x` is account 1; the filter demands `id: 2`. The two halves
        // intersect nothing, so the locate misses and the whole tree aborts.
        const rejection = await client.account
          .update({
            where: { email: "live@x", AND: [{ id: 2 }] },
            data: { logins: { create: { id: 102, label: "smuggled" } } },
            select: { id: true },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(rejection).toBeInstanceOf(NotFoundError);
        expect(await client.login.findMany({ select: { id: true } })).toEqual(
          []
        );
      })
    );

    // -- 6. the boundary ----------------------------------------------------

    test(
      "a filter-only where is a ValidationError, not a scan",
      { timeout: 30_000 },
      run(async (client) => {
        const rejection = await client.account
          .update({
            where: { status: "active" } as never,
            data: { score: { increment: 1 } },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(rejection).toBeInstanceOf(ValidationError);
        expect((rejection as Error).message).toContain("one of");
      })
    );

    test(
      "a relation filter inside a unique where is refused BY NAME",
      { timeout: 30_000 },
      run(async (client) => {
        const rejection = await client.account
          .findUnique({
            where: { id: 1, logins: { some: {} } } as never,
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(rejection).toBeInstanceOf(ValidationError);
        expect((rejection as Error).message).toContain(
          "is not supported inside a unique 'where'"
        );
      })
    );

    test(
      "a NESTED target selector keeps the STRICT unique schema",
      { timeout: 30_000 },
      run(async (client) => {
        await client.login.create({
          data: { id: 200, label: "owned", accountId: 1 },
        });
        const rejection = await client.account
          .update({
            where: { id: 1 },
            data: {
              logins: {
                update: {
                  where: { id: 200, label: "owned" } as never,
                  data: { label: "renamed" },
                },
              },
            },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(rejection).toBeInstanceOf(ValidationError);
        expect((rejection as Error).message).toContain("Unknown key: label");
        expect(
          await client.login.findUnique({
            where: { id: 200 },
            select: { label: true },
          })
        ).toEqual({ label: "owned" });
      })
    );
  });
}

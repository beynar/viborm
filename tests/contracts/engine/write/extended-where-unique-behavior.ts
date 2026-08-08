import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import {
  NotFoundError,
  UniqueConstraintError,
  ValidationError,
  VibORMErrorCode,
} from "@errors";
import { hydrateSchemaNames, s } from "@schema";
import {
  type BehaviorDatabaseSource,
  useBehaviorDatabase,
} from "@tests/fixtures/drivers/pglite";
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
 *
 * Since N6-U2 the filter half may also be a RELATION filter, and §7 below pins
 * the four things that follow from it: transparency when it matches, not-found
 * when it excludes, arm selection for `upsert`, and — the one that is not a
 * restatement of the scalar case — that the correlated `EXISTS` names the
 * MUTATED table. Both models here carry an `id`, so a bare-column correlation
 * would silently bind the outer reference to the RELATED table.
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
  // N6-U2's dialect-risk shape: a SELF relation, so a relation filter's `EXISTS`
  // reads the very table the statement mutates. MySQL rejects that (ERROR 1093)
  // unless the subquery is hidden behind a derived table — which is why this
  // model exists here rather than only in the cross-table suite above, and why
  // the witnesses on it run on every driver and both substrates.
  const node = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int().nullable(),
      parent: s
        .manyToOne(() => node)
        .fields("parentId")
        .references("id")
        .optional(),
      children: s.oneToMany(() => node),
    })
    .map("ext_wu_nodes");
  return { account, login, node, note, ticket };
})();

hydrateSchemaNames(extendedWhereUniqueSchema);

type ExtendedWhereUniqueClient = ReturnType<typeof makeClient>;

function makeClient(driver: AnyDriver) {
  return createClient({ schema: extendedWhereUniqueSchema, driver });
}

export function runExtendedWhereUniqueBehavior(
  options: { readonly name: string } & BehaviorDatabaseSource
): void {
  describe(`${options.name} extended whereUnique`, () => {
    const openDatabase = useBehaviorDatabase(
      extendedWhereUniqueSchema,
      options
    );
    const setup = async () => {
      const database = await openDatabase();
      const { client } = database;
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
      // boss ← mid ← kid: `mid` has both a parent and a child, `boss` only a
      // child, `kid` only a parent — so every self-relation filter below has a
      // row it matches and a row it excludes.
      await client.node.create({
        data: { id: 1, label: "boss", parentId: null },
      });
      await client.node.create({ data: { id: 2, label: "mid", parentId: 1 } });
      await client.node.create({ data: { id: 3, label: "kid", parentId: 2 } });
      return database;
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

    // DELIBERATE RETARGET (N1-U1), CORRECTED in the N1 fix round. This case used
    // to pin an `UnsupportedOperationError`: with `id` named only by the AND
    // branch, no compile-time literal held the referenced column, and the nested
    // create refused. That refusal was literal-only propagation, not the Pin
    // Rule, and N1 removed its cause — the locate now SELECTS the referenced
    // column and the create reads it from the located row.
    //
    // What the deleted assertion had also been doing, unnoticed, was FALSIFYING
    // the Pin-Rule half: an implementation reading the filter as a pin would
    // never have raised it. The retarget's first cut claimed the two AND cases
    // below carried that falsification forward. They do not, and the claim was
    // measured false — a `locatedCreateParent` mutated to scan `where.AND` for
    // the referenced field and return it as a literal passes BOTH. It cannot be
    // otherwise: the filter half is ANDed into the locate, so an AND branch
    // either names the located row's own value (this case — the two provenances
    // coincide by construction) or names another row's and the locate finds
    // NOTHING (the case below — no row, no write, regardless of provenance).
    //
    // These two are therefore accept-and-execute witnesses only: the payload
    // that used to refuse now executes, and an excluding filter still aborts the
    // whole tree. The discriminating witness is the OR case that follows, where
    // the two halves DISAGREE while the locate still succeeds — the only shape
    // in which "the value came from the located row" and "the value came from
    // the filter" produce different rows.
    test(
      "a filter naming the referenced column executes — the value comes from the located row",
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
      "a filter naming another row's referenced value is NOT-FOUND, and writes nothing",
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

    // THE FALSIFICATION of "the filter half pins NOTHING" (N1 fix round). An OR
    // filter is the one shape whose halves can disagree while the locate still
    // finds a row: `email = 'live@x' AND (id = … OR id = …)` matches account 1
    // in both orderings below, but account 2's id is sitting right there in the
    // filter half. An implementation that read a pin out of that half would take
    // `2` — a live, insertable foreign key, so the wrong parent is a SILENTLY
    // wrong row, not an error. `resolveCreateParent` consults
    // `getWhereUniqueEntries` — the discriminator alone — and goes to the LOCATED
    // ROW when that does not name the referenced column, so both logins must hang
    // off account 1. Both branch orderings are run: no positional filter-as-pin
    // (first branch or last) survives one of them.
    test(
      "an OR filter naming another row's referenced value pins NOTHING",
      { timeout: 30_000 },
      run(async (client) => {
        await client.account.update({
          where: { email: "live@x", OR: [{ id: 2 }, { id: 1 }] },
          data: { logins: { create: { id: 201, label: "decoy first" } } },
          select: { id: true },
        });
        await client.account.update({
          where: { email: "live@x", OR: [{ id: 1 }, { id: 2 }] },
          data: { logins: { create: { id: 202, label: "decoy last" } } },
          select: { id: true },
        });
        expect(
          await client.login.findMany({
            select: { id: true, accountId: true },
            orderBy: { id: "asc" },
          })
        ).toEqual([
          { id: 201, accountId: 1 },
          { id: 202, accountId: 1 },
        ]);
        // …and account 2, the row the filter half named, gained nothing.
        expect(
          await client.account.findUnique({
            where: { id: 2 },
            select: { logins: { select: { id: true } } },
          })
        ).toEqual({ logins: [] });
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

    // -- 7. N6-U2: RELATION filters in the unique where ---------------------
    //
    // RETARGETED (N6-U2). This slot held "a relation filter inside a unique
    // where is refused BY NAME". The refusal existed because the filter half
    // compiles into the UPDATE/DELETE as well as the locate, and the unaliased
    // mutation target left the correlated EXISTS with nothing to name. It is
    // named now — `buildUpdate`/`buildDelete` qualify the unique `where` by the
    // target's table, exactly as `buildUpdateMany`/`buildDeleteMany` do — so the
    // same payload EXECUTES, and what follows pins that it executes CORRECTLY.
    //
    // MERGE CORRECTION. This slot's note used to end "the strict-nested-selector
    // test below is what still separates the two schemas". That sentence was true
    // in N6-U2's lane and false the moment N6-U1 merged into it: the test it
    // pointed at was retargeted by N6-U1, and there is no longer a strict/extended
    // boundary at a nested TARGET selector at all. The boundary that survives is
    // the one §8 and the module note name — `connect` / `disconnect` / `set` /
    // `connectOrCreate.where` and `cursor` — and §8 witnesses what the two units
    // compose into where the target selectors used to be strict.

    test(
      "a relation filter is transparent when it MATCHES",
      { timeout: 30_000 },
      run(async (client) => {
        await client.login.create({
          data: { id: 201, label: "live", accountId: 1 },
        });
        expect(
          await client.account.findUnique({
            where: { id: 1, logins: { some: { label: "live" } } },
            select: { id: true, score: true },
          })
        ).toEqual({ id: 1, score: 10 });
        expect(
          await client.account.update({
            where: { id: 1, logins: { some: { label: "live" } } },
            data: { score: { increment: 5 } },
            select: { score: true },
          })
        ).toEqual({ score: 15 });
      })
    );

    test(
      "a relation filter that EXCLUDES makes the row not-found, state unchanged",
      { timeout: 30_000 },
      run(async (client) => {
        // Account 1 has no logins at all, so `some` is false for it.
        expect(
          await client.account.findUnique({
            where: { id: 1, logins: { some: {} } },
            select: { id: true },
          })
        ).toBeNull();
        const missing = await client.account
          .findUniqueOrThrow({ where: { id: 1, logins: { some: {} } } })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(missing).toBeInstanceOf(NotFoundError);
        expect((missing as NotFoundError).code).toBe(
          VibORMErrorCode.RECORD_NOT_FOUND
        );
        const updateRejection = await client.account
          .update({
            where: { id: 1, logins: { some: {} } },
            data: { score: { increment: 1 } },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(updateRejection).toBeInstanceOf(NotFoundError);
        const deleteRejection = await client.account
          .delete({ where: { id: 1, logins: { some: {} } } })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(deleteRejection).toBeInstanceOf(NotFoundError);
        // Neither statement touched the row it declined to address.
        expect(
          await client.account.findUnique({
            where: { id: 1 },
            select: { score: true },
          })
        ).toEqual({ score: 10 });
      })
    );

    test(
      "a TO-ONE relation filter answers on both sides of the edge",
      { timeout: 30_000 },
      run(async (client) => {
        await client.login.create({
          data: { id: 210, label: "attached", accountId: 1 },
        });
        await client.login.create({
          data: { id: 211, label: "orphan", accountId: null },
        });
        expect(
          await client.login.findUnique({
            where: { id: 210, account: { is: { status: "active" } } },
            select: { label: true },
          })
        ).toEqual({ label: "attached" });
        expect(
          await client.login.findUnique({
            where: { id: 210, account: { is: { status: "archived" } } },
            select: { label: true },
          })
        ).toBeNull();
        // `is: null` names the unattached row and nothing else.
        expect(
          await client.login.update({
            where: { id: 211, account: { is: null } },
            data: { label: "still-orphan" },
            select: { label: true },
          })
        ).toEqual({ label: "still-orphan" });
        expect(
          await client.login
            .update({
              where: { id: 210, account: { is: null } },
              data: { label: "unreachable" },
            })
            .then(
              () => undefined,
              (error: unknown) => error
            )
        ).toBeInstanceOf(NotFoundError);
      })
    );

    test(
      "the correlation names the MUTATED table, not the related one",
      { timeout: 30_000 },
      run(async (client) => {
        // The wrong-row hazard this absorption had to answer. Both models carry
        // an `id`, so a correlated EXISTS built against a BARE `id` — which is
        // all an unaliased UPDATE target used to offer — binds the outer column
        // to `ext_wu_logins` and asks "is there a login whose id equals its own
        // accountId", a question about no account at all.
        //
        // Login 1 is exactly that decoy: `id === accountId`. Account 1 owns it,
        // so the WRITE must run; the assertion is that it runs because the
        // account's own id correlated, which a decorrelated spelling would get
        // right here and wrong below.
        await client.login.create({
          data: { id: 1, label: "decoy", accountId: 1 },
        });
        expect(
          await client.account.update({
            where: { id: 1, logins: { some: { label: "decoy" } } },
            data: { score: { increment: 7 } },
            select: { score: true },
          })
        ).toEqual({ score: 17 });
        // Account 2 owns NO login, so the correct answer is not-found. The
        // decorrelated spelling would answer "yes — login 1 satisfies
        // `id = accountId`" and update the wrong account's row.
        expect(
          await client.account
            .update({
              where: { id: 2, logins: { some: { label: "decoy" } } },
              data: { score: { increment: 100 } },
            })
            .then(
              () => undefined,
              (error: unknown) => error
            )
        ).toBeInstanceOf(NotFoundError);
        expect(
          await client.account.findUnique({
            where: { id: 2 },
            select: { score: true },
          })
        ).toEqual({ score: 20 });
        // The DELETE half of the same claim, in the negative direction: account
        // 2 owns nothing, so `none` holds and the row must go. A decorrelated
        // `NOT EXISTS` asks instead whether ANY login has `id = accountId` —
        // login 1 does — and answers false, leaving the row behind. Only the
        // atomic-batch substrate can observe this: a transaction addresses the
        // located row by its captured primary key, so the filter never reaches
        // the DELETE there (the compile-level tripwire in
        // `unique-where-relation-filter-plan.test.ts` covers that spelling).
        await client.account.delete({ where: { id: 2, logins: { none: {} } } });
        expect(
          await client.account.findUnique({
            where: { id: 2 },
            select: { id: true },
          })
        ).toBeNull();
      })
    );

    test(
      "a relation filter picks the upsert ARM, and pins no identity",
      { timeout: 30_000 },
      run(async (client) => {
        await client.login.create({
          data: { id: 220, label: "held", accountId: 1 },
        });
        // MATCHES → the UPDATE arm, on the row the `where` named.
        expect(
          await client.account.upsert({
            where: { id: 1, logins: { some: { label: "held" } } },
            create: { id: 90, email: "new@x", status: "fresh", score: 0 },
            update: { score: { increment: 3 } },
            select: { id: true, score: true },
          })
        ).toEqual({ id: 1, score: 13 });
        // EXCLUDES → the CREATE arm, whose data names its own row. The filter
        // narrowed which row was addressed; it named none, so nothing about the
        // created row comes from it.
        expect(
          await client.account.upsert({
            where: { id: 2, logins: { some: { label: "held" } } },
            create: { id: 91, email: "made@x", status: "fresh", score: 4 },
            update: { score: { increment: 100 } },
            select: { id: true, email: true, score: true },
          })
        ).toEqual({ id: 91, email: "made@x", score: 4 });
        // Account 2 — the row the discriminator named — is untouched.
        expect(
          await client.account.findUnique({
            where: { id: 2 },
            select: { score: true },
          })
        ).toEqual({ score: 20 });
        // A create arm whose data collides is a genuine conflict, not a race:
        // the locate never established "this key is free", so no racePin.
        const conflict = await client.account
          .upsert({
            where: { id: 2, logins: { some: { label: "held" } } },
            create: { id: 2, email: "clash@x", status: "fresh", score: 0 },
            update: { score: { increment: 1 } },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(conflict).toBeInstanceOf(UniqueConstraintError);
      })
    );

    test(
      "a SELF-relation filter reads the mutated table, on every dialect",
      { timeout: 30_000 },
      run(async (client) => {
        // The ERROR 1093 shape. On MySQL the statements below are only legal
        // because the relation-filter subquery is wrapped in a derived table;
        // everywhere else the same predicate goes in directly. Both answers must
        // be the same answer, which is what this asserts.
        expect(
          await client.node.update({
            where: { id: 2, children: { some: { label: "kid" } } },
            data: { label: "promoted" },
            select: { label: true },
          })
        ).toEqual({ label: "promoted" });
        // `kid` manages nobody, so the same filter excludes it.
        expect(
          await client.node
            .update({
              where: { id: 3, children: { some: {} } },
              data: { label: "unreachable" },
            })
            .then(
              () => undefined,
              (error: unknown) => error
            )
        ).toBeInstanceOf(NotFoundError);
        // A to-one self-relation filter, through `upsert`'s UPDATE arm — the one
        // statement in this family that keeps the original `where` on BOTH
        // substrates, and therefore the only one that puts the filter inside a
        // MySQL UPDATE.
        expect(
          await client.node.upsert({
            where: { id: 3, parent: { is: { label: "promoted" } } },
            create: { id: 9, label: "unused", parentId: null },
            update: { label: "confirmed" },
            select: { id: true, label: true },
          })
        ).toEqual({ id: 3, label: "confirmed" });
        // …and an excluding one takes the CREATE arm on its own data.
        expect(
          await client.node.upsert({
            where: { id: 1, parent: { is: { label: "promoted" } } },
            create: { id: 4, label: "created", parentId: 1 },
            update: { label: "never" },
            select: { id: true, label: true },
          })
        ).toEqual({ id: 4, label: "created" });
        // Delete by a self-relation-filtered unique where: `kid` is childless.
        expect(
          await client.node.delete({
            where: { id: 3, children: { none: {} } },
            select: { label: true },
          })
        ).toEqual({ label: "confirmed" });
        expect(
          await client.node
            .delete({ where: { id: 1, children: { none: {} } } })
            .then(
              () => undefined,
              (error: unknown) => error
            )
        ).toBeInstanceOf(NotFoundError);
        expect(
          await client.node.findMany({
            orderBy: { id: "asc" },
            select: { id: true, label: true },
          })
        ).toEqual([
          { id: 1, label: "boss" },
          { id: 2, label: "promoted" },
          { id: 4, label: "created" },
        ]);
      })
    );

    test(
      "a nested create under a relation-filtered where takes the LOCATED parent",
      { timeout: 30_000 },
      run(async (client) => {
        await client.login.create({
          data: { id: 230, label: "anchor", accountId: 1 },
        });
        // The `where` is located by a NON-PK unique AND narrowed by a relation
        // filter. The child's FK comes from the row the locate acted on; the
        // filter half contributes no pin (it names no row — see the module note
        // on `where-unique-builder`).
        await client.account.update({
          where: { email: "live@x", logins: { some: { label: "anchor" } } },
          data: { logins: { create: { id: 231, label: "child" } } },
        });
        expect(
          await client.login.findUnique({
            where: { id: 231 },
            select: { accountId: true },
          })
        ).toEqual({ accountId: 1 });
      })
    );

    // DELIBERATE RETARGET (N6-U1 / decision D-N1, maintainer yes). This case used
    // to pin `a NESTED target selector keeps the STRICT unique schema` — a
    // ValidationError on `Unknown key: label`. That scoping was W4's, and it was
    // never about the selector being unspellable: W4 recorded it as "a nested target
    // is located by PK boundaries the extra filters would collide with", and N1 /
    // N4-U1 removed the collision by making a nested locate RETURN its primary key
    // however the row was named. With the cause gone the refusal was arbitrary, so
    // the selectors widened and this pins the accepting behaviour instead.
    //
    // The pair below is what replaces the refusal, and the pair is the point: the
    // filter half must be HONOURED, not merely tolerated. Accepting it and silently
    // dropping it is strictly worse than refusing — it writes the row the caller
    // excluded. The full three-Part, both-substrate, wrong-row-decoy matrix lives in
    // `depth-seam-behavior.ts` under the N6-U1 heading; these two keep the claim
    // beside the root behaviour it now matches.
    test(
      "a NESTED target selector takes the EXTENDED unique where (N6-U1)",
      { timeout: 30_000 },
      run(async (client) => {
        await client.login.create({
          data: { id: 200, label: "owned", accountId: 1 },
        });
        await client.account.update({
          where: { id: 1 },
          data: {
            logins: {
              update: {
                where: { id: 200, label: "owned" },
                data: { label: "renamed" },
              },
            },
          },
        });
        expect(
          await client.login.findUnique({
            where: { id: 200 },
            select: { label: true },
          })
        ).toEqual({ label: "renamed" });
      })
    );

    test(
      "a NESTED target selector's filter half EXCLUDES, and nothing is written",
      { timeout: 30_000 },
      run(async (client) => {
        await client.login.create({
          data: { id: 200, label: "owned", accountId: 1 },
        });
        // Same discriminator, a filter the row does not satisfy: the locate misses,
        // so the nested target's own not-found aborts the tree and the row keeps its
        // label. Without this arm the test above would pass just as well against an
        // implementation that parsed the filter and threw it away.
        const rejection = await client.account
          .update({
            where: { id: 1 },
            data: {
              logins: {
                update: {
                  where: { id: 200, label: "not-owned" },
                  data: { label: "must-not-land" },
                },
              },
            },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect((rejection as Error).message).toContain(
          "Cannot update relation 'logins'"
        );
        expect(
          await client.login.findUnique({
            where: { id: 200 },
            select: { label: true },
          })
        ).toEqual({ label: "owned" });
      })
    );

    // -- 8. N6-U1 × N6-U2: the surface only the MERGE creates ----------------
    //
    // Neither lane could witness this. N6-U1 pointed the nested `update` /
    // `upsert` / `delete` target selectors at `getWhereUniqueExtendedSchema`;
    // N6-U2 put RELATION filters into that schema. Merged, a nested target
    // selector accepts a relation filter — a payload that existed in neither
    // lane's tree, and one that reaches a seam neither lane's witnesses cover.
    //
    // MEASURED, not assumed: the filter half of a nested selector never reaches
    // a write. A nested targeted `update`/`delete` addresses the row by the
    // primary key its correlated probe captured, on BOTH substrates, so the
    // relation filter is carried only by `buildFind` — an aliased SELECT, which
    // correlates correctly and is not subject to MySQL's 1093 restriction on
    // reading the mutated table. The compile-level tripwire for that claim is in
    // `unique-where-relation-filter-plan.test.ts`; these are the behaviours it
    // predicts, and the exclusion arms are what separate "honoured" from
    // "parsed and dropped".

    test(
      "a NESTED target selector takes a relation filter — matching, then excluding",
      { timeout: 30_000 },
      run(async (client) => {
        await client.login.create({
          data: { id: 240, label: "owned", accountId: 1 },
        });
        await client.account.update({
          where: { id: 1 },
          data: {
            logins: {
              update: {
                where: { id: 240, account: { is: { status: "active" } } },
                data: { label: "renamed" },
              },
            },
          },
        });
        expect(
          await client.login.findUnique({
            where: { id: 240 },
            select: { label: true },
          })
        ).toEqual({ label: "renamed" });
        // Same discriminator, a relation filter the row does not satisfy: the
        // nested target's own not-found aborts the tree and nothing is written.
        const rejection = await client.account
          .update({
            where: { id: 1 },
            data: {
              logins: {
                update: {
                  where: { id: 240, account: { is: { status: "archived" } } },
                  data: { label: "must-not-land" },
                },
              },
            },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect((rejection as Error).message).toContain(
          "Cannot update relation 'logins'"
        );
        expect(
          await client.login.findUnique({
            where: { id: 240 },
            select: { label: true },
          })
        ).toEqual({ label: "renamed" });
        // The nested DELETE half of the same claim.
        const declined = await client.account
          .update({
            where: { id: 1 },
            data: {
              logins: {
                delete: { id: 240, account: { is: { status: "archived" } } },
              },
            },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect((declined as Error).message).toContain(
          "Cannot delete relation 'logins'"
        );
        expect(
          await client.login.findUnique({
            where: { id: 240 },
            select: { label: true },
          })
        ).toEqual({ label: "renamed" });
      })
    );

    test(
      "a nested SELF-relation filter answers the same on every dialect",
      { timeout: 30_000 },
      run(async (client) => {
        // The 1093-shaped payload at DEPTH: the nested target of `boss`'s
        // `children` is narrowed by a filter that reads `ext_wu_nodes`, the very
        // table the nested write mutates. It is legal on MySQL without a derived
        // table only because the filter rides the probe, never the UPDATE — and
        // it must give the same answer as everywhere else either way.
        await client.node.update({
          where: { id: 1 },
          data: {
            children: {
              update: {
                where: { id: 2, children: { some: { label: "kid" } } },
                data: { label: "promoted" },
              },
            },
          },
        });
        expect(
          await client.node.findUnique({
            where: { id: 2 },
            select: { label: true },
          })
        ).toEqual({ label: "promoted" });
        // `mid` has a child, so `none` excludes it: not-found, nothing written.
        const rejection = await client.node
          .update({
            where: { id: 1 },
            data: {
              children: {
                update: {
                  where: { id: 2, children: { none: {} } },
                  data: { label: "must-not-land" },
                },
              },
            },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect((rejection as Error).message).toContain(
          "Cannot update relation 'children'"
        );
        expect(
          await client.node.findUnique({
            where: { id: 2 },
            select: { label: true },
          })
        ).toEqual({ label: "promoted" });
      })
    );

    test(
      "a nested upsert's target selector picks its ARM by the relation filter",
      { timeout: 30_000 },
      run(async (client) => {
        await client.login.create({
          data: { id: 250, label: "held", accountId: 1 },
        });
        // MATCHES → the UPDATE arm, on the row the selector named.
        await client.account.update({
          where: { id: 1 },
          data: {
            logins: {
              upsert: {
                where: { id: 250, account: { is: { status: "active" } } },
                create: { id: 251, label: "unused" },
                update: { label: "updated" },
              },
            },
          },
        });
        // EXCLUDES → the CREATE arm, which names its own row and takes the
        // LOCATED parent's key for the edge. The filter narrowed which row was
        // addressed; it names none, so nothing about the created row is its.
        await client.account.update({
          where: { id: 1 },
          data: {
            logins: {
              upsert: {
                where: { id: 250, account: { is: { status: "archived" } } },
                create: { id: 252, label: "created" },
                update: { label: "must-not-land" },
              },
            },
          },
        });
        expect(
          await client.login.findMany({
            orderBy: { id: "asc" },
            select: { id: true, label: true, accountId: true },
          })
        ).toEqual([
          { id: 250, label: "updated", accountId: 1 },
          { id: 252, label: "created", accountId: 1 },
        ]);
      })
    );
  });
}

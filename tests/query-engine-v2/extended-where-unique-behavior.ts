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
import { UnsupportedOperationError } from "../../src/query-engine-v2/shared";

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
 *  4. a nested create under an extended `where` pins its parent column from the
 *     DISCRIMINATOR only; a column named by the filter half pins nothing and the
 *     pre-existing refusal fires unchanged.
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
  // cannot carry the PK, so upsert's create arm has to CAPTURE the identity the
  // database assigns and address the created row by it. `account`'s
  // caller-supplied `id` addresses the created row directly and never reaches
  // that branch.
  const ticket = s
    .model({
      id: s.int().id().increment(),
      email: s.string().unique(),
      status: s.string(),
      score: s.int(),
    })
    .map("ext_wu_tickets");
  return { account, login, ticket };
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

    // -- 4b. the create arm's terminal read, on a DB-GENERATED primary key ---
    //
    // Every `account` upsert above addresses its created row by the primary key
    // the `create` data carries. `ticket`'s PK is DB-generated, so the create arm
    // has no PK literal to address and must CAPTURE the identity the INSERT
    // produced (`… RETURNING id`, or the driver's insert id) — the same capture
    // `create` itself performs.
    //
    // The `where` is never an option here. Prisma does not require `create` to
    // satisfy `where`, so the two can name different rows, and an extended `where`
    // is what makes that divergence reachable at all: the unique half matched a
    // live row that the filter EXCLUDED, so reading back by it returns a row this
    // upsert never wrote. The four tests below are one witness each — the created
    // row must come back, whatever the `where` says.

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
        // the one asked for — the created row, addressed by the captured
        // identity, is still what comes back.
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
        // The falsification for the four cases above: addressing the created row
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

    test(
      "a filter naming the referenced column pins NOTHING — the refusal stands",
      { timeout: 30_000 },
      run(async (client) => {
        // `id` is fixed by the AND branch, not by the discriminator. If the
        // filter half were allowed to pin, this would silently succeed with a
        // literal parent FK; instead the pre-existing refusal fires unchanged.
        const rejection = await client.account
          .update({
            where: { email: "live@x", AND: [{ id: 1 }] },
            data: { logins: { create: { id: 101, label: "smuggled" } } },
            select: { id: true },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(rejection).toBeInstanceOf(UnsupportedOperationError);
        expect((rejection as Error).message).toContain(
          "requires the referenced parent column 'id' to be pinned by the unique where"
        );
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

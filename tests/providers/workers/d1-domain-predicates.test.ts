/**
 * D1 Driver Tests — domain predicates as the Permissions plan's K1 and K2 make them
 * (plan §4.1, §4.2, §7 "D1" for W-K1a..g and W-K2a..g), on D1 itself, not
 * only through the entry runner:
 *
 * - `domain-predicate-behavior.ts`, the runner SQLite3, PGlite, pg and MySQL2
 *   run: admission, layering and parameters against its hand oracles
 *   (W-K1a..d, W-K1f, W-K1g, W-K2b, W-K2d, W-K2e, W-K2g);
 * - `bound-rows-behavior.ts` and the two unique-key interleavings of
 *   `tests/raptor3/post-prep/row-scopes.test.ts`, with the concurrent write
 *   landed on the D1 binding between two of the operation's statements
 *   (W-K2c, DC10/DC11 under parameters);
 * - one prepared predicate and one statement text for 10,000 actors (W-K2a);
 * - the composed tenancy, soft delete and lock chain's statements equal to
 *   those recorded on D1 before K1/K2 (W-K1e; the golden and its recording
 *   are described beside the test).
 *
 * W-K2f (binds and bytes of §1.1's statements) is `d1-permissions-statement-budget.test.ts`.
 * D1 declares no migration capability: the tables are the SQLite plan's
 * `push` statements, run on the binding.
 */

import { env } from "cloudflare:test";
import { createClient } from "@client/client";
import type { D1Database } from "@cloudflare/workers-types";
import { NotFoundError, UniqueConstraintError } from "@errors";
import { defineExtension } from "@extensions/definition";
import { Queries } from "@query-engine/raptor3/shared/query";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { v } from "@src/validation";
import {
  openBoundRowsFixture,
  runBoundRowsBehavior,
} from "@tests/contracts/engine/query/bound-rows-behavior";
import {
  domainPredicateSchema,
  runDomainPredicateBehavior,
} from "@tests/contracts/engine/query/domain-predicate-behavior";
import { failure } from "@tests/fixtures/failure";
import { afterEach, describe, expect, test, vi } from "vitest";
import golden from "./__golden__/d1-composed-rows-sql.json";
import {
  composedRowsClient,
  composedRowsTranscript,
  unwrapDerivedExists,
} from "./d1-composed-rows";
import { RecordingD1 } from "./d1-statements";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

/** What `push` would create, run on the binding. */
const pushed = async (client: Parameters<typeof createMigrationClient>[0]) => {
  const preview = await createMigrationClient(client).push({ dryRun: true });
  for (const statement of preview.statements)
    await env.DB.prepare(statement.sql).run();
};

const d1 = () => new D1Driver({ database: env.DB });

runDomainPredicateBehavior({ name: "D1", createDriver: d1, prepare: pushed });
runBoundRowsBehavior({ name: "D1", createDriver: d1, prepare: pushed });

const MOVE_TO_GLOBEX = `UPDATE "post" SET "tenantId" = 'globex' WHERE "id" = ?`;
const ON_POST = /"post"/;
const ON_CONFLICT = /ON CONFLICT/i;
const TITLE_UPDATE = /^UPDATE "post" SET "title"/;

describe("D1: unique keys under a bound domain (W-K2c, DC10/DC11)", () => {
  const open: { $disconnect(): Promise<void> }[] = [];
  afterEach(async () => {
    for (const client of open.splice(0)) await client.$disconnect();
  });
  const opened = async () => {
    const recorder = new RecordingD1(env.DB);
    const fixture = await openBoundRowsFixture(
      new D1Driver({ database: recorder.database }),
      pushed
    );
    open.push(fixture.base);
    recorder.statements.length = 0;
    return { ...fixture, recorder };
  };
  const upsert = (id: number, tenant: string) =>
    ({
      where: { id },
      create: { id, title: "new" },
      update: { title: "upserted" },
      tenant,
    }) as const;

  test("a row moved to another tenant after the unlocked probe is not overwritten: the upsert is not found", async () => {
    const { base, db, recorder } = await opened();
    recorder.before(ON_POST, MOVE_TO_GLOBEX, [1], 1);
    expect(await failure(db.post.upsert(upsert(1, "acme")))).toBeInstanceOf(
      NotFoundError
    );
    // The move landed between the operation's statements, not after it.
    expect(recorder.armed).toBe(false);
    const moved = await base.post.findUniqueOrThrow({ where: { id: 1 } });
    expect(moved).toMatchObject({ tenantId: "globex", title: "a" });
  });

  test("the targeted ON CONFLICT fold declines under a bound domain: another tenant's key is refused, never folded", async () => {
    const { base, db, recorder } = await opened();
    const outcome = await failure(
      db.$transaction([db.post.upsert(upsert(3, "acme"))])
    );
    expect(outcome).toBeInstanceOf(UniqueConstraintError);
    expect(recorder.statements.some(({ sql }) => ON_CONFLICT.test(sql))).toBe(
      false
    );
    expect(
      (await base.post.findUniqueOrThrow({ where: { id: 3 } })).title
    ).toBe("c");
    const [own] = await db.$transaction([
      db.post.upsert({ ...upsert(1, "acme"), select: { title: true } }),
    ]);
    expect(own).toEqual({ title: "upserted" });
  });
});

describe("D1: one prepared predicate for every call value (W-K2a)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("10,000 actors: the domain's predicate is prepared once, by identity, and every call emits one statement text", async () => {
    const recorder = new RecordingD1(env.DB);
    const base = createClient({
      schema: domainPredicateSchema(),
      driver: new D1Driver({ database: recorder.database }),
    });
    try {
      await pushed(base);
      await base.account.createMany({ data: [{ id: "u1" }, { id: "u2" }] });
      await base.doc.createMany({
        data: [
          { id: "d1", ownerId: "u1", parentId: null, expiresAt: null },
          { id: "d2", ownerId: "u2", parentId: "d1", expiresAt: null },
        ],
      });
      const userId = { control: "actor", path: "userId" };
      const db = base.$extends(
        defineExtension({
          name: "actor",
          controls: {
            actor: {
              schema: v.object({ userId: v.string() }),
              required: true,
            },
          },
          rows: {
            control: "actorMode",
            default: "on",
            models: {
              doc: {
                on: {
                  root: {
                    OR: [
                      { ownerId: userId },
                      { parent: { is: { ownerId: userId } } },
                    ],
                  },
                },
              },
            },
          },
        })
      );
      const prepare = vi.spyOn(Queries.prototype, "prepareSelector");
      expect(
        await db.doc.findMany({ actor: { userId: "u1" }, select: { id: true } })
      ).toEqual([{ id: "d1" }, { id: "d2" }]);
      expect(prepare.mock.calls).toHaveLength(1);
      prepare.mockClear();
      recorder.statements.length = 0;
      for (let index = 0; index < 10_000; index++) {
        const actor = index === 9999 ? "u2" : `actor-${index}`;
        const found = await db.doc.findMany({
          actor: { userId: actor },
          select: { id: true },
        });
        expect(found).toEqual(index === 9999 ? [{ id: "d2" }] : []);
      }
      expect(prepare).not.toHaveBeenCalled();
      expect(recorder.statements).toHaveLength(10_000);
      expect(new Set(recorder.statements.map(({ sql }) => sql)).size).toBe(1);
    } finally {
      await base.$disconnect();
    }
  }, 300_000);
});

describe("D1: tenancy, soft delete and an optional control: SQL unchanged (W-K1e)", () => {
  test("every statement of 27 calls matches the D1 golden recorded before K1/K2, the driver's derived-table relation filters unwrapped", async () => {
    const recorder = new RecordingD1(env.DB);
    const transcript = await composedRowsTranscript(
      new D1Driver({ database: recorder.database }),
      recorder,
      pushed
    );
    expect(unwrapDerivedExists(transcript)).toEqual(
      unwrapDerivedExists(golden)
    );
  });

  test("a nested update and delete is one atomic unit: when its update's target goes before the write, none of its writes stays", async () => {
    // At 2fcaa26a8 the call is one batch (the golden's "nested update"): the
    // concurrent tombstone lands before it, its assertion fails, and the
    // nested delete rolls back with it. Two batches would commit the delete.
    const recorder = new RecordingD1(env.DB);
    const { base, db } = await composedRowsClient(
      new D1Driver({ database: recorder.database }),
      pushed
    );
    try {
      const T = { tenant: "acme" } as const;
      await db.author.create({ ...T, data: { id: 1, name: "a" } });
      await db.post.createMany({
        ...T,
        data: [
          { id: 10, title: "t", authorId: 1 },
          { id: 13, title: "w", authorId: 1 },
        ],
      });
      recorder.before(
        TITLE_UPDATE,
        `UPDATE "post" SET "deletedAt" = '2026-01-01T00:00:00.000Z' WHERE "id" = ?`,
        [10]
      );
      const refused = await failure(
        db.author.update({
          ...T,
          where: { id: 1 },
          data: {
            posts: {
              update: { where: { id: 10 }, data: { title: "n" } },
              delete: { id: 13 },
            },
          },
        })
      );
      expect(recorder.armed).toBe(false);
      expect(refused).toBeInstanceOf(Error);
      expect(
        await base.post.findMany({
          orderBy: { id: "asc" },
          select: { id: true, title: true, deletedAt: true },
        })
      ).toEqual([
        { id: 10, title: "t", deletedAt: new Date("2026-01-01T00:00:00.000Z") },
        { id: 13, title: "w", deletedAt: null },
      ]);
    } finally {
      await base.$disconnect();
    }
  });
});

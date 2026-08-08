import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { manyToManySchema as schema } from "@tests/fixtures/many-to-many-schema";

/**
 * M9 filtered-M2M-deleteMany staleness gate (§11 M9, §9, §5.5 Rule 3, §1.2 A6).
 *
 * The planned mode materializes the connected-and-matching membership set at
 * plan time (it cannot re-evaluate the filter after the junction rows are gone),
 * so a member CONCURRENTLY added between plan time and execution would otherwise
 * be silently missed. The interpreter closes that window FAIL-CLOSED with two
 * raceable symmetric-difference guards: the added-member guard
 * (`notExists(connected ∧ filter ∧ pk NOT IN pks)`) aborts the atomic unit, its
 * failure is tagged raceable, and the write-race retry (§7.4) re-plans against
 * fresh membership and converges — deleting the newly-added member too.
 *
 * This needs a REAL second connection that commits the concurrent member after
 * the interpreter's plan-time read, so it lives with the Docker-gated driver
 * tests (PGlite is single-connection).
 *
 * A caller wires:
 *  - `createTxDriver` — an interactive-transaction driver (seed / observe / the
 *    concurrent planting connection).
 *  - `createStalePlanBatchDriver` — a batch-forced driver (PlannedMode) that
 *    runs `beforeFirstBatch()` ONCE just before its first atomic batch, and
 *    records the error each atomic batch surfaced. The callback commits the
 *    concurrent member on a SEPARATE tx connection, after the interpreter has
 *    already read committed membership at plan time.
 */

type StalenessClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type StalenessClient = VibORMClient<StalenessClientConfig>;

export interface M2mDeleteManyStalenessBehaviorOptions {
  driverName: string;
  createTxDriver: () => AnyDriver;
  /** A batch-forced driver whose `beforeFirstBatch` fires once before the first
   *  atomic batch and whose `onBatchError` records each atomic batch's error. */
  createStalePlanBatchDriver: (config: {
    beforeFirstBatch: () => Promise<void>;
    onBatchError: (error: unknown) => void;
  }) => AnyDriver;
}

export function runM2mDeleteManyStalenessBehavior({
  driverName,
  createTxDriver,
  createStalePlanBatchDriver,
}: M2mDeleteManyStalenessBehaviorOptions) {
  describe(`${driverName} filtered m2m deleteMany staleness`, () => {
    let clients: StalenessClient[] = [];

    async function reset(): Promise<void> {
      const driver = createTxDriver();
      const client = createClient({ schema, driver });
      clients.push(client);
      // Persistent databases keep tables between runs; drop first so a schema
      // with unique columns re-pushes cleanly.
      for (const table of [
        "m2m_post_tags",
        "m2m_tags",
        "m2m_posts",
        "m2m_categories",
        "m2m_users",
        "m2m_alphas",
        "m2m_betas",
      ]) {
        await driver._executeRaw(`DROP TABLE IF EXISTS ${table}`);
      }
      await push(client, { force: true });
    }

    function boot(driver: AnyDriver): StalenessClient {
      const client = createClient({ schema, driver });
      clients.push(client);
      return client;
    }

    beforeEach(async () => {
      clients = [];
      await reset();
    });

    afterEach(async () => {
      for (const client of clients) {
        await client.$disconnect();
      }
      clients = [];
    });

    test(
      "a member added after the plan-time read aborts the guard, then the retry converges",
      { timeout: 30_000 },
      async () => {
        // Seed: one post connected to one matching tag. The deleteMany filter
        // matches tags whose name starts with "del-".
        const seeder = boot(createTxDriver());
        await seeder.post.create({ data: { id: "p1", title: "Post 1" } });
        await seeder.tag.create({ data: { id: "t-seed", name: "del-seed" } });
        await seeder.post.update({
          where: { id: "p1" },
          data: { tags: { connect: { id: "t-seed" } } },
        });

        // The concurrent planter connects a NEW matching tag to the same post,
        // ON a separate real connection, exactly once — simulating a member
        // added between the interpreter's plan-time membership read and the
        // atomic batch's execution.
        const planter = boot(createTxDriver());
        let planted = false;
        const batchErrors: unknown[] = [];
        const plantConcurrentMember = async (): Promise<void> => {
          if (planted) {
            return;
          }
          planted = true;
          await planter.tag.create({
            data: { id: "t-added", name: "del-added" },
          });
          await planter.post.update({
            where: { id: "p1" },
            data: { tags: { connect: { id: "t-added" } } },
          });
        };

        const client = boot(
          createStalePlanBatchDriver({
            beforeFirstBatch: plantConcurrentMember,
            onBatchError: (error) => batchErrors.push(error),
          })
        );

        // The planned plan reads membership {t-seed} at plan time, then the
        // planter commits t-added. The added-member guard
        // (notExists connected ∧ filter ∧ pk NOT IN {t-seed}) now fails, the
        // atomic unit aborts (raceable), and the retry re-plans against
        // {t-seed, t-added} and converges — both matching members are removed.
        await client.post.update({
          where: { id: "p1" },
          data: { tags: { deleteMany: { name: { startsWith: "del-" } } } },
        });

        // The first atomic batch aborted on the staleness guard (fail-closed,
        // not silently missing the new member).
        expect(batchErrors.length).toBeGreaterThanOrEqual(1);

        // Converged: the post has no matching-tag members left, and both tag
        // rows are deleted (deleteMany removes the child rows).
        const observer = boot(createTxDriver());
        const post = await observer.post.findUnique({
          where: { id: "p1" },
          include: { tags: true },
        });
        expect(post?.tags ?? []).toHaveLength(0);
        const remaining = await observer.tag.findMany({
          where: { name: { startsWith: "del-" } },
        });
        expect(remaining).toHaveLength(0);
      }
    );
  });
}

export const m2mDeleteManyStalenessContract = defineContract({
  id: "drivers.m2m-delete-many-staleness",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runM2mDeleteManyStalenessBehavior,
});

import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { createV2RoutedClient } from "./v2-client-proxy";

/**
 * T3b-2 family C witnesses (TO-ONE.md §7.7) — a m2m junction create/update/upsert
 * target whose data carries its OWN relations folds them one level deeper against the
 * target's literal PK (mechanism 2 create-arm / mechanism 1 update-arm reuse).
 *
 * The conformance census proves state parity for the 10 absorbed keys. These witnesses
 * add the three assertions the census's cross-substrate + golden-state check does not:
 *
 *  1. a live dual-run oracle (V1 vs V2, both substrates) with a native-route assertion —
 *     the deeper junction write is served by V2, not masked by the fallback;
 *  2. a DEEPEST-LEVEL multi-parent correlation witness — two junction targets in ONE
 *     operation each carry a distinct deeper junction write, which must land on the
 *     correct target (the fold correlates to each target's own literal PK);
 *  3. raw junction-row A/B inspection for a deep SELF-referential m2m — the orientation
 *     (source=the located target, target=the connected row) must survive at depth.
 */

const schema = (() => {
  const workspace = s
    .model({
      id: s.int().id(),
      projects: s.manyToMany(() => project),
    })
    .map("njt_workspaces");
  const project = s
    .model({
      id: s.int().id(),
      workspaces: s.manyToMany(() => workspace),
      tags: s.manyToMany(() => tag),
      // Self-referential m2m with explicit A/B columns: junction "njt_related"
      // (fromId, toId). A/B orientation at depth is the correctness question.
      related: s
        .manyToMany(() => project)
        .A("fromId")
        .B("toId"),
      relatedBy: s.manyToMany(() => project),
    })
    .map("njt_projects");
  const tag = s
    .model({
      id: s.int().id(),
      projects: s.manyToMany(() => project),
    })
    .map("njt_tags");
  return { workspace, project, tag };
})();

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

function makeClient(db: PGlite) {
  return createClient({
    schema,
    driver: new PGliteDriver({ client: db }),
  });
}
type AnyClient = ReturnType<typeof makeClient>;

async function seed(client: AnyClient): Promise<void> {
  // Workspace 1 with projects 1 and 2 (members); workspace 2 with project 3.
  await (client as any).workspace.create({
    data: { id: 1, projects: { create: [{ id: 1 }, { id: 2 }] } },
  });
  await (client as any).workspace.create({
    data: { id: 2, projects: { create: [{ id: 3 }] } },
  });
  await (client as any).tag.create({ data: { id: 100 } });
  await (client as any).tag.create({ data: { id: 200 } });
}

async function membershipDump(client: AnyClient) {
  const projects = (await (client as any).project.findMany({
    orderBy: { id: "asc" },
    include: {
      tags: { orderBy: { id: "asc" } },
      related: { orderBy: { id: "asc" } },
    },
  })) as {
    id: number;
    tags?: { id: number }[];
    related?: { id: number }[];
  }[];
  return projects.map((p) => ({
    id: p.id,
    tags: (p.tags ?? []).map((t) => t.id).sort((a, b) => a - b),
    related: (p.related ?? []).map((r) => r.id).sort((a, b) => a - b),
  }));
}

type Arm = "v1" | "v2-tx" | "v2-batch";

async function run(
  arm: Arm,
  act: (client: Record<string, any>) => Promise<unknown>
) {
  const db = new PGlite();
  const client = makeClient(db);
  await push(client as any, { force: true });
  await seed(client);
  let routes: { engine: "v1" | "v2" }[] = [];
  if (arm === "v1") {
    await act(client as unknown as Record<string, any>);
  } else {
    const driver =
      arm === "v2-tx"
        ? new PGliteDriver({ client: db })
        : new BatchOnlyPGliteDriver({ client: db });
    const routed = createV2RoutedClient({
      schema,
      client: client as unknown as Record<string, any>,
      driver,
    });
    routes = routed.routes;
    await act(routed.client);
  }
  const state = await membershipDump(client);
  const related = (
    await db.query(
      'SELECT "fromId", "toId" FROM "project_project" ORDER BY "fromId", "toId"'
    )
  ).rows;
  const routedToV2 =
    routes.length > 0 && routes.every((r) => r.engine === "v2");
  await client.$disconnect();
  return { state, related, routedToV2 };
}

describe("nested junction-target recursion (family C witnesses)", () => {
  // (1) Dual-run oracle + native route: a junction UPDATE target (project 1) carries a
  // deeper m2m connectOrCreate (tags), which V2 folds one level deeper natively.
  const oracleAct = (c: Record<string, any>) =>
    c.workspace.update({
      where: { id: 1 },
      data: {
        projects: {
          update: {
            where: { id: 1 },
            data: {
              tags: {
                connectOrCreate: { where: { id: 100 }, create: { id: 100 } },
              },
            },
          },
        },
      },
    });

  test(
    "deep junction-target relation folds natively and matches V1",
    { timeout: 30_000 },
    async () => {
      const v1 = await run("v1", oracleAct);
      const tx = await run("v2-tx", oracleAct);
      const batch = await run("v2-batch", oracleAct);

      expect(tx.routedToV2).toBe(true);
      expect(batch.routedToV2).toBe(true);
      expect(tx.state).toEqual(v1.state);
      expect(batch.state).toEqual(v1.state);
      // Project 1 gained tag 100; projects 2 and 3 untouched.
      expect(v1.state).toContainEqual({ id: 1, tags: [100], related: [] });
      expect(v1.state).toContainEqual({ id: 2, tags: [], related: [] });
    }
  );

  // (2) Deepest-level multi-parent correlation: ONE operation updates BOTH junction
  // targets (projects 1 and 2), each carrying a DISTINCT deeper junction write. Each
  // must land on its own target — the fold correlates to each target's literal PK.
  const multiParentAct = (c: Record<string, any>) =>
    c.workspace.update({
      where: { id: 1 },
      data: {
        projects: {
          update: [
            { where: { id: 1 }, data: { tags: { connect: { id: 100 } } } },
            { where: { id: 2 }, data: { tags: { connect: { id: 200 } } } },
          ],
        },
      },
    });

  test(
    "two junction targets keep their deeper writes isolated",
    { timeout: 30_000 },
    async () => {
      const v1 = await run("v1", multiParentAct);
      const tx = await run("v2-tx", multiParentAct);
      const batch = await run("v2-batch", multiParentAct);

      expect(tx.routedToV2).toBe(true);
      expect(batch.routedToV2).toBe(true);
      expect(tx.state).toEqual(v1.state);
      expect(batch.state).toEqual(v1.state);
      // No cross-contamination: project 1 has ONLY tag 100, project 2 ONLY tag 200.
      expect(v1.state).toContainEqual({ id: 1, tags: [100], related: [] });
      expect(v1.state).toContainEqual({ id: 2, tags: [200], related: [] });
      expect(v1.state).toContainEqual({ id: 3, tags: [], related: [] });
    }
  );

  // (3) Raw junction A/B orientation at depth: a self-referential m2m connect one level
  // deeper. The junction row must be (fromId = the located target, toId = the connected
  // row) — the located project is the A/source, exactly as at the root.
  const selfRefAct = (c: Record<string, any>) =>
    c.workspace.update({
      where: { id: 1 },
      data: {
        projects: {
          update: {
            where: { id: 1 },
            data: { related: { connect: { id: 2 } } },
          },
        },
      },
    });

  test(
    "deep self-referential m2m keeps A/B orientation (raw junction rows)",
    { timeout: 30_000 },
    async () => {
      const v1 = await run("v1", selfRefAct);
      const tx = await run("v2-tx", selfRefAct);
      const batch = await run("v2-batch", selfRefAct);

      expect(tx.routedToV2).toBe(true);
      expect(batch.routedToV2).toBe(true);
      expect(tx.state).toEqual(v1.state);
      expect(batch.state).toEqual(v1.state);
      // The located target (project 1) is the source; project 2 is the target — never
      // the reverse. Byte-identical raw junction rows across V1 and both V2 substrates.
      expect(v1.related).toEqual([{ fromId: 1, toId: 2 }]);
      expect(tx.related).toEqual(v1.related);
      expect(batch.related).toEqual(v1.related);
    }
  );
});

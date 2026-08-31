import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { s } from "@schema";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import {
  closeTestPGlite,
  openTestPGlite as openBorrowedPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

/**
 * T3b-2 family C witnesses — a m2m junction create/update/upsert
 * target whose data carries its OWN relations folds them one level deeper against the
 * target's literal PK (mechanism 2 create-arm / mechanism 1 update-arm reuse).
 *
 * The conformance census proves state parity for the 10 absorbed keys. These witnesses
 * add the three assertions the census's cross-substrate + golden-state check does not:
 *
 *  1. a live dual-run oracle (Direct vs Observed, both substrates) with a native-route assertion —
 *     the deeper junction write is served by Observed, not masked by the fallback;
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
      projects: s.toMany(() => project),
    })
    .map("njt_workspaces");
  const project = s
    .model({
      id: s.int().id(),
      workspaces: s.toMany(() => workspace),
      tags: s.toMany(() => tag),
      // Self-referential m2m with explicit A/B columns: junction "njt_related"
      // (fromId, toId). A/B orientation at depth is the correctness question.
      related: s
        .toMany(() => project)
        .source("fromId")
        .target("toId"),
      relatedBy: s.toMany(() => project),
    })
    .map("njt_projects");
  const tag = s
    .model({
      id: s.int().id(),
      projects: s.toMany(() => project),
    })
    .map("njt_tags");
  return { workspace, project, tag };
})();

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

type Arm = "direct" | "observed-tx" | "observed-batch";

async function run(
  arm: Arm,
  act: (client: Record<string, any>) => Promise<unknown>
) {
  const db = openBorrowedPGlite();
  const client = makeClient(db);
  await syncLiveSchema(client as any);
  await seed(client);
  let operations: { boundary: "direct" | "production" }[] = [];
  if (arm === "direct") {
    await act(client as unknown as Record<string, any>);
  } else {
    const driver =
      arm === "observed-tx"
        ? new PGliteDriver({ client: db })
        : new BatchOnlyPGliteDriver({ client: db });
    const observed = observeClientOperations({
      schema,
      driver,
    });
    operations = observed.operations;
    await act(observed.client);
  }
  const state = await membershipDump(client);
  const related = (
    await db.query(
      'SELECT "fromId", "toId" FROM "project_project" ORDER BY "fromId", "toId"'
    )
  ).rows;
  const routedToObserved =
    operations.length > 0 &&
    operations.every((r) => r.boundary === "production");
  await client.$disconnect();
  await closeTestPGlite(db);
  return { state, related, routedToObserved };
}

describe("nested junction-target recursion (family C witnesses)", () => {
  // (1) Dual-run oracle + native route: a junction UPDATE target (project 1) carries a
  // deeper m2m connectOrCreate (tags), which Observed folds one level deeper natively.
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
    "deep junction-target relation folds natively and matches Direct",
    { timeout: 30_000 },
    async () => {
      const direct = await run("direct", oracleAct);
      const tx = await run("observed-tx", oracleAct);
      const batch = await run("observed-batch", oracleAct);

      expect(tx.routedToObserved).toBe(true);
      expect(batch.routedToObserved).toBe(true);
      expect(tx.state).toEqual(direct.state);
      expect(batch.state).toEqual(direct.state);
      // Project 1 gained tag 100; projects 2 and 3 untouched.
      expect(direct.state).toContainEqual({ id: 1, tags: [100], related: [] });
      expect(direct.state).toContainEqual({ id: 2, tags: [], related: [] });
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
      const direct = await run("direct", multiParentAct);
      const tx = await run("observed-tx", multiParentAct);
      const batch = await run("observed-batch", multiParentAct);

      expect(tx.routedToObserved).toBe(true);
      expect(batch.routedToObserved).toBe(true);
      expect(tx.state).toEqual(direct.state);
      expect(batch.state).toEqual(direct.state);
      // No cross-contamination: project 1 has ONLY tag 100, project 2 ONLY tag 200.
      expect(direct.state).toContainEqual({ id: 1, tags: [100], related: [] });
      expect(direct.state).toContainEqual({ id: 2, tags: [200], related: [] });
      expect(direct.state).toContainEqual({ id: 3, tags: [], related: [] });
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
      const direct = await run("direct", selfRefAct);
      const tx = await run("observed-tx", selfRefAct);
      const batch = await run("observed-batch", selfRefAct);

      expect(tx.routedToObserved).toBe(true);
      expect(batch.routedToObserved).toBe(true);
      expect(tx.state).toEqual(direct.state);
      expect(batch.state).toEqual(direct.state);
      // The located target (project 1) is the source; project 2 is the target — never
      // the reverse. Byte-identical raw junction rows across Direct and both Observed substrates.
      expect(direct.related).toEqual([{ fromId: 1, toId: 2 }]);
      expect(tx.related).toEqual(direct.related);
      expect(batch.related).toEqual(direct.related);
    }
  );
});

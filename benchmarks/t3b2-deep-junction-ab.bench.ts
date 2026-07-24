/**
 * T3b-2 item 5 — the deep-junction A/B benchmark (families C, TO-ONE.md §7.7.3).
 *
 * A m2m junction UPDATE target whose data carries its OWN m2m relation write, folded
 * one level deeper (`workspace.update({ projects: { update: { data: { tags: { connect }
 * } } } })`). The `queryEngine` escape hatch runs the identical workload through the
 * frozen V1 runtime and the native V2 engine on two seeded in-memory SQLite databases.
 * Ratio = V2 hz / V1 hz (higher = V2 faster). Numbers, not adjectives.
 *
 * Run: pnpm bench -- benchmarks/t3b2-deep-junction-ab.bench.ts
 */
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { push } from "@migrations";
import { s } from "@schema";
import { bench, describe } from "vitest";

const schema = (() => {
  const workspace = s
    .model({ id: s.int().id(), projects: s.manyToMany(() => project) })
    .map("t3b2_workspaces");
  const project = s
    .model({
      id: s.int().id(),
      workspaces: s.manyToMany(() => workspace),
      tags: s.manyToMany(() => tag),
    })
    .map("t3b2_projects");
  const tag = s
    .model({ id: s.int().id(), projects: s.manyToMany(() => project) })
    .map("t3b2_tags");
  return { workspace, project, tag };
})();

const makeClient = async (engine: "v1" | "v2") => {
  const driver = new SQLite3Driver({ dataDir: ":memory:" });
  const client = createClient({ schema, driver, queryEngine: engine });
  await push(client, { force: true });
  // 200 workspaces, each owning one project (member); 200 tags to connect at depth.
  for (let i = 0; i < 200; i += 1) {
    await (client as any).workspace.create({
      data: { id: i, projects: { create: { id: i } } },
    });
    await (client as any).tag.create({ data: { id: 1000 + i } });
  }
  return client;
};

const v1 = await makeClient("v1");
const v2 = await makeClient("v2");
let n = 0;

const op = (i: number) => ({
  where: { id: i },
  data: {
    projects: {
      update: {
        where: { id: i },
        data: { tags: { connect: { id: 1000 + i } } },
      },
    },
  },
});

describe("deep-junction A/B: m2m update target folds a deeper m2m connect", () => {
  bench("v1 workspace.update > projects.update > tags.connect", async () => {
    await (v1 as any).workspace.update(op(n++ % 200));
  });
  bench("v2 workspace.update > projects.update > tags.connect", async () => {
    await (v2 as any).workspace.update(op(n++ % 200));
  });
});

/**
 * T3b-2 item 5 — the deep-junction A/B benchmark (family C).
 *
 * A m2m junction UPDATE target whose data carries its OWN m2m relation write, folded
 * one level deeper (`workspace.update({ projects: { update: { data: { tags: { connect }
 * } } } })`). Single-armed since P6 deleted V1 and the `queryEngine` escape hatch it
 * used to A/B against; the recorded V2/V1 ratio stays in
 * `docs/architecture/engine-unification/PERF.md`.
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

const makeClient = async () => {
  const driver = new SQLite3Driver({ dataDir: ":memory:" });
  const client = createClient({ schema, driver });
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

const client = await makeClient();
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

describe("deep-junction: m2m update target folds a deeper m2m connect", () => {
  bench("workspace.update > projects.update > tags.connect", async () => {
    await (client as any).workspace.update(op(n++ % 200));
  });
});

/**
 * T4c CLASS IV A/B — a legality-gated referenced-key transition upsert (ATOM §8.1
 * T4c). The root update writes a parent PK a child-held (inverse one-to-one)
 * relation references WHILE nesting an upsert on that relation — the shape V1's
 * referential-action legality engine gated and V2 declined to V1 before T4c. T4c
 * absorbed it: `interpretTransitionedChildUpsert` classifies the transition at
 * compile (here a NO-OP `{ increment: 0 }` — before == after — so the ordinary
 * correlated upsert part runs and takes its update branch on the occupied child),
 * proving the legality gate adds no per-call planning read on the accepted path.
 *
 * Single-armed since P6 deleted V1 and the `queryEngine` escape hatch it used to A/B
 * against; the recorded V2/V1 ratio stays in
 * `docs/architecture/engine-unification/PERF.md`.
 *
 * Run: pnpm bench -- benchmarks/t4c-legality-transition-ab.bench.ts
 */
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { push } from "@migrations";
import { s } from "@schema";
import { bench, describe } from "vitest";

const schema = (() => {
  const parent = s
    .model({
      id: s.int().id(),
      name: s.string(),
      child: s.toOne(() => child),
    })
    .map("t4c_parents");
  const child = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int().unique().nullable(),
      parent: s
        .toOne(() => parent)
        .fields("parentId")
        .references("id")
        .onUpdate("setNull"),
    })
    .map("t4c_children");
  return { parent, child };
})();

const COUNT = 200;

const makeClient = async () => {
  const driver = new SQLite3Driver({ dataDir: ":memory:" });
  const client = createClient({ schema, driver });
  await push(client);
  // Each parent owns one child, so the transition upsert takes its update branch.
  for (let i = 0; i < COUNT; i += 1) {
    await (client as any).parent.create({ data: { id: i, name: `p${i}` } });
    await (client as any).child.create({
      data: { id: i, label: "seed", parentId: i },
    });
  }
  return client;
};

const client = await makeClient();
let n = 0;

// A no-op PK transition (`{ increment: 0 }`) beside a child upsert: the legality
// engine classifies before == after and keeps the ordinary correlated upsert part,
// which updates the occupied child. The PK never moves, so the workload is stable.
const op = (i: number) => ({
  where: { id: i },
  data: {
    id: { increment: 0 },
    child: {
      upsert: {
        create: { id: i, label: "created" },
        update: { label: `p${i}-${n}` },
      },
    },
  },
});

describe("CLASS IV: legality-gated referenced-key transition upsert", () => {
  bench("parent.update > id increment 0 + child.upsert", async () => {
    await (client as any).parent.update(op(n++ % COUNT));
  });
});

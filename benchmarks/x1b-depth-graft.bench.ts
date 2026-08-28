/**
 * X1b — the fresh-create-subtree depth curve (absolute; no V1 to A/B against, P6
 * deleted it). A create-context chain grafted under a located `update` target, each
 * fresh child the parent of the next, folded by the create-ROOT machinery
 * (`CreateOperation` `nestedFresh` mode). Benchmarked at increasing depths on one
 * in-memory PGlite; the per-level curve must be LINEAR — each level adds one INSERT
 * step and one FK inline. A superlinear curve would be the conflict signal that depth
 * had become a correlation axis instead of a plain list splice.
 *
 * Run: pnpm bench -- benchmarks/x1b-depth-graft.bench.ts
 */
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { bench, describe } from "vitest";

const schema = (() => {
  const node = s
    .model({
      id: s.string().id(),
      name: s.string(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node),
    })
    .map("x1b_bench_node");
  return { node };
})();

const db = new PGlite();
const client = createClient({
  schema,
  driver: new PGliteDriver({ client: db }),
});
await push(client as never);
await (client as any).node.create({ data: { id: "r0", name: "r0" } });
await (client as any).node.create({
  data: { id: "c1", name: "c1", parentId: "r0" },
});

let seq = 0;

// A create-context chain of `depth` fresh nodes, unique ids per invocation.
function chain(depth: number, run: number, index = 0): Record<string, unknown> {
  const id = `g${run}_${index}`;
  const data: Record<string, unknown> = { id, name: id };
  if (index < depth - 1) {
    data.children = { create: chain(depth, run, index + 1) };
  }
  return data;
}

const graft = async (depth: number) => {
  await (client as any).node.update({
    where: { id: "r0" },
    data: {
      children: {
        update: {
          where: { id: "c1" },
          data: { children: { create: chain(depth, seq++) } },
        },
      },
    },
  });
};

describe("x1b depth graft — create-context chain under a located update target", () => {
  for (const depth of [1, 2, 4, 6, 8]) {
    bench(`d${depth}`, async () => {
      await graft(depth);
    });
  }
});

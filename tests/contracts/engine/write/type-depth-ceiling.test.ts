import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * X1b — the TS ceiling is the COMPILER's, not the boundary's.
 *
 * MEASURED (compat-docs "no boundary depth limit"): TypeScript's type-instantiation
 * depth for a deeply-nested LITERAL create payload is a compiler limit. With a rich
 * per-level payload (each level spelling `children.create` + a parent-held `tag.create`
 * + an M2M `labels.create`), a literal payload type-checks at 30 levels and fails at
 * 32 with TS2321 "Excessive stack depth comparing types" — a ~31-level DX ceiling on
 * the client INPUT inference, far past any hand-written payload. The WORKAROUND is to
 * widen the payload type: build the payload programmatically (as below) so the compiler
 * never infers the deep literal.
 *
 * This test proves the ENGINE folds a create SUBTREE DEEPER than that literal ceiling:
 * a 40-level rich create chain, built programmatically (widened) and grafted under a
 * located `update` target, executes natively on Observed and persists every level. The
 * runtime carries no depth counter; TypeScript's literal-inference cliff is the only
 * limit, and it is the compiler's, not the atom's.
 */

const DEPTH = 40; // > the ~31-level rich-literal TS ceiling.

const schema = (() => {
  const tag = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      nodes: s.oneToMany(() => node),
    })
    .map("x1b_tsc_tag");
  const label = s
    .model({
      id: s.string().id(),
      name: s.string(),
      nodes: s.manyToMany(() => node),
    })
    .map("x1b_tsc_label");
  const node = s
    .model({
      id: s.string().id(),
      name: s.string(),
      parentId: s.string().nullable(),
      parent: s
        .manyToOne(() => node)
        .fields("parentId")
        .references("id")
        .optional(),
      children: s.oneToMany(() => node),
      tagId: s.int().nullable(),
      tag: s
        .manyToOne(() => tag)
        .fields("tagId")
        .references("id")
        .optional(),
      labels: s.manyToMany(() => label),
    })
    .map("x1b_tsc_node");
  return { tag, label, node };
})();

function makeClient(db: PGlite) {
  return createClient({
    schema: schema as never,
    driver: new PGliteDriver({ client: db }),
  });
}
type AnyClient = ReturnType<typeof makeClient>;

// A rich create chain of `depth` fresh nodes, each spelling a parent-held tag create
// and an M2M label create — the same per-level shape the TS-ceiling probe measured,
// but built PROGRAMMATICALLY so its type is the widened relation input, not an inferred
// literal. This is the documented workaround for the compiler ceiling.
function richChain(depth: number, index = 1): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: `n${index}`,
    name: `n${index}`,
    tag: { create: { name: `t${index}` } },
    labels: { create: { id: `l${index}`, name: `l${index}` } },
  };
  if (index < depth) {
    data.children = { create: richChain(depth, index + 1) };
  }
  return data;
}

describe("X1b — the boundary executes beyond the TS literal-inference ceiling", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.node.create({ data: { id: "r0", name: "r0" } });
    await client.node.create({
      data: { id: "c1", name: "c1", parentId: "r0" },
    });
  };

  const op = async (c: Record<string, any>) => {
    await c.node.update({
      where: { id: "r0" },
      data: {
        children: {
          update: {
            where: { id: "c1" },
            // The 40-deep chain is a plain object (widened input type); the compiler
            // never infers this literal, so its ~31-level ceiling does not apply.
            data: { children: { create: richChain(DEPTH) } },
          },
        },
      },
    });
  };

  for (const substrate of ["tx", "batch"] as const) {
    test(`${substrate}: a ${DEPTH}-level rich create chain folds and persists, native Observed`, async () => {
      const db = new PGlite();
      const base = makeClient(db);
      await push(base as never, { force: true });
      await seed(base);
      const driver =
        substrate === "batch"
          ? new BatchOnlyPGliteDriver({ client: db })
          : new PGliteDriver({ client: db });
      const observed = observeClientOperations({
        schema: schema as never,
        driver,
      });
      await op(observed.client);
      expect(new Set(observed.operations.map((r) => r.boundary))).toEqual(
        new Set(["production"])
      );
      const rows = (await (base as any).node.findMany({
        orderBy: { id: "asc" },
      })) as any[];
      // r0, c1, and n1..nDEPTH — every level persisted, each under its ancestor.
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.size).toBe(DEPTH + 2);
      expect(byId.get("n1")?.parentId).toBe("c1");
      for (let i = 2; i <= DEPTH; i += 1) {
        expect(byId.get(`n${i}`)?.parentId).toBe(`n${i - 1}`);
        expect(byId.get(`n${i}`)?.tagId).not.toBeNull();
      }
      await base.$disconnect();
    });
  }
});

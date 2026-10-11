// engine-07: the recursion budget counts path-expanded output rows (10,000 by
// default). Exceeding it is reported with the operation actually called and a
// result-size error, not ValidationError('findMany') for every operation, and
// `recurse.maxOccurrences` raises it for one projection.
import { s } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "engine-07",
  title:
    "Recursion budget overflow names the real operation with a result-size error",
  plan: "track-a/engine-07",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/evidence/engine/probes/f08-recurse-budget.mjs; src/query-engine/raptor3/shared/query.ts:6040-6046",
};

const category = s
  .model({
    id: s.int().id(),
    name: s.string(),
    slug: s.string(),
    description: s.string().nullable(),
    position: s.int().default(0),
    visibility: s.enum(["public", "private", "archived"]).default("public"),
    attributes: s.json().nullable(),
    weight: s.number().default(1),
    featured: s.boolean().default(false),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
    parentId: s.int().nullable(),
    parent: s
      .toOne(() => category)
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => category),
  })
  .map("category");

const CHILDREN = 100;
const GRANDCHILDREN = 120; // 1 + 100 + 12,000 = 12,101 rows, depth 2

export default async function probe() {
  const db = createClient({ schema: { category } });
  try {
    await createMigrationClient(db).push();
    const rows = [{ id: 1, name: "root", slug: "root", parentId: null }];
    let id = 2;
    for (let c = 0; c < CHILDREN; c++) {
      const childId = id++;
      rows.push({
        id: childId,
        name: `c${childId}`,
        slug: `c${childId}`,
        parentId: 1,
      });
      for (let g = 0; g < GRANDCHILDREN; g++)
        rows.push({
          id,
          name: `g${id}`,
          slug: `g${id++}`,
          parentId: childId,
          attributes: { color: "red", tags: ["a", "b"] },
        });
    }
    for (let i = 0; i < rows.length; i += 2000)
      await db.category.createMany({ data: rows.slice(i, i + 2000) });

    let thrown;
    try {
      await db.category.findUnique({
        where: { id: 1 },
        select: { id: true, children: { recurse: true, select: { id: true } } },
      });
    } catch (error) {
      thrown = error;
    }
    if (!thrown)
      return {
        status: "fail",
        evidence: `findUnique recurse over ${rows.length} rows returned without the budget refusal`,
      };
    const message = String(thrown.message);
    const realOperation =
      message.includes("findUnique") && !message.includes("findMany");
    const notValidation =
      thrown.name !== "ValidationError" && thrown.code !== "V4001";

    // Configurability: the same tree under a raised budget comes back whole.
    let raised;
    try {
      const root = await db.category.findUnique({
        where: { id: 1 },
        select: {
          id: true,
          children: {
            recurse: { depth: false, maxOccurrences: rows.length },
            select: { id: true },
          },
        },
      });
      const count = (nodes) =>
        (nodes ?? []).reduce(
          (total, node) => total + 1 + count(node.children),
          0
        );
      raised = count(root?.children);
    } catch (error) {
      raised = `${error?.name} ${error?.code}: ${String(error?.message).slice(0, 120)}`;
    }
    const configurable = raised === rows.length - 1;
    return {
      status: realOperation && notValidation && configurable ? "pass" : "fail",
      evidence: `findUnique recurse over ${rows.length} rows threw ${thrown.name} ${thrown.code}: ${message.slice(0, 220)}; with recurse.maxOccurrences ${rows.length}: ${raised} occurrences`,
    };
  } finally {
    await db.$disconnect();
  }
}

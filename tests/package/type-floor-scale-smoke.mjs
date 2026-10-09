/**
 * The documented TypeScript floor at application scale. A packed-tarball
 * consumer with a SaaS-shaped 100-model schema - org and user hubs every model
 * points at, a ternary ownership tree, a self relation every 7th model and a
 * many-to-many every 5th, about 15 fields each - type-checks a plain
 * three-level include under the floor compiler with no errors. TypeScript 5.8
 * fails this exact query with TS2589 at about 7M instantiations (adversarial
 * review 2026-10-09, types-02), which is why the floor is 5.9.
 */
import { withPackedConsumer } from "./packed-consumer.mjs";

const MODELS = 100;
const parentOf = (i) => (i >= 3 ? 2 + Math.floor((i - 3) / 3) : undefined);
const selfAt = (i) => i >= 7 && i % 7 === 0;
const linkAt = (i) => i >= 5 && i % 5 === 0 && i + 1 < MODELS;

function model(i) {
  const fields = [
    "id: s.string().id().ulid()",
    "name: s.string()",
    "slug: s.string().unique()",
    "title: s.string()",
    "description: s.string().nullable()",
    'status: s.enum(["draft", "published", "archived"]).default("draft")',
    "count: s.int().default(0)",
    "rank: s.int().nullable()",
    "score: s.number().default(0)",
    "active: s.boolean().default(true)",
    "createdAt: s.dateTime().now()",
    "updatedAt: s.dateTime().updatedAt()",
    "meta: s.json().nullable()",
  ];
  if (i >= 2)
    fields.push(
      "orgId: s.string()",
      `org: s.toOne(() => m0).name("org_${i}").fields("orgId").references("id")`,
      "createdById: s.string()",
      `createdBy: s.toOne(() => m1).name("by_${i}").fields("createdById").references("id")`
    );
  const parent = parentOf(i);
  if (parent !== undefined)
    fields.push(
      "parentId: s.string().nullable()",
      `parent: s.toOne(() => m${parent}).name("tree_${i}").fields("parentId").references("id")`
    );
  for (let child = 3; child < MODELS; child++)
    if (parentOf(child) === i)
      fields.push(
        `children${child}: s.toMany(() => m${child}).name("tree_${child}")`
      );
  if (selfAt(i))
    fields.push(
      "selfParentId: s.string().nullable()",
      `selfParent: s.toOne(() => m${i}).name("self_${i}").fields("selfParentId").references("id")`,
      `selfChildren: s.toMany(() => m${i}).name("self_${i}")`
    );
  if (linkAt(i))
    fields.push(`links${i + 1}: s.toMany(() => m${i + 1}).name("mn_${i}")`);
  if (linkAt(i - 1))
    fields.push(
      `linkedBy${i - 1}: s.toMany(() => m${i - 1}).name("mn_${i - 1}")`
    );
  // m0 (org) and m1 (user) are the hubs holding every model's inverse.
  const hub = [
    ["items", "org"],
    ["created", "by"],
  ][i];
  if (hub)
    for (let j = 2; j < MODELS; j++)
      fields.push(
        `${hub[0]}${j}: s.toMany(() => m${j}).name("${hub[1]}_${j}")`
      );
  return `export const m${i} = s.model({\n  ${fields.join(",\n  ")},\n});\n`;
}

const names = Array.from({ length: MODELS }, (_, i) => `m${i}`);

withPackedConsumer(
  "viborm-type-floor-scale",
  {
    "schema.ts": `import { s } from "viborm";\n${names.map((_, i) => model(i)).join("")}export const schema = { ${names.join(", ")} };\n`,
    "client.ts": `import { createClient } from "viborm/sqlite3";
import { schema } from "./schema.ts";
export const orm = createClient({ schema });
`,
    "deep.ts": `import { orm } from "./client.ts";
export async function deep() {
  const rows = await orm.m2.findMany({ include: { children3: { include: { children6: { include: { createdBy: true, org: true } } } } } });
  const leaf = rows[0]!.children3[0]!.children6[0]!;
  const org: string = leaf.org.name;
  const authored: Date = leaf.createdBy.createdAt;
  // @ts-expect-error - the third-level include keeps its exact shape, not any
  void leaf.org.nmae;
  return { org, authored };
}
`,
  },
  ({ typeCheck }) => {
    const started = performance.now();
    typeCheck(["deep.ts"]);
    console.log(
      `100-model three-level include type-checked under the floor in ${Math.round(performance.now() - started)} ms`
    );
  }
);

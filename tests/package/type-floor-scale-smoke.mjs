/**
 * The documented TypeScript floor at application scale, and the type-check
 * budgets held there (decision 16 of the 1.2.0 plan). A packed-tarball
 * consumer with a SaaS-shaped schema of `VIBORM_TYPE_SCALE_MODELS` models
 * (default 100) - org and user hubs every model points at, a ternary ownership
 * tree, a self relation every 7th model and a many-to-many every 5th, about 15
 * fields each - type-checks representative queries under the floor compiler
 * with no errors. TypeScript 5.8 fails the three-level include at 100 models
 * with TS2589 at about 7M instantiations (adversarial review 2026-10-09,
 * types-02), which is why the floor is 5.9.
 *
 * Each query is checked alone with the schema and client (`base` is those two
 * alone), and its `tsc --extendedDiagnostics` instantiation and type counts
 * must stay within `type-budgets.json`: the recorded values plus its headroom.
 * `VIBORM_TYPE_BUDGET_ENTRY` checks one entry instead of all four, which keeps
 * each package case inside its timeout. Every measurement is printed with its
 * check time. To ratchet after making types cheaper, or to re-measure on a new
 * compiler, run this file with `VIBORM_TYPE_BUDGETS_WRITE=1` for each fixture
 * and commit the new values.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot, withPackedConsumer } from "./packed-consumer.mjs";
import { PACKAGE_STAGE_PREFIX } from "./stage-progress.mjs";

const MODELS = Number(process.env.VIBORM_TYPE_SCALE_MODELS ?? 100);
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
const owned =
  'org: { connect: { id: "o" } }, createdBy: { connect: { id: "u" } }';
/** The measured entry files; each imports the client, which imports the schema. */
const entries = {
  base: "client.ts",
  deep: "deep.ts",
  filter: "filter.ts",
  create: "create.ts",
};
const budgetsFile = join(repositoryRoot, "tests/package/type-budgets.json");
const budgets = JSON.parse(readFileSync(budgetsFile, "utf8"));
const compiler = JSON.parse(
  readFileSync(
    join(repositoryRoot, "node_modules/typescript/package.json"),
    "utf8"
  )
).version;
const reported = (output, label) =>
  Number(new RegExp(`^${label}:\\s+([\\d.]+)`, "m").exec(output)?.[1]);

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
    "filter.ts": `import { orm } from "./client.ts";
export async function filter() {
  const rows = await orm.m3.findMany({
    where: { active: true, count: { gt: 5 }, name: { contains: "a" }, org: { is: { active: true } }, children6: { some: { status: "published" } } },
    orderBy: [{ rank: "asc" }, { createdAt: "desc" }],
    take: 10,
    select: { id: true, name: true, createdBy: { select: { name: true } } },
  });
  const author: string = rows[0]!.createdBy.name;
  // @ts-expect-error - a field the select leaves out is not on the row
  void rows[0]!.title;
  return author;
}
`,
    "create.ts": `import { orm } from "./client.ts";
export async function create() {
  const row = await orm.m3.create({
    data: {
      name: "n", slug: "s", title: "t", ${owned},
      children6: { create: [{ name: "c", slug: "c", title: "c", ${owned} }] },
    },
    include: { children6: true },
  });
  const child: string = row.children6[0]!.slug;
  // @ts-expect-error - the nested create's include keeps the child's exact shape
  void row.children6[0]!.slgu;
  return child;
}
`,
  },
  ({ typeCheck }) => {
    const measured = {};
    const exceeded = [];
    const only = process.env.VIBORM_TYPE_BUDGET_ENTRY;
    // An unknown entry name has no file, which the compiler call rejects.
    const checked =
      only === undefined ? Object.entries(entries) : [[only, entries[only]]];
    for (const [entry, file] of checked) {
      const output = typeCheck(["--extendedDiagnostics", file]);
      measured[entry] = {
        instantiations: reported(output, "Instantiations"),
        types: reported(output, "Types"),
      };
      for (const [count, value] of Object.entries(measured[entry])) {
        const recorded = budgets.fixtures[MODELS]?.[entry]?.[count] ?? 0;
        const ceiling = Math.floor(recorded * (1 + budgets.headroom));
        // Negated so an unparsed (NaN) count fails too.
        if (!(value <= ceiling))
          exceeded.push(`${entry} ${count}: ${value} > ${ceiling}`);
      }
      process.stderr.write(
        `${PACKAGE_STAGE_PREFIX}${JSON.stringify({ compiler: `TS${compiler}`, scenario: `type-budget-${MODELS}`, stage: entry, ...measured[entry], checkSeconds: reported(output, "Check time") })}\n`
      );
    }
    if (process.env.VIBORM_TYPE_BUDGETS_WRITE === "1") {
      // Counts from another compiler are dropped, so whatever is not
      // re-measured on this one has no budget and fails until it is.
      if (budgets.typescript !== compiler) budgets.fixtures = {};
      budgets.typescript = compiler;
      budgets.fixtures[MODELS] = { ...budgets.fixtures[MODELS], ...measured };
      writeFileSync(budgetsFile, `${JSON.stringify(budgets, null, 2)}\n`);
    } else if (budgets.typescript !== compiler) {
      throw new Error(
        `Type budgets were recorded on TypeScript ${budgets.typescript} but this is ${compiler}: re-measure every fixture with VIBORM_TYPE_BUDGETS_WRITE=1.`
      );
    } else if (exceeded.length > 0) {
      throw new Error(
        `Type budgets for ${MODELS} models exceeded:\n${exceeded.join("\n")}`
      );
    }
  }
);

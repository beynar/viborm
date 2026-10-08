/** Composite packages/db emission and its downstream user, against a real tarball. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot, withPackedConsumer } from "./packed-consumer.mjs";

const db = `import { createClient, defineExtension, s } from "viborm";
import { SQLite3Driver } from "viborm/sqlite3";
export const user = s.model({ id: s.string().id(), name: s.string(), active: s.boolean() });
export const post = s.model({ id: s.string().id(), title: s.string(), authorId: s.string(), author: s.toOne(() => user).fields("authorId").references("id") });
export const sale = s.model({ id: s.string().id(), region: s.string(), channel: s.string(), amount: s.decimal({ precision: 10, scale: 2 }) });
export const schema = { user, post, sale };
export const db = createClient({ schema, driver: new SQLite3Driver() });
export const extended = db.$extends(defineExtension({ name: "ready", client: () => ({ $ready: () => true }) }));
export const loadPosts = () => db.post.findMany({ include: { author: true } });
export const grouped = () => db.sale.groupBy({ by: ["region", "channel"], _sum: { amount: true } });
`;
const downstream = `import { db, extended, loadPosts, grouped } from "./db.js";
export async function consumer() {
  const posts = await loadPosts();
  const title: string = posts[0]!.title;
  const author: string = posts[0]!.author.name;
  const rows = await grouped();
  const region: string = rows[0]!.region;
  const channel: string = rows[0]!.channel;
  const ready: boolean = extended.$ready();
  // @ts-expect-error - genuine retained types reject the wrong scalar input
  db.user.findUnique({ where: { id: 42 } });
  return { title, author, region, channel, ready };
}
`;

function chainSource(count, ring = false) {
  const models = Array.from({ length: count }, (_, i) => {
    const previous =
      i > 0 || ring
        ? `parentId: s.string(), parent: s.toOne(() => m${(i + count - 1) % count}).fields("parentId").references("id"),`
        : "";
    const next =
      i < count - 1 || ring
        ? `children: s.toMany(() => m${(i + 1) % count}),`
        : "";
    return `export const m${i} = s.model({ id: s.string().id(), active: s.boolean(), rank: s.int(), ${previous} ${next} });`;
  });
  return `import { createClient, s } from "viborm";
import { SQLite3Driver } from "viborm/sqlite3";
${models.join("\n")}
export const schema = { ${models.map((_, i) => `m${i}`).join(", ")} };
export const db = createClient({ schema, driver: new SQLite3Driver() });
export const load = () => db.m0.findUnique({ where: { id: "first" }, include: { children: { where: { active: true }, orderBy: { rank: "asc" }, take: 5 } } });
`;
}
const compilers = [
  ["TS5.8", join(repositoryRoot, "node_modules/typescript-5-8/bin/tsc")],
  ["native", join(repositoryRoot, "node_modules/typescript-native/bin/tsc")],
];

withPackedConsumer(
  "viborm-declaration-consumer",
  { "db.ts": db },
  ({ root }) => {
    for (const [label, compiler] of compilers) {
      const output = join(root, label);
      const project = join(root, `tsconfig-${label}.json`);
      writeFileSync(
        project,
        JSON.stringify({
          compilerOptions: {
            strict: true,
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            declaration: true,
            emitDeclarationOnly: true,
            composite: true,
            skipLibCheck: false,
            outDir: output,
            types: [],
            lib: ["ES2022", "DOM"],
          },
          files: ["./db.ts"],
        })
      );
      try {
        execFileSync(process.execPath, [compiler, "--project", project], {
          cwd: root,
          encoding: "utf8",
          stdio: "pipe",
        });
        const declaration = readFileSync(join(output, "db.d.ts"), "utf8");
        writeFileSync(join(output, "use.ts"), downstream);
        execFileSync(
          process.execPath,
          [
            compiler,
            "--strict",
            "--noEmit",
            "--target",
            "ES2022",
            "--module",
            "ESNext",
            "--moduleResolution",
            "Bundler",
            "--types",
            "node",
            "--typeRoots",
            join(repositoryRoot, "node_modules/@types"),
            join(output, "use.ts"),
          ],
          { cwd: root, encoding: "utf8", stdio: "pipe" }
        );
        console.log(
          `${label}: exported schema/client emitted ${Buffer.byteLength(declaration)} bytes; downstream positive and negative probes passed`
        );
        for (const count of [2, 5, 30]) {
          const file = `chain${count}.ts`;
          writeFileSync(join(root, file), chainSource(count));
          const chainProject = join(
            root,
            `tsconfig-${label}-chain${count}.json`
          );
          const chainOutput = join(root, `${label}-chain${count}`);
          writeFileSync(
            chainProject,
            JSON.stringify({
              compilerOptions: {
                strict: true,
                target: "ES2022",
                module: "ESNext",
                moduleResolution: "Bundler",
                declaration: true,
                emitDeclarationOnly: true,
                composite: true,
                skipLibCheck: false,
                outDir: chainOutput,
                types: [],
                lib: ["ES2022", "DOM"],
              },
              files: [`./${file}`],
            })
          );
          execFileSync(
            process.execPath,
            [compiler, "--project", chainProject],
            { cwd: root, encoding: "utf8", stdio: "pipe" }
          );
          const emitted = readFileSync(
            join(chainOutput, `chain${count}.d.ts`),
            "utf8"
          );
          console.log(
            `${label}: unannotated related chain${count} emitted ${Buffer.byteLength(emitted)} bytes`
          );
        }
        for (const [count, ring] of [
          [100, false],
          [10, true],
        ]) {
          const file = `${ring ? "ring" : "chain"}${count}-query.ts`;
          writeFileSync(join(root, file), chainSource(count, ring));
          execFileSync(
            process.execPath,
            [
              compiler,
              "--strict",
              "--noEmit",
              "--target",
              "ES2022",
              "--module",
              "ESNext",
              "--moduleResolution",
              "Bundler",
              "--types",
              "node",
              "--typeRoots",
              join(repositoryRoot, "node_modules/@types"),
              join(root, file),
            ],
            { cwd: root, encoding: "utf8", stdio: "pipe" }
          );
          console.log(
            `${label}: same-shape ${ring ? "ring" : "chain"}${count} nested public query passed`
          );
        }
      } catch (error) {
        throw new Error(
          `${label} declaration consumer failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`
        );
      }
    }
  }
);

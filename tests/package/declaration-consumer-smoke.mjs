/** Composite packages/db emission and its downstream user, against a real tarball. */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { repositoryRoot, withPackedConsumer } from "./packed-consumer.mjs";

const db = `import { createClient, defineExtension, s } from "viborm";
import { SQLite3Driver } from "viborm/sqlite3";
export const user = s.model({ id: s.string().id(), name: s.string(), active: s.boolean(), posts: s.toMany(() => post) });
export const post = s.model({ id: s.string().id(), title: s.string(), authorId: s.string(), author: s.toOne(() => user).fields("authorId").references("id") });
export const sale = s.model({ id: s.string().id(), region: s.string(), channel: s.string(), amount: s.decimal({ precision: 10, scale: 2 }) });
export const schema = { user, post, sale };
export const db = createClient({ schema, driver: new SQLite3Driver() });
export const extended = db.$extends(defineExtension({ name: "ready", client: () => ({ $ready: () => true }) }));
export const loadPosts = () => db.post.findMany({ include: { author: true } });
export const grouped = () => db.sale.groupBy({ by: ["region", "channel"], _sum: { amount: true } });
`;
const downstream = `import { db, extended, loadPosts, grouped } from "./db.js";
import { sql } from "viborm";
export async function consumer() {
  const posts = await loadPosts();
  const title: string = posts[0]!.title;
  const author: string = posts[0]!.author.name;
  const rows = await grouped();
  const region: string = rows[0]!.region;
  const channel: string = rows[0]!.channel;
  const ready: boolean = extended.$ready();
  // @ts-expect-error - a non-self relation cannot gain recursive eligibility
  void db.post.findMany({ include: { author: { select: { id: true }, recurse: true } } });
  // @ts-expect-error - genuine retained types reject the wrong scalar input
  db.user.findUnique({ where: { id: 42 } });
  void db.user.create({ data: { id: "one", name: "ok", active: true } });
  void db.user.update({ where: { id: "one" }, data: { name: "ok" } });
  void db.user.upsert({ where: { id: "one" }, create: { id: "one", name: "ok", active: true }, update: { name: "ok" } });
  void db.user.createMany({ data: [{ id: "one", name: "ok", active: true }] });
  // @ts-expect-error - fresh root data typo beside real keys is refused
  void db.user.create({ data: { name: "ok", active: true, naame: "wrong" } });
  const heldCreate = { name: "ok", active: true, naame: "wrong" };
  // @ts-expect-error - held root create data is structurally keyed
  void db.user.create({ data: heldCreate });
  // @ts-expect-error - fresh update data typo beside a real key is refused
  void db.user.update({ where: { id: "one" }, data: { name: "ok", naame: "wrong" } });
  const heldUpdate = { name: "ok", naame: "wrong" };
  // @ts-expect-error - held update data is structurally keyed
  void db.user.update({ where: { id: "one" }, data: heldUpdate });
  // @ts-expect-error - fresh upsert create data typo beside real keys is refused
  void db.user.upsert({ where: { id: "one" }, create: { name: "ok", active: true, naame: "wrong" }, update: { name: "ok" } });
  // @ts-expect-error - held upsert update data is structurally keyed
  void db.user.upsert({ where: { id: "one" }, create: { name: "ok", active: true }, update: heldUpdate });
  // @ts-expect-error - fresh createMany member typo beside real keys is refused
  void db.user.createMany({ data: [{ name: "ok", active: true, naame: "wrong" }] });
  // @ts-expect-error - held createMany members are structurally keyed
  void db.user.createMany({ data: [heldCreate] });
  void db.$queryRaw(sql\`SELECT 1\`);
  void db.$executeRaw(sql\`SELECT 1\`);
  // @ts-expect-error - a safe Sql fragment already owns its arguments
  void db.$queryRaw(sql\`SELECT 1\`, "ignored");
  // @ts-expect-error - execute raw preserves the same safe argument contract
  void db.$executeRaw(sql\`SELECT 1\`, "ignored");
  return { title, author, region, channel, ready };
}
`;

const extensionSource = `import { createClient, s } from "viborm";
import { SQLite3Driver } from "viborm/sqlite3";
const model = s.model({ id: s.string().id(), name: s.string() });
const zero = createClient({ schema: { model }, driver: new SQLite3Driver() });
const one = zero.$extends({ name: "chain-1", client() { return { $one: () => 1 }; } });
const two = one.$extends({ name: "chain-2", client(scope) { scope.$one(); return { $two: () => "two" }; } });
const three = two.$extends({ name: "chain-3", client() { return { $three: () => true }; } });
const four = three.$extends({ name: "chain-4", client() { return { $four: () => 4 }; } });
const five = four.$extends({ name: "chain-5", client(scope) { scope.$one(); scope.$four(); return { $five: () => "five" }; } });
const six = five.$extends({ name: "chain-6", client: () => ({ $six: () => 6 }) });
const seven = six.$extends({ name: "chain-7", client: () => ({ $seven: () => 7 }) });
const eight = seven.$extends({ name: "chain-8", client: () => ({ $eight: () => 8 }) });
const nine = eight.$extends({ name: "chain-9", client: () => ({ $nine: () => 9 }) });
export const ten = nine.$extends({ name: "chain-10", client(scope) { scope.$one(); scope.$five(); scope.$nine(); return { $ten: () => 10 }; } });
`;
const extensionConsumer = `import { ten } from "./extends10.js";
const one: number = ten.$one();
const two: string = ten.$two();
const three: boolean = ten.$three();
const four: number = ten.$four();
const five: string = ten.$five();
const six: number = ten.$six();
const seven: number = ten.$seven();
const eight: number = ten.$eight();
const nine: number = ten.$nine();
const last: number = ten.$ten();
// @ts-expect-error - unknown extension methods remain absent after ten layers
void ten.$eleven();
void [one, two, three, four, five, six, seven, eight, nine, last];
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
  ["TS5.9", join(repositoryRoot, "node_modules/typescript/bin/tsc")],
  ["native", join(repositoryRoot, "node_modules/typescript-native/bin/tsc")],
];

const compilerChoice = process.env.VIBORM_DECLARATION_COMPILER;
const caseChoice = process.env.VIBORM_DECLARATION_CASE;
const cases = [
  "db",
  "extends10",
  "chain2",
  "chain5",
  "chain30",
  "chain100",
  "chain200",
  "ring10",
];
if (compilerChoice && !compilers.some(([label]) => label === compilerChoice))
  throw new Error(`Unknown declaration compiler: ${compilerChoice}`);
if (caseChoice && !cases.includes(caseChoice))
  throw new Error(`Unknown declaration case: ${caseChoice}`);
const includesCase = (name) => !caseChoice || caseChoice === name;

withPackedConsumer(
  "viborm-declaration-consumer",
  { "db.ts": db },
  ({ root, run }) => {
    // better-sqlite3 publishes its types through its real DefinitelyTyped peer.
    // Supply the two declared typings a SQLite user installs; no ambient stubs.
    mkdirSync(join(root, "node_modules/@types"), { recursive: true });
    for (const peer of ["better-sqlite3", "node"])
      symlinkSync(
        realpathSync(join(repositoryRoot, "node_modules/@types", peer)),
        join(root, "node_modules/@types", peer),
        "dir"
      );
    if (includesCase("extends10")) {
      writeFileSync(join(root, "extends10.ts"), extensionSource);
      writeFileSync(
        join(root, "runtime-extensions.ts"),
        'import { ten } from "./extends10.ts";\nif (ten.$one() !== 1 || ten.$five() !== "five" || ten.$nine() !== 9 || ten.$ten() !== 10) throw new Error("Extension chain failed");\nconsole.log("ten extensions: pass");\n'
      );
      run("runtime-extensions.ts", "ten extensions");
      writeFileSync(join(root, "use-extensions.ts"), extensionConsumer);
    }
    if (includesCase("db")) {
      // Construction executes the actual L5 topology gate: the required owner
      // has its inverse, rather than an invalid one-sided declaration.
      writeFileSync(
        join(root, "runtime.ts"),
        'import { db } from "./db.ts";\nif (!db.$schema.post) throw new Error("Missing admitted model");\nconsole.log("declaration topology: pass");\n'
      );
      run("runtime.ts", "declaration topology");
      writeFileSync(join(root, "use-source.ts"), downstream);
    }
    for (const [label, compiler] of compilers) {
      if (compilerChoice && compilerChoice !== label) continue;
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
        if (includesCase("extends10")) {
          const extensionProject = join(
            root,
            `tsconfig-${label}-extends10.json`
          );
          const extensionOutput = join(root, `${label}-extends10`);
          const options = JSON.parse(readFileSync(project, "utf8"));
          options.compilerOptions.outDir = extensionOutput;
          options.files = ["./extends10.ts"];
          writeFileSync(extensionProject, JSON.stringify(options));
          const check = (file) =>
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
                file,
              ],
              {
                cwd: root,
                encoding: "utf8",
                stdio: "pipe",
                timeout: 30_000,
                killSignal: "SIGKILL",
              }
            );
          check(join(root, "use-extensions.ts"));
          execFileSync(
            process.execPath,
            [compiler, "--project", extensionProject],
            {
              cwd: root,
              encoding: "utf8",
              stdio: "pipe",
              timeout: 30_000,
              killSignal: "SIGKILL",
            }
          );
          writeFileSync(join(extensionOutput, "use.ts"), extensionConsumer);
          check(join(extensionOutput, "use.ts"));
          console.log(
            `${label}: ten dependent $extends layers source/emission/downstream passed`
          );
        }
        if (includesCase("db")) {
          // Pin source inference separately from the emitted declaration's
          // downstream inference; both must preserve required-owner nullability.
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
              join(root, "use-source.ts"),
            ],
            { cwd: root, encoding: "utf8", stdio: "pipe" }
          );
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
        }
        for (const count of [2, 5, 30]) {
          if (!includesCase(`chain${count}`)) continue;
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
          // The original JS compiler crash began after120–150 FK hops.
          [200, false],
          [10, true],
        ]) {
          if (!includesCase(`${ring ? "ring" : "chain"}${count}`)) continue;
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

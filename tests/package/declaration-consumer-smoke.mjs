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
import {
  backreferenceSource,
  chainSource,
  constructionSource,
  factoryProbe,
  factorySource,
  jsonProbe,
  jsonSource,
  lossyModelsControl,
  modifierProbe,
  modifierSource,
  selfJunctionProbe,
  selfJunctionSource,
  variantProbe,
  variantSource,
} from "./declaration-fixtures.mjs";
import { assertChain5ClientIntegrity } from "./emitted-client-integrity.mjs";
import { repositoryRoot, withPackedConsumer } from "./packed-consumer.mjs";
import { runPackageStage } from "./stage-progress.mjs";

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

const compilers = [
  ["TS5.8", join(repositoryRoot, "node_modules/typescript-5-8/bin/tsc")],
  ["TS5.9", join(repositoryRoot, "node_modules/typescript/bin/tsc")],
  ["native", join(repositoryRoot, "node_modules/typescript-native/bin/tsc")],
];

const TYPESCRIPT_DIAGNOSTIC_CODE = /\bTS(\d+):/g;
const LOSSY_REBUILD_DIAGNOSTICS = new Set([
  2322, 2339, 2344, 2345, 2353, 2578, 18_047, 18_048,
]);
const compilerChoice = process.env.VIBORM_DECLARATION_COMPILER;
const caseChoice = process.env.VIBORM_DECLARATION_CASE;
const declarationFamilies = {
  "core-family": ["db", "extends10", "backreference"],
  "target-family": ["factories", "self-junction", "variants"],
  "modifier-family": ["modifiers", "json"],
};
const composedFixtures = [
  ["factories", factorySource(), factoryProbe()],
  ["self-junction", selfJunctionSource, selfJunctionProbe],
  ["variants", variantSource, variantProbe],
  ["modifiers", modifierSource, modifierProbe],
  ["json", jsonSource, jsonProbe],
];
const cases = [
  "db",
  "extends10",
  "chain2",
  "chain5",
  "backreference",
  "factories",
  "self-junction",
  "variants",
  "modifiers",
  "lossy-models",
  "chain30",
  "chain100",
  "chain200",
  "ring10",
  "json",
  ...Object.keys(declarationFamilies),
];
if (compilerChoice && !compilers.some(([label]) => label === compilerChoice))
  throw new Error(`Unknown declaration compiler: ${compilerChoice}`);
if (caseChoice && !cases.includes(caseChoice))
  throw new Error(`Unknown declaration case: ${caseChoice}`);
const includesCase = (name) => !caseChoice || caseChoice === name;

withPackedConsumer(
  "viborm-declaration-consumer",
  { "db.ts": db },
  ({ root, run: executeRuntime }) => {
    const run = (file, label) =>
      runPackageStage(
        compilerChoice ?? "all",
        caseChoice ?? "all",
        "construction",
        () => executeRuntime(file, label)
      );
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
    const checkFile = (compiler, file) =>
      runPackageStage(
        compilers.find((entry) => entry[1] === compiler)[0],
        caseChoice ?? "all",
        "consumer",
        () =>
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
          )
      );
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
      // Source probes participate in the producer's strict emission program.
      // Their downstream copies are checked separately beside declarations only.
      const emitSource = (projectFile, outDir, producers, probes = []) => {
        const options = JSON.parse(readFileSync(project, "utf8"));
        options.compilerOptions.outDir = outDir;
        if (probes.length > 0) {
          options.compilerOptions.types = ["node"];
          options.compilerOptions.typeRoots = [
            join(repositoryRoot, "node_modules/@types"),
          ];
        }
        options.files = [...producers, ...probes];
        writeFileSync(projectFile, JSON.stringify(options));
        const arguments_ =
          label === "native" || probes.length === 0
            ? [compiler, "--project", projectFile]
            : [
                join(
                  repositoryRoot,
                  "tests/package/check-and-emit-producer.mjs"
                ),
                compiler,
                projectFile,
                ...producers,
              ];
        runPackageStage(label, caseChoice ?? "all", "check-and-emit", () =>
          execFileSync(process.execPath, arguments_, {
            cwd: root,
            encoding: "utf8",
            stdio: "pipe",
            timeout: 30_000,
            killSignal: "SIGKILL",
          })
        );
      };
      try {
        if (Object.hasOwn(declarationFamilies, caseChoice)) {
          const selected = declarationFamilies[caseChoice];
          const definitions = [
            ["db", "db", db, downstream],
            ["extends10", "extends10", extensionSource, extensionConsumer],
            ["backreference", "chain5", chainSource(5), backreferenceSource()],
            ...composedFixtures.map(([name, source, probe]) => [
              name,
              name,
              source,
              probe,
            ]),
          ].filter(([scenario]) => selected.includes(scenario));
          if (definitions.length !== selected.length)
            throw new Error("Declaration family is missing a scenario");
          const producers = [];
          const probes = [];
          const consumerFiles = [];
          const familyOutput = join(root, `${label}-${caseChoice}`);
          for (const [scenario, name, source, probe] of definitions) {
            const directory = join(root, caseChoice, scenario);
            mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, `${name}.ts`), source);
            writeFileSync(join(directory, "source-probe.ts"), probe);
            producers.push(`./${caseChoice}/${scenario}/${name}.ts`);
            probes.push(`./${caseChoice}/${scenario}/source-probe.ts`);
            if (
              ["factories", "self-junction", "variants", "modifiers"].includes(
                scenario
              )
            ) {
              writeFileSync(
                join(directory, "runtime.ts"),
                constructionSource(scenario)
              );
              run(
                `${caseChoice}/${scenario}/runtime.ts`,
                `${scenario} topology`
              );
            } else if (scenario === "db") {
              writeFileSync(
                join(directory, "runtime.ts"),
                'import { db } from "./db.ts";\nif (!db.$schema.post) throw new Error("Missing admitted model");\nconsole.log("declaration topology: pass");\n'
              );
              run(
                `${caseChoice}/${scenario}/runtime.ts`,
                "declaration topology"
              );
            } else if (scenario === "extends10") {
              writeFileSync(
                join(directory, "runtime.ts"),
                'import { ten } from "./extends10.ts";\nif (ten.$one() !== 1 || ten.$five() !== "five" || ten.$nine() !== 9 || ten.$ten() !== 10) throw new Error("Extension chain failed");\nconsole.log("ten extensions: pass");\n'
              );
              run(`${caseChoice}/${scenario}/runtime.ts`, "ten extensions");
            }
          }
          const familyProject = join(
            root,
            `tsconfig-${label}-${caseChoice}.json`
          );
          emitSource(familyProject, familyOutput, producers, probes);
          for (const [scenario, name, _source, probe] of definitions) {
            const directory = join(familyOutput, caseChoice, scenario);
            const declaration = readFileSync(
              join(directory, `${name}.d.ts`),
              "utf8"
            );
            if (!declaration)
              throw new Error("Producer did not emit a declaration");
            if (scenario === "backreference" || scenario === "factories")
              assertChain5ClientIntegrity(declaration);
            const consumer = join(directory, "consumer.ts");
            writeFileSync(consumer, probe);
            consumerFiles.push(consumer);
          }
          const consumerProject = join(
            root,
            `tsconfig-${label}-${caseChoice}-consumer.json`
          );
          writeFileSync(
            consumerProject,
            JSON.stringify({
              compilerOptions: {
                strict: true,
                noEmit: true,
                skipLibCheck: false,
                target: "ES2022",
                module: "ESNext",
                moduleResolution: "Bundler",
                types: ["node"],
                typeRoots: [join(repositoryRoot, "node_modules/@types")],
              },
              files: consumerFiles,
            })
          );
          runPackageStage(label, caseChoice, "consumer", () =>
            execFileSync(
              process.execPath,
              [compiler, "--project", consumerProject],
              {
                cwd: root,
                encoding: "utf8",
                stdio: "pipe",
                timeout: 30_000,
                killSignal: "SIGKILL",
              }
            )
          );
          console.log(
            `${label}: ${selected.join(", ")} construction/source/emission/declaration-only probes passed`
          );
          continue;
        }
        if (includesCase("extends10")) {
          const extensionProject = join(
            root,
            `tsconfig-${label}-extends10.json`
          );
          const extensionOutput = join(root, `${label}-extends10`);
          emitSource(
            extensionProject,
            extensionOutput,
            ["./extends10.ts"],
            ["./use-extensions.ts"]
          );
          writeFileSync(join(extensionOutput, "use.ts"), extensionConsumer);
          checkFile(compiler, join(extensionOutput, "use.ts"));
          console.log(
            `${label}: ten dependent $extends layers source/emission/downstream passed`
          );
        }
        if (includesCase("db")) {
          // Share source checking and producer emission; the declaration-only
          // consumer below remains a separate program and trust boundary.
          emitSource(project, output, ["./db.ts"], ["./use-source.ts"]);
          const declaration = readFileSync(join(output, "db.d.ts"), "utf8");
          writeFileSync(join(output, "use.ts"), downstream);
          checkFile(compiler, join(output, "use.ts"));
          console.log(
            `${label}: exported schema/client emitted ${Buffer.byteLength(declaration)} bytes; downstream positive and negative probes passed`
          );
        }
        for (const count of [2, 5, 30]) {
          if (
            !(
              includesCase(`chain${count}`) ||
              (count === 5 &&
                (includesCase("backreference") || includesCase("lossy-models")))
            )
          )
            continue;
          const file = `chain${count}.ts`;
          writeFileSync(join(root, file), chainSource(count));
          const chainProject = join(
            root,
            `tsconfig-${label}-chain${count}.json`
          );
          const chainOutput = join(root, `${label}-chain${count}`);
          const probes = [];
          if (
            count === 5 &&
            (includesCase("backreference") || includesCase("lossy-models"))
          ) {
            writeFileSync(
              join(root, "backreference.ts"),
              backreferenceSource()
            );
            probes.push("./backreference.ts");
            if (includesCase("lossy-models")) {
              writeFileSync(join(root, "lossy-control.ts"), lossyModelsControl);
              probes.push("./lossy-control.ts");
            }
          }
          emitSource(chainProject, chainOutput, [`./${file}`], probes);
          const emitted = readFileSync(
            join(chainOutput, `chain${count}.d.ts`),
            "utf8"
          );
          if (
            count === 5 &&
            (includesCase("backreference") || includesCase("lossy-models"))
          ) {
            assertChain5ClientIntegrity(emitted);
            const backreference = backreferenceSource();
            const emittedProbe = join(chainOutput, "backreference.ts");
            writeFileSync(emittedProbe, backreference);
            checkFile(compiler, emittedProbe);
            console.log(
              `${label}: source and emitted backreference domains passed`
            );
          }
          console.log(
            `${label}: unannotated related chain${count} emitted ${Buffer.byteLength(emitted)} bytes`
          );
        }
        for (const [fixture, source, probe] of composedFixtures) {
          if (!includesCase(fixture)) continue;
          writeFileSync(join(root, `${fixture}.ts`), source);
          const sourceProbe = join(root, `${fixture}-probe.ts`);
          writeFileSync(sourceProbe, probe);
          // Construction invokes the actual topology owner without database I/O.
          if (fixture !== "json")
            writeFileSync(
              join(root, `${fixture}-runtime.ts`),
              constructionSource(fixture)
            );
          if (fixture !== "json")
            run(`${fixture}-runtime.ts`, `${fixture} topology`);
          const fixtureOutput = join(root, `${label}-${fixture}`);
          const fixtureProject = join(
            root,
            `tsconfig-${label}-${fixture}.json`
          );
          emitSource(
            fixtureProject,
            fixtureOutput,
            [`./${fixture}.ts`],
            [`./${fixture}-probe.ts`]
          );
          const consumerProbe = join(fixtureOutput, "consumer.ts");
          writeFileSync(consumerProbe, probe);
          checkFile(compiler, consumerProbe);
          console.log(
            `${label}: ${fixture} source/emission/declaration-only consumer passed`
          );
        }
        if (includesCase("lossy-models")) {
          const emittedControl = join(
            root,
            `${label}-chain5`,
            "lossy-control.ts"
          );
          writeFileSync(emittedControl, lossyModelsControl);
          let rejected = false;
          try {
            checkFile(compiler, emittedControl);
          } catch (error) {
            const codes = [
              ...(error.stdout ?? "").matchAll(TYPESCRIPT_DIAGNOSTIC_CODE),
            ].map((match) => Number(match[1]));
            if (
              error.status !== (label === "native" ? 1 : 2) ||
              codes.length === 0 ||
              codes.some((code) => !LOSSY_REBUILD_DIAGNOSTICS.has(code))
            )
              throw error;
            rejected = true;
          }
          if (!rejected)
            throw new Error(
              "Lossy emitted-model rebuild control no longer reproduces; reassess its documented limitation"
            );
          console.log(
            `${label}: source-valid emitted-model rebuild control retains the explicit limitation`
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
          runPackageStage(label, caseChoice ?? "all", "query", () =>
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
            )
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

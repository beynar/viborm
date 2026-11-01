/**
 * Soft delete alone and the permissions guide's composition (§11) from the packed
 * tarball, at application scale (60 models), on every TypeScript a consumer
 * uses, in one packed consumer. Each
 * program is a generated schema of `models` models (a `user` with one to-many
 * relation per other model; every other model owned by a user and
 * soft-deletable), then:
 *
 *   soft   `softDelete(config)(base)` and `base.$extends(softDelete(config))`
 *   chain     `base.$extends(tombstones).$extends(policy)`, the guide's
 *             composition (each official extension one step, any order)
 *   reversed  `base.$extends(policy).$extends(tombstones)`
 *
 * and reads through the result: a relation the rows can hide reads `| null`,
 * `restore` narrows to its `select`, `$as`, `can` and `$access` keep each
 * model's actions, and each `@ts-expect-error` must bite (a client that
 * collapsed to `any` leaves them unused, an error).
 *
 * RBAC 9c50a3191 typed the factory and its steps from the steps' inferred
 * return types, which each declaration inlined (every copy of the rows
 * definition a distinct type, compared member by member), and `$extends(step)`
 * fell back to the step's generic constraint for C, then compared the whole
 * receiving client with that generic client. Every program raised TS2589 on
 * every checker. TS 5.9 instantiations (`before` in the budgets file has all
 * three checkers; 1.2.4 is `git archive 2fcaa26a8`, which has no rbac and no
 * `$extends(factory)`, so its soft program omits that line):
 *
 *   program    1.2.4       9c50a3191              fixed
 *   soft-30    1,273,742   11,086,159 TS2589      221,049
 *   soft-60    2,234,702   12,538,577 TS2589      553,959
 *   chain-30   -            7,420,474 TS2589    1,117,944
 *   chain-60   -            8,719,264 TS2589    1,784,304
 *
 * Most of a chain's figure is paid once per program: `$extends(step)` infers
 * between two client types, which measures the client alias's variance
 * (about 650k at any schema size). The whole factories keep `NoInfer` on
 * their result, which skips that inference; a step does not, so a step
 * written over `VibORMClient<C, X>` still infers C and X from its result.
 *
 * `VIBORM_COMPOSITION_CHECKERS` picks the checkers (comma separated; default
 * `tsc5,tsc6,tsc7`). Every program must report no diagnostic, and each
 * TypeScript's instantiations must stay within `type-composition-budgets.json`
 * (the recorded value plus its headroom, on that exact compiler version). To
 * re-measure, run with `VIBORM_TYPE_BUDGETS_WRITE=1` and commit the values.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPackedConsumer,
  packedArchive,
  repositoryRoot,
} from "./packed-consumer.mjs";
import { PACKAGE_STAGE_PREFIX } from "./stage-progress.mjs";

const compilers = {
  tsc5: { name: "typescript", entry: "lib/tsc.js", flags: [] },
  tsc6: { name: "typescript-6", entry: "lib/tsc.js", flags: [] },
  // Single-threaded: parallel checkers each instantiate what they meet.
  tsc7: {
    name: "typescript-native",
    entry: "bin/tsc",
    flags: ["--singleThreaded"],
  },
};
const OUTPUT_BYTES = 64 * 1024 * 1024;
const budgetsFile = join(
  repositoryRoot,
  "tests/package/type-composition-budgets.json"
);
const budgets = JSON.parse(readFileSync(budgetsFile, "utf8"));
const checkers = (
  process.env.VIBORM_COMPOSITION_CHECKERS ?? "tsc5,tsc6,tsc7"
).split(",");
const diagnostic = /error TS\d+/;
const reported = (output, label) =>
  Number(new RegExp(`^${label}:\\s+([\\d.]+)`, "m").exec(output)?.[1]);

const compilerOptions = {
  strict: true,
  target: "ES2022",
  module: "ESNext",
  moduleResolution: "bundler",
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  noEmit: true,
  noUnusedLocals: true,
  types: [],
};

/** `user` and `models - 1` soft-deletable models it owns, and the client. */
function schemaSource(models) {
  const names = Array.from({ length: models - 1 }, (_, i) => `m${i}`);
  const model = (name) =>
    `const ${name} = s.model({ id: s.string().id(), title: s.string(), ownerId: s.string(), deletedAt: s.dateTime().nullable(), owner: s.toOne(() => user).fields("ownerId").references("id") });`;
  return `import { s } from "viborm";
import { createClient } from "viborm/sqlite3";
import { softDelete } from "viborm/soft-delete";

const user = s.model({ id: s.string().id(), name: s.string(), ${names.map((name) => `${name}s: s.toMany(() => ${name})`).join(", ")} });
${names.map(model).join("\n")}
export const base = createClient({ schema: { user, ${names.join(", ")} }, dataDir: ":memory:" });
export const tombstones = softDelete({ models: { ${names.map((name) => `${name}: { deletedAt: "deletedAt" }`).join(", ")} } });
`;
}

const softSource = (
  models
) => `import { base, tombstones } from "./schema-${models}";

export const db = tombstones(base);
export const viaExtends: typeof db = base.$extends(tombstones);

export async function reads() {
  const [row] = await db.m0.findMany({ include: { owner: true } });
  const owner: { id: string; name: string } | null = row!.owner;
  const at: Date | null = row!.deletedAt;
  const restored = await db.m${models - 2}.restore({ where: { id: "x" }, select: { id: true } });
  const id: string = restored.id;
  // @ts-expect-error - restore narrows to its select
  restored.title;
  // @ts-expect-error - restore writes its own data
  await db.m1.restore({ where: { id: "x" }, data: {} });
  // @ts-expect-error - "bogus" is not a mode
  await db.m1.findMany({ deleted: "bogus" });
  // @ts-expect-error - restore exists only on configured models
  await db.user.restore({ where: { id: "u" } });
  await db.m2.delete({ where: { id: "x" }, mode: "hard" });
  return [owner, at, id];
}
`;

const chainSource = (
  models,
  order
) => `import { permissions } from "viborm/permissions";
import { v } from "viborm/validation";
import { base, tombstones } from "./schema-${models}";

const own = { ownerId: { actor: "userId" } } as const;
const policy = permissions({
  actor: v.object({ userId: v.string() }),
  models: {
    user: { read: {} },
    ${Array.from({ length: models - 1 }, (_, i) => `m${i}: { read: own, update: own, delete: own }`).join(",\n    ")},
  },
});

export const db = ${order === "soft-first" ? "base.$extends(tombstones).$extends(policy)" : "base.$extends(policy).$extends(tombstones)"};

export async function reads() {
  const call = db.$as({ userId: "u" });
  const same: typeof db = call;
  const may: Promise<boolean> = call.m0.can("delete", { id: "x" });
  // @ts-expect-error - "publish" is not an action of m0
  call.m0.can("publish", { id: "x" });
  // @ts-expect-error - the actor schema is checked
  db.$as({ user: "u" });
  const [row] = await call.m0.findMany({ include: { owner: true }, deleted: "with" });
  const owner: { id: string; name: string } | null = row!.owner;
  const restored = await call.m${models - 2}.restore({ where: { id: "x" }, select: { id: true } });
  const id: string = restored.id;
  const purged = await call.m3.purge({ where: { id: "x" }, include: { owner: true } });
  const purgedOwner: { id: string; name: string } | null = purged.owner;
  // @ts-expect-error - the policy can hide the owner: restore's relation reads null too
  const notNull: { id: string; name: string } = (await call.m4.restore({ where: { id: "x" }, include: { owner: true } })).owner;
  // @ts-expect-error - "bogus" is not a mode
  await call.m1.findMany({ deleted: "bogus" });
  const [held] = await call.m2.findMany({ select: { id: true, $access: true } });
  const deletable: boolean = held!.$access.delete;
  return [same, may, owner, id, deletable, purgedOwner, notNull];
}
`;

// 60 models only: the regression appeared from 10 to 25 models on every
// checker, so 60 catches it with room to spare, and the package job keeps
// its wall budget (one packed consumer, three programs per checker).
const programs = [60].flatMap((models) => [
  { name: `soft-${models}`, models, source: softSource(models) },
  {
    name: `chain-${models}`,
    models,
    source: chainSource(models, "soft-first"),
  },
  {
    name: `reversed-${models}`,
    models,
    source: chainSource(models, "policy-first"),
  },
]);

function check(checker, project) {
  const started = performance.now();
  const compiler = compilers[checker];
  if (compiler === undefined) throw new Error(`Unknown checker ${checker}`);
  const root = join(repositoryRoot, "node_modules", compiler.name);
  const { version } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8")
  );
  const result = spawnSync(
    process.execPath,
    [
      join(root, compiler.entry),
      "-p",
      project,
      "--extendedDiagnostics",
      "--pretty",
      "false",
      ...compiler.flags,
    ],
    { encoding: "utf8", maxBuffer: OUTPUT_BYTES }
  );
  const output = `${result.stdout}${result.stderr}`;
  return {
    version,
    status: result.status,
    signal: result.signal,
    output,
    instantiations: reported(output, "Instantiations"),
    memoryKB: reported(output, "Memory used"),
    checkSeconds: reported(output, "Check time"),
    wallSeconds: (performance.now() - started) / 1000,
  };
}

const fixtureRoot = mkdtempSync(join(tmpdir(), "viborm-composition-types-"));
const failures = [];
try {
  const consumerRoot = join(fixtureRoot, "consumer");
  createPackedConsumer(
    consumerRoot,
    packedArchive(fixtureRoot),
    "viborm-composition-types"
  );
  const source = join(consumerRoot, "src");
  mkdirSync(source, { recursive: true });
  for (const models of new Set(programs.map((program) => program.models))) {
    writeFileSync(join(source, `schema-${models}.ts`), schemaSource(models));
  }
  for (const program of programs) {
    writeFileSync(join(source, `${program.name}.ts`), program.source);
    writeFileSync(
      join(consumerRoot, `tsconfig.${program.name}.json`),
      JSON.stringify({ compilerOptions, files: [`src/${program.name}.ts`] })
    );
  }

  for (const checker of checkers) {
    for (const program of programs) {
      const { output, status, signal, version, ...measured } = check(
        checker,
        join(consumerRoot, `tsconfig.${program.name}.json`)
      );
      process.stderr.write(
        `${PACKAGE_STAGE_PREFIX}${JSON.stringify({ scenario: "type-composition", stage: `${checker}:${program.name}`, ...measured })}\n`
      );
      const label = `${checker} ${program.name}`;
      // Every checker exits non-zero on a diagnostic, and on a crash.
      if (status !== 0) {
        const errors = output
          .split("\n")
          .filter((line) => diagnostic.test(line));
        failures.push(
          `${label} reports ${errors.length} diagnostic(s), exit ${status ?? signal}:\n${(errors.length > 0 ? errors : [output.slice(-2000)]).join("\n")}`
        );
      }
      if (process.env.VIBORM_TYPE_BUDGETS_WRITE === "1") {
        budgets.programs[program.name][checker] = {
          typescript: version,
          instantiations: measured.instantiations,
        };
        continue;
      }
      const recorded = budgets.programs[program.name]?.[checker];
      if (recorded?.typescript !== version) {
        failures.push(
          `${label} budget was recorded on TypeScript ${recorded?.typescript} but this is ${version}: re-measure with VIBORM_TYPE_BUDGETS_WRITE=1.`
        );
        continue;
      }
      const ceiling = Math.floor(
        recorded.instantiations * (1 + budgets.headroom)
      );
      // Negated so an unparsed (NaN) count fails too.
      if (!(measured.instantiations <= ceiling)) {
        failures.push(
          `${label} instantiations ${measured.instantiations} > ${ceiling}`
        );
      }
    }
  }
  if (process.env.VIBORM_TYPE_BUDGETS_WRITE === "1") {
    writeFileSync(budgetsFile, `${JSON.stringify(budgets, null, 2)}\n`);
  }
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}
if (failures.length > 0) {
  throw new Error(
    `Soft delete and the guide's composition fail their type contract:\n${failures.join("\n")}`
  );
}

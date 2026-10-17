/**
 * The RBAC acceptance policy (plan §1.1 `policy.ts`) from the packed tarball,
 * on every checker a consumer uses: a consumer with the rbac-app schema
 * (`fixtures/rbac-app/schema`) writes the whole policy, its stored-role
 * variant and the blog with explicit RBAC predicates, and compiles each against
 * the schema (`policy.compile(schema)`, which checks the model and field names
 * the policy spells), and applies the policy to a client: `db.$as(actor)` is
 * the governed client again, `can` and `assert` take each listed model's own
 * actions (one or a list), `$access` and a read-gated field type the result
 * at every depth, and a wrong action, domain or key name is an error (an
 * unused `@ts-expect-error` fails the check). Predicates are opaque data: no model's `where` type is
 * walked over a policy, so a policy costs about what its literal does (plan
 * §11.2 F8: ~740 instantiations per model).
 *
 * `VIBORM_RBAC_CHECKERS` picks the checkers (comma separated; default
 * `tsc5,tsc6,tsc7`), as `type-recursive-where-smoke.mjs` does: the
 * repository's `typescript` (5.9.3), `typescript-6` and `typescript-native`
 * (7.0.2, single-threaded) packages, and `bun` for `bun check`. Every checker
 * must report no diagnostic, and each TypeScript's instantiations must stay
 * within `type-rbac-budgets.json`, recorded on that exact compiler version.
 * To re-measure, run with `VIBORM_TYPE_BUDGETS_WRITE=1` and commit the values.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
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
  tsc7: {
    name: "typescript-native",
    entry: "bin/tsc",
    flags: ["--singleThreaded"],
  },
};
const BUN_FLOOR = [1, 4, 3];
const OUTPUT_BYTES = 64 * 1024 * 1024;
const budgetsFile = join(
  repositoryRoot,
  "tests/package/type-rbac-budgets.json"
);
const budgets = JSON.parse(readFileSync(budgetsFile, "utf8"));
const checkers = (process.env.VIBORM_RBAC_CHECKERS ?? "tsc5,tsc6,tsc7").split(
  ","
);
const diagnostic = /error TS\d+/;
const reported = (output, label) =>
  Number(new RegExp(`^${label}:\\s+([\\d.]+)`, "m").exec(output)?.[1]);

const tsconfig = {
  compilerOptions: {
    strict: true,
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    noEmit: true,
    noUnusedLocals: true,
    types: [],
  },
  include: ["src"],
};

/** The repository's policy, with its imports as a consumer spells them. */
const policySource = readFileSync(
  join(repositoryRoot, "tests/types/rbac/acceptance-policy.ts"),
  "utf8"
)
  .replace('from "@src/rbac"', 'from "viborm/rbac"')
  .replace('from "@src/validation"', 'from "viborm/validation"');
if (/from "@/.test(policySource))
  throw new Error("acceptance-policy.ts imports a repository alias");
const compileSource = `import { schema } from "./schema";
import { blog, policy, storedPolicy } from "./policy";

export const compiled = [
  policy.compile(schema),
  storedPolicy.compile(schema),
  blog.compile(schema),
];
`;
/**
 * The entry on a client: `$as` is the governed client again (a key actor
 * too, its restrictions judged in the statement); can and assert take each model's
 * own actions, one or a list; `$access` is a projection key at every depth,
 * typed as a boolean map of each model's actions; a read-gated field is absent
 * from a default row and present where
 * selected; `as` takes the policy's actions and domains. Each wrong name is
 * an `@ts-expect-error` that must bite.
 */
const clientSource = `import { createClient } from "viborm/pg";
import { schema } from "./schema";
import { policy } from "./policy";

const base = createClient({ schema, databaseUrl: "postgresql://localhost/rbac" });
const db = base.$extends(policy);
const call = db.$as({ userId: "user-01", organizationId: "org-1", network: "office" });
export const same: typeof db = call;
export const keyed: typeof db = db.$as({
  userId: "user-02",
  organizationId: "org-1",
  network: "office",
  key: { id: "key-02-a", scopes: { page: ["read"] }, resources: { document: ["d1"] } },
});
export const answers: [Promise<boolean>, Promise<void>, Promise<boolean>] = [
  call.team.can("invite", { id: "t1" }),
  call.organization.assert("export", { id: "org-1" }),
  call.document.can("archive", { id: "d1" }),
];
// @ts-expect-error - a filter is not the unique selector can takes
export const filtered = call.document.can("archive", { parentId: null });
export const listed: Promise<{ readonly comment: boolean; readonly share: boolean }> =
  call.document.can(["comment", "share"], { id: "d1" });
export const all: Promise<void> = call.page.assert(["read", "update"], { id: "p1" });
// @ts-expect-error - "export" is not an action of team
export const wrong = call.team.can("export", { id: "t1" });
// @ts-expect-error - "archive" is document's, not page's
export const wrongList = call.page.can(["read", "archive"], { id: "p1" });

export async function reads() {
  const documents = await call.document.findMany({
    where: { parentId: null },
    include: { $access: true, children: { include: { $access: ["share"] } } },
  });
  const held: { readonly read: boolean; readonly export: boolean } = documents[0]!.$access;
  const shared: { readonly share: boolean } = documents[0]!.children[0]!.$access;
  const pages = await call.page.findMany({ include: { $access: true, group: true } });
  const level: { readonly read: boolean; readonly update: boolean; readonly full: boolean; readonly create: boolean } = pages[0]!.$access;
  const given = await call.page.findMany({ as: "given" });
  const [row] = await call.collection.findMany();
  const absent: number | undefined = row!.budget;
  const [named] = await call.collection.findMany({ select: { id: true, budget: true } });
  const present: number = named!.budget;
  // @ts-expect-error - "nope" is no action or domain of any model
  await call.page.findMany({ as: "nope" });
  // @ts-expect-error - "archive" is not one of page's names
  await call.page.findMany({ select: { id: true, $access: ["archive"] } });
  // @ts-expect-error - the actor is never an argument
  await call.page.findMany({ actor: { userId: "u" } });
  return [held, shared, level, given, absent, present];
}
`;

function check(checker, consumerRoot) {
  const started = performance.now();
  if (checker === "bun") {
    const bun = process.env.BUN ?? "bun";
    const version = spawnSync(bun, ["--version"], { encoding: "utf8" });
    const found = (version.stdout ?? "").trim();
    const rank = (parts) =>
      parts.reduce((total, part) => total * 1000 + Number(part), 0);
    if (version.status !== 0 || !(rank(found.split(".")) >= rank(BUN_FLOOR)))
      throw new Error(
        `bun check needs Bun >= ${BUN_FLOOR.join(".")} on PATH (found ${found || "none"})`
      );
    const result = spawnSync(
      bun,
      ["check", "--no-pretty", "--all", "-p", consumerRoot],
      { encoding: "utf8", maxBuffer: OUTPUT_BYTES }
    );
    return {
      compiler: `bun${found}`,
      status: result.status,
      signal: result.signal,
      output: `${result.stdout}${result.stderr}`,
      wallSeconds: (performance.now() - started) / 1000,
    };
  }
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
      consumerRoot,
      "--extendedDiagnostics",
      "--pretty",
      "false",
      ...compiler.flags,
    ],
    { encoding: "utf8", maxBuffer: OUTPUT_BYTES }
  );
  const output = `${result.stdout}${result.stderr}`;
  return {
    compiler: `TS${version}`,
    version,
    status: result.status,
    signal: result.signal,
    output,
    instantiations: reported(output, "Instantiations"),
    types: reported(output, "Types"),
    memoryKB: reported(output, "Memory used"),
    checkSeconds: reported(output, "Check time"),
    wallSeconds: (performance.now() - started) / 1000,
  };
}

const fixtureRoot = mkdtempSync(join(tmpdir(), "viborm-rbac-types-"));
const failures = [];
try {
  const consumerRoot = join(fixtureRoot, "consumer");
  createPackedConsumer(
    consumerRoot,
    packedArchive(fixtureRoot),
    "viborm-rbac-types",
    []
  );
  const source = join(consumerRoot, "src");
  mkdirSync(source, { recursive: true });
  cpSync(
    join(repositoryRoot, "tests/package/fixtures/rbac-app/schema"),
    join(source, "schema"),
    { recursive: true }
  );
  writeFileSync(join(source, "policy.ts"), policySource);
  writeFileSync(join(source, "compile.ts"), compileSource);
  writeFileSync(join(source, "client.ts"), clientSource);
  writeFileSync(join(consumerRoot, "tsconfig.json"), JSON.stringify(tsconfig));

  for (const checker of checkers) {
    const { output, status, signal, version, ...measured } = check(
      checker,
      consumerRoot
    );
    process.stderr.write(
      `${PACKAGE_STAGE_PREFIX}${JSON.stringify({ scenario: "type-rbac", stage: checker, ...measured })}\n`
    );
    if (status !== 0) {
      const errors = output.split("\n").filter((line) => diagnostic.test(line));
      failures.push(
        `${checker} reports ${errors.length} diagnostic(s), exit ${status ?? signal}:\n${(errors.length > 0 ? errors : [output.slice(-2000)]).join("\n")}`
      );
    }
    if (checker === "bun") continue;
    const recorded = budgets.checkers[checker];
    if (process.env.VIBORM_TYPE_BUDGETS_WRITE === "1") {
      budgets.checkers[checker] = {
        typescript: version,
        instantiations: measured.instantiations,
      };
      continue;
    }
    if (recorded?.typescript !== version) {
      failures.push(
        `${checker} budget was recorded on TypeScript ${recorded?.typescript} but this is ${version}: re-measure with VIBORM_TYPE_BUDGETS_WRITE=1.`
      );
      continue;
    }
    const ceiling = Math.floor(
      recorded.instantiations * (1 + budgets.headroom)
    );
    // Negated so an unparsed (NaN) count fails too.
    if (!(measured.instantiations <= ceiling)) {
      failures.push(
        `${checker} instantiations ${measured.instantiations} > ${ceiling}`
      );
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
    `The rbac consumer fails its type contract:\n${failures.join("\n")}`
  );
}

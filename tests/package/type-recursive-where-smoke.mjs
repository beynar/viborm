/**
 * A held `where` type inside nested projections, at application scale, on
 * every checker a consumer uses. A packed-tarball consumer with a 50-model
 * schema (`fixtures/recursive-where`: an auth-library identity hub with ~33
 * inverse relations, an organization hub with ~19, a team graph through a
 * join model, grants as an exclusive arc) builds its queries the way an
 * application does: rule helpers spread into `where`, `as const` select
 * helpers, `recurse` over self relations, a nested `select` / `include` whose
 * `where` is typed as the client's own `where` payload, and a client that is
 * the union of the plain and the instrumented one.
 *
 * 1.2.0 walked every OPTIONAL relation key of such a held `where` and
 * enumerated the paths through the model graph: TS2589 at three sites on
 * every TypeScript, nine under `bun check`, and from there wrong types (22
 * more errors on TypeScript 5.9 and 6, the `any` of TS7006 / TS7031 under
 * Bun). Instantiations on this fixture (TypeScript 7 single-threaded, as
 * measured here) and check wall time:
 *
 *   checker          1.1.0              1.2.0              1.2.1
 *   TS 5.9.3   6,360,291  7.9 s   16,875,711  8.2 s   1,167,122  2.3 s
 *   TS 6.0.3   6,542,730  8.0 s   17,050,480  8.2 s   1,340,686  2.3 s
 *   TS 7.0.2   9,050,815  3.9 s   17,446,082  4.0 s   1,710,882  1.1 s
 *   bun 1.4.3              2.2 s               3.3 s              0.5 s
 *
 * 1.1.0 already had one TS2589 here, on a payload-typed `where` spread into a
 * root relation filter (`queries/held-where.ts`). The type-floor-scale
 * budgets never saw any of it: none of their queries has a nested `where`.
 *
 * The table predates `queries/held-nodes.ts`: whole relation nodes read
 * through `Parameters<…>` and passed back, which 1.2.0 and the first 1.2.1
 * fix refused (TS2322 on every checker; 1.1.0 compiled them). It adds about
 * 80k instantiations on each TypeScript (TS 7: 1,793,624). 1.2.2 walks the
 * optional keys of a finite held `where` again and stops at each payload;
 * `queries/held-optional.ts` holds payloads under such keys, about 20k more
 * (TS 7: 1,816,278). Without the stop it is TS2589 again (TS 7: 27.5M).
 *
 * `VIBORM_RECURSIVE_WHERE_CHECKERS` picks the checkers (comma separated;
 * default `tsc5,tsc6,tsc7`): the repository's `typescript` (5.9.3),
 * `typescript-6` and `typescript-native` (7.0.2) packages, and `bun` for
 * `bun check` (Bun >= 1.4.3 on PATH; CI's Bun job runs it, and asking for it
 * without Bun is an error, never a skip). Every checker must report no
 * diagnostic, and each TypeScript's instantiations must stay within
 * `type-recursive-where-budgets.json`: the recorded value plus its headroom,
 * recorded on that exact compiler version. To ratchet after making types
 * cheaper, run with `VIBORM_TYPE_BUDGETS_WRITE=1` and commit the values.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
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
  // A Node shim that execs the platform binary. Its parallel checkers each
  // instantiate what they meet, so only one checker gives a count that does
  // not depend on the machine's cores (and a quarter of the memory).
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
  "tests/package/type-recursive-where-budgets.json"
);
const budgets = JSON.parse(readFileSync(budgetsFile, "utf8"));
const checkers = (
  process.env.VIBORM_RECURSIVE_WHERE_CHECKERS ?? "tsc5,tsc6,tsc7"
).split(",");
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

const fixtureRoot = mkdtempSync(join(tmpdir(), "viborm-recursive-where-"));
const failures = [];
try {
  const consumerRoot = join(fixtureRoot, "consumer");
  createPackedConsumer(
    consumerRoot,
    packedArchive(fixtureRoot),
    "viborm-recursive-where",
    ["pg", "@types/pg", "@types/node"]
  );
  cpSync(
    join(repositoryRoot, "tests/package/fixtures/recursive-where"),
    join(consumerRoot, "src"),
    { recursive: true }
  );
  writeFileSync(join(consumerRoot, "tsconfig.json"), JSON.stringify(tsconfig));

  for (const checker of checkers) {
    const { output, status, signal, version, ...measured } = check(
      checker,
      consumerRoot
    );
    process.stderr.write(
      `${PACKAGE_STAGE_PREFIX}${JSON.stringify({ scenario: "type-recursive-where", stage: checker, ...measured })}\n`
    );
    // Every checker exits non-zero on a diagnostic, and on a crash.
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
    `The recursive-where consumer fails its type contract:\n${failures.join("\n")}`
  );
}

/**
 * The quick start runs as written, from `npm init -y`, against the packed
 * package (parity-06/13).
 *
 * The page's setup fence is executed line by line: `npm init -y` and
 * `npm pkg set` run as written; each `npm install` is satisfied offline, the
 * packed tarball as `viborm` and every other named package linked from this
 * repository's install (`packed-consumer.mjs`), so a package the page names
 * that this repository does not have fails here. `tsx` is the one exception:
 * it is not installed here, and Node's type stripping runs the same
 * `.ts`-extension imports in its place. Then the page's titled fences (the
 * first of each title: the SQLite tab leads the client tabs) are written as
 * files, `tsc -p` checks them with the page's `tsconfig.json` (which must be
 * the Installation page's), the installed bin runs `viborm push`, Node runs
 * `src/index.ts`, and the database holds what the page's queries leave. Last,
 * the "Type Safety" fence must fail to type-check on exactly its two `❌`
 * statements.
 *
 * Run after `pnpm package:build`.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createPackedConsumer,
  packedArchive,
  repositoryRoot,
} from "./packed-consumer.mjs";

const FENCE = /^```(\w+)([^\n]*)\n([\s\S]*?)^```/gm;
const TITLE = /title="([^"]+)"/;
const pages = join(
  repositoryRoot,
  "docs",
  "content",
  "docs",
  "getting-started"
);

function fencesOf(page) {
  return [...readFileSync(join(pages, page), "utf8").matchAll(FENCE)].map(
    ([, language, info, body]) => ({
      language,
      title: TITLE.exec(info)?.[1],
      body,
    })
  );
}

const fences = fencesOf("quick-start.mdx");
const bash = (needle) => {
  const fence = fences.find(
    ({ language, body }) => language === "bash" && body.includes(needle)
  );
  if (!fence)
    throw new Error(`The quick start has no bash fence running "${needle}"`);
  return fence.body;
};
const files = new Map();
for (const { title, body } of fences) {
  if (title !== undefined && !files.has(title)) files.set(title, body);
}
const tsconfig = files.get("tsconfig.json");
if (
  !fencesOf("index.mdx").some(
    ({ title, body }) => title === "tsconfig.json" && body === tsconfig
  )
)
  throw new Error(
    "The quick start's tsconfig.json must be the Installation page's"
  );
if (!files.get("src/db/client.ts")?.includes('"viborm/sqlite3"'))
  throw new Error("The quick start's first client tab must be SQLite");

const npm = (args, cwd) =>
  execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
    },
  });
const node = (args, cwd) =>
  execFileSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });

const fixtureRoot = mkdtempSync(join(tmpdir(), "viborm-quick-start-"));
try {
  const root = join(fixtureRoot, "blog");
  mkdirSync(root);
  const installed = [];
  for (const line of bash("npm init -y").split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words[0] === "" || words[0] === "mkdir") continue;
    if (words[0] !== "npm")
      throw new Error(`The setup fence runs an unexpected command: ${line}`);
    if (words[1] === "install" || words[1] === "i")
      installed.push(...words.slice(2).filter((word) => !word.startsWith("-")));
    else npm(words.slice(1), root);
  }
  const manifest = readFileSync(join(root, "package.json"), "utf8");
  if (JSON.parse(manifest).type !== "module")
    throw new Error("The setup fence leaves the project CommonJS");
  createPackedConsumer(
    root,
    packedArchive(fixtureRoot),
    "blog",
    installed.filter((name) => name !== "viborm" && name !== "tsx")
  );
  writeFileSync(join(root, "package.json"), manifest);
  for (const [path, body] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }

  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const typeCheck = () => {
    try {
      node([tsc, "-p", "tsconfig.json"], root);
      return "";
    } catch (error) {
      return `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
  };
  const errors = typeCheck();
  if (errors !== "")
    throw new Error(`The quick start does not type-check:\n${errors}`);

  if (!bash("viborm push").includes("npx viborm push"))
    throw new Error("The quick start must push with npx viborm push");
  const bin = JSON.parse(
    readFileSync(join(root, "node_modules", "viborm", "package.json"), "utf8")
  ).bin.viborm;
  node([join(root, "node_modules", "viborm", bin), "push"], root);

  if (!bash("npx tsx").includes("npx tsx src/index.ts"))
    throw new Error("The quick start must run npx tsx src/index.ts");
  node(["--experimental-strip-types", "src/index.ts"], root);

  const Database = createRequire(join(root, "package.json"))("better-sqlite3");
  const database = new Database(join(root, "data.db"), { readonly: true });
  try {
    const users = database.prepare("SELECT email FROM user").all();
    const posts = database.prepare("SELECT published FROM post").all();
    if (
      JSON.stringify(users) !== '[{"email":"alice@example.com"}]' ||
      JSON.stringify(posts) !== '[{"published":1}]'
    )
      throw new Error(
        `The quick start left users ${JSON.stringify(users)} and posts ${JSON.stringify(posts)}`
      );
  } finally {
    database.close();
  }

  const misuse = fences.find(
    ({ language, body }) => language === "ts" && body.includes("// ❌")
  );
  if (!misuse) throw new Error("The quick start has no Type Safety fence");
  const preamble = 'import { client } from "./db/client.ts";\n';
  writeFileSync(join(root, "src", "type-safety.ts"), preamble + misuse.body);
  const expected = (preamble + misuse.body)
    .split("\n")
    .flatMap((line, index) => (line.includes("// ❌") ? [index + 2] : []));
  const reported = [
    ...typeCheck().matchAll(/^src\/type-safety\.ts\((\d+),\d+\): error/gm),
  ].map(([, line]) => Number(line));
  // Each ❌ comment's statement starts on the next line; its error is inside it.
  const misplaced = reported.filter(
    (line) =>
      !expected.some(
        (start, index) => line >= start && line < (expected[index + 1] ?? 1e9)
      )
  );
  if (
    expected.length !== 2 ||
    misplaced.length > 0 ||
    expected.some(
      (start, index) =>
        !reported.some(
          (line) => line >= start && line < (expected[index + 1] ?? 1e9)
        )
    )
  )
    throw new Error(
      `The Type Safety fence must fail on exactly its ❌ statements (from lines ${expected.join(", ")}); tsc reported lines ${reported.join(", ")}`
    );
  console.log("Quick start from npm init -y: pass");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

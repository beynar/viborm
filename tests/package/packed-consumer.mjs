/**
 * A consumer application of the packed package: a directory holding the
 * tarball as `node_modules/viborm`, the package's own runtime dependencies and
 * the SQLite peer, linked from this repository's install, and nothing else
 * from this repository. The third-party smokes (soft delete, the guide's
 * extension recipes) write their files into it, type-check them against the
 * published declarations and run them with Node's type stripping.
 *
 * `VIBORM_PACKAGE_TARBALL` names an existing tarball instead of packing one.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = realpathSync(
  join(dirname(fileURLToPath(import.meta.url)), "../..")
);
const repositoryPackage = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8")
);
// By path, not `.bin/tsc`: two TypeScripts are installed and that link is
// whichever won pnpm's bin collision.
const tsc = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

/** The packed archive: `VIBORM_PACKAGE_TARBALL`, or one packed into `into`. */
function packedArchive(into) {
  const archive = process.env.VIBORM_PACKAGE_TARBALL;
  if (archive !== undefined) return archive;
  execFileSync("pnpm", ["pack", "--pack-destination", into], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
  const archives = readdirSync(into).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`Expected one packed archive, found ${archives.length}`);
  }
  return join(into, archives[0]);
}

/**
 * Runs `use` against a fresh consumer named `name` whose files are `files`
 * (path to source), and deletes it afterwards. `use` receives `typeCheck`
 * (`tsc --strict` over the named files) and `run` (Node runs one file, which
 * must print `<label>: pass`).
 */
export function withPackedConsumer(name, files, use) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), `${name}-`));
  try {
    const archive = packedArchive(fixtureRoot);
    const consumerRoot = join(fixtureRoot, "consumer");
    const modules = join(consumerRoot, "node_modules");
    const packageRoot = join(modules, "viborm");
    mkdirSync(packageRoot, { recursive: true });
    execFileSync(
      "tar",
      ["-xzf", archive, "-C", packageRoot, "--strip-components=1"],
      { stdio: "pipe" }
    );
    // The package's runtime dependencies and the one peer a consumer uses,
    // each linked from this repository's install: nothing else resolves.
    for (const dependency of [
      ...Object.keys(repositoryPackage.dependencies ?? {}),
      "better-sqlite3",
    ]) {
      const target = realpathSync(
        join(repositoryRoot, "node_modules", dependency)
      );
      mkdirSync(dirname(join(modules, dependency)), { recursive: true });
      symlinkSync(target, join(modules, dependency), "dir");
    }
    writeFileSync(
      join(consumerRoot, "package.json"),
      JSON.stringify({ name, type: "module" })
    );
    for (const [file, source] of Object.entries(files)) {
      writeFileSync(join(consumerRoot, file), source);
    }

    const typeCheck = (entries) => {
      try {
        execFileSync(
          tsc,
          [
            "--noEmit",
            "--strict",
            "--skipLibCheck",
            "--target",
            "es2022",
            "--module",
            "esnext",
            "--moduleResolution",
            "bundler",
            "--allowImportingTsExtensions",
            "--types",
            "node",
            "--typeRoots",
            join(repositoryRoot, "node_modules", "@types"),
            ...entries,
          ],
          { cwd: consumerRoot, encoding: "utf8", stdio: "pipe" }
        );
      } catch (error) {
        throw new Error(
          `The ${name} consumer does not type-check:\n${error.stdout ?? ""}${error.stderr ?? ""}`
        );
      }
    };
    const run = (file, label) => {
      // The flag is what Node 22.12, the package's floor, needs to run a
      // `.ts` file; later versions strip types without it and accept it.
      const output = execFileSync(
        process.execPath,
        ["--experimental-strip-types", file],
        {
          cwd: consumerRoot,
          encoding: "utf8",
          stdio: "pipe",
        }
      );
      if (!output.includes(`${label}: pass`)) {
        throw new Error(`The ${label} did not finish:\n${output}`);
      }
    };
    use({ typeCheck, run, root: consumerRoot });
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

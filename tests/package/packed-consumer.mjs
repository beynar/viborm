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
import { createHash } from "node:crypto";
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
// By path, not `.bin/tsc`: two TypeScripts are installed and that link is
// whichever won pnpm's bin collision.
const tsc = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

/** The packed archive: `VIBORM_PACKAGE_TARBALL`, or one packed into `into`. */
export function packedArchive(into) {
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

/** Built-only probes must observe the exact published bytes supplied to the suite. */
export function assertBuiltPublicDistMatchesArchive(
  archive,
  builtRoot = repositoryRoot
) {
  const snapshot = mkdtempSync(join(tmpdir(), "viborm-package-dist-"));
  const digest = (file) =>
    createHash("sha256").update(readFileSync(file)).digest("hex");
  const publicFiles = (directory, published) => {
    const files = new Map();
    const walk = (prefix) => {
      for (const entry of readdirSync(join(directory, prefix), {
        withFileTypes: true,
      })) {
        const path = join(prefix, entry.name);
        if (prefix === "" && entry.name === "internal") {
          if (published)
            throw new Error(
              "Published dist includes the private benchmark friend"
            );
          continue;
        }
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) files.set(path, digest(join(directory, path)));
        else throw new Error(`Public dist must contain regular files: ${path}`);
      }
    };
    walk("");
    return files;
  };
  try {
    execFileSync(
      "tar",
      ["-xzf", archive, "-C", snapshot, "--strip-components=1"],
      { stdio: "pipe" }
    );
    const packed = publicFiles(join(snapshot, "dist"), true);
    const built = publicFiles(join(builtRoot, "dist"), false);
    if (packed.size === 0) throw new Error("Published dist is empty");
    for (const [path, hash] of packed) {
      if (!built.has(path))
        throw new Error(`Built public dist is missing ${path}`);
      if (built.get(path) !== hash)
        throw new Error(
          `Built public dist differs from supplied archive: ${path}`
        );
    }
    for (const path of built.keys()) {
      if (!packed.has(path))
        throw new Error(`Built public dist has extra ${path}`);
    }
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

/**
 * Lays out the consumer `name` at `consumerRoot`: the archive as
 * `node_modules/viborm`, then its runtime dependencies and `peers`, each
 * linked from this repository's install, so nothing else resolves.
 */
export function createPackedConsumer(
  consumerRoot,
  archive,
  name,
  peers = ["better-sqlite3"]
) {
  const modules = join(consumerRoot, "node_modules");
  const packageRoot = join(modules, "viborm");
  mkdirSync(packageRoot, { recursive: true });
  execFileSync(
    "tar",
    ["-xzf", archive, "-C", packageRoot, "--strip-components=1"],
    { stdio: "pipe" }
  );
  // The archive's own manifest names its dependencies: a published version
  // may differ from this checkout.
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8")
  );
  for (const dependency of [
    ...Object.keys(manifest.dependencies ?? {}),
    ...peers,
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
}

/**
 * Runs `use` against a fresh consumer named `name` whose files are `files`
 * (path to source), and deletes it afterwards. `use` receives `typeCheck`
 * (`tsc --strict` over the named files, returning its output) and `run` (Node runs one file, which
 * must print `<label>: pass`).
 */
export function withPackedConsumer(name, files, use) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), `${name}-`));
  try {
    const consumerRoot = join(fixtureRoot, "consumer");
    createPackedConsumer(consumerRoot, packedArchive(fixtureRoot), name);
    for (const [file, source] of Object.entries(files)) {
      writeFileSync(join(consumerRoot, file), source);
    }

    const typeCheck = (entries) => {
      try {
        return execFileSync(
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

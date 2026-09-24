/**
 * The published declarations' types must be delivered by viborm's own runtime
 * `dependencies`.
 *
 * A consumer installs `viborm` and gets `dependencies`; it does not get
 * `devDependencies`, and it gets a peer only if it asked for one. Nothing else
 * in the repository can tell a runtime type dependency from a development one:
 * the repository's own `node_modules` holds both kinds, and every other package
 * probe type-checks with the repository root as its working directory, so a
 * dev-only type leaking into a published `.d.mts` would resolve there and
 * compile. It would not compile for the consumer — and it would not FAIL for
 * them either: with `skipLibCheck`, which is the floor this package documents,
 * an unresolvable type in a declaration file silently becomes `any` and every
 * mistake made against it type-checks.
 *
 * `@standard-schema/spec` is the witness. It is types-only, it is a runtime
 * `dependency`, and the interface it declares is the one every schema this
 * package publishes speaks — so it is exactly the placement this file measures.
 *
 * Run after `pnpm package:build`. Two arms:
 *
 *   A. DELIVERED — a consumer with the built package and ONLY the packages
 *                  `dependencies` declares beside it sees the real standard
 *                  schema interface: a wrongly typed call is still an error.
 *   B. FALSIFIED — remove those declarations from that same sandbox and arm A's
 *                  probe must stop failing, which is what proves arm A measures
 *                  the types and not merely that the file parses.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The types-only runtime dependency this probe is written around. */
const WITNESS_PACKAGE = "@standard-schema/spec";

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const repositoryPackage = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8")
);
// By path, not `.bin/tsc`: two TypeScripts are installed and that link is
// whichever won pnpm's bin collision.
const tsc =
  process.env.VIBORM_TYPESCRIPT_BIN === undefined
    ? join(repositoryRoot, "node_modules", "typescript", "bin", "tsc")
    : resolve(repositoryRoot, process.env.VIBORM_TYPESCRIPT_BIN);

const sandbox = mkdtempSync(join(tmpdir(), "viborm-dependency-types-"));
/** An empty directory, so `--typeRoots` finds genuinely nothing. */
const emptyTypeRoots = join(sandbox, "no-types");

function typeCheck(file) {
  try {
    execFileSync(
      tsc,
      [
        "--noEmit",
        "--strict",
        // The floor consumers actually compile at: a package that needs
        // `skipLibCheck: false` to keep its types would be measuring a
        // stricter consumer than the one it documents.
        "--skipLibCheck",
        "--target",
        "es2022",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--lib",
        "es2022",
        "--typeRoots",
        emptyTypeRoots,
        file,
      ],
      { cwd: sandbox, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return "";
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
  }
}

try {
  mkdirSync(emptyTypeRoots);
  const installedRoot = join(sandbox, "node_modules", "viborm");
  mkdirSync(installedRoot, { recursive: true });
  // The artifact a consumer receives, and beside it exactly what `viborm`
  // declares as a runtime dependency - no `devDependencies`, no optional peer.
  // Copied rather than linked: TypeScript resolves a symlinked file to its real
  // path, and the repository's own `node_modules` sits above that path.
  cpSync(join(repositoryRoot, "dist"), join(installedRoot, "dist"), {
    dereference: true,
    recursive: true,
  });
  cpSync(
    join(repositoryRoot, "package.json"),
    join(installedRoot, "package.json")
  );
  const declared = Object.keys(repositoryPackage.dependencies ?? {});
  if (!declared.includes(WITNESS_PACKAGE)) {
    throw new Error(
      `[dependency-types] ${WITNESS_PACKAGE} is no longer a runtime dependency; ` +
        "this probe needs a types-only `dependencies` entry to measure."
    );
  }
  for (const name of declared) {
    const destination = join(installedRoot, "node_modules", name);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repositoryRoot, "node_modules", name), destination, {
      dereference: true,
      recursive: true,
    });
  }

  const consumerFile = join(sandbox, "consumer.ts");
  writeFileSync(
    consumerFile,
    [
      'import { getSchemas, s } from "viborm";',
      "",
      "const user = s.model({ id: s.string().id() });",
      "const where = getSchemas({ user }).user.core.where;",
      "",
      "// @ts-expect-error `validate` takes a value and an OPTIONAL OPTIONS",
      "// OBJECT, so a string second argument is an error for exactly as long",
      "// as the published declarations resolve the standard schema interface.",
      "// When they cannot, that whole surface becomes `any` and this stops",
      "// being an error - which is arm B.",
      'where["~standard"].validate({ id: "x" }, "not-options");',
      "",
      'export const vendor: string = where["~standard"].vendor;',
      "",
    ].join("\n")
  );

  const delivered = typeCheck(consumerFile);
  if (delivered !== "") {
    throw new Error(
      "[dependency-types] A (DELIVERED) FAILED\n" +
        "A consumer installing viborm gets its `dependencies` and nothing else. " +
        "Every type the published declarations name must come from that set.\n" +
        delivered
    );
  }

  rmSync(join(installedRoot, "node_modules", WITNESS_PACKAGE), {
    force: true,
    recursive: true,
  });
  const falsified = typeCheck(consumerFile);
  if (falsified === "") {
    throw new Error(
      "[dependency-types] B (FALSIFIED) FAILED\n" +
        `With ${WITNESS_PACKAGE}'s declarations removed the probe still ` +
        "compiled, so arm A is not measuring the published types at all."
    );
  }
} finally {
  rmSync(sandbox, { force: true, recursive: true });
}

process.stdout.write(
  "[dependency-types] A delivered / B falsified: the published declarations " +
    "carry their types from viborm's own dependencies.\n"
);

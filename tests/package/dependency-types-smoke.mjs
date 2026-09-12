/**
 * The published declarations' types must be delivered by viborm's own runtime
 * `dependencies`.
 *
 * big.js ships no declarations of its own and the emitted `.d.mts` names the
 * module, so `@types/big.js` is a **runtime** dependency rather than a
 * development one. Nothing else in the repository can tell the two placements
 * apart: the repository's own `node_modules` holds both kinds, every other
 * package probe links `devDependencies` into its sandbox, and a consumer whose
 * `@types/big.js` is missing does not fail to compile — the public `Decimal`
 * silently becomes `any` and every arithmetic mistake against it type-checks.
 *
 * Run after `pnpm package:build`. Two arms:
 *
 *   A. DELIVERED — a consumer with the built package and ONLY the packages
 *                  `dependencies` declares beside it sees a real big.js
 *                  `Decimal`: a wrongly typed call is still an error.
 *   B. FALSIFIED — remove the declarations from that same sandbox and arm A's
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
  if (declared.length === 0) {
    throw new Error("[dependency-types] viborm declares no dependencies");
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
      'import { Decimal } from "viborm";',
      'const value: Decimal = new Decimal("1.2").plus(1);',
      "// @ts-expect-error big.js declares toFixed(dp?: number), so a string is",
      "// an error here for as long as the published Decimal IS big.js's Big.",
      'value.toFixed("2");',
      "export const text: string = value.toFixed();",
      "",
    ].join("\n")
  );

  const delivered = typeCheck(consumerFile);
  if (delivered !== "") {
    throw new Error(
      "[dependency-types] A (DELIVERED) FAILED\n" +
        "A consumer installing viborm gets its `dependencies` and nothing else. " +
        "Every type the published declarations name must come from that set — " +
        "`@types/big.js` belongs in `dependencies`, not `devDependencies`.\n" +
        delivered
    );
  }

  rmSync(join(installedRoot, "node_modules", "@types", "big.js"), {
    force: true,
    recursive: true,
  });
  const falsified = typeCheck(consumerFile);
  if (falsified === "") {
    throw new Error(
      "[dependency-types] B (FALSIFIED) FAILED\n" +
        "With big.js's declarations removed the probe still compiled, so arm A " +
        "is not measuring the published Decimal's type at all."
    );
  }
} finally {
  rmSync(sandbox, { force: true, recursive: true });
}

process.stdout.write(
  "[dependency-types] A delivered / B falsified: the published Decimal carries " +
    "big.js's declarations from viborm's own dependencies.\n"
);

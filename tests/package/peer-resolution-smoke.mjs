/**
 * npm's peer resolution of the PACKED manifest, offline: npm refuses an
 * install (ERESOLVE) when an installed peer's version does not satisfy the
 * range, so the ranges are judged here with npm's own bundled `semver`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packedArchive } from "./packed-consumer.mjs";

const npmRoot = execFileSync("npm", ["root", "--global"], {
  encoding: "utf8",
}).trim();
const semver = createRequire(join(npmRoot, "npm", "package.json"))("semver");
const packRoot = mkdtempSync(join(tmpdir(), "viborm-peers-"));
let manifest;
try {
  manifest = JSON.parse(
    execFileSync(
      "tar",
      ["-xzOf", packedArchive(packRoot), "package/package.json"],
      {
        encoding: "utf8",
      }
    )
  );
} finally {
  rmSync(packRoot, { recursive: true, force: true });
}
const peers = manifest.peerDependencies;

const expectations = [
  // dist/d1.d.mts imports D1Database from it; a Workers project on the
  // current major must install without ERESOLVE, and 4.x keeps working.
  ["@cloudflare/workers-types", "5.20261010.1", true],
  ["@cloudflare/workers-types", "4.20260103.0", true],
  // 2.0.0 removed `execute(query, args)`: every parameterized statement the
  // driver sends throws "Query parameters are not supported", so the range
  // refuses it rather than admitting an install that cannot run a query.
  ["@planetscale/database", "1.19.0", true],
  ["@planetscale/database", "2.0.0", false],
];
for (const [peer, version, admitted] of expectations) {
  if (semver.satisfies(version, peers[peer]) !== admitted) {
    throw new Error(
      `${peer} "${peers[peer]}" must ${admitted ? "admit" : "refuse"} ${version}`
    );
  }
}
if (
  manifest.peerDependenciesMeta["@cloudflare/workers-types"]?.optional !== true
)
  throw new Error("@cloudflare/workers-types must stay an optional peer");
console.log(
  `npm semver ${semver.SEMVER_SPEC_VERSION}: ${expectations.length} peer resolutions as declared`
);

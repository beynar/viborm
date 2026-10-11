// parity-05 (tenant blocker): `npm install viborm` must resolve next to the
// current @cloudflare/workers-types 5.x (1.1.0's peer range ^4.20260103.0
// makes npm fail with ERESOLVE). Checked offline against the installed
// package.json's peerDependencies with a small semver range check; 4.x must
// stay accepted. @planetscale/database 2 is refused (1.2.0 pinned "qualify or
// refuse" to refuse): 2.0.0 throws "Query parameters are not supported" on
// every `execute(query, args)` the driver sends, so its range must not admit
// it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  id: "parity-05-peer-ranges",
  title:
    "The @cloudflare/workers-types peer accepts 5.x and 4.x; @planetscale/database 2 is refused",
  plan: "phase-1/lane-O/tenant-blockers (parity-05)",
  needs: [],
  source:
    "completion-plan-2026-10/code-check-probes/track-a/peer-wt5/package.json; completion-plan-2026-10/code-check/track-a.md (parity-05)",
};

const WORKERS_TYPES_CURRENT = "5.20261010.1";
const WORKERS_TYPES_PREVIOUS = "4.20260103.0";
const PLANETSCALE_CURRENT = "2.0.0";
const LEADING_V = /^v/;
const COMPARATOR =
  /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*))?)$/;
const OPERATOR_SPACE = /(\^|~|>=|<=|>|<|=)\s+/g;
const WHITESPACE = /\s+/;

function vibormManifest() {
  let directory = dirname(fileURLToPath(import.meta.resolve("viborm")));
  for (;;) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, "utf8"));
      if (manifest.name === "viborm") return manifest;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error("viborm's package.json was not found");
    directory = parent;
  }
}

const parse = (text) => {
  const [major = 0, minor = 0, patch = 0] = text
    .replace(LEADING_V, "")
    .split(".")
    .map(Number);
  return [major, minor, patch];
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** One comparator of a node-semver range, for the forms peer ranges use. */
function satisfiesComparator(version, comparator) {
  if (comparator === "*" || comparator === "") return true;
  const match = COMPARATOR.exec(comparator);
  if (!match) throw new Error(`unsupported range comparator "${comparator}"`);
  const [, operator = "=", raw] = match;
  const parts = raw.split(".");
  const floor = parse(
    parts.map((part) => (part === "x" || part === "*" ? "0" : part)).join(".")
  );
  const v = parse(version);
  const wildcard =
    parts.length < 3 || parts.some((part) => part === "x" || part === "*");
  if (operator === "^") {
    const ceiling =
      floor[0] > 0
        ? [floor[0] + 1, 0, 0]
        : floor[1] > 0
          ? [0, floor[1] + 1, 0]
          : [0, 0, floor[2] + 1];
    return compare(v, floor) >= 0 && compare(v, ceiling) < 0;
  }
  if (operator === "~")
    return (
      compare(v, floor) >= 0 && compare(v, [floor[0], floor[1] + 1, 0]) < 0
    );
  if (operator === ">=") return compare(v, floor) >= 0;
  if (operator === ">") return compare(v, floor) > 0;
  if (operator === "<=") return compare(v, floor) <= 0;
  if (operator === "<") return compare(v, floor) < 0;
  if (wildcard) {
    return parts.length === 1 || parts[1] === "x" || parts[1] === "*"
      ? v[0] === floor[0]
      : v[0] === floor[0] && v[1] === floor[1];
  }
  return compare(v, floor) === 0;
}

const satisfies = (version, range) =>
  range
    .split("||")
    .map((set) => set.trim())
    .some((set) =>
      set
        .replace(OPERATOR_SPACE, "$1")
        .split(WHITESPACE)
        .every((comparator) => satisfiesComparator(version, comparator))
    );

export default async function probe() {
  const manifest = vibormManifest();
  const peers = manifest.peerDependencies ?? {};
  const workers = peers["@cloudflare/workers-types"];
  const planetscale = peers["@planetscale/database"];
  if (workers === undefined) {
    return {
      status: "fail",
      evidence:
        "viborm declares no @cloudflare/workers-types peer (dist/d1.d.mts imports it)",
    };
  }
  const current = satisfies(WORKERS_TYPES_CURRENT, workers);
  const previous = satisfies(WORKERS_TYPES_PREVIOUS, workers);
  const planetscaleRefused =
    planetscale !== undefined && !satisfies(PLANETSCALE_CURRENT, planetscale);
  const planetscaleNote =
    planetscale === undefined
      ? "@planetscale/database peer absent"
      : `@planetscale/database "${planetscale}" ${planetscaleRefused ? "refuses" : "accepts (its driver cannot run there)"} ${PLANETSCALE_CURRENT}`;
  return {
    status: current && previous && planetscaleRefused ? "pass" : "fail",
    evidence: `viborm ${manifest.version}: @cloudflare/workers-types "${workers}" ${current ? "accepts" : "refuses (npm ERESOLVE)"} ${WORKERS_TYPES_CURRENT}, ${previous ? "accepts" : "refuses"} ${WORKERS_TYPES_PREVIOUS}; ${planetscaleNote}`,
  };
}

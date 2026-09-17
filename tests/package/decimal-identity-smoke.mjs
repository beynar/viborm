/**
 * The built package publishes exactly ONE Decimal constructor.
 *
 * `Decimal` used to be an external dependency, and `tsdown.config.ts` kept it
 * external for one reason: bundling it would have inlined one class per entry
 * point, so a value handed back by `viborm` would not have been `instanceof`
 * the constructor `viborm/schema` builds. The class is VibORM's own now and is
 * bundled, which makes that risk ours — and a chunking property rather than a
 * packaging one.
 *
 * So it is proven rather than assumed, two ways:
 *
 * 1. the root entry publishes a CONSTRUCTOR, its instances belong to it, and
 *    they carry the canonical spelling the codec keys on;
 * 2. exactly ONE built file carries the class's own refusal sentence. That is
 *    the identity proof: an entry that constructs a Decimal must import it from
 *    that one file, so there is one constructor for every entry to share. A
 *    build that inlined a private copy per entry writes the sentence twice and
 *    this goes red.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const distRoot = join(repositoryRoot, "dist");

/**
 * A sentence only the Decimal class carries, verbatim from its source.
 *
 * Deliberately NOT its constructor's refusal: that sentence is word for word
 * the one `v.decimal()` reports for the same input family, on purpose, and it
 * lives in a second module. This one is `div`'s, and it is the class's alone —
 * grepped across `src/` to be sure.
 */
const REFUSAL = "Division by zero";

const rootEntry = await import(pathToFileURL(join(distRoot, "index.mjs")).href);

const { Decimal } = rootEntry;
if (typeof Decimal !== "function") {
  throw new Error("The root entry must publish the Decimal constructor");
}
const value = new Decimal("1.2");
if (!(value instanceof Decimal)) {
  throw new Error("A Decimal must be an instance of the published constructor");
}
if (value.toString() !== "1.2") {
  throw new Error("A published Decimal must carry its canonical spelling");
}

const walk = (directory) => {
  const found = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      found.push(...walk(path));
    } else if (name.endsWith(".mjs")) {
      found.push(path);
    }
  }
  return found;
};

const carriers = walk(distRoot).filter((path) =>
  readFileSync(path, "utf8").includes(REFUSAL)
);
if (carriers.length !== 1) {
  throw new Error(
    `Expected exactly one built file to carry the Decimal class, found ${carriers.length}: ${carriers
      .map((path) => path.slice(distRoot.length + 1))
      .join(", ")}`
  );
}

process.stdout.write(
  `decimal identity: one constructor, one copy (${carriers[0].slice(distRoot.length + 1)})\n`
);

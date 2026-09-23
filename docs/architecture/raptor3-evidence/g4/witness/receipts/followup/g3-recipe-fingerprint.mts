import { createHash } from "node:crypto";
import { generateG3Recipe } from "/Users/arnaud/code/viborm/tests/raptor3/g3/generation/recipe.ts";
const hash = createHash("sha256");
for (let seed = 8000; seed < 18000; seed++)
  hash.update(JSON.stringify(generateG3Recipe(seed)));
process.stdout.write(`${hash.digest("hex")}\n`);

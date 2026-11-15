// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
import { client } from "docs-examples/shared";

declare function recordDuration(milliseconds: number): void;
declare function record(facts: object): void;

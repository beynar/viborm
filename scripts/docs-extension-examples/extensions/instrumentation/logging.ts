// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
import { schema } from "docs-examples/shared";
import { createClient } from "viborm";
import { instrumentation } from "viborm/instrumentation";
import { PGliteDriver } from "viborm/pglite";

declare const driver: PGliteDriver;
declare const errorTracker: { capture(event: unknown): void };
declare const appLogger: { info(event: unknown): void };

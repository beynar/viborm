// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
import { PGliteDriver } from "viborm/pglite";
import { client as orm, schema } from "./general-schema";

declare const driver: PGliteDriver;
declare const args: object;

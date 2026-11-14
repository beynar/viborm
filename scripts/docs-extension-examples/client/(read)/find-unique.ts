// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
import { createClient } from "viborm";
import { PGliteDriver } from "viborm/pglite";
import { s } from "viborm/schema";
import { client, client as orm, schema } from "./general-schema";

declare const driver: PGliteDriver;
declare const title: string;
declare const isbn: string;
declare const authorId: string;
declare const posts: readonly { authorId: string }[];

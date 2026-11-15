// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
import type { KVNamespace } from "@cloudflare/workers-types";
import { sql } from "viborm";
import { cache } from "viborm/cache";
import { CloudflareKVCache } from "viborm/cache/cloudflare-kv";
import { MemoryCache } from "viborm/cache/memory";
import { createClient } from "viborm/d1";
import type { PGliteDriver } from "viborm/pglite";
import { base, post, schema, user } from "./cache-schema";

declare const driver: PGliteDriver;
declare const env: { CACHE: KVNamespace };
declare const ctx: { waitUntil(promise: Promise<unknown>): void };
declare const id: string;
declare const title: string;
const client = base.$extends(cache({ driver: new MemoryCache() }));

// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
import type {
  D1Database,
  ExecutionContext,
  Queue,
} from "@cloudflare/workers-types";
import { on } from "viborm/on";
import { createClient as createPglite } from "viborm/pglite";
import { s } from "viborm/schema";

const user = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
});
const schema = { user };
const base = createPglite({ schema });

declare const ctx: { waitUntil(promise: Promise<unknown>): void };
declare function syncToMyOtherDatabase(rows: readonly object[]): Promise<void>;
declare function removeFromSearchIndex(ids: readonly string[]): Promise<void>;
declare function sendWelcomeEmails(rows: readonly object[]): Promise<void>;
declare function reportToMyErrorTracker(
  error: Error,
  args: unknown
): Promise<void>;
interface Env {
  readonly DB: D1Database;
  readonly SYNC_QUEUE: Queue;
}
// The Workers handler type, over the DOM's Request and Response this check
// compiles with (a Worker compiles with the Workers' own).
type ExportedHandler<E> = {
  fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response>;
};

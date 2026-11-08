import type { DurableObjectState } from "@cloudflare/workers-types";

export default {
  fetch(): Response {
    return new Response("VibORM Durable Object driver test worker");
  },
};

/**
 * A SQLite-backed Durable Object with nothing of its own: each test runs
 * inside a fresh one through `runInDurableObject` and drives `ctx.storage`.
 */
export class SqlObject {
  readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  fetch(): Response {
    return new Response(null);
  }
}

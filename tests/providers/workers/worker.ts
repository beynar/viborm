export default {
  fetch(): Response {
    return new Response("VibORM D1 test worker");
  },
};

/**
 * SQLite-backed Durable Object whose storage hosts the migration-history
 * suite; the tests reach `ctx.storage` through `runInDurableObject`.
 */
export class EstateHistoryObject {}

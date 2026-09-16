/**
 * Review probe. Claim under attack: `tests/raptor3/g4/lifecycle-admission.test.ts`
 * "C13 cache-bypass: a cached read inside a transaction never serves the cache"
 * is listed in the witness note §2 and the unit brief as one of the five
 * required C13 falsifiers for the CANDIDATE route.
 *
 * The test proves the oracle on the shipped route with three assertions, then
 * runs the candidate route through the block reproduced verbatim below —
 * which contains no assertion at all. This probe substitutes a stand-in
 * "route" that violates cache-bypass in the most complete way available (it
 * never reaches a provider and serves one memoized value forever, inside and
 * outside a transaction) and runs the identical block. If the block passes,
 * the falsifier has no discriminating power over the candidate route.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

interface StandInClient {
  $extends(definition: unknown): StandInClient;
  $withCache(options?: unknown): StandInClient;
  $transaction(work: (tx: StandInClient) => Promise<unknown>): Promise<unknown>;
  $disconnect(): Promise<unknown>;
  record: { findMany(args?: unknown): Promise<unknown> };
}

/** A route that ALWAYS serves the cache. It never reaches a provider. */
function cacheAlwaysRoute(reached: string[]): StandInClient {
  const stale = [{ id: 1, label: "stale", score: 10 }];
  const client: StandInClient = {
    $extends: () => client,
    $withCache: () => client,
    async $transaction(work) {
      return work(client);
    },
    async $disconnect() {
      return undefined;
    },
    record: {
      async findMany() {
        // Deliberately NOT recording a provider round trip: this route serves
        // the cache even inside a transaction, which is exactly the defect the
        // C13 falsifier is named for.
        return stale;
      },
    },
  };
  void reached;
  return client;
}

describe("review probe: C13 cache-bypass falsifier", () => {
  it("passes against a route that never bypasses the cache", async () => {
    const reached: string[] = [];
    const background: Promise<unknown>[] = [];
    const extension = { name: "review-cache-extension" };

    // ---- verbatim candidate section of the witness test ----
    const routed = cacheAlwaysRoute(reached);
    const routedCached = routed.$extends(extension).$withCache();
    await routedCached.record?.findMany({ where: { score: { gte: 10 } } });
    await Promise.all(background.splice(0));
    await routed.$disconnect();
    // ---- end verbatim section ----

    // The block completed without observing anything, so a route that serves a
    // stale cached row inside a transaction satisfies it.
    assert.deepEqual(reached, [], "the block observed a provider round trip");

    // And the defect the falsifier names is genuinely present in the stand-in:
    const inside = await routed.$transaction(async (transaction) =>
      transaction.record.findMany({ where: { score: { gte: 10 } } })
    );
    assert.deepEqual(
      inside,
      [{ id: 1, label: "stale", score: 10 }],
      "the stand-in did not actually serve the cache inside a transaction"
    );
    assert.deepEqual(reached, [], "the stand-in reached a provider after all");
  });
});

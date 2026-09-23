/**
 * The one topology both RQ-05 cache files seed: r → a → a1 → a1x and r → b by
 * foreign key; r → a, r → b, a → d, b → d and d → r by junction — a diamond at
 * d and a cycle back to the root. Each file keeps its own schema (a `node`
 * model with `id`, `label`, `parentId` and the `links` junction) and fills its
 * own extra columns.
 */

/** Every row, as `[id, label, parentId]`. */
const CACHE_WORLD_ROWS = [
  ["r", "Root", null],
  ["a", "A", "r"],
  ["b", "B", "r"],
  ["a1", "A1", "a"],
  ["a1x", "A1x", "a1"],
  ["d", "D", null],
] as const;

/** Every junction link, grouped by its source, as `[from, to[]]`. */
const CACHE_WORLD_LINKS = [
  ["r", ["a", "b"]],
  ["a", ["d"]],
  ["b", ["d"]],
  ["d", ["r"]],
] as const;

/** The two writes of a cache file's `node` delegate that seeding needs. */
interface CacheWorldNode {
  createMany(args: unknown): PromiseLike<unknown>;
  update(args: unknown): PromiseLike<unknown>;
}

/**
 * Seed the topology through the file's own shipped client: one `createMany`
 * of every row with the file's extra columns (`extra(id, index)`), then one
 * `update` per linking row.
 */
export async function seedCacheWorld(
  client: object,
  extra: (id: string, index: number) => Readonly<Record<string, unknown>>
): Promise<void> {
  // The client's delegate is typed by each file's own schema; seeding reads
  // only the two writes every such schema shares.
  const node = Reflect.get(client, "node") as CacheWorldNode;
  await node.createMany({
    data: CACHE_WORLD_ROWS.map(([id, label, parentId], index) => ({
      id,
      label,
      parentId,
      ...extra(id, index),
    })),
  });
  for (const [from, to] of CACHE_WORLD_LINKS)
    await node.update({
      where: { id: from },
      data: { links: { connect: to.map((id) => ({ id })) } },
    });
}

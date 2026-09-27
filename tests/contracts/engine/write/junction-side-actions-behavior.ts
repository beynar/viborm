import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { ForeignKeyError } from "@errors";
import { createMigrationClient } from "@migrations";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * Issue #46 — one junction, two foreign keys, two policies, on a real database.
 *
 * The owner is `post`, and `post` sorts SECOND: the physical junction puts the
 * `label` side first. So an implementation that read `source` / `target` as the
 * alphabetical column order would attach `cascade` to the label key and this
 * suite's protective refusals would silently succeed. `source` is the key to
 * the declaring model (post), `target` the key to its target (label).
 *
 *   · deleting a post cascades ITS memberships and no others;
 *   · deleting an assigned label is refused (`noAction`) and keeps the label
 *     and every membership;
 *   · changing a post key cascades into the junction (`onUpdate.source`);
 *   · changing an assigned label key is refused (`onUpdate.target: restrict`);
 *   · a nested `delete` through a post removes THAT post's membership first,
 *     so the key protects a label only while another post still holds it.
 *
 * Around them, the migration facts only a live catalog settles: a second push
 * is a no-op, moving the one configuration to the other endpoint (with its
 * sides swapped) is a no-op, and changing one side's policy touches only the
 * junction.
 */

const ownedByPost = () => {
  const label = s.model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    labels: s
      .toMany(() => label)
      .onDelete({ source: "cascade", target: "noAction" })
      .onUpdate({ source: "cascade", target: "restrict" }),
  });
  return { label, post };
};

/** The same physical policy, declared from the other endpoint. */
const ownedByLabel = () => {
  const label = s.model({
    id: s.string().id(),
    name: s.string(),
    posts: s
      .toMany(() => post)
      .onDelete({ source: "noAction", target: "cascade" })
      .onUpdate({ source: "restrict", target: "cascade" }),
  });
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    labels: s.toMany(() => label),
  });
  return { label, post };
};

/** One side's policy changed: the label key now `restrict` on delete. */
const labelSideRestricted = () => {
  const label = s.model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    labels: s
      .toMany(() => label)
      .onDelete({ source: "cascade", target: "restrict" })
      .onUpdate({ source: "cascade", target: "restrict" }),
  });
  return { label, post };
};

const JUNCTION = "label_post";

export function runJunctionSideActionsBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}): void {
  describe(`${options.name} asymmetric junction actions (#46)`, () => {
    const driver = options.createDriver();
    const client = createClient({ schema: ownedByPost(), driver });

    const labelsOf = async (postId: string) =>
      (
        await client.post.findUniqueOrThrow({
          where: { id: postId },
          include: { labels: { orderBy: { id: "asc" } } },
        })
      ).labels.map((label) => label.id);
    const postsOf = async (labelId: string) =>
      (
        await client.label.findUniqueOrThrow({
          where: { id: labelId },
          include: { posts: { orderBy: { id: "asc" } } },
        })
      ).posts.map((post) => post.id);

    beforeAll(async () => {
      await syncLiveSchema(client);
      await client.label.createMany({
        data: [
          { id: "l1", name: "one" },
          { id: "l2", name: "two" },
          { id: "l3", name: "three" },
        ],
      });
      await client.post.create({
        data: {
          id: "p1",
          title: "first",
          labels: { connect: [{ id: "l1" }, { id: "l2" }] },
        },
      });
      await client.post.create({
        data: {
          id: "p2",
          title: "second",
          labels: { connect: [{ id: "l1" }] },
        },
      });
    });

    afterAll(async () => {
      await client.$disconnect();
    });

    test("a second push of the same declaration is a no-op", async () => {
      const again = await createMigrationClient(client).push({ dryRun: true });
      expect(again.operations).toEqual([]);
    });

    test("the configuration declared from the other endpoint is a no-op", async () => {
      const inverted = createClient({ schema: ownedByLabel(), driver });
      const plan = await createMigrationClient(inverted).push({ dryRun: true });
      expect(plan.operations).toEqual([]);
    });

    test("changing one side's policy plans work on the junction alone", async () => {
      const changed = createClient({ schema: labelSideRestricted(), driver });
      const plan = await createMigrationClient(changed).push({ dryRun: true });
      // ONE foreign key is replaced; the post side's key is not touched.
      expect(plan.operations.map((operation) => operation.label)).toEqual([
        "dropForeignKey",
        "addForeignKey",
      ]);
      const touched = plan.statements
        .map((statement) => statement.sql)
        .filter((sql) => !sql.startsWith("PRAGMA"));
      expect(touched.length).toBeGreaterThan(0);
      expect(touched.every((sql) => sql.includes(JUNCTION))).toBe(true);
    });

    test("deleting an assigned label is refused and keeps every membership", async () => {
      await expect(
        client.label.delete({ where: { id: "l1" } })
      ).rejects.toBeInstanceOf(ForeignKeyError);
      expect(await postsOf("l1")).toEqual(["p1", "p2"]);
      expect(await labelsOf("p1")).toEqual(["l1", "l2"]);
    });

    test("an unassigned label still deletes: the refusal is the key's, not the table's", async () => {
      await client.label.delete({ where: { id: "l3" } });
      expect(await client.label.count()).toBe(2);
    });

    test("deleting a post cascades its own memberships and no others", async () => {
      await client.post.delete({ where: { id: "p1" } });
      expect(await postsOf("l1")).toEqual(["p2"]);
      expect(await postsOf("l2")).toEqual([]);
      expect(await client.label.count()).toBe(2);
    });

    test("changing a post key cascades into the junction", async () => {
      await client.post.update({ where: { id: "p2" }, data: { id: "p2b" } });
      expect(await postsOf("l1")).toEqual(["p2b"]);
    });

    test("changing an assigned label key is refused and keeps the label", async () => {
      await expect(
        client.label.update({ where: { id: "l1" }, data: { id: "l1b" } })
      ).rejects.toBeInstanceOf(ForeignKeyError);
      expect(await postsOf("l1")).toEqual(["p2b"]);
      expect(await client.label.findUnique({ where: { id: "l1b" } })).toBe(
        null
      );
    });

    test("a nested delete through a post removes that post's membership first", async () => {
      await client.label.create({ data: { id: "l4", name: "four" } });
      await client.post.create({
        data: {
          id: "p3",
          title: "third",
          labels: { connect: [{ id: "l1" }, { id: "l4" }] },
        },
      });
      // `l1` is still held by `p2b`: the protective key refuses, and the
      // whole update is undone, `p3`'s own membership included.
      await expect(
        client.post.update({
          where: { id: "p3" },
          data: { labels: { delete: [{ id: "l1" }] } },
        })
      ).rejects.toBeInstanceOf(ForeignKeyError);
      expect(await postsOf("l1")).toEqual(["p2b", "p3"]);
      expect(await labelsOf("p3")).toEqual(["l1", "l4"]);
      // `l4` is held by `p3` alone: once its membership is gone, nothing
      // protects it.
      await client.post.update({
        where: { id: "p3" },
        data: { labels: { delete: [{ id: "l4" }] } },
      });
      expect(await client.label.findUnique({ where: { id: "l4" } })).toBe(null);
      expect(await labelsOf("p3")).toEqual(["l1"]);
    });
  });
}

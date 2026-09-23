/**
 * Review probe. Adversarial cases the unit brief names explicitly and the
 * fixed witnesses do not contain:
 *
 *  - "nested pagination with two parents sharing children" — the witnesses'
 *    Q-P03 windows `posts`, where every child belongs to exactly one parent.
 *    The one genuinely shared collection in the world is the `tags` junction
 *    (tag 2 belongs to acme/ada AND acme/bob) and no witness windows it.
 *  - "a mapped compound key omitted from projection" — OP-R01 omits it on a
 *    flat row, but no witness omits it while a nested collection still has to
 *    be stitched to that parent.
 *  - "an insensitive mode with a non-ASCII value" — Q-W04 is ASCII only.
 *  - "a list containing NULL" — no seeded list has a NULL member.
 *
 * Each cell runs the hand value against the SHIPPED engine first, exactly as
 * `expectRead` does, so a wrong hand value fails before the candidate is
 * reached.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  AUTHOR_TABLE,
  relationWorldSchema,
  seedJunctions,
  seedRelationWorld,
} from "../../read-schema";
import {
  createWitnessWorld,
  expectRead,
  observeFailure,
  type WitnessWorld,
} from "../../witness-world";

describe("review probe: cases the fixed witnesses leave uncovered", () => {
  let world: WitnessWorld;

  beforeEach(async () => {
    world = await createWitnessWorld(relationWorldSchema(), {
      foreignKeys: false,
      seed(database) {
        seedRelationWorld(database);
        seedJunctions(database);
      },
    });
  });

  afterEach(async () => {
    await world?.close();
  });

  it("windows a junction collection whose member is shared by two parents", async () => {
    // tag 2 ("beta") is a member of BOTH acme/ada and acme/bob. A per-parent
    // window must give each parent its own first member, not one global window.
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { tenant: "acme" },
        orderBy: { handle: "asc" },
        select: {
          handle: true,
          tags: { orderBy: { id: "desc" }, take: 1, select: { label: true } },
        },
      },
      [
        { handle: "ada", tags: [{ label: "beta" }] },
        { handle: "bob", tags: [{ label: "beta" }] },
        { handle: "cy", tags: [] },
      ]
    );
  });

  it("stitches a nested collection when the mapped compound key is not projected", async () => {
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { tenant: "acme" },
        orderBy: { handle: "asc" },
        select: {
          name: true,
          posts: { orderBy: { id: "asc" }, select: { slug: true } },
        },
      },
      [
        { name: "Ada", posts: [{ slug: "p-one" }, { slug: "p-two" }] },
        { name: "Bob", posts: [{ slug: "p-three" }] },
        { name: "Cy", posts: [] },
      ]
    );
  });

  it("records what `mode: insensitive` does to a non-ASCII value", async () => {
    world.database.exec(`
      INSERT INTO ${AUTHOR_TABLE}
        (tenant_key, author_handle, display_name, author_rank, author_score, author_bio, mentor_tenant_key, mentor_handle)
      VALUES ('mark','acc','ÉCOLE',9,NULL,NULL,NULL,NULL);
    `);
    const shipped = await world.shipped.author?.findMany?.({
      where: { name: { contains: "école", mode: "insensitive" } },
      select: { handle: true },
    });
    // SQLite's LIKE folds ASCII only; the shipped engine therefore finds
    // nothing. The point is that no witness pins this, so a candidate that
    // folded Unicode (or refused) would agree with no recorded expectation.
    assert.deepEqual(
      shipped,
      [],
      "the shipped engine folds non-ASCII case after all — then the missing witness matters more, not less"
    );
  });

  it("records what a NULL member inside a scalar list does", async () => {
    // The relation world has no list column, so this uses the junction-free
    // path: a NULL inside a JSON-encoded list is a physical shape no seeded
    // specimen carries. Reading it back is the boundary no witness pins.
    world.database.exec(
      `UPDATE ${AUTHOR_TABLE} SET author_bio = NULL WHERE author_handle = 'ada' AND tenant_key = 'acme'`
    );
    const shipped = await world.shipped.author?.findMany?.({
      where: { bio: null },
      orderBy: [{ tenant: "asc" }, { handle: "asc" }],
      select: { tenant: true, handle: true },
    });
    assert.deepEqual(shipped, [
      { tenant: "acme", handle: "ada" },
      { tenant: "acme", handle: "bob" },
      { tenant: "beta", handle: "ada" },
    ]);
    const candidate = await world.candidate.execute("author", "findMany", {
      where: { bio: null },
      orderBy: [{ tenant: "asc" }, { handle: "asc" }],
      select: { tenant: true, handle: true },
    });
    assert.deepStrictEqual(candidate, shipped);
  });

  it("refuses a nested typo placed beside a valid key", async () => {
    const args = {
      where: { tenant: "acme" },
      select: {
        handle: true,
        posts: { orderBy: { id: "asc" }, select: { slug: true, slugg: true } },
      },
    };
    const shipped = await observeFailure(() =>
      Promise.resolve(world.shipped.author?.findMany?.(args))
    );
    assert.equal(shipped.name, "ValidationError", shipped.message);
    const candidate = await observeFailure(() =>
      world.candidate.execute("author", "findMany", args)
    );
    assert.equal(
      candidate.name,
      shipped.name,
      `the candidate raised ${candidate.name} (${candidate.message})`
    );
  });
});

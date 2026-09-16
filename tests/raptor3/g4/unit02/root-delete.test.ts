/**
 * G4-02 — root `delete` (OP-W03) and the whole-value assignment repair.
 *
 * Root `delete` is the selected-row removal owner plus ONE cardinality: a
 * RETURNING adapter carries the removed row on the DELETE itself; a provider
 * without RETURNING, or a projection that names a relation, keeps the same
 * owner's locked capture — the row's shape is read BEFORE the removal.
 */

import assert from "node:assert/strict";
import { NotFoundError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterEach, describe, it } from "vitest";
import { createWorld, worldSchema, type World } from "./world";

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

function engineOf(current: World) {
  return createCommandEngine({ schema: worldSchema, driver: current.driver });
}

function remaining(current: World): number {
  return Number(
    current.database.prepare("SELECT COUNT(*) FROM g4u2_authors").pluck().get()
  );
}

describe("G4-02 root delete", () => {
  it("removes one located row and publishes its default projection in one statement", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    world.driver.reset();
    const value = await engine.execute("author", "delete", {
      where: { id: 2 },
    });
    assert.deepEqual(value, { id: 2, name: "Bo", age: 41, avatar: null });
    assert.equal(world.driver.statements.length, 1);
    assert.equal(world.driver.transactionCalls, 0);
    assert.match(world.driver.statements[0]?.sql ?? "", /^DELETE\b/);
    assert.equal(remaining(world), 1);
  });

  it("publishes the requested projection, not the whole row", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    const value = await engine.execute("author", "delete", {
      where: { id: 2 },
      select: { name: true },
    });
    assert.deepEqual(value, { name: "Bo" });
  });

  it("keeps one not-found identity across the two seams and removes nothing", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    const shipped = await world.client.author
      .delete({ where: { id: 99 } })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    const candidate = await engine
      .execute("author", "delete", { where: { id: 99 } })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    assert.ok(shipped instanceof NotFoundError);
    assert.ok(candidate instanceof NotFoundError);
    assert.equal(
      (candidate as NotFoundError).message,
      (shipped as NotFoundError).message
    );
    assert.equal(remaining(world), 2);
  });

  it("reads a relation projection BEFORE the row is gone", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    world.driver.reset();
    const value = await engine.execute("author", "delete", {
      where: { id: 1 },
      select: { id: true, posts: { orderBy: { id: "asc" }, select: { id: true } } },
    });
    assert.deepEqual(value, { id: 1, posts: [{ id: 10 }, { id: 11 }] });
    const kinds = world.driver.statements.map(
      (statement) => statement.sql.match(/^\w+/)?.[0]
    );
    assert.deepEqual(kinds, ["SELECT", "SELECT", "DELETE"]);
    assert.equal(world.driver.transactionCalls, 1);
    assert.equal(remaining(world), 1);
  });

  it("delete is admitted as a verb and refuses nothing it used to answer", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    const shipped = await world.client.post.delete({ where: { id: 12 } });
    const candidate = await engine.execute("post", "delete", {
      where: { id: 11 },
    });
    assert.deepEqual(shipped, {
      id: 12,
      title: "third",
      rank: 3,
      authorId: 2,
    });
    assert.deepEqual(candidate, {
      id: 11,
      title: "second",
      rank: 2,
      authorId: 1,
    });
  });
});

describe("G4-02 whole-value assignment", () => {
  it("writes a Uint8Array as one blob value, not as its inherited set", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    const bytes = new Uint8Array([1, 2, 250]);
    const created = (await engine.execute("author", "create", {
      data: { id: 3, name: "Cy", age: 20, avatar: bytes },
    })) as { avatar: unknown };
    assert.deepEqual(created.avatar, bytes);
    const updated = (await engine.execute("author", "update", {
      where: { id: 3 },
      data: { avatar: new Uint8Array([9]) },
    })) as { avatar: unknown };
    assert.deepEqual(updated.avatar, new Uint8Array([9]));
  });
});

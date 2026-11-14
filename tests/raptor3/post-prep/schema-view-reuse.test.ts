import assert from "node:assert/strict";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import {
  bindMembership,
  physicalField,
} from "@query-engine/raptor3/shared/storage";
import { s } from "@schema";
import { describe, it } from "vitest";

describe("post-G3 immutable schema views", () => {
  it("reuses views by exact model, slot, and variant identity", () => {
    const post = s.model({ id: s.string().id(), title: s.string() });
    const image = s.model({ id: s.string().id(), url: s.string() });
    const board = s.model({
      id: s.string().id(),
      items: s.toMany({ post: () => post, image: () => image }),
    });
    const schema = new EngineSchema({ post, image, board });

    const id = physicalField(schema, board, "id");
    assert.equal(physicalField(schema, board, "id"), id);

    const fields = schema.storedFields(board);
    assert.equal(schema.storedFields(board), fields);

    const posts = bindMembership(schema, board, "items", "post");
    const images = bindMembership(schema, board, "items", "image");
    assert.equal(bindMembership(schema, board, "items", "post"), posts);
    assert.notEqual(posts, images);

    const resolved = schema.index.get(board)!.get("items")!;
    const clearability = schema.clearability(resolved);
    assert.equal(schema.clearability(resolved), clearability);
    assert.equal(posts.clearability, clearability);

    const owner = s
      .model({
        tenant: s.string(),
        code: s.string(),
        children: s.toMany(() => child),
      })
      .id(["tenant", "code"]);
    const child = s.model({
      id: s.string().id(),
      tenant: s.string(),
      ownerCode: s.string().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("tenant", "ownerCode")
        .references("tenant", "code"),
    });
    const referenceSchema = new EngineSchema({ owner, child });
    const reference = bindMembership(referenceSchema, child, "owner");
    assert.equal(reference.clearability.kind, "columns");
    if (reference.clearability.kind === "columns") {
      assert.deepEqual(reference.clearability.fields, ["ownerCode"]);
    }
  });
});

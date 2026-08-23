import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { SchemaValidator } from "@src/schema/validation";
import {
  type ResolvedRelationEdge,
  resolvedEdges,
} from "@src/schema/validation/relation-resolution";
import { describe, expect, it } from "vitest";

/**
 * WHAT THE TRUSTED INDEX IS (plan §6.1, §6.6; falsifiers §11.2.19, §11.3.11).
 *
 * One contextual slot map — `model → field → ResolvedSlot` — and nothing else.
 * Edge enumeration is DERIVED from it by walking canonical order and yielding
 * each edge at its own anchor, so there is no second `edges` collection to keep
 * synchronized with the first. An inverse view is exactly that: the SAME edge
 * object, plus the exact member object the carrier edge already holds.
 */

function resolve(schema: Record<string, AnyModel>) {
  hydrateSchemaNames(schema);
  const resolution = new SchemaValidator().registerAll(schema).resolve();
  if (!resolution.ok) {
    throw new Error(
      `fixture did not resolve: ${resolution.issues.map((i) => i.code).join(", ")}`
    );
  }
  return resolution;
}

/** Ordinary pair, self pair, ordinary junction, row carrier, member junction. */
function everyEdgeFamily() {
  const user = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
    tags: s.toMany(() => tag),
  });
  const tag = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
  const node = s.model({
    id: s.string().id(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => node)
      .name("Tree")
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => node).name("Tree"),
  });
  const clip = s.model({
    id: s.string().id(),
    notes: s.toMany(() => note).name("about"),
  });
  const note = s.model({
    id: s.string().id(),
    about: s.toOne({ clip: () => clip }).name("about"),
  });
  const shelf = s.model({
    id: s.string().id(),
    items: s.toMany({ note: () => note }),
  });
  return { user, post, tag, node, clip, note, shelf };
}

describe("the resolved index", () => {
  it("stores one contextual slot map and no edges array", () => {
    const resolution = resolve(everyEdgeFamily());

    expect(resolution).not.toHaveProperty("edges");
    expect(resolution.index).toBeInstanceOf(Map);
    for (const slots of resolution.index.values()) {
      for (const resolved of slots.values()) {
        expect(Object.keys(resolved).sort()).toEqual(
          resolved.member ? ["edge", "member", "slot"] : ["edge", "slot"]
        );
      }
    }
  });

  it("enumerates every edge exactly once, at its canonical anchor", () => {
    const schema = everyEdgeFamily();
    const resolution = resolve(schema);
    const edges = [...resolvedEdges(resolution.index)];

    // Five edge families, no duplicates and nothing missing. `user.posts` is
    // absent because a foreign key anchors at its OWNER, which is `post.author`
    // — the anchor rule is what keeps carrier storage in the carrier's
    // historical serializer position when an inverse model sorts earlier.
    expect(edges.map(anchorOf)).toEqual([
      "post.author:foreignKey",
      "post.tags:junction",
      "node.parent:foreignKey",
      "note.about:variantRowCarrier",
      "shelf.items:variantJunctionCarrier",
    ]);
    expect(new Set(edges).size).toBe(edges.length);
  });

  it("gives the two endpoints of an ordinary edge the SAME edge object", () => {
    const schema = everyEdgeFamily();
    const { index } = resolve(schema);

    expect(index.get(schema.post)?.get("author")?.edge).toBe(
      index.get(schema.user)?.get("posts")?.edge
    );
    expect(index.get(schema.post)?.get("tags")?.edge).toBe(
      index.get(schema.tag)?.get("posts")?.edge
    );
  });
});

describe("a variant carrier lookup", () => {
  it("returns the shared edge with NO member view", () => {
    const schema = everyEdgeFamily();
    const { index } = resolve(schema);
    const carrier = index.get(schema.note)?.get("about");

    expect(carrier?.edge.kind).toBe("variantRowCarrier");
    expect(carrier?.member).toBeUndefined();
  });

  it("gives a bound inverse that same edge and the EXACT member object", () => {
    const schema = everyEdgeFamily();
    const { index } = resolve(schema);
    const carrier = index.get(schema.note)?.get("about");
    const inverse = index.get(schema.clip)?.get("notes");

    expect(inverse?.edge).toBe(carrier?.edge);
    const edge = carrier?.edge;
    if (edge?.kind !== "variantRowCarrier") throw new Error("wrong edge kind");
    // Identity, not equality: the inverse view copies no target, storage,
    // uniqueness or action fact — it points at the record the carrier owns.
    expect(inverse?.member).toBe(edge.members[0]);
  });

  it("creates no inverse slot entry for a direct-only member", () => {
    const schema = everyEdgeFamily();
    const { index } = resolve(schema);
    const shelfItems = index.get(schema.shelf)?.get("items");

    expect(shelfItems?.edge.kind).toBe("variantJunctionCarrier");
    // `note` has no slot bound to shelf.items, and none was invented for it.
    expect([...(index.get(schema.note)?.keys() ?? [])]).toEqual(["about"]);
  });
});

function anchorOf(edge: ResolvedRelationEdge): string {
  if (edge.kind === "foreignKey") {
    return `${edge.owner.source["~"].names.ts}.${edge.owner.field}:foreignKey`;
  }
  if (edge.kind === "junction") {
    const [first] = edge.endpoints;
    return `${first.source["~"].names.ts}.${first.field}:junction`;
  }
  return `${edge.carrier.source["~"].names.ts}.${edge.carrier.field}:${edge.kind}`;
}

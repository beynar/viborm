import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { SchemaValidator, validateSchema } from "@src/schema/validation";
import { describe, expect, it } from "vitest";

/**
 * PAIRING IS A GRAPH, NOT A LADDER (plan §6.2; falsifiers §11.2.8-10, 23).
 *
 * HEAD resolved an inverse by walking a precedence ladder — a named polymorphic
 * match, then the first ordinary candidate, then a sole-variant convenience rule
 * — and, crucially, a SOLE candidate resolved whatever either side was named.
 * This file is where the pins that documented that behaviour now live (ruling
 * D22): candidates are collected structurally, partitioned by the EXACT name
 * claim, and only then counted.
 */

function codes(schema: Record<string, AnyModel>): string[] {
  hydrateSchemaNames(schema);
  return validateSchema(schema).errors.map((issue) => issue.code);
}

function resolves(schema: Record<string, AnyModel>): boolean {
  hydrateSchemaNames(schema);
  return new SchemaValidator().registerAll(schema).resolve().ok;
}

// =============================================================================
// THE EXACT NAME PARTITION (§11.2.8) — D22's moved sole-candidate pins
// =============================================================================

/** One structurally unique pair, with whatever names the case gives it. */
function solePair(
  userName: string | undefined,
  postName: string | undefined
): Record<string, AnyModel> {
  const posts = s.toMany(() => post);
  const author = s
    .toOne(() => user)
    .fields("authorId")
    .references("id");
  const user = s.model({
    id: s.string().id(),
    posts: userName === undefined ? posts : posts.name(userName),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    author: postName === undefined ? author : author.name(postName),
  });
  return { user, post };
}

describe("the exact relation-name partition", () => {
  it("pairs an unnamed sole candidate with an unnamed slot", () => {
    expect(resolves(solePair(undefined, undefined))).toBe(true);
  });

  it("pairs two endpoints that claim the SAME name", () => {
    expect(resolves(solePair("PostAuthor", "PostAuthor"))).toBe(true);
  });

  it.each([
    ["named on one side only", "PostAuthor", undefined],
    ["named on the other side only", undefined, "PostAuthor"],
    ["named differently on both sides", "PostAuthor", "AuthoredPost"],
  ])("refuses a sole candidate %s — a name is a verdict, not a fallback", (_label, userName, postName) => {
    // HEAD resolved every one of these, because a SOLE candidate won
    // regardless of names (`inverse.ts:257-259`, documented as deliberate at
    // `relation/types.ts:206-207`). §6.2 rule 3 makes each one `nameMismatch`.
    expect(codes(solePair(userName, postName))).toEqual(["R010"]);
  });

  it("keeps two matching-name pairs between the same models separate", () => {
    const user = s.model({
      id: s.string().id(),
      written: s.toMany(() => post).name("Author"),
      edited: s.toMany(() => post).name("Editor"),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      editorId: s.string(),
      author: s
        .toOne(() => user)
        .name("Author")
        .fields("authorId")
        .references("id"),
      editor: s
        .toOne(() => user)
        .name("Editor")
        .fields("editorId")
        .references("id"),
    });
    const schema = { user, post };
    hydrateSchemaNames(schema);
    const resolution = new SchemaValidator().registerAll(schema).resolve();

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    // Each pair is one edge; `written` never sees `editor`.
    expect(resolution.index.get(user)?.get("written")?.edge).toBe(
      resolution.index.get(post)?.get("author")?.edge
    );
    expect(resolution.index.get(user)?.get("edited")?.edge).toBe(
      resolution.index.get(post)?.get("editor")?.edge
    );
    expect(resolution.index.get(user)?.get("written")?.edge).not.toBe(
      resolution.index.get(user)?.get("edited")?.edge
    );
  });

  it("refuses two candidates that claim the same name", () => {
    const user = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post).name("Author"),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      editorId: s.string(),
      author: s
        .toOne(() => user)
        .name("Author")
        .fields("authorId")
        .references("id"),
      editor: s
        .toOne(() => user)
        .name("Author")
        .fields("editorId")
        .references("id"),
    });

    expect(codes({ user, post })).toContain("R009");
  });

  it("never creates a pair between structurally incompatible targets", () => {
    const user = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post).name("Shared"),
    });
    const post = s.model({ id: s.string().id() });
    const tag = s.model({
      id: s.string().id(),
      // Same name, but this slot's target is `tag`, not `user`.
      selves: s.toMany(() => tag).name("Shared"),
    });

    // `user.posts` has no candidate on `post` at all; the matching name on an
    // unrelated model is not one.
    expect(codes({ user, post, tag })).toContain("R002");
  });
});

// =============================================================================
// NO PRECEDENCE (§11.2.9)
// =============================================================================

describe("candidate counting", () => {
  it("does not prefer an ordinary candidate over a variant member", () => {
    const post = s.model({
      id: s.string().id(),
      comments: s.toMany(() => comment),
    });
    const comment = s.model({
      id: s.string().id(),
      postId: s.string(),
      // An ordinary candidate…
      post: s
        .toOne(() => post)
        .fields("postId")
        .references("id"),
      // …and a variant member, both targeting `post`, neither named.
      subject: s.toOne({ post: () => post }),
    });

    expect(codes({ post, comment })).toEqual(["R009"]);
  });

  it("keeps a mismatched pair's ONE diagnostic on the slot that must pair", () => {
    // §6.2 rule 4 evaluates the count AFTER the partition, so the MEMBER here
    // has zero candidates — a valid direct-only member — and only `post.comments`
    // fails. The carrier is declared FIRST on purpose: the mismatch is reported
    // once, at the canonically first disagreeing endpoint, so a member that also
    // claimed `nameMismatch` would take the pair's only diagnostic away from the
    // slot that cannot resolve.
    const comment = s.model({
      id: s.string().id(),
      subject: s.toOne({ post: () => post }),
    });
    const post = s.model({
      id: s.string().id(),
      comments: s.toMany(() => comment).name("subject"),
    });
    const schema = { comment, post };
    hydrateSchemaNames(schema);

    const errors = validateSchema(schema).errors;
    expect(errors.map((issue) => issue.code)).toEqual(["R010"]);
    expect(errors[0]?.model).toBe("post");
    expect(errors[0]?.relation).toBe("comments");
  });

  it("reports the competing paths so the repair is spellable", () => {
    const post = s.model({
      id: s.string().id(),
      comments: s.toMany(() => comment),
    });
    const comment = s.model({
      id: s.string().id(),
      postId: s.string(),
      post: s
        .toOne(() => post)
        .fields("postId")
        .references("id"),
      subject: s.toOne({ post: () => post }),
    });
    hydrateSchemaNames({ post, comment });

    const [issue] = validateSchema({ post, comment }).errors;
    expect(issue?.candidates).toEqual(["comment.post", "comment.subject.post"]);
    expect(issue?.repair).toContain(".name(");
  });
});

// =============================================================================
// SELF RELATIONS (§11.2.10)
// =============================================================================

describe("self relations", () => {
  it("refuses a lone self slot — the asking slot is not its own inverse", () => {
    const node = s.model({ id: s.string().id(), links: s.toMany(() => node) });

    expect(codes({ node })).toEqual(["R002"]);
  });

  it("resolves two distinct self slots", () => {
    const node = s.model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node),
    });

    expect(resolves({ node })).toBe(true);
  });

  it("keeps two distinctly named self pairs from crossing", () => {
    const person = s.model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      managerId: s.string().nullable(),
      parent: s
        .toOne(() => person)
        .name("Lineage")
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => person).name("Lineage"),
      manager: s
        .toOne(() => person)
        .name("Reports")
        .fields("managerId")
        .references("id"),
      reports: s.toMany(() => person).name("Reports"),
    });
    const schema = { person };
    hydrateSchemaNames(schema);
    const resolution = new SchemaValidator().registerAll(schema).resolve();

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.index.get(person)?.get("parent")?.edge).toBe(
      resolution.index.get(person)?.get("children")?.edge
    );
    expect(resolution.index.get(person)?.get("parent")?.edge).not.toBe(
      resolution.index.get(person)?.get("manager")?.edge
    );
  });
});

// =============================================================================
// A DYNAMIC NAME (§11.2.23, runtime half)
// =============================================================================

describe("a dynamically supplied relation name", () => {
  it("resolves when both endpoints carry the same runtime value", () => {
    // The TYPE surface cannot prove `string` equals `string`, so it stays
    // conservative (§11.2.23's static half). The RUNTIME graph compares the
    // settled values and resolves the edge.
    const dynamic: string = ["Post", "Author"].join("");
    const user = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post).name(dynamic),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .name(dynamic)
        .fields("authorId")
        .references("id"),
    });

    expect(resolves({ user, post })).toBe(true);
  });
});

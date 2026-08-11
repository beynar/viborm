import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { QueryEngineError } from "@errors";
import {
  bindRelation,
  findInverseRelationState,
} from "@query-engine/builders/relation-data-builder";
import { createQueryScope, getRelationInfo } from "@query-engine/context";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import { getPolymorphicInverseBinding } from "@schema/relation";
import { getInverseRelationMap } from "@schema/relation/types";
import { describe, expect, test } from "vitest";

/**
 * **Unit 2.1 — the pre-change parity pin for inverse resolution.**
 *
 * Two independent runtime scanners answer "which back-reference on the target model
 * carries this relation's foreign key", and Phase 2 is about to give that question one
 * owner:
 *
 *  · `getInverseRelationMap` (`src/schema/relation/types.ts`) — the OPERATION-SCHEMA
 *    scanner. Its answer is the key set a nested `create`/`update` omits, so it decides
 *    what a caller may spell;
 *  · `findInverseRelationState` (`src/query-engine/builders/relation-data-builder.ts`) —
 *    the ENGINE scanner, reached through `bindRelation`. Its answer is the column the
 *    engine writes and correlates on.
 *
 * Every case below asserts BOTH answers side by side, including the cases where they
 * DISAGREE. The disagreements are pinned deliberately: they are the pre-change truth, so
 * that Phase 2's resolver migration (which must preserve every answer) and Phase 2's
 * later, isolated behaviour commit (which changes some of them on purpose) are told apart
 * by which of these pins move. A pin that changes without a commit that says it will is
 * the failure this file exists to make loud.
 *
 * The two open axes, as measured at this HEAD:
 *
 *  1. **empty `.fields()`** — `getInverseRelationMap` tests `state.fields` for TRUTHINESS
 *     (`[]` is truthy) at both the owner-side short-circuit and the candidate filter,
 *     while `bindRelation`/`findInverseRelationState` test `fields.length > 0`. Cases 9,
 *     10 and the second half of case 12. This is the plan's named axis and the recorded
 *     retirement condition of the owned-FK guard.
 *  2. **ambiguity** — with two or more fields-bearing back-references and no `.name()`
 *     that picks one, `getInverseRelationMap` silently answers with the FIRST declared
 *     candidate (or `undefined` when a name matches none) while the engine scanner throws
 *     `QueryEngineError: Ambiguous relation …`. Cases 4 and 6. The plan preamble records
 *     that this axis was found at Phase 0 and is not named by §4.6's sketch.
 *
 * The engine scanner is only ever consulted for a relation that does NOT hold its own
 * `.fields()`; `bindRelation` short-circuits owner-side relations before reaching it
 * (`relation-data-builder.ts:124`). Where an owner-side `findInverseRelationState` answer
 * is pinned below it is labelled as unreachable-in-production, because a resolver that
 * "fixes" it would be changing something nothing reads.
 */

const adapter = new PostgresAdapter();

const relationInfoOf = (model: Model<any>, relationKey: string) => {
  const scope = createQueryScope(adapter, model);
  const relationInfo = getRelationInfo(scope, relationKey);
  if (!relationInfo) {
    throw new Error(`Expected relation '${relationKey}' on the fixture model.`);
  }
  return { scope, relationInfo };
};

/** The operation-schema scanner's answer for one relation key. */
const scanMap = (model: Model<any>, relationKey: string) =>
  getInverseRelationMap(
    model["~"].state.relations[relationKey]["~"].state,
    model
  );

/** The engine scanner's answer for the same relation key. */
const scanEngine = (model: Model<any>, relationKey: string) => {
  const { relationInfo } = relationInfoOf(model, relationKey);
  return findInverseRelationState(model, relationInfo);
};

/** What the engine actually binds — the scanner's only production consumer. */
const bind = (model: Model<any>, relationKey: string) => {
  const { scope, relationInfo } = relationInfoOf(model, relationKey);
  return bindRelation(scope, relationInfo);
};

describe("inverse resolution parity", () => {
  describe("1. named inverse on both sides", () => {
    const user = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => post).name("author"),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .manyToOne(() => user)
        .fields("authorId")
        .references("id")
        .name("author"),
    });

    test("both scanners resolve the matched pair", () => {
      expect(scanMap(user, "posts")).toEqual(["authorId"]);
      expect(scanEngine(user, "posts")).toEqual({
        fields: ["authorId"],
        references: ["id"],
        onUpdate: undefined,
      });
      expect(bind(user, "posts")).toMatchObject({
        kind: "childHeldToMany",
        foreignFields: ["authorId"],
        referencedFields: ["id"],
      });
    });

    test("the owner side answers from its own fields", () => {
      expect(scanMap(post, "author")).toEqual(["authorId"]);
      expect(bind(post, "author")).toMatchObject({
        kind: "parentHeldToOne",
        foreignFields: ["authorId"],
        referencedFields: ["id"],
      });

      // The engine's owner-side answer lives in `bindRelation`'s own short-circuit, so
      // the scanner is never asked here. Asked anyway, it looks for a fields-bearing
      // to-one on `user` pointing back at `post` and finds none.
      expect(scanEngine(post, "author")).toBeUndefined();
    });
  });

  describe("2. sole back-reference whose name does not echo the source's", () => {
    const author = s.model({
      id: s.string().id(),
      books: s.oneToMany(() => book).name("writer"),
    });
    const book = s.model({
      id: s.string().id(),
      authorId: s.string(),
      // No `.name()`: the sole back-reference IS the edge whatever either side spelled.
      author: s
        .manyToOne(() => author)
        .fields("authorId")
        .references("id"),
    });

    const shelf = s.model({
      id: s.string().id(),
      volumes: s.oneToMany(() => volume),
    });
    const volume = s.model({
      id: s.string().id(),
      shelfId: s.string(),
      shelf: s
        .manyToOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("stack"),
    });

    test("a named source resolves an unnamed sole candidate (D5/TH, aligned)", () => {
      expect(scanMap(author, "books")).toEqual(["authorId"]);
      expect(scanEngine(author, "books")).toEqual({
        fields: ["authorId"],
        references: ["id"],
        onUpdate: undefined,
      });
      expect(bind(author, "books")).toMatchObject({
        kind: "childHeldToMany",
        foreignFields: ["authorId"],
        referencedFields: ["id"],
      });
    });

    test("an unnamed source resolves a named sole candidate", () => {
      expect(scanMap(shelf, "volumes")).toEqual(["shelfId"]);
      expect(scanEngine(shelf, "volumes")).toEqual({
        fields: ["shelfId"],
        references: ["id"],
        onUpdate: undefined,
      });
    });
  });

  describe("3. missing inverse", () => {
    const orphanTarget = s.model({
      id: s.string().id(),
      title: s.string(),
    });
    const orphanSource = s.model({
      id: s.string().id(),
      targets: s.oneToMany(() => orphanTarget),
    });

    test("both scanners answer undefined and the binding refuses", () => {
      expect(scanMap(orphanSource, "targets")).toBeUndefined();
      expect(scanEngine(orphanSource, "targets")).toBeUndefined();

      expect(() => bind(orphanSource, "targets")).toThrow(QueryEngineError);
      expect(() => bind(orphanSource, "targets")).toThrow(
        "Cannot determine FK fields for relation 'targets'. Define the inverse relation with .fields([...]) or use explicit FK fields."
      );
    });
  });

  describe("4. ambiguous with no name on the source relation", () => {
    // THE DISAGREEMENT, held deliberately: `getInverseRelationMap` never reports
    // ambiguity. With `state.name` unset its `!state.name` arm takes the FIRST candidate
    // in the target's declaration order and answers silently; the engine scanner throws.
    // Both answers are pinned so Phase 2's migration can preserve them and Phase 2's
    // behaviour commit has to move a witness to change either.
    const user = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      editorId: s.string(),
      // `author` is declared FIRST, so it is `candidates[0]`.
      author: s
        .manyToOne(() => user)
        .fields("authorId")
        .references("id"),
      editor: s
        .manyToOne(() => user)
        .fields("editorId")
        .references("id"),
    });
    hydrateSchemaNames({ user, post });

    const flippedUser = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => flippedPost),
    });
    const flippedPost = s.model({
      id: s.string().id(),
      authorId: s.string(),
      editorId: s.string(),
      // The same two candidates in the opposite declaration order.
      editor: s
        .manyToOne(() => flippedUser)
        .fields("editorId")
        .references("id"),
      author: s
        .manyToOne(() => flippedUser)
        .fields("authorId")
        .references("id"),
    });
    hydrateSchemaNames({ flippedUser, flippedPost });

    test("the operation-schema scanner silently takes the first declared candidate", () => {
      expect(scanMap(user, "posts")).toEqual(["authorId"]);
      // Declaration order is the whole rule: swapping the two back-references swaps the
      // answer, and neither model says which one the author meant.
      expect(scanMap(flippedUser, "posts")).toEqual(["editorId"]);
    });

    test("the engine scanner refuses the same edge", () => {
      expect(() => scanEngine(user, "posts")).toThrow(QueryEngineError);
      expect(() => scanEngine(user, "posts")).toThrow(
        "Ambiguous relation 'posts' on model 'user': multiple relations on 'post' point back to it. Add .name() to both sides of each relation to disambiguate."
      );
      expect(() => bind(user, "posts")).toThrow(
        "Ambiguous relation 'posts' on model 'user'"
      );
      expect(() => scanEngine(flippedUser, "posts")).toThrow(QueryEngineError);
    });
  });

  describe("5. ambiguous with a name matching one candidate", () => {
    const user = s.model({
      id: s.string().id(),
      authored: s.oneToMany(() => post).name("author"),
      edited: s.oneToMany(() => post).name("editor"),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      editorId: s.string(),
      author: s
        .manyToOne(() => user)
        .fields("authorId")
        .references("id")
        .name("author"),
      editor: s
        .manyToOne(() => user)
        .fields("editorId")
        .references("id")
        .name("editor"),
    });

    test("both scanners let the name pick, per relation", () => {
      expect(scanMap(user, "authored")).toEqual(["authorId"]);
      expect(scanMap(user, "edited")).toEqual(["editorId"]);

      expect(scanEngine(user, "authored")).toEqual({
        fields: ["authorId"],
        references: ["id"],
        onUpdate: undefined,
      });
      expect(scanEngine(user, "edited")).toEqual({
        fields: ["editorId"],
        references: ["id"],
        onUpdate: undefined,
      });

      expect(bind(user, "authored")).toMatchObject({
        kind: "childHeldToMany",
        foreignFields: ["authorId"],
      });
      expect(bind(user, "edited")).toMatchObject({
        kind: "childHeldToMany",
        foreignFields: ["editorId"],
      });
    });
  });

  describe("6. a name matching none of several candidates", () => {
    // The second half of the ambiguity disagreement: the map falls out of its loop with
    // `undefined` (so the parse omits nothing) where the engine throws. Pinned as the
    // pre-change truth for the same reason as case 4.
    const user = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => post).name("ghostwriter"),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      editorId: s.string(),
      author: s
        .manyToOne(() => user)
        .fields("authorId")
        .references("id")
        .name("author"),
      editor: s
        .manyToOne(() => user)
        .fields("editorId")
        .references("id")
        .name("editor"),
    });
    hydrateSchemaNames({ user, post });

    test("the operation-schema scanner answers undefined", () => {
      expect(scanMap(user, "posts")).toBeUndefined();
    });

    test("the engine scanner refuses instead", () => {
      expect(() => scanEngine(user, "posts")).toThrow(QueryEngineError);
      expect(() => scanEngine(user, "posts")).toThrow(
        "Ambiguous relation 'posts' on model 'user': multiple relations on 'post' point back to it. Add .name() to both sides of each relation to disambiguate."
      );
      expect(() => bind(user, "posts")).toThrow(QueryEngineError);
    });
  });

  describe("7. self-relation", () => {
    const node: Model<any> = s.model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parent: s
        .manyToOne(() => node)
        .fields("parentId")
        .references("id")
        .optional()
        .name("tree"),
      children: s.oneToMany(() => node).name("tree"),
    });

    test("both scanners resolve the inverse side of a model onto itself", () => {
      expect(scanMap(node, "children")).toEqual(["parentId"]);
      expect(scanEngine(node, "children")).toEqual({
        fields: ["parentId"],
        references: ["id"],
        onUpdate: undefined,
      });
      expect(bind(node, "children")).toMatchObject({
        kind: "childHeldToMany",
        foreignFields: ["parentId"],
        referencedFields: ["id"],
      });
    });

    test("the owning side keeps its own fields and its parent-held position", () => {
      expect(scanMap(node, "parent")).toEqual(["parentId"]);
      expect(bind(node, "parent")).toMatchObject({
        kind: "parentHeldToOne",
        foreignFields: ["parentId"],
        referencedFields: ["id"],
      });

      // Neither scanner excludes the ASKING relation, so on a self-relation the owner
      // side's scan finds itself. Unreachable in production (`bindRelation` answers from
      // `.fields()` first), pinned so a resolver does not change it by accident.
      expect(scanEngine(node, "parent")).toEqual({
        fields: ["parentId"],
        references: ["id"],
        onUpdate: undefined,
      });
    });
  });

  describe("8. two relation pairs between the same two models", () => {
    const org = s.model({
      id: s.string().id(),
      staff: s.oneToMany(() => member).name("staff"),
      founder: s
        .oneToOne(() => member)
        .name("founder")
        .optional(),
    });
    const member = s.model({
      id: s.string().id(),
      employerId: s.string(),
      foundedOrgId: s.string().unique().nullable(),
      employer: s
        .manyToOne(() => org)
        .fields("employerId")
        .references("id")
        .name("staff"),
      foundedOrg: s
        .oneToOne(() => org)
        .fields("foundedOrgId")
        .references("id")
        .name("founder")
        .optional(),
    });

    test("each pair resolves to its own foreign key on both scanners", () => {
      expect(scanMap(org, "staff")).toEqual(["employerId"]);
      expect(scanMap(org, "founder")).toEqual(["foundedOrgId"]);

      expect(scanEngine(org, "staff")).toEqual({
        fields: ["employerId"],
        references: ["id"],
        onUpdate: undefined,
      });
      expect(scanEngine(org, "founder")).toEqual({
        fields: ["foundedOrgId"],
        references: ["id"],
        onUpdate: undefined,
      });

      // The arity of each pair survives the shared target model.
      expect(bind(org, "staff")).toMatchObject({
        kind: "childHeldToMany",
        foreignFields: ["employerId"],
      });
      expect(bind(org, "founder")).toMatchObject({
        kind: "childHeldToOne",
        foreignFields: ["foundedOrgId"],
      });
    });

    test("both owning sides keep their own fields", () => {
      expect(scanMap(member, "employer")).toEqual(["employerId"]);
      expect(scanMap(member, "foundedOrg")).toEqual(["foundedOrgId"]);
      expect(bind(member, "employer")).toMatchObject({
        kind: "parentHeldToOne",
        foreignFields: ["employerId"],
      });
      expect(bind(member, "foundedOrg")).toMatchObject({
        kind: "parentHeldToOne",
        foreignFields: ["foundedOrgId"],
      });
    });
  });

  describe("9. zero-argument .fields() on the source to-one", () => {
    // The shape of `splitScannerSchema` in
    // `tests/contracts/engine/write/nested-update-owned-fk.test.ts`, reduced to the two
    // scanners. `[]` is truthy, so the map short-circuits on the OWNER-side arm and
    // answers `[]` — the parse omits nothing — while the engine drops the same relation
    // on `fields.length > 0` and resolves the target's real back-reference. That gap is
    // guard-ledger site 11's only route; it is pinned here, not fixed.
    const user = s.model({
      id: s.string().id(),
      name: s.string(),
      profile: s
        .oneToOne(() => profile)
        .fields()
        .optional(),
    });
    const profile = s.model({
      id: s.string().id(),
      bio: s.string(),
      userId: s.string().unique().nullable(),
      user: s
        .oneToOne(() => user)
        .fields("userId")
        .references("id")
        .optional(),
    });

    test("the map answers the empty tuple and the engine answers the real key", () => {
      expect(scanMap(user, "profile")).toEqual([]);
      expect(scanEngine(user, "profile")).toEqual({
        fields: ["userId"],
        references: ["id"],
        onUpdate: undefined,
      });
      expect(bind(user, "profile")).toMatchObject({
        kind: "childHeldToOne",
        foreignFields: ["userId"],
        referencedFields: ["id"],
      });
    });
  });

  describe("10. zero-argument .fields() on a candidate back-reference", () => {
    // The shape of `splitToManySchema` in the same file: the same axis, the other
    // position. `ghost` is declared FIRST, so the map counts it a candidate, meets two
    // candidates, takes `candidates[0]` and answers `[]`; the engine drops it before
    // counting, so exactly one candidate remains and there is no ambiguity to report.
    const user = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.oneToMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      title: s.string(),
      userId: s.string(),
      ghost: s.manyToOne(() => user).fields(),
      author: s
        .manyToOne(() => user)
        .fields("userId")
        .references("id"),
    });

    test("the map answers the ghost's empty tuple, the engine the real key", () => {
      expect(scanMap(user, "posts")).toEqual([]);
      expect(scanEngine(user, "posts")).toEqual({
        fields: ["userId"],
        references: ["id"],
        onUpdate: undefined,
      });
      expect(bind(user, "posts")).toMatchObject({
        kind: "childHeldToMany",
        foreignFields: ["userId"],
        referencedFields: ["id"],
      });
    });

    test("the ghost relation itself is answerable to the map and unbindable to the engine", () => {
      expect(scanMap(post, "ghost")).toEqual([]);
      expect(scanEngine(post, "ghost")).toBeUndefined();
      expect(() => bind(post, "ghost")).toThrow(
        "Cannot determine FK fields for relation 'ghost'."
      );
    });
  });

  describe("11. compound foreign key and reference order", () => {
    const tenant = s.model({
      region: s.string().id(),
      slug: s.string().id(),
      memberships: s.oneToMany(() => membership),
    });
    const membership = s.model({
      id: s.string().id(),
      // Declared in the REVERSE of the `.fields()` argument order, so the pins below
      // record which order the scanners preserve.
      tenantSlug: s.string(),
      tenantRegion: s.string(),
      tenant: s
        .manyToOne(() => tenant)
        .fields("tenantRegion", "tenantSlug")
        .references("region", "slug")
        .onUpdate("cascade"),
    });

    test("both scanners preserve the declared argument order, not the shape order", () => {
      expect(scanMap(tenant, "memberships")).toEqual([
        "tenantRegion",
        "tenantSlug",
      ]);
      expect(scanEngine(tenant, "memberships")).toEqual({
        fields: ["tenantRegion", "tenantSlug"],
        references: ["region", "slug"],
        onUpdate: "cascade",
      });
      expect(scanMap(membership, "tenant")).toEqual([
        "tenantRegion",
        "tenantSlug",
      ]);
    });

    test("the binding carries both ordered arrays and the referential action", () => {
      expect(bind(tenant, "memberships")).toMatchObject({
        kind: "childHeldToMany",
        foreignFields: ["tenantRegion", "tenantSlug"],
        referencedFields: ["region", "slug"],
        onUpdate: "cascade",
      });
      expect(bind(membership, "tenant")).toMatchObject({
        kind: "parentHeldToOne",
        foreignFields: ["tenantRegion", "tenantSlug"],
        referencedFields: ["region", "slug"],
        onUpdate: "cascade",
      });
    });
  });

  describe("12. ordinary and polymorphic candidates on one target", () => {
    const parent = s.model({
      id: s.string().id(),
      children: s.oneToMany(() => child),
      subjects: s.oneToMany(() => child).name("subject"),
    });
    const other = s.model({ id: s.string().id() });
    const child = s.model({
      id: s.string().id(),
      parentId: s.string(),
      parent: s
        .manyToOne(() => parent)
        .fields("parentId")
        .references("id"),
      subject: s
        .polymorphic(
          { parent: () => parent, other: () => other },
          { values: { parent: "parent.v1", other: "other.v1" } }
        )
        .name("subject"),
    });

    const ghostParent = s.model({
      id: s.string().id(),
      children: s.oneToMany(() => ghostChild),
    });
    const ghostOther = s.model({ id: s.string().id() });
    const ghostChild = s.model({
      id: s.string().id(),
      // The same coexistence, with the ordinary back-reference spelled `.fields()` with
      // zero arguments.
      parent: s.manyToOne(() => ghostParent).fields(),
      subject: s
        .polymorphic(
          { parent: () => ghostParent, other: () => ghostOther },
          { values: { parent: "parent.v1", other: "other.v1" } }
        )
        .name("subject"),
    });

    test("a physical foreign key declines the polymorphic binding unless a name pairs", () => {
      expect(
        getPolymorphicInverseBinding(child, parent, undefined)
      ).toBeUndefined();
      expect(getPolymorphicInverseBinding(child, parent, "subject")).toEqual({
        relationKey: "subject",
        publicType: "parent",
        storedType: "parent.v1",
      });
    });

    test("the ordinary scanners answer the physical key for both source relations", () => {
      // Neither ordinary scanner knows the polymorphic edge exists: with one ordinary
      // candidate both short-circuit on it, and the pairing `.name()` does not redirect
      // them. `bindRelation` is what consults `getPolymorphicInverseBinding` first, and
      // binding `subjects` needs the private storage only full schema validation
      // materializes — so the precedence itself is pinned at the resolver level here.
      expect(scanMap(parent, "children")).toEqual(["parentId"]);
      expect(scanMap(parent, "subjects")).toEqual(["parentId"]);
      expect(scanEngine(parent, "children")).toEqual({
        fields: ["parentId"],
        references: ["id"],
        onUpdate: undefined,
      });
      expect(scanEngine(parent, "subjects")).toEqual({
        fields: ["parentId"],
        references: ["id"],
        onUpdate: undefined,
      });
    });

    test("a zero-argument .fields() back-reference splits all three resolvers", () => {
      // The empty-`.fields()` axis, third position: the polymorphic selector already
      // reads `fields.length > 0` (so it does NOT decline), the map still reads
      // truthiness (so it answers the empty tuple), and the engine drops the candidate
      // entirely (so it answers nothing). One edge, three answers.
      expect(
        getPolymorphicInverseBinding(ghostChild, ghostParent, undefined)
      ).toEqual({
        relationKey: "subject",
        publicType: "parent",
        storedType: "parent.v1",
      });
      expect(scanMap(ghostParent, "children")).toEqual([]);
      expect(scanEngine(ghostParent, "children")).toBeUndefined();
    });
  });

  describe("13. lazy and circular model definitions", () => {
    const getterCalls = { post: 0, user: 0 };
    const lazyUser: Model<any> = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => {
        getterCalls.post += 1;
        return lazyPost;
      }),
    });
    const lazyPost: Model<any> = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .manyToOne(() => {
          getterCalls.user += 1;
          return lazyUser;
        })
        .fields("authorId")
        .references("id"),
    });
    hydrateSchemaNames({ lazyPost, lazyUser });

    test("neither definition nor hydration forces a target getter, and resolution still works", () => {
      // Mutually recursive model consts only stay definable because the getters are
      // thunks. Any resolver that runs eagerly at model construction breaks this, so the
      // counters are asserted BEFORE the scanners run.
      expect(getterCalls).toEqual({ post: 0, user: 0 });

      expect(scanMap(lazyUser, "posts")).toEqual(["authorId"]);
      expect(scanEngine(lazyUser, "posts")).toEqual({
        fields: ["authorId"],
        references: ["id"],
        onUpdate: undefined,
      });
      expect(bind(lazyUser, "posts")).toMatchObject({
        kind: "childHeldToMany",
        foreignFields: ["authorId"],
        referencedFields: ["id"],
      });
      expect(scanMap(lazyPost, "author")).toEqual(["authorId"]);

      // Resolved only when a scanner asked.
      expect(getterCalls.post).toBeGreaterThan(0);
      expect(getterCalls.user).toBeGreaterThan(0);
    });
  });
});

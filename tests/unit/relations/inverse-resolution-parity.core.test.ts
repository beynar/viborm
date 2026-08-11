import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { QueryEngineError } from "@errors";
import { bindRelation } from "@query-engine/builders/relation-data-builder";
import { createQueryScope, getRelationInfo } from "@query-engine/context";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import type { AnyModel, Model } from "@schema/model";
import {
  collectInverseCandidates,
  getPolymorphicInverseBinding,
  resolveInverseRelation,
  resolveOrdinaryInverse,
} from "@schema/relation";
import { getInverseRelationMap } from "@schema/relation/types";
import { describe, expect, test } from "vitest";

/**
 * **Unit 2.2 — the resolver-parity contract for inverse resolution.**
 *
 * ONE runtime owner now answers "which back-reference on the target model carries this
 * relation's foreign key" — `resolveInverseRelation` / `resolveOrdinaryInverse` /
 * `collectInverseCandidates` in `src/schema/relation/inverse.ts`. It THROWS NOTHING:
 * `missing` and `ambiguous` are answers, and each consumer translates them by its own
 * established policy. This file asserts the resolver's verdict beside every surviving
 * consumer's translation of it, on one fixture at a time:
 *
 *  · `getInverseRelationMap` (`src/schema/relation/types.ts`) — the FK-OMISSION VIEW of
 *    the same scan. Its answer is the key set a nested `create`/`update` omits, so it
 *    decides what a caller may spell. It keeps its historical candidate policy exactly
 *    (sole candidate wins whatever either side is named; among several `.name()` picks,
 *    an unnamed source takes the FIRST declared candidate and a name matching none
 *    answers `undefined`) and it deliberately never consults the polymorphic arm;
 *  · `getPolymorphicInverseBinding` — the polymorphic-only projection of the same
 *    verdict, `undefined` for `ordinary`, `ambiguous` and `missing` alike;
 *  · `bindRelation` (`src/query-engine/builders/relation-data-builder.ts`) — the ENGINE's
 *    consumer. It owns the TWO error translations the deleted `findInverseRelationState`
 *    used to raise from inside the scan (`Ambiguous relation …` and `Cannot determine FK
 *    fields …`), and it chooses which resolution to ask for: the composed one for a
 *    `oneToOne`/`oneToMany` inverse, the ordinary-only one for the retained fields-less
 *    `manyToOne` compatibility form, where a named polymorphic pairing must not shadow a
 *    physical back-reference.
 *
 * WHAT MOVED. The empty-`.fields()` axis is CLOSED: `getInverseRelationMap`'s owner-side
 * short-circuit and the candidate filter now LENGTH-TEST `.fields()` (`fields.length > 0`,
 * the reading the engine always applied), so a relation spelled `.fields()` with zero
 * arguments is fields-LESS to every reader. Cases 9, 10 and 12's third fixture are the
 * ones whose answers changed; each says at the case what it used to answer. **Commit
 * 40e50057 holds the before-pins** (unit 2.1's file, which asserted the two scanners side
 * by side and named their disagreements). That alignment is what retired guard-ledger
 * site 11 (`RelationWritePart.assertOwnedFkAbsentFromUpdateData`), whose falsifiers are
 * re-authored in `tests/contracts/engine/write/nested-update-owned-fk.test.ts`.
 *
 * WHAT DID NOT MOVE. The ambiguity axis is unchanged and stays pinned: with two or more
 * fields-bearing back-references and no `.name()` that picks one, the map view answers
 * silently with the first declared candidate while `bindRelation` refuses. It is not a
 * disagreement between two scanners any more — it is ONE verdict (`ambiguous`, carrying
 * the full ordered candidate list) translated two ways on purpose.
 *
 * COVERAGE. `src/schema/relation/**` is gated at 100% (`pnpm test:coverage:relations`,
 * whose project is `tests/unit/relations/**`), so this file also carries the resolver arms
 * no schema in the thirteen-case matrix reaches — sections 14 and 15.
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

const stateOf = (model: Model<any>, relationKey: string) =>
  model["~"].state.relations[relationKey]["~"].state;

/** The FK-omission view's answer for one relation key. */
const scanMap = (model: Model<any>, relationKey: string) =>
  getInverseRelationMap(stateOf(model, relationKey), model);

/** The composed resolution, asked the way `bindRelation` asks it for a to-one/to-many
 *  inverse: the relation's target, the model it must point back to, and the asking
 *  relation's own `.name()`. */
const resolveComposed = (model: Model<any>, relationKey: string) => {
  const state = stateOf(model, relationKey);
  return resolveInverseRelation(state.getter(), model, state.name);
};

/** The ordinary-only resolution — `bindRelation`'s arm for a relation that can never
 *  bind a polymorphic inverse. */
const resolveOrdinary = (model: Model<any>, relationKey: string) => {
  const state = stateOf(model, relationKey);
  return resolveOrdinaryInverse(state.getter(), model, state.name);
};

/** The candidate list itself, in the target model's declaration order. */
const candidateKeys = (targetModel: AnyModel, sourceModel: unknown) =>
  collectInverseCandidates(targetModel, sourceModel).map(
    (candidate) => candidate.relationKey
  );

/** What the engine actually binds — the resolver's only query-time consumer. */
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

    test("the resolver, the omission view and the binding agree on the matched pair", () => {
      expect(scanMap(user, "posts")).toEqual(["authorId"]);
      expect(resolveComposed(user, "posts")).toEqual({
        kind: "ordinary",
        relationKey: "author",
        fields: ["authorId"],
        references: ["id"],
        onUpdate: undefined,
        pairingName: "author",
      });
      expect(bind(user, "posts")).toMatchObject({
        position: "childHeld",
        cardinality: "many",
        membership: {
          kind: "foreignKey",
          foreignFields: ["authorId"],
          referencedFields: ["id"],
        },
      });
    });

    test("the owner side answers from its own fields", () => {
      expect(scanMap(post, "author")).toEqual(["authorId"]);
      expect(bind(post, "author")).toMatchObject({
        position: "parentHeld",
        cardinality: "one",
        membership: {
          kind: "foreignKey",
          foreignFields: ["authorId"],
          referencedFields: ["id"],
        },
      });

      // `bindRelation` short-circuits an owner-side relation on its own `.fields()`
      // before asking anything, so this resolution is unreachable in production. Asked
      // anyway, it looks for a fields-bearing to-one on `user` pointing back at `post`
      // and finds none — pinned so a resolver change does not move it by accident.
      expect(resolveOrdinary(post, "author")).toEqual({ kind: "missing" });
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
      expect(resolveComposed(author, "books")).toEqual({
        kind: "ordinary",
        relationKey: "author",
        fields: ["authorId"],
        references: ["id"],
        onUpdate: undefined,
        pairingName: undefined,
      });
      // The ordinary-only entry point states the single-candidate rule in its own body,
      // so both copies are asked on the same edge.
      expect(resolveOrdinary(author, "books")).toEqual(
        resolveComposed(author, "books")
      );
      expect(bind(author, "books")).toMatchObject({
        position: "childHeld",
        cardinality: "many",
        membership: {
          kind: "foreignKey",
          foreignFields: ["authorId"],
          referencedFields: ["id"],
        },
      });
    });

    test("an unnamed source resolves a named sole candidate", () => {
      expect(scanMap(shelf, "volumes")).toEqual(["shelfId"]);
      expect(resolveComposed(shelf, "volumes")).toEqual({
        kind: "ordinary",
        relationKey: "shelf",
        fields: ["shelfId"],
        references: ["id"],
        onUpdate: undefined,
        pairingName: "stack",
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

    test("every reader answers nothing and the binding refuses", () => {
      expect(scanMap(orphanSource, "targets")).toBeUndefined();
      expect(collectInverseCandidates(orphanTarget, orphanSource)).toEqual([]);
      expect(resolveComposed(orphanSource, "targets")).toEqual({
        kind: "missing",
      });
      // The polymorphic-only view declines a `missing` verdict.
      expect(
        getPolymorphicInverseBinding(orphanTarget, orphanSource, undefined)
      ).toBeUndefined();

      expect(() => bind(orphanSource, "targets")).toThrow(QueryEngineError);
      expect(() => bind(orphanSource, "targets")).toThrow(
        "Cannot determine FK fields for relation 'targets'. Define the inverse relation with .fields([...]) or use explicit FK fields."
      );
    });
  });

  describe("4. ambiguous with no name on the source relation", () => {
    // ONE verdict, translated two ways ON PURPOSE. The resolver answers `ambiguous` with
    // the full ordered candidate list; the omission view keeps its historical
    // first-declared-candidate policy (so the parse omits SOMETHING) and `bindRelation`
    // refuses. Unchanged by the alignment — 40e50057 pinned the same two answers when
    // they came from two independent scanners.
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

    test("the omission view silently takes the first declared candidate", () => {
      expect(scanMap(user, "posts")).toEqual(["authorId"]);
      // Declaration order is the whole rule: swapping the two back-references swaps the
      // answer, and neither model says which one the author meant.
      expect(scanMap(flippedUser, "posts")).toEqual(["editorId"]);
    });

    test("the resolver ANSWERS ambiguous, in declaration order, and throws nothing", () => {
      const resolved = resolveComposed(user, "posts");
      expect(resolved).toEqual({
        kind: "ambiguous",
        candidates: [
          {
            relationKey: "author",
            fields: ["authorId"],
            references: ["id"],
            onUpdate: undefined,
            pairingName: undefined,
          },
          {
            relationKey: "editor",
            fields: ["editorId"],
            references: ["id"],
            onUpdate: undefined,
            pairingName: undefined,
          },
        ],
      });
      expect(candidateKeys(post, user)).toEqual(["author", "editor"]);
      expect(candidateKeys(flippedPost, flippedUser)).toEqual([
        "editor",
        "author",
      ]);
      // The ordinary-only entry point reports the same verdict from its own body…
      expect(resolveOrdinary(user, "posts")).toEqual(resolved);
      // …and the polymorphic-only view declines an `ambiguous` one.
      expect(
        getPolymorphicInverseBinding(post, user, undefined)
      ).toBeUndefined();
    });

    test("bindRelation owns the refusal, with the message the scan used to raise", () => {
      expect(() => bind(user, "posts")).toThrow(QueryEngineError);
      expect(() => bind(user, "posts")).toThrow(
        "Ambiguous relation 'posts' on model 'user': multiple relations on 'post' point back to it. Add .name() to both sides of each relation to disambiguate."
      );
      expect(() => bind(flippedUser, "posts")).toThrow(QueryEngineError);
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

    test("the name picks, per relation, in every reader", () => {
      expect(scanMap(user, "authored")).toEqual(["authorId"]);
      expect(scanMap(user, "edited")).toEqual(["editorId"]);

      expect(resolveComposed(user, "authored")).toMatchObject({
        kind: "ordinary",
        relationKey: "author",
        fields: ["authorId"],
        pairingName: "author",
      });
      expect(resolveComposed(user, "edited")).toMatchObject({
        kind: "ordinary",
        relationKey: "editor",
        fields: ["editorId"],
        pairingName: "editor",
      });
      // The named arm of the ordinary-only entry point, on the same edge.
      expect(resolveOrdinary(user, "authored")).toEqual(
        resolveComposed(user, "authored")
      );

      expect(bind(user, "authored")).toMatchObject({
        position: "childHeld",
        cardinality: "many",
        membership: {
          kind: "foreignKey",
          foreignFields: ["authorId"],
        },
      });
      expect(bind(user, "edited")).toMatchObject({
        position: "childHeld",
        cardinality: "many",
        membership: {
          kind: "foreignKey",
          foreignFields: ["editorId"],
        },
      });
    });
  });

  describe("6. a name matching none of several candidates", () => {
    // The second half of the ambiguity translation: the omission view falls out of its
    // loop with `undefined` (so the parse omits nothing) where `bindRelation` refuses.
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

    test("the omission view answers undefined", () => {
      expect(scanMap(user, "posts")).toBeUndefined();
    });

    test("the resolver answers ambiguous and the binding refuses", () => {
      expect(resolveComposed(user, "posts")).toMatchObject({
        kind: "ambiguous",
        candidates: [{ relationKey: "author" }, { relationKey: "editor" }],
      });
      // A name that matches no candidate does not select in either entry point.
      expect(resolveOrdinary(user, "posts")).toMatchObject({
        kind: "ambiguous",
      });

      expect(() => bind(user, "posts")).toThrow(QueryEngineError);
      expect(() => bind(user, "posts")).toThrow(
        "Ambiguous relation 'posts' on model 'user': multiple relations on 'post' point back to it. Add .name() to both sides of each relation to disambiguate."
      );
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

    test("the inverse side of a model onto itself resolves to the parent edge", () => {
      expect(scanMap(node, "children")).toEqual(["parentId"]);
      // The to-MANY relation on the same model is dropped by the candidate scan's TYPE
      // filter, which is why one model pointing at itself is not ambiguous.
      expect(candidateKeys(node, node)).toEqual(["parent"]);
      expect(resolveComposed(node, "children")).toEqual({
        kind: "ordinary",
        relationKey: "parent",
        fields: ["parentId"],
        references: ["id"],
        onUpdate: undefined,
        pairingName: "tree",
      });
      expect(bind(node, "children")).toMatchObject({
        position: "childHeld",
        cardinality: "many",
        membership: {
          kind: "foreignKey",
          foreignFields: ["parentId"],
          referencedFields: ["id"],
        },
      });
    });

    test("the owning side keeps its own fields and its parent-held position", () => {
      expect(scanMap(node, "parent")).toEqual(["parentId"]);
      expect(bind(node, "parent")).toMatchObject({
        position: "parentHeld",
        cardinality: "one",
        membership: {
          kind: "foreignKey",
          foreignFields: ["parentId"],
          referencedFields: ["id"],
        },
      });

      // The scan does not exclude the ASKING relation, so on a self-relation the owner
      // side finds itself. Unreachable in production (`bindRelation` answers from
      // `.fields()` first), pinned so a resolver does not change it by accident.
      expect(resolveOrdinary(node, "parent")).toMatchObject({
        kind: "ordinary",
        relationKey: "parent",
        fields: ["parentId"],
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

    test("each pair resolves to its own foreign key", () => {
      expect(scanMap(org, "staff")).toEqual(["employerId"]);
      expect(scanMap(org, "founder")).toEqual(["foundedOrgId"]);

      expect(candidateKeys(member, org)).toEqual(["employer", "foundedOrg"]);
      expect(resolveComposed(org, "staff")).toMatchObject({
        kind: "ordinary",
        relationKey: "employer",
        fields: ["employerId"],
      });
      expect(resolveComposed(org, "founder")).toMatchObject({
        kind: "ordinary",
        relationKey: "foundedOrg",
        fields: ["foundedOrgId"],
      });
      expect(resolveOrdinary(org, "founder")).toEqual(
        resolveComposed(org, "founder")
      );

      // The arity of each pair survives the shared target model.
      expect(bind(org, "staff")).toMatchObject({
        position: "childHeld",
        cardinality: "many",
        membership: {
          kind: "foreignKey",
          foreignFields: ["employerId"],
        },
      });
      expect(bind(org, "founder")).toMatchObject({
        position: "childHeld",
        cardinality: "one",
        membership: {
          kind: "foreignKey",
          foreignFields: ["foundedOrgId"],
        },
      });
    });

    test("both owning sides keep their own fields", () => {
      expect(scanMap(member, "employer")).toEqual(["employerId"]);
      expect(scanMap(member, "foundedOrg")).toEqual(["foundedOrgId"]);
      expect(bind(member, "employer")).toMatchObject({
        position: "parentHeld",
        cardinality: "one",
        membership: {
          kind: "foreignKey",
          foreignFields: ["employerId"],
        },
      });
      expect(bind(member, "foundedOrg")).toMatchObject({
        position: "parentHeld",
        cardinality: "one",
        membership: {
          kind: "foreignKey",
          foreignFields: ["foundedOrgId"],
        },
      });
    });
  });

  describe("9. zero-argument .fields() on the source to-one (ALIGNED)", () => {
    // The shape of `splitScannerSchema` in
    // `tests/contracts/engine/write/nested-update-owned-fk.test.ts`.
    //
    // BEFORE THE ALIGNMENT (pinned at 40e50057): `[]` was truthy, so the omission view
    // short-circuited on its OWNER-side arm and answered `[]` — the parse omitted
    // nothing and admitted a spelled `userId` — while the engine dropped the same
    // relation on `fields.length > 0` and resolved `profile.user`. That gap was
    // guard-ledger site 11's only route. The view now length-tests too, so it falls to
    // the same scan and answers the same key.
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

    test("the omission view answers the real key the engine binds", () => {
      // Was `[]`.
      expect(scanMap(user, "profile")).toEqual(["userId"]);
      expect(resolveComposed(user, "profile")).toEqual({
        kind: "ordinary",
        relationKey: "user",
        fields: ["userId"],
        references: ["id"],
        onUpdate: undefined,
        pairingName: undefined,
      });
      expect(bind(user, "profile")).toMatchObject({
        position: "childHeld",
        cardinality: "one",
        membership: {
          kind: "foreignKey",
          foreignFields: ["userId"],
          referencedFields: ["id"],
        },
      });
    });
  });

  describe("10. zero-argument .fields() on a candidate back-reference (ALIGNED)", () => {
    // The shape of `splitToManySchema` in the same file: the same axis, the other
    // position.
    //
    // BEFORE THE ALIGNMENT (pinned at 40e50057): the view counted `ghost` a candidate
    // (its filter was `!state.fields`, and `[]` is truthy), met TWO candidates, took
    // `candidates[0]` and answered `[]`. The candidate scan now drops `ghost` before
    // counting, so exactly one candidate remains — there is no ambiguity to report and
    // the view answers the key the engine binds.
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

    test("the ghost is not a candidate, so one edge has one answer", () => {
      // Was `[]` — the ghost's own empty tuple.
      expect(scanMap(user, "posts")).toEqual(["userId"]);
      expect(candidateKeys(post, user)).toEqual(["author"]);
      expect(resolveComposed(user, "posts")).toEqual({
        kind: "ordinary",
        relationKey: "author",
        fields: ["userId"],
        references: ["id"],
        onUpdate: undefined,
        pairingName: undefined,
      });
      expect(bind(user, "posts")).toMatchObject({
        position: "childHeld",
        cardinality: "many",
        membership: {
          kind: "foreignKey",
          foreignFields: ["userId"],
          referencedFields: ["id"],
        },
      });
    });

    test("the ghost relation itself is fields-less to every reader", () => {
      // Was `[]`; the view now falls to the scan, which finds no to-one back-reference
      // on `user` at all (`posts` is dropped by the TYPE filter).
      expect(scanMap(post, "ghost")).toBeUndefined();
      // `bindRelation` asks the ordinary-only resolution for a `manyToOne`.
      expect(resolveOrdinary(post, "ghost")).toEqual({ kind: "missing" });
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
      // record which order the readers preserve.
      tenantSlug: s.string(),
      tenantRegion: s.string(),
      tenant: s
        .manyToOne(() => tenant)
        .fields("tenantRegion", "tenantSlug")
        .references("region", "slug")
        .onUpdate("cascade"),
    });

    test("the declared argument order survives, not the shape order", () => {
      expect(scanMap(tenant, "memberships")).toEqual([
        "tenantRegion",
        "tenantSlug",
      ]);
      expect(resolveComposed(tenant, "memberships")).toEqual({
        kind: "ordinary",
        relationKey: "tenant",
        fields: ["tenantRegion", "tenantSlug"],
        references: ["region", "slug"],
        onUpdate: "cascade",
        pairingName: undefined,
      });
      expect(scanMap(membership, "tenant")).toEqual([
        "tenantRegion",
        "tenantSlug",
      ]);
    });

    test("the binding carries both ordered arrays and the referential action", () => {
      expect(bind(tenant, "memberships")).toMatchObject({
        position: "childHeld",
        cardinality: "many",
        membership: {
          kind: "foreignKey",
          foreignFields: ["tenantRegion", "tenantSlug"],
          referencedFields: ["region", "slug"],
          onUpdate: "cascade",
        },
      });
      expect(bind(membership, "tenant")).toMatchObject({
        position: "parentHeld",
        cardinality: "one",
        membership: {
          kind: "foreignKey",
          foreignFields: ["tenantRegion", "tenantSlug"],
          referencedFields: ["region", "slug"],
          onUpdate: "cascade",
        },
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
      // Precedence step 2 answers `ordinary`, so the polymorphic view declines…
      expect(
        getPolymorphicInverseBinding(child, parent, undefined)
      ).toBeUndefined();
      // …and precedence step 1 — an exact pairing `.name()` — beats the physical
      // candidate outright.
      expect(getPolymorphicInverseBinding(child, parent, "subject")).toEqual({
        relationKey: "subject",
        publicType: "parent",
        storedType: "parent.v1",
      });
      expect(resolveComposed(parent, "subjects")).toEqual({
        kind: "polymorphic",
        relationKey: "subject",
        publicType: "parent",
        storedType: "parent.v1",
      });
      // The candidate scan itself matches on the SOURCE MODEL: `child.parent` points at
      // `parent`, so it is no candidate for an edge coming from `other`.
      expect(collectInverseCandidates(child, other)).toEqual([]);
    });

    test("the ordinary readers answer the physical key for both source relations", () => {
      // The omission view never consults the polymorphic arm: it answers "which fields
      // might the enclosing edge supply to nested data", and a name-paired polymorphic
      // edge does not stop the physical foreign key from being the omitted one.
      expect(scanMap(parent, "children")).toEqual(["parentId"]);
      expect(scanMap(parent, "subjects")).toEqual(["parentId"]);
      expect(resolveComposed(parent, "children")).toMatchObject({
        kind: "ordinary",
        relationKey: "parent",
        fields: ["parentId"],
      });
      // The ordinary-only entry point is the one `bindRelation` asks for a relation that
      // can never bind a polymorphic inverse — the pairing name does not redirect it.
      expect(resolveOrdinary(parent, "subjects")).toMatchObject({
        kind: "ordinary",
        relationKey: "parent",
        fields: ["parentId"],
      });
    });

    test("a zero-argument .fields() back-reference is fields-less to all three (ALIGNED)", () => {
      // BEFORE THE ALIGNMENT (pinned at 40e50057) this edge had THREE answers: the
      // polymorphic selector already read `fields.length > 0` (so it did not decline),
      // the omission view read truthiness (so it answered the empty tuple `[]`), and the
      // engine dropped the candidate (so it answered nothing). Now all three read the
      // zero-argument `.fields()` the same way — there is no physical candidate — so the
      // two polymorphic-aware readers agree on the SAME `subject` binding and the two
      // ordinary ones agree that no foreign key is omitted here.
      expect(
        getPolymorphicInverseBinding(ghostChild, ghostParent, undefined)
      ).toEqual({
        relationKey: "subject",
        publicType: "parent",
        storedType: "parent.v1",
      });
      expect(resolveComposed(ghostParent, "children")).toEqual({
        kind: "polymorphic",
        relationKey: "subject",
        publicType: "parent",
        storedType: "parent.v1",
      });
      expect(collectInverseCandidates(ghostChild, ghostParent)).toEqual([]);
      expect(resolveOrdinary(ghostParent, "children")).toEqual({
        kind: "missing",
      });
      // Was `[]`.
      expect(scanMap(ghostParent, "children")).toBeUndefined();
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
      // counters are asserted BEFORE anything is asked.
      expect(getterCalls).toEqual({ post: 0, user: 0 });

      expect(scanMap(lazyUser, "posts")).toEqual(["authorId"]);
      expect(resolveComposed(lazyUser, "posts")).toMatchObject({
        kind: "ordinary",
        relationKey: "author",
        fields: ["authorId"],
      });
      expect(bind(lazyUser, "posts")).toMatchObject({
        position: "childHeld",
        cardinality: "many",
        membership: {
          kind: "foreignKey",
          foreignFields: ["authorId"],
          referencedFields: ["id"],
        },
      });
      expect(scanMap(lazyPost, "author")).toEqual(["authorId"]);

      // Resolved only when a reader asked.
      expect(getterCalls.post).toBeGreaterThan(0);
      expect(getterCalls.user).toBeGreaterThan(0);
    });
  });

  describe("14. resolver arms the thirteen-case matrix does not reach", () => {
    // The precedence's polymorphic selection has arms no ordinary parity fixture
    // produces. They are answers, not errors — every one of them ends in `missing`,
    // which is what makes the convenience rules SAFE: an unclear polymorphic edge never
    // guesses a binding.

    test("a fields-less manyToOne (no .fields() at all) is not a candidate", () => {
      // The retained FK004-warned compatibility form, and the reason `bindRelation` has
      // an ordinary-only arm at all. Distinct from case 10's `.fields()`: there the
      // tuple exists and is empty, here there is no tuple.
      const looseSource = s.model({
        id: s.string().id(),
        targets: s.oneToMany(() => looseTarget),
      });
      const looseTarget = s.model({
        id: s.string().id(),
        source: s.manyToOne(() => looseSource),
      });

      expect(collectInverseCandidates(looseTarget, looseSource)).toEqual([]);
      expect(scanMap(looseSource, "targets")).toBeUndefined();
      expect(resolveComposed(looseSource, "targets")).toEqual({
        kind: "missing",
      });
      expect(() => bind(looseTarget, "source")).toThrow(
        "Cannot determine FK fields for relation 'source'."
      );
    });

    test("two polymorphic groups sharing one pairing name select neither", () => {
      const twinSource = s.model({ id: s.string().id() });
      const twinChild = s.model({
        id: s.string().id(),
        first: s
          .polymorphic(
            { source: () => twinSource },
            { values: { source: "source.first.v1" } }
          )
          .name("subject"),
        second: s
          .polymorphic(
            { source: () => twinSource },
            { values: { source: "source.second.v1" } }
          )
          .name("subject"),
      });

      // The name matches TWO groups, so the exact-pairing arm selects nothing; the
      // sole-group convenience rule then has two groups and also selects nothing.
      expect(resolveInverseRelation(twinChild, twinSource, "subject")).toEqual({
        kind: "missing",
      });
      expect(resolveInverseRelation(twinChild, twinSource, undefined)).toEqual({
        kind: "missing",
      });
      expect(
        getPolymorphicInverseBinding(twinChild, twinSource, "subject")
      ).toBeUndefined();
    });

    test("a selected group that does not name this source exactly once selects nothing", () => {
      const pairSource = s.model({ id: s.string().id() });
      // ONE group, naming the same source TWICE: the group is selected and then yields
      // two candidates, which is not a binding.
      const pairChild = s.model({
        id: s.string().id(),
        subject: s.polymorphic(
          { primary: () => pairSource, backup: () => pairSource },
          {
            values: {
              primary: "source.primary.v1",
              backup: "source.backup.v1",
            },
          }
        ),
      });
      // ONE group naming a DIFFERENT model: the group is selected and yields none.
      const strangerSource = s.model({ id: s.string().id() });
      const strangerOther = s.model({ id: s.string().id() });
      const strangerChild = s.model({
        id: s.string().id(),
        subject: s.polymorphic(
          { other: () => strangerOther },
          { values: { other: "other.v1" } }
        ),
      });

      expect(resolveInverseRelation(pairChild, pairSource, undefined)).toEqual({
        kind: "missing",
      });
      expect(
        resolveInverseRelation(strangerChild, strangerSource, undefined)
      ).toEqual({ kind: "missing" });
    });
  });

  describe("15. coverage low value — the resolver's defensive readings", () => {
    // Neither shape is producible through `s.model()`, whose state always carries both
    // relation maps and whose relations always carry a getter. They are asserted because
    // `src/schema/relation/**` is gated at 100% and a defensive read that nothing
    // executes is indistinguishable from a broken one.

    test("a carrier with no ordinary relation map yields no candidates", () => {
      // Only the ordinary-map read is defensive (`relations ?? {}`, inherited
      // from the deleted engine scanner). The polymorphic-map read is
      // deliberately UNGUARDED, matching `getPolymorphicInverseCandidates`'s
      // own read — every `s.model()` carries the map, so a carrier without one
      // is not a state the resolver defends against.
      const carrier = { "~": { state: {} } } as unknown as AnyModel;
      expect(collectInverseCandidates(carrier, carrier)).toEqual([]);
    });

    test("a relation carrying no target getter is not a candidate", () => {
      const source = s.model({ id: s.string().id() });
      const carrier = {
        "~": {
          state: {
            relations: {
              orphan: {
                "~": { state: { type: "manyToOne", fields: ["sourceId"] } },
              },
            },
          },
        },
      } as unknown as AnyModel;
      expect(collectInverseCandidates(carrier, source)).toEqual([]);
    });
  });
});

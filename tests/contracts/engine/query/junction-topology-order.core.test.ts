/**
 * B1 Step 0 order falsifiers for the engine's junction topology resolution
 * (docs/architecture/polymorphic-cardinality-plan.md, Package B step B.1),
 * pinned against the CURRENT binder so the ResolvedJunctionTopology
 * extraction is measurable.
 *
 * The engine's configuration-error ORDER is a contract of its own, and it
 * DIFFERS from the serializer's (tests/unit/migrations/serializer.core.test.ts
 * pins that one: referential actions, then row keys, then the raw A/B pair):
 * the binder reconciles the raw A/B pair BEFORE either endpoint's row key is
 * requested, and none of it happens at bind time — the first membership read
 * pays every refusal. Until now those two facts only had witnesses in the
 * extended-local gate; a core gate must fail if either moves.
 */

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { QueryEngineError } from "@errors";
import {
  bindRelation,
  classifyRelation,
} from "@query-engine/builders/relation-data-builder";
import { createQueryScope, getRelationInfo } from "@query-engine/context";
import {
  getMembershipScope,
  relationMembershipScopesEqual,
} from "@query-engine/RelationMembership";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import { describe, expect, test } from "vitest";

/**
 * BOTH defects at once: the pair disagrees on the post-side junction column
 * (`.A('postCol')` vs paired `.B('tagCol')`) AND the source endpoint has no
 * primary key. Which refusal answers is the order under test.
 */
const conflictSchema = (() => {
  const post = s.model({
    title: s.string(),
    tags: s.manyToMany(() => tag).A("postCol"),
  });
  const tag = s.model({
    id: s.string().id(),
    posts: s.manyToMany(() => post).B("tagCol"),
  });
  return { post, tag };
})();
hydrateSchemaNames(conflictSchema);

/** A clean pair whose only defect is the missing source primary key. */
const noKeySchema = (() => {
  const orphan = s.model({
    title: s.string(),
    badges: s.manyToMany(() => badge),
  });
  const badge = s.model({
    id: s.string().id(),
    orphans: s.manyToMany(() => orphan),
  });
  return { orphan, badge };
})();
hydrateSchemaNames(noKeySchema);

/** A self-referential pair with explicit columns on ONE side. */
const selfSchema = (() => {
  const follower: Model<any> = s.model({
    id: s.string().id(),
    follows: s
      .manyToMany(() => follower)
      .A("followerId")
      .B("followedId"),
    followedBy: s.manyToMany(() => follower),
  });
  return { follower };
})();
hydrateSchemaNames(selfSchema);

const adapter = new PostgresAdapter();

/** Bind one relation and narrow it to the junction arm. */
function bindJunction(source: Model<any>, relationName: string) {
  const scope = createQueryScope(adapter, source);
  const relationInfo = getRelationInfo(scope, relationName);
  if (!relationInfo) {
    throw new Error(`Expected relation '${relationName}' on the test model.`);
  }
  const relation = bindRelation(scope, relationInfo);
  if (relation.position !== "junction") {
    throw new Error(`Expected relation '${relationName}' to bind a junction.`);
  }
  return relation;
}

/** The error one read throws, so its exact bytes can be pinned. */
function captureThrown(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("junction topology resolution order", () => {
  test("the raw A/B pair is reconciled before either row key on the first membership read", () => {
    const relation = bindJunction(conflictSchema.post, "tags");

    const thrown = captureThrown(() => relation.membership.table);

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("Expected the membership read to throw.");
    }
    // The PK-less source would refuse too; the discarded raw-pair probe wins,
    // exactly as the binder's order comment promises.
    expect(thrown.message).toBe(
      "Many-to-many relations between 'post' and 'tag' disagree on junction columns: .A('postCol') vs paired .B('tagCol')."
    );
    expect(thrown.message).not.toContain("has no primary key");
  });

  test("a PK-less endpoint refuses with the engine's exact QueryEngineError", () => {
    const relation = bindJunction(noKeySchema.orphan, "badges");

    const thrown = captureThrown(() => relation.membership.table);

    expect(thrown).toBeInstanceOf(QueryEngineError);
    if (!(thrown instanceof QueryEngineError)) {
      throw new Error("Expected the membership read to throw.");
    }
    expect(thrown.message).toBe(
      'Model "orphan" has no primary key. Many-to-many relations require a complete primary key.'
    );
  });

  test("classification and binding stay lazy over a malformed junction; the first membership read refuses", () => {
    const scope = createQueryScope(adapter, conflictSchema.post);
    const relationInfo = getRelationInfo(scope, "tags");
    if (!relationInfo) {
      throw new Error("Expected relation 'tags' on the test model.");
    }

    // Neither classification nor the bind itself resolves topology — sites
    // that classify to place aliases must not pay configuration refusals.
    expect(() => classifyRelation(scope, relationInfo)).not.toThrow();
    const relation = bindRelation(scope, relationInfo);
    if (relation.position !== "junction") {
      throw new Error("Expected a junction bind.");
    }

    // A different getter than `.table` above: every getter routes through the
    // one all-or-nothing resolver, so the first read pays the same refusal.
    const thrown = captureThrown(() => relation.membership.source);
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("Expected the membership read to throw.");
    }
    expect(thrown.message).toBe(
      "Many-to-many relations between 'post' and 'tag' disagree on junction columns: .A('postCol') vs paired .B('tagCol')."
    );
  });
});

describe("membership scope orientation erasure", () => {
  test("a self-junction read from either end is one membership with opposite sourceIsFirst", () => {
    const follows = bindJunction(selfSchema.follower, "follows").membership;
    const followedBy = bindJunction(
      selfSchema.follower,
      "followedBy"
    ).membership;

    const followsScope = getMembershipScope(follows);
    const followedByScope = getMembershipScope(followedBy);
    if (
      followsScope.kind !== "manyToMany" ||
      followedByScope.kind !== "manyToMany"
    ) {
      throw new Error("Expected junction membership scopes.");
    }

    expect(followsScope.junctionTable).toBe("follower_follower");
    // Both ends name the same model, so the FIELD tie-break decides the
    // canonical order — and the two ends land on opposite orientations.
    expect(followsScope.sourceIsFirst).toBe(false);
    expect(followedByScope.sourceIsFirst).toBe(true);
    // Orientation is carried, never compared: either end is ONE membership.
    expect(relationMembershipScopesEqual(followsScope, followedByScope)).toBe(
      true
    );
    expect(relationMembershipScopesEqual(followedByScope, followsScope)).toBe(
      true
    );
  });
});

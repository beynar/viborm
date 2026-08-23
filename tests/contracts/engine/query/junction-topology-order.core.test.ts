/**
 * WHERE a malformed junction is refused, and what survives orientation.
 *
 * RE-FOUNDED (Package E, §8.3, §11.5.9). This file used to pin the ENGINE's own
 * configuration-error ORDER — "the raw A/B pair is reconciled before either
 * endpoint's row key" — against a binder that expanded a junction lazily at its
 * first membership read. Neither half of that has a successor: exactly one
 * endpoint owns every junction override (§4.4, R011), so there is no cross-side
 * pair to reconcile, and the schema-wide gate expands each junction ONCE, so a
 * malformed one never reaches a scope at all. The physical owner's own refusal
 * order is pinned by `tests/unit/relations/junction-topology.core.test.ts`.
 *
 * What is left here is the fact only a BOUND relation can state: one member
 * table read from either end is ONE membership, and the two traversals differ
 * only by orientation — which for a SELF junction is decided by the asking
 * slot, because both endpoints name the same model.
 */

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { bindRelation } from "@query-engine/builders/relation-data-builder";
import { lookupRelation } from "@query-engine/context";
import { getMembershipReadOrientation } from "@query-engine/OwnWriteLedger";
import {
  getMembershipScope,
  relationMembershipScopesEqual,
} from "@query-engine/RelationMembership";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import { resolveSchemaOrThrow } from "@schema/validation/validator";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

/** A self-referential pair with explicit columns on ONE side. */
const selfSchema = (() => {
  const follower: Model<any> = s.model({
    id: s.string().id(),
    follows: s
      .toMany(() => follower)
      .source("followerId")
      .target("followedId"),
    followedBy: s.toMany(() => follower),
  });
  return { follower };
})();
prepareSchema(selfSchema);

const adapter = new PostgresAdapter();

/** Bind one relation and narrow it to the junction arm. */
function bindJunction(source: Model<any>, relationName: string) {
  const scope = scopeFor(adapter, source);
  const relationRef = lookupRelation(scope, relationName);
  if (!relationRef) {
    throw new Error(`Expected relation '${relationName}' on the test model.`);
  }
  const relation = bindRelation(scope, relationRef);
  if (relation.position !== "junction") {
    throw new Error(`Expected relation '${relationName}' to bind a junction.`);
  }
  return relation;
}

describe("a malformed junction never reaches a bind", () => {
  test("a junction endpoint with no row key is refused by the definition gate", () => {
    const orphan = s.model({
      title: s.string(),
      badges: s.toMany(() => badge),
    });
    const badge = s.model({
      id: s.string().id(),
      orphans: s.toMany(() => orphan),
    });
    const schema = { orphan, badge };
    hydrateSchemaNames(schema);

    // Not a lazy membership read, and not a `QueryEngineError`: the row key a
    // junction side needs is proved when the schema is resolved, so no scope
    // over this schema can be opened at all.
    expect(() => resolveSchemaOrThrow(schema)).toThrow("[JT002]");
  });
});

describe("membership scope orientation erasure", () => {
  test("a self-junction read from either end is one membership with opposite sourceIsFirst", () => {
    const followsRelation = bindJunction(selfSchema.follower, "follows");
    const followedByRelation = bindJunction(selfSchema.follower, "followedBy");
    const follows = followsRelation.membership;
    const followedBy = followedByRelation.membership;

    const followsScope = getMembershipScope(follows);
    const followedByScope = getMembershipScope(followedBy);
    if (
      followsScope.kind !== "junction" ||
      followedByScope.kind !== "junction"
    ) {
      throw new Error("Expected junction membership scopes.");
    }

    expect(followsScope.junctionTable).toBe("follower_follower");
    // Both ends name the same model, so the FIELD tie-break decides the
    // canonical order — and the two ends land on opposite orientations.
    expect(followsScope.sourceIsFirst).toBe(false);
    expect(followedByScope.sourceIsFirst).toBe(true);
    expect(getMembershipReadOrientation(followsRelation)).toBe("junction");
    expect(getMembershipReadOrientation(followedByRelation)).toBe("junction");
    // Orientation is carried, never compared: either end is ONE membership.
    expect(relationMembershipScopesEqual(followsScope, followedByScope)).toBe(
      true
    );
    expect(relationMembershipScopesEqual(followedByScope, followsScope)).toBe(
      true
    );
  });
});

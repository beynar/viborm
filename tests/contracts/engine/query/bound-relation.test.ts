import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { PGliteDriver } from "@drivers/pglite";
import { NestedWriteError } from "@errors";
import {
  type BoundRelation,
  bindRelation,
} from "@query-engine/builders/relation-data-builder";
import { createQueryScope, getRelationInfo } from "@query-engine/context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { constructRoutedOperation } from "@query-engine/write-engine/routing";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const team = s.model({
  id: s.string().id(),
  members: s.oneToMany(() => member),
});

const member = s.model({
  id: s.string().id(),
  teamId: s.string(),
  team: s
    .manyToOne(() => team)
    .fields("teamId")
    .references("id"),
});

const tenant = s.model({
  region: s.string().id(),
  slug: s.string().id(),
  memberships: s.oneToMany(() => membership),
});

const membership = s.model({
  id: s.string().id(),
  tenantRegion: s.string(),
  tenantSlug: s.string(),
  tenant: s
    .manyToOne(() => tenant)
    .fields("tenantRegion", "tenantSlug")
    .references("region", "slug")
    .onUpdate("cascade"),
});

const user = s.model({
  id: s.string().id(),
  profile: s
    .oneToOne(() => profile)
    .name("profile")
    .optional(),
});

const profile = s.model({
  id: s.string().id(),
  userId: s.string(),
  user: s
    .oneToOne(() => user)
    .fields("userId")
    .references("id")
    .name("profile")
    .onUpdate("setNull"),
});

const left = s.model({
  id: s.string().id(),
  inverse: s.manyToOne(() => right).name("edge"),
});

const right = s.model({
  id: s.string().id(),
  leftId: s.string(),
  left: s
    .manyToOne(() => left)
    .fields("leftId")
    .references("id")
    .name("edge"),
});

const namedParent = s.model({
  id: s.string().id(),
  authored: s.oneToMany(() => namedPost).name("author"),
  edited: s.oneToMany(() => namedPost).name("editor"),
});

const namedPost = s.model({
  id: s.string().id(),
  authorId: s.string(),
  editorId: s.string(),
  author: s
    .manyToOne(() => namedParent)
    .fields("authorId")
    .references("id")
    .name("author"),
  editor: s
    .manyToOne(() => namedParent)
    .fields("editorId")
    .references("id")
    .name("editor"),
});

const selfNode: Model<any> = s.model({
  id: s.string().id(),
  parentId: s.string().nullable(),
  parent: s
    .manyToOne(() => selfNode)
    .fields("parentId")
    .references("id")
    .optional()
    .name("tree"),
  children: s.oneToMany(() => selfNode).name("tree"),
});

const organization = s.model({
  id: s.string().id(),
  code: s.string().unique(),
  workers: s.oneToMany(() => worker),
});

const worker = s.model({
  id: s.string().id(),
  organizationCode: s.string(),
  organization: s
    .manyToOne(() => organization)
    .fields("organizationCode")
    .references("code"),
});

const article = s.model({
  id: s.string().id(),
  tags: s.manyToMany(() => tag),
});

const tag = s.model({
  id: s.string().id(),
  articles: s.manyToMany(() => article),
});

const orphanSource = s.model({
  id: s.string().id(),
  targets: s.oneToMany(() => orphanTarget),
});

const orphanTarget = s.model({
  id: s.string().id(),
});

const errorOwner: Model<any> = s.model({
  id: s.string().id(),
  code: s.int().unique(),
  kids: s.oneToMany(() => errorKid),
});

const errorKid: Model<any> = s.model({
  id: s.string().id(),
  ownerA: s.int(),
  ownerB: s.int(),
  owner: s
    .manyToOne(() => errorOwner)
    .fields("ownerA", "ownerB")
    .references("code"),
});

/**
 * Junction-side pins live on their own hydrated schema: a junction's table and
 * column names derive from MODEL names (`@schema/relation/helpers`), so an
 * unhydrated model would resolve every side as "unknown".
 */
const junctionSchema = (() => {
  const post = s.model({
    id: s.string().id(),
    labels: s.manyToMany(() => label),
  });

  const label = s.model({
    id: s.string().id(),
    posts: s.manyToMany(() => post),
  });

  // One self-referential pair with explicit columns on ONE side; the other side
  // must recover the same two columns, swapped.
  const follower: Model<any> = s.model({
    id: s.string().id(),
    follows: s
      .manyToMany(() => follower)
      .A("followerId")
      .B("followedId"),
    followedBy: s.manyToMany(() => follower),
  });

  const compoundDoc = s
    .model({
      tenantId: s.string(),
      id: s.string(),
      labels: s.manyToMany(() => compoundLabel),
    })
    .id(["tenantId", "id"]);

  const compoundLabel = s.model({
    id: s.string().id(),
    docs: s.manyToMany(() => compoundDoc),
  });

  return { post, label, follower, compoundDoc, compoundLabel };
})();
hydrateSchemaNames(junctionSchema);

const adapter = new PostgresAdapter();

interface ClassificationCase {
  readonly label: string;
  readonly source: Model<any>;
  readonly relationName: string;
  /** The three orthogonal axes, pinned one by one. */
  readonly position: BoundRelation["position"];
  readonly cardinality: BoundRelation["cardinality"];
  readonly membership: BoundRelation["membership"]["kind"];
  readonly foreignFields?: readonly string[];
  readonly referencedFields?: readonly string[];
  readonly onUpdate?: "cascade" | "setNull";
}

const cases: readonly ClassificationCase[] = [
  {
    label: "an explicit FK is parent-held to-one",
    source: member,
    relationName: "team",
    position: "parentHeld",
    cardinality: "one",
    membership: "foreignKey",
    foreignFields: ["teamId"],
    referencedFields: ["id"],
  },
  {
    label: "an unnamed one-to-many inverse is child-held to-many",
    source: team,
    relationName: "members",
    position: "childHeld",
    cardinality: "many",
    membership: "foreignKey",
    foreignFields: ["teamId"],
    referencedFields: ["id"],
  },
  {
    label: "an explicit compound FK is parent-held to-one",
    source: membership,
    relationName: "tenant",
    position: "parentHeld",
    cardinality: "one",
    membership: "foreignKey",
    foreignFields: ["tenantRegion", "tenantSlug"],
    referencedFields: ["region", "slug"],
    onUpdate: "cascade",
  },
  {
    label: "the inverse compound edge is child-held to-many",
    source: tenant,
    relationName: "memberships",
    position: "childHeld",
    cardinality: "many",
    membership: "foreignKey",
    foreignFields: ["tenantRegion", "tenantSlug"],
    referencedFields: ["region", "slug"],
    onUpdate: "cascade",
  },
  {
    label: "a fields-less one-to-one is child-held to-one",
    source: user,
    relationName: "profile",
    position: "childHeld",
    cardinality: "one",
    membership: "foreignKey",
    foreignFields: ["userId"],
    referencedFields: ["id"],
    onUpdate: "setNull",
  },
  {
    label: "a fields-less many-to-one is child-held to-one",
    source: left,
    relationName: "inverse",
    position: "childHeld",
    cardinality: "one",
    membership: "foreignKey",
    foreignFields: ["leftId"],
    referencedFields: ["id"],
  },
  {
    label: "a named inverse selects the matching FK",
    source: namedParent,
    relationName: "edited",
    position: "childHeld",
    cardinality: "many",
    membership: "foreignKey",
    foreignFields: ["editorId"],
    referencedFields: ["id"],
  },
  {
    label: "a self-relation keeps its parent-held position",
    source: selfNode,
    relationName: "parent",
    position: "parentHeld",
    cardinality: "one",
    membership: "foreignKey",
    foreignFields: ["parentId"],
    referencedFields: ["id"],
  },
  {
    label: "a non-primary unique reference keeps the referenced field",
    source: organization,
    relationName: "workers",
    position: "childHeld",
    cardinality: "many",
    membership: "foreignKey",
    foreignFields: ["organizationCode"],
    referencedFields: ["code"],
  },
  {
    label: "many-to-many is a junction without FK direction",
    source: article,
    relationName: "tags",
    position: "junction",
    cardinality: "many",
    membership: "junction",
  },
];

describe("bound relation classification", () => {
  test.each(cases)("$label", (classification) => {
    const scope = createQueryScope(adapter, classification.source);
    const relationInfo = getRelationInfo(scope, classification.relationName);
    if (!relationInfo) {
      throw new Error(
        `Expected relation '${classification.relationName}' on the test model.`
      );
    }

    const relation = bindRelation(scope, relationInfo);

    expect(relation.position).toBe(classification.position);
    expect(relation.cardinality).toBe(classification.cardinality);
    expect(relation.membership.kind).toBe(classification.membership);
    expect(relation.sourceModel).toBe(classification.source);
    expect(relation.relationInfo).toBe(relationInfo);

    if (relation.position === "junction") {
      expect(classification.foreignFields).toBeUndefined();
      expect(classification.referencedFields).toBeUndefined();
      return;
    }

    // The binder carries holder/referenced eagerly; this pins them against the
    // position ternary every consumer used to re-run.
    const parentHeld = relation.position === "parentHeld";
    expect(relation.membership.holder).toBe(
      parentHeld ? relation.sourceModel : relation.relationInfo.targetModel
    );
    expect(relation.membership.referenced).toBe(
      parentHeld ? relation.relationInfo.targetModel : relation.sourceModel
    );

    expect(relation.membership.foreignFields).toEqual(
      classification.foreignFields
    );
    if (relation.membership.kind === "polymorphic") {
      expect([relation.membership.referencedField]).toEqual(
        classification.referencedFields
      );
    } else {
      expect(relation.membership.referencedFields).toEqual(
        classification.referencedFields
      );
      expect(relation.membership.members).toEqual(
        classification.foreignFields?.map((foreignField, index) => ({
          foreignField,
          referencedField: classification.referencedFields?.[index],
        }))
      );
    }
    expect(relation.membership.onUpdate).toBe(classification.onUpdate);
  });

  test("a relation without an inverse keeps the existing direction error", () => {
    const scope = createQueryScope(adapter, orphanSource);
    const relationInfo = getRelationInfo(scope, "targets");
    if (!relationInfo) throw new Error("Expected relation 'targets'.");

    expect(() => bindRelation(scope, relationInfo)).toThrow(
      "Cannot determine FK fields for relation 'targets'. Define the inverse relation with .fields([...]) or use explicit FK fields."
    );
  });

  test("relation-key legality still answers before mismatched FK arity", () => {
    const schema = { owner: errorOwner, kid: errorKid };
    hydrateSchemaNames(schema);
    const engine = new QueryEngine(
      new PGliteDriver(),
      createModelRegistry(schema, createSchemaRegistry(schema))
    );

    let thrown: unknown;
    try {
      constructRoutedOperation(engine, errorOwner, "update", {
        where: { id: "owner-1" },
        data: {
          code: { increment: 1 },
          kids: { connect: { id: "kid-1" } },
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NestedWriteError);
    if (!(thrown instanceof Error)) {
      throw new Error("Expected update construction to fail.");
    }
    expect(thrown.message).toBe(
      "Cannot update relation key field 'code' with a non-literal operation while mutating relation 'kids'. Use a literal value or '{ set: ... }'."
    );
    expect(thrown.message).not.toContain("mismatched foreign-key metadata");
  });
});

/** The bound junction's MEMBERSHIP — the two sides and the table they join. */
function bindJunctionMembership(source: Model<any>, relationName: string) {
  const scope = createQueryScope(adapter, source);
  const relationInfo = getRelationInfo(scope, relationName);
  if (!relationInfo) {
    throw new Error(`Expected relation '${relationName}' on the test model.`);
  }
  const relation = bindRelation(scope, relationInfo);
  if (relation.position !== "junction") {
    throw new Error(`Expected relation '${relationName}' to bind a junction.`);
  }
  return relation.membership;
}

describe("bound junction sides", () => {
  test("both sides carry their model, column and referenced field", () => {
    const membership = bindJunctionMembership(junctionSchema.post, "labels");

    expect(membership.table).toBe("label_post");
    expect(membership.source.model).toBe(junctionSchema.post);
    expect(membership.source.members).toEqual([
      { junctionField: "postId", referencedField: "id" },
    ]);
    expect(membership.target.model).toBe(junctionSchema.label);
    expect(membership.target.members).toEqual([
      { junctionField: "labelId", referencedField: "id" },
    ]);
  });

  test("the paired relation reverses the sides and keeps the table", () => {
    const membership = bindJunctionMembership(junctionSchema.label, "posts");

    expect(membership.table).toBe("label_post");
    expect(membership.source.model).toBe(junctionSchema.label);
    expect(membership.source.members).toEqual([
      { junctionField: "labelId", referencedField: "id" },
    ]);
    expect(membership.target.model).toBe(junctionSchema.post);
    expect(membership.target.members).toEqual([
      { junctionField: "postId", referencedField: "id" },
    ]);
  });

  test("a self-relation's two ends reverse orientation on one table", () => {
    const follows = bindJunctionMembership(junctionSchema.follower, "follows");
    const followedBy = bindJunctionMembership(
      junctionSchema.follower,
      "followedBy"
    );

    expect(follows.table).toBe("follower_follower");
    expect(followedBy.table).toBe("follower_follower");
    // Both ends address the same model; only the COLUMN orientation differs, which
    // is the fact a scalar `sourceFieldName` channel used to have to recover.
    expect(follows.source.model).toBe(junctionSchema.follower);
    expect(follows.target.model).toBe(junctionSchema.follower);
    expect(follows.source.members).toEqual([
      { junctionField: "followerId", referencedField: "id" },
    ]);
    expect(follows.target.members).toEqual([
      { junctionField: "followedId", referencedField: "id" },
    ]);
    expect(followedBy.source.members).toEqual([
      { junctionField: "followedId", referencedField: "id" },
    ]);
    expect(followedBy.target.members).toEqual([
      { junctionField: "followerId", referencedField: "id" },
    ]);
  });

  test("a compound primary key is refused when a side is READ, not when the relation is classified", () => {
    // The timing is the contract: `bindRelation` runs at many sites that never ask
    // for junction topology, and the compound-M2M limitation must keep firing where
    // the topology is requested — with its established class and sentence.
    const scope = createQueryScope(adapter, junctionSchema.compoundDoc);
    const relationInfo = getRelationInfo(scope, "labels");
    if (!relationInfo) throw new Error("Expected relation 'labels'.");

    const relation = bindRelation(scope, relationInfo);
    expect(relation.position).toBe("junction");
    if (relation.position !== "junction") {
      throw new Error("Expected a junction.");
    }

    expect(() => relation.membership.source).toThrow(
      'Model "compoundDoc" uses a compound primary key. Many-to-many relations with compound PKs are not supported. Use a single-field surrogate key (e.g., s.string().id().ulid()) instead.'
    );
    // The refusal belongs to the junction resolution, not to one side: the other
    // end of the same pair meets it too, naming the compound model.
    expect(
      () => bindJunctionMembership(junctionSchema.compoundLabel, "docs").target
    ).toThrow('Model "compoundDoc" uses a compound primary key.');
  });
});

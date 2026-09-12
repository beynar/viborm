import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import {
  deriveIdDomains,
  idDomainOf,
  idDomainsOf,
} from "@schema/validation/id-domains";
import {
  type RelationResolution,
  resolveSchemaRelations,
} from "@schema/validation/relation-resolution";
import { describe, expect, test } from "vitest";

const resolve = (schema: Record<string, Model<any>>): RelationResolution => {
  hydrateSchemaNames(schema);
  const models = new Map(Object.entries(schema));
  const modelToName = new Map<Model<any>, string>();
  for (const [name, model] of models) modelToName.set(model, name);
  return resolveSchemaRelations(models, {
    modelToName,
    tableToModels: new Map(),
  });
};

const okIndex = (schema: Record<string, Model<any>>) => {
  const resolution = resolve(schema);
  if (!resolution.ok) {
    throw new Error(
      `expected a resolved schema, got: ${resolution.issues
        .map((issue) => issue.message)
        .join(" | ")}`
    );
  }
  return resolution.index;
};

/** The issues a schema the gate REFUSES reports; an accepted one has none. */
const refusal = (schema: Record<string, Model<any>>) => {
  const resolution = resolve(schema);
  return resolution.ok ? [] : resolution.issues;
};

describe("a foreign key inherits its target's domain", () => {
  test("the ordinary one-to-many case", () => {
    const user = s.model({
      id: s.string().id().uuid("usr"),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    const index = okIndex({ user, post });
    expect(idDomainOf(post, "authorId", index)).toEqual({
      format: "uuid",
      prefix: "usr",
      length: undefined,
    });
  });

  test("the FK scalar's own state is never touched", () => {
    const shared = s.string();
    const user = s.model({
      id: s.string().id().ulid(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: shared,
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    okIndex({ user, post });
    expect(shared["~"].state.autoGenerate).toBeUndefined();
    expect(shared["~"].state.hasDefault).toBe(false);
    // The lookup answers by (model, field): the same scalar elsewhere is not
    // a foreign key and derives nothing.
    expect(idDomainOf(post, "authorId", undefined)).toBeUndefined();
  });

  test("a nullable foreign key derives the same domain", () => {
    const user = s.model({
      id: s.string().id().ksuid(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    expect(idDomainOf(post, "authorId", okIndex({ user, post }))).toMatchObject(
      {
        format: "ksuid",
      }
    );
  });

  test("a self-relation derives from its own model", () => {
    const node = s.model({
      id: s.string().id().uuidv7(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node),
    });
    expect(idDomainOf(node, "parentId", okIndex({ node }))).toMatchObject({
      format: "uuidv7",
    });
  });

  test("a compound key derives member for member", () => {
    const tenant = s
      .model({
        tenantId: s.string().uuid("t"),
        slug: s.string().nanoid(10),
        docs: s.toMany(() => doc),
      })
      .id(["tenantId", "slug"]);
    const doc = s.model({
      id: s.string().id(),
      ownerTenant: s.string(),
      ownerSlug: s.string(),
      owner: s
        .toOne(() => tenant)
        .fields("ownerTenant", "ownerSlug")
        .references("tenantId", "slug"),
    });
    const index = okIndex({ tenant, doc });
    expect(idDomainOf(doc, "ownerTenant", index)).toMatchObject({
      format: "uuid",
      prefix: "t",
    });
    expect(idDomainOf(doc, "ownerSlug", index)).toMatchObject({
      format: "nanoid",
      length: 10,
    });
  });

  test("a chain derives through a key that is itself a foreign key", () => {
    const user = s.model({
      id: s.string().id().uuid(),
      profile: s.toOne(() => profile),
    });
    const profile = s.model({
      userId: s.string().id(),
      user: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
      setting: s.toOne(() => setting),
    });
    const setting = s.model({
      profileId: s.string().id(),
      profile: s
        .toOne(() => profile)
        .fields("profileId")
        .references("userId"),
    });
    const index = okIndex({ user, profile, setting });
    expect(idDomainOf(profile, "userId", index)).toMatchObject({
      format: "uuid",
    });
    // The one-to-one child's own primary key IS the foreign key, so the next
    // level down derives from a derived domain.
    expect(idDomainOf(setting, "profileId", index)).toMatchObject({
      format: "uuid",
    });
  });

  test("a plain key hands its foreign keys no domain", () => {
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
    });
    expect(idDomainOf(post, "authorId", okIndex({ user, post }))).toBe(
      undefined
    );
  });

  test("the derivation is computed once per index", () => {
    const user = s.model({
      id: s.string().id().uuid(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    const index = okIndex({ user, post });
    expect(idDomainsOf(index)).toBe(idDomainsOf(index));
  });
});

describe("disagreement is refused, never resolved", () => {
  test("a foreign key declaring a different format", () => {
    const user = s.model({
      id: s.string().id().uuid(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string().ulid(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    const issues = refusal({ user, post });
    const conflict = issues.find((issue) => issue.code === "FK012");
    expect(conflict?.message).toContain("post.authorId");
    expect(conflict?.message).toContain("a ulid value");
    expect(conflict?.message).toContain("a uuid value");
    expect(conflict?.repair).toContain("declare nothing and let it derive");
  });

  test("a foreign key declaring a different prefix", () => {
    const user = s.model({
      id: s.string().id().uuid("usr"),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string().uuid("org"),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    expect(
      refusal({ user, post }).some((issue) => issue.code === "FK012")
    ).toBe(true);
  });

  test("a foreign key declaring a domain its plain target does not have", () => {
    const user = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string().uuid(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    const conflict = refusal({ user, post }).find(
      (issue) => issue.code === "FK012"
    );
    expect(conflict?.message).toContain("no identifier domain");
  });

  test("one column shared by two references that disagree", () => {
    const author = s.model({
      id: s.string().id().uuid(),
      posts: s.toMany(() => post),
    });
    const editor = s.model({
      id: s.string().id().ulid(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      personId: s.string(),
      author: s
        .toOne(() => author)
        .fields("personId")
        .references("id"),
      editor: s
        .toOne(() => editor)
        .fields("personId")
        .references("id"),
    });
    const conflict = refusal({ author, editor, post }).find(
      (issue) => issue.code === "FK012"
    );
    expect(conflict?.candidates).toEqual(["author.id", "editor.id"]);
    expect(conflict?.repair).toContain("the same identifier format");
  });

  test("a compound key whose members disagree is refused member-wise", () => {
    const tenant = s
      .model({
        tenantId: s.string().uuid(),
        slug: s.string(),
        docs: s.toMany(() => doc),
      })
      .id(["tenantId", "slug"]);
    const doc = s.model({
      id: s.string().id(),
      ownerTenant: s.string().ulid(),
      ownerSlug: s.string(),
      owner: s
        .toOne(() => tenant)
        .fields("ownerTenant", "ownerSlug")
        .references("tenantId", "slug"),
    });
    const issues = refusal({ tenant, doc }).filter(
      (issue) => issue.code === "FK012"
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("ownerTenant");
  });
});

describe("a schema with no relations", () => {
  test("derives nothing and reports nothing", () => {
    const user = s.model({ id: s.string().id().uuid() });
    const index = okIndex({ user });
    const derivation = deriveIdDomains(index);
    expect(derivation.issues).toEqual([]);
    expect(derivation.domains.size).toBe(0);
    // The declared domain is still the lookup's answer.
    expect(idDomainOf(user, "id", index)).toMatchObject({ format: "uuid" });
  });
});

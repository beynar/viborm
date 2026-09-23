import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import { MYSQL, PG, SQLITE } from "@schema/scalars/native-types";
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

  test("a reference cycle with no declaration on it has no domain", () => {
    // `a.peerId` derives from `b.mateId`, which derives from `a.peerId`: one
    // component, whose domain is what its declarations agree on — here, none.
    const a = s.model({
      id: s.string().id(),
      peerId: s.string().unique().nullable(),
      peer: s
        .toOne(() => b)
        .name("peer")
        .fields("peerId")
        .references("mateId"),
      mates: s.toOne(() => b).name("mate"),
    });
    const b = s.model({
      id: s.string().id(),
      mateId: s.string().unique().nullable(),
      mate: s
        .toOne(() => a)
        .name("mate")
        .fields("mateId")
        .references("peerId"),
      peers: s.toOne(() => a).name("peer"),
    });
    const index = okIndex({ a, b });
    expect(idDomainOf(a, "peerId", index)).toBeUndefined();
    expect(idDomainOf(b, "mateId", index)).toBeUndefined();
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

  test("two references that AGREE settle on the one domain they name", () => {
    const author = s.model({
      id: s.string().id().uuid("p"),
      posts: s.toMany(() => post).name("authored"),
    });
    const editor = s.model({
      id: s.string().id().uuid("p"),
      posts: s.toMany(() => post).name("edited"),
    });
    const post = s.model({
      id: s.string().id(),
      personId: s.string(),
      author: s
        .toOne(() => author)
        .name("authored")
        .fields("personId")
        .references("id"),
      editor: s
        .toOne(() => editor)
        .name("edited")
        .fields("personId")
        .references("id"),
    });
    expect(
      idDomainOf(post, "personId", okIndex({ author, editor, post }))
    ).toMatchObject({ format: "uuid", prefix: "p" });
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

/**
 * The polymorphic row carrier's ONE private id column, which stores every
 * variant's key. The question is what each key HOLDS, not what it declares: a
 * variant whose primary key is its parent foreign key declares nothing and
 * still holds uuids, and a carrier typed from one variant while another writes
 * a different domain through it is a column with two readings.
 */
describe("a variant row carrier holds one identifier domain", () => {
  /** Two variants, each keyed by `mode`: "declared" names it, "derived" inherits. */
  const carrierSchema = (
    first: "declared" | "derived",
    second: "declared" | "derived",
    secondFormat: "uuid" | "ulid" = "uuid"
  ) => {
    const keyOf = (format: "uuid" | "ulid") =>
      format === "uuid" ? s.string().id().uuid("b") : s.string().id().ulid();
    const parentA = s.model({
      id: keyOf("uuid"),
      child: s.toOne(() => variantA),
    });
    const parentB = s.model({
      id: keyOf(secondFormat),
      child: s.toOne(() => variantB),
    });
    const variantA =
      first === "declared"
        ? s.model({
            id: keyOf("uuid"),
            notes: s.toMany(() => note).name("subject"),
          })
        : s.model({
            id: s.string().id(),
            parent: s
              .toOne(() => parentA)
              .fields("id")
              .references("id"),
            notes: s.toMany(() => note).name("subject"),
          });
    const variantB =
      second === "declared"
        ? s.model({
            id: keyOf(secondFormat),
            notes: s.toMany(() => note).name("subject"),
          })
        : s.model({
            id: s.string().id(),
            parent: s
              .toOne(() => parentB)
              .fields("id")
              .references("id"),
            notes: s.toMany(() => note).name("subject"),
          });
    const note = s.model({
      id: s.string().id(),
      subject: s
        .toOne(
          { a: () => variantA, b: () => variantB },
          { values: { a: "a", b: "b" } }
        )
        .name("subject"),
    });
    return {
      variantA,
      variantB,
      note,
      // A parent belongs to the schema only when its child derives from it;
      // a declared variant names no parent and would leave one uninverted.
      ...(first === "derived" ? { parentA } : {}),
      ...(second === "derived" ? { parentB } : {}),
    };
  };

  test("one variant declares the domain and the other derives it", () => {
    expect(refusal(carrierSchema("declared", "derived"))).toEqual([]);
  });

  test("both variants derive the same domain", () => {
    expect(refusal(carrierSchema("derived", "derived"))).toEqual([]);
  });

  test("two DERIVED domains that differ are refused", () => {
    const conflict = refusal(carrierSchema("derived", "derived", "ulid")).find(
      (issue) => issue.code === "P002"
    );
    expect(conflict?.message).toContain(
      "A column stores one identifier domain"
    );
    expect(conflict?.candidates).toEqual(["variantA.id", "variantB.id"]);
  });

  test("two DECLARED domains that differ are still refused", () => {
    const conflict = refusal(
      carrierSchema("declared", "declared", "ulid")
    ).find((issue) => issue.code === "P002");
    expect(conflict?.relation).toBe("subject");
    expect(conflict?.repair).toContain("the same identifier format");
  });
});

describe("a schema with no relations", () => {
  test("derives nothing and reports nothing", () => {
    const user = s.model({ id: s.string().id().uuid() });
    const index = okIndex({ user });
    const derivation = deriveIdDomains(index);
    expect(derivation.issues).toEqual([]);
    expect(derivation.domains.get(user)?.get("id")).toMatchObject({
      format: "uuid",
    });
    expect(idDomainOf(user, "id", index)).toMatchObject({ format: "uuid" });
  });
});

describe("a native type the domain cannot live in", () => {
  test("is refused with the spellings it accepts", () => {
    const user = s.model({ id: s.string(PG.INT.INTEGER).id().uuid() });
    const issue = refusal({ user }).find((entry) => entry.code === "F013");
    expect(issue?.message).toContain("user.id");
    expect(issue?.message).toContain("a uuid value");
    expect(issue?.message).toContain("integer");
    expect(issue?.repair).toContain("uuid, bytea, text");
  });

  test("a text-family override is accepted and keeps the domain", () => {
    const user = s.model({ id: s.string(PG.STRING.VARCHAR(36)).id().uuid() });
    expect(refusal({ user })).toEqual([]);
  });

  test("a binary override of the wrong width is refused", () => {
    const user = s.model({ id: s.string(MYSQL.BLOB.BINARY(16)).id().ksuid() });
    expect(refusal({ user }).some((entry) => entry.code === "F013")).toBe(true);
  });

  test("an override for another dialect is checked against that dialect", () => {
    const user = s.model({ id: s.string(SQLITE.BLOB.BLOB).id().uuid() });
    expect(refusal({ user })).toEqual([]);
  });

  test("a DERIVED foreign key is checked too", () => {
    const user = s.model({
      id: s.string().id().uuid(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(PG.INT.INTEGER),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    const issue = refusal({ user, post }).find(
      (entry) => entry.code === "F013"
    );
    expect(issue?.field).toBe("authorId");
  });

  test("a field with no domain keeps every override it ever had", () => {
    const user = s.model({ id: s.string(PG.INT.INTEGER).id() });
    expect(refusal({ user })).toEqual([]);
  });
});

/**
 * A foreign key holds its key's values, so it holds them in the key's own
 * physical form. Storage is read off each column's OWN native type, so a key
 * kept text by an override beside a foreign key that declares none would be a
 * `uuid` / byte column referencing a text one.
 */
describe("a foreign key stores its key's values the way the key does", () => {
  const referencing = (
    keyType: Parameters<typeof s.string>[0],
    foreignType: Parameters<typeof s.string>[0]
  ) => {
    const user = s.model({
      id: s.string(keyType).id().uuid("usr"),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(foreignType),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    return { user, post };
  };

  test("a foreign key with no override beside a text-kept key is refused", () => {
    const issue = refusal(referencing(PG.STRING.VARCHAR(40), undefined)).find(
      (entry) => entry.code === "FK012"
    );
    expect(issue?.field).toBe("authorId");
    expect(issue?.candidates).toEqual(["post.authorId", "user.id"]);
    expect(issue?.message).toContain("as uuid on pg");
    expect(issue?.message).toContain("'user.id', as varchar(40)");
    expect(issue?.repair).toContain("the same pg native type");
  });

  test("a text-kept foreign key beside a compact key is refused", () => {
    expect(
      refusal(referencing(undefined, MYSQL.STRING.VARCHAR(40))).some(
        (entry) => entry.code === "FK012"
      )
    ).toBe(true);
  });

  test("two text spellings hold the same strings and are accepted", () => {
    expect(refusal(referencing(PG.STRING.TEXT, PG.STRING.VARCHAR(40)))).toEqual(
      []
    );
  });

  test("an override that names the automatic storage is accepted", () => {
    expect(refusal(referencing(MYSQL.BLOB.BINARY(16), undefined))).toEqual([]);
  });
});

describe("without a schema context", () => {
  test("an issue still names the field it is about", () => {
    // `idDomainsOf` derives from an index alone — it drops issues, so it needs
    // no names — and `deriveIdDomains` is exported for the same shape. The
    // marker falls back to the model's own hydrated name, and to a neutral
    // word for a model that was never registered under one.
    const user = s.model({ id: s.string(PG.INT.INTEGER).id().uuid() });
    const index = new Map([[user, new Map()]]);
    const issue = deriveIdDomains(index).issues[0];
    expect(issue?.code).toBe("F013");
    expect(issue?.message).toContain("model.id");
  });
});

/**
 * A reference cycle is one strongly connected component of the reference
 * graph: every field on it holds every other's values, so the component holds
 * ONE domain, agreed by every declaration on it and every key it references
 * outside itself. Registration order is an object's key order, and a schema's
 * validity cannot depend on it.
 */
describe("a reference cycle derives one domain, whatever order registers it", () => {
  /** `a.peerId` → `b.mateId` → `a.peerId`, each side optionally declaring. */
  const pair = (
    onA: "uuid" | "ulid" | undefined,
    onB: "uuid" | "ulid" | undefined
  ) => {
    const key = (format: "uuid" | "ulid" | undefined) => {
      const base = s.string().unique().nullable();
      if (format === "uuid") return base.uuid("p");
      if (format === "ulid") return base.ulid();
      return base;
    };
    const a = s.model({
      id: s.string().id(),
      peerId: key(onA),
      peer: s
        .toOne(() => b)
        .name("peer")
        .fields("peerId")
        .references("mateId"),
      mates: s.toOne(() => b).name("mate"),
    });
    const b = s.model({
      id: s.string().id(),
      mateId: key(onB),
      mate: s
        .toOne(() => a)
        .name("mate")
        .fields("mateId")
        .references("peerId"),
      peers: s.toOne(() => a).name("peer"),
    });
    return { a, b };
  };

  test("one declaration on a two-model cycle is every member's domain, in both orders", () => {
    for (const declaring of ["a", "b"] as const) {
      const forward = pair(
        declaring === "a" ? "uuid" : undefined,
        declaring === "b" ? "uuid" : undefined
      );
      const forwardIndex = okIndex({ a: forward.a, b: forward.b });
      const backward = pair(
        declaring === "a" ? "uuid" : undefined,
        declaring === "b" ? "uuid" : undefined
      );
      const backwardIndex = okIndex({ b: backward.b, a: backward.a });
      for (const [{ a, b }, index] of [
        [forward, forwardIndex],
        [backward, backwardIndex],
      ] as const) {
        expect(idDomainOf(a, "peerId", index)).toMatchObject({
          format: "uuid",
          prefix: "p",
        });
        expect(idDomainOf(b, "mateId", index)).toMatchObject({
          format: "uuid",
          prefix: "p",
        });
      }
    }
  });

  test("two declarations that disagree on a cycle are refused in both orders", () => {
    const forward = pair("uuid", "ulid");
    const backward = pair("uuid", "ulid");
    for (const issues of [
      refusal({ a: forward.a, b: forward.b }),
      refusal({ b: backward.b, a: backward.a }),
    ]) {
      const conflict = issues.find((issue) => issue.code === "FK012");
      expect(conflict?.message).toContain("a uuid value");
      expect(conflict?.message).toContain("a ulid value");
    }
  });

  test("a three-model cycle with one declaration derives it in every order", () => {
    const ring = () => {
      const a = s.model({
        id: s.string().id(),
        nextId: s.string().unique().nullable().uuid("r"),
        next: s
          .toOne(() => b)
          .name("ab")
          .fields("nextId")
          .references("nextId"),
        prev: s.toOne(() => c).name("ca"),
      });
      const b = s.model({
        id: s.string().id(),
        nextId: s.string().unique().nullable(),
        next: s
          .toOne(() => c)
          .name("bc")
          .fields("nextId")
          .references("nextId"),
        prev: s.toOne(() => a).name("ab"),
      });
      const c = s.model({
        id: s.string().id(),
        nextId: s.string().unique().nullable(),
        next: s
          .toOne(() => a)
          .name("ca")
          .fields("nextId")
          .references("nextId"),
        prev: s.toOne(() => b).name("bc"),
      });
      return { a, b, c };
    };
    const orders = [
      ["a", "b", "c"],
      ["a", "c", "b"],
      ["b", "a", "c"],
      ["b", "c", "a"],
      ["c", "a", "b"],
      ["c", "b", "a"],
    ] as const;
    for (const order of orders) {
      const models = ring();
      const index = okIndex(
        Object.fromEntries(order.map((name) => [name, models[name]]))
      );
      for (const model of [models.a, models.b, models.c]) {
        expect(idDomainOf(model, "nextId", index)).toMatchObject({
          format: "uuid",
          prefix: "r",
        });
      }
    }
  });

  test("a cycle inside one model derives one domain, in both field orders", () => {
    const loop = (first: "peer" | "mate") => {
      const peer = {
        peerId: s.string().unique().nullable().ulid(),
        peer: s
          .toOne(() => node)
          .name("peer")
          .fields("peerId")
          .references("mateId"),
        peerOf: s.toOne(() => node).name("peer"),
      };
      const mate = {
        mateId: s.string().unique().nullable(),
        mate: s
          .toOne(() => node)
          .name("mate")
          .fields("mateId")
          .references("peerId"),
        mateOf: s.toOne(() => node).name("mate"),
      };
      const node = s.model(
        first === "peer"
          ? { id: s.string().id(), ...peer, ...mate }
          : { id: s.string().id(), ...mate, ...peer }
      );
      return node;
    };
    for (const first of ["peer", "mate"] as const) {
      const node = loop(first);
      const index = okIndex({ node });
      expect(idDomainOf(node, "mateId", index)).toMatchObject({
        format: "ulid",
      });
    }
  });

  test("a cycle takes the domain of a key it references outside itself", () => {
    const owned = (onB: "uuid" | undefined) => {
      const user = s.model({
        id: s.string().id().ksuid(),
        pair: s.toOne(() => a).name("owner"),
      });
      const a = s.model({
        id: s.string().id(),
        peerId: s.string().unique().nullable(),
        peer: s
          .toOne(() => b)
          .name("peer")
          .fields("peerId")
          .references("mateId"),
        owner: s
          .toOne(() => user)
          .name("owner")
          .fields("peerId")
          .references("id"),
        mates: s.toOne(() => b).name("mate"),
      });
      const mateId = s.string().unique().nullable();
      const b = s.model({
        id: s.string().id(),
        mateId: onB === "uuid" ? mateId.uuid() : mateId,
        mate: s
          .toOne(() => a)
          .name("mate")
          .fields("mateId")
          .references("peerId"),
        peers: s.toOne(() => a).name("peer"),
      });
      return { user, a, b };
    };
    for (const reversed of [false, true]) {
      const { user, a, b } = owned(undefined);
      const index = okIndex(reversed ? { b, a, user } : { user, a, b });
      expect(idDomainOf(b, "mateId", index)).toMatchObject({ format: "ksuid" });

      const declaring = owned("uuid");
      const conflict = refusal(
        reversed
          ? { b: declaring.b, a: declaring.a, user: declaring.user }
          : { user: declaring.user, a: declaring.a, b: declaring.b }
      ).find((issue) => issue.code === "FK012");
      expect(conflict?.message).toContain("a ksuid value");
      expect(conflict?.message).toContain("a uuid value");
    }
  });
});

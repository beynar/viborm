import { s } from "@src/schema";
import { validateSchema } from "@src/schema/validation";
import { describe, expect, it } from "vitest";

function errors(result: ReturnType<typeof validateSchema>) {
  return result.errors.map((issue) => issue.code);
}
const repairs = (result: ReturnType<typeof validateSchema>) =>
  result.errors.map((issue) => issue.repair);

/** Two endpoints joined through `link`, with what each test varies. */
const between = (
  linkOf: (ends: { left: any; right: any }) => any,
  through: (relation: any) => any = (relation) => relation
) => {
  const left: any = s.model({
    id: s.string().id(),
    rights: through(s.toMany(() => right).through(() => link)),
  });
  const right: any = s.model({
    id: s.string().id(),
    lefts: s.toMany(() => left),
  });
  const link: any = linkOf({ left, right });
  return { left, right, link };
};

const fieldsOf = (left: any, right: any) => ({
  leftId: s.string(),
  rightId: s.string(),
  left: s
    .toOne(() => left)
    .fields("leftId")
    .references("id"),
  right: s
    .toOne(() => right)
    .fields("rightId")
    .references("id"),
});

describe("a declared model as a junction: the legal forms", () => {
  it("resolves with no inverse on either side, and chooses each side when one aims at it", () => {
    const schema = between(({ left, right }) =>
      s.model(fieldsOf(left, right)).id(["leftId", "rightId"])
    );
    expect(validateSchema(schema).errors).toEqual([]);
  });

  it("names a side with an inverse of its own and pairs it as usual", () => {
    const left: any = s.model({
      id: s.string().id(),
      rights: s
        .toMany(() => right)
        .through(() => link)
        .source("left")
        .target("right"),
      links: s.toMany(() => link),
    });
    const right: any = s.model({
      id: s.string().id(),
      lefts: s.toMany(() => left),
    });
    const link: any = s
      .model(fieldsOf(left, right))
      .id(["leftId", "rightId"]);
    expect(validateSchema({ left, right, link }).errors).toEqual([]);
  });

  it("reads the declaration from either endpoint", () => {
    const left: any = s.model({
      id: s.string().id(),
      rights: s.toMany(() => right),
    });
    const right: any = s.model({
      id: s.string().id(),
      lefts: s.toMany(() => left).through(() => link),
    });
    const link: any = s
      .model(fieldsOf(left, right))
      .id(["leftId", "rightId"]);
    expect(validateSchema({ left, right, link }).errors).toEqual([]);
  });

  it("lets a side with no same-named inverse sit beside one with an inverse", () => {
    const node: any = s.model({
      id: s.string().id(),
      parents: s
        .toMany(() => node)
        .name("graph")
        .through(() => link)
        .source("child")
        .target("parent"),
      children: s.toMany(() => node).name("graph"),
      childLinks: s.toMany(() => link).name("child"),
    });
    const link: any = s
      .model({
        childId: s.string(),
        parentId: s.string(),
        child: s
          .toOne(() => node)
          .name("child")
          .fields("childId")
          .references("id"),
        parent: s
          .toOne(() => node)
          .fields("parentId")
          .references("id"),
      })
      .id(["childId", "parentId"]);
    expect(validateSchema({ node, link }).errors).toEqual([]);
  });

  it("keeps the inverse rule for every other relation of the junction model", () => {
    const owner = s.model({ id: s.string().id() });
    const schema = between(({ left, right }) =>
      s
        .model({
          ...fieldsOf(left, right),
          ownerId: s.string().nullable(),
          owner: s
            .toOne(() => owner)
            .fields("ownerId")
            .references("id"),
        })
        .id(["leftId", "rightId"])
    );
    expect(errors(validateSchema({ ...schema, owner }))).toContain("R002");
  });

  it("omits a shared column from the key only where it follows from the row", () => {
    const team: any = s
      .model({
        id: s.string().id(),
        org: s.string(),
        parents: s
          .toMany(() => team)
          .name("g")
          .through(() => link)
          .source("child")
          .target("parent"),
        children: s.toMany(() => team).name("g"),
      })
      .unique(["org", "id"]);
    const link: any = s
      .model({
        org: s.string(),
        childId: s.string(),
        parentId: s.string(),
        child: s
          .toOne(() => team)
          .fields("org", "childId")
          .references("org", "id"),
        parent: s
          .toOne(() => team)
          .fields("org", "parentId")
          .references("org", "id"),
      })
      .id(["childId", "parentId"]);
    expect(validateSchema({ team, link }).errors).toEqual([]);
  });
});

describe("a declared model as a junction: every refusal carries its repair", () => {
  it("JT004: a model the schema does not register", () => {
    const stray = s.model({ id: s.string().id() });
    const left: any = s.model({
      id: s.string().id(),
      rights: s.toMany(() => right).through(() => stray),
    });
    const right: any = s.model({
      id: s.string().id(),
      lefts: s.toMany(() => left),
    });
    const result = validateSchema({ left, right });
    expect(errors(result)).toEqual(["JT004"]);
    expect(repairs(result)[0]).toContain("Register");
  });

  it("JT004: a thunk that throws stops resolution with its reason", () => {
    const left: any = s.model({
      id: s.string().id(),
      rights: s
        .toMany(() => right)
        .through(() => {
          throw new Error("no model here");
        }),
    });
    const right: any = s.model({
      id: s.string().id(),
      lefts: s.toMany(() => left),
    });
    expect(validateSchema({ left, right }).errors[0]).toMatchObject({
      code: "JT004",
      message: expect.stringContaining("no model here"),
    });
  });

  it("JT005: a named side that is missing", () => {
    const schema = between(
      ({ left, right }) =>
        s.model(fieldsOf(left, right)).id(["leftId", "rightId"]),
      (relation) => relation.source("nope")
    );
    expect(errors(validateSchema(schema))).toEqual(["JT005"]);
  });

  it("JT005: a named side that is not a to-one holding its reference", () => {
    const left: any = s.model({
      id: s.string().id(),
      rights: s
        .toMany(() => right)
        .through(() => link)
        .source("leftRows"),
      linkRows: s.toMany(() => link).name("rows"),
    });
    const right: any = s.model({
      id: s.string().id(),
      lefts: s.toMany(() => left),
    });
    const link: any = s
      .model({
        ...fieldsOf(left, right),
        leftRows: s.toMany(() => left).name("rows"),
      })
      .id(["leftId", "rightId"]);
    expect(errors(validateSchema({ left, right, link }))).toContain("JT005");
  });

  it("JT005: a side aimed at the wrong model", () => {
    const schema = between(
      ({ left, right }) =>
        s.model(fieldsOf(left, right)).id(["leftId", "rightId"]),
      (relation) => relation.source("right").target("left")
    );
    expect(errors(validateSchema(schema))).toEqual(["JT005", "JT005"]);
  });

  it("JT005: a nullable side", () => {
    const schema = between(({ left, right }) =>
      s
        .model({ ...fieldsOf(left, right), leftId: s.string().nullable() })
        .id(["rightId"])
    );
    expect(errors(validateSchema(schema))).toContain("JT005");
  });

  it("JT005: one relation named as both sides of a self relation", () => {
    const node: any = s.model({
      id: s.string().id(),
      parents: s
        .toMany(() => node)
        .name("g")
        .through(() => link)
        .source("child")
        .target("child"),
      children: s.toMany(() => node).name("g"),
    });
    const link: any = s
      .model({
        childId: s.string(),
        parentId: s.string(),
        child: s
          .toOne(() => node)
          .fields("childId")
          .references("id"),
        parent: s
          .toOne(() => node)
          .fields("parentId")
          .references("id"),
      })
      .id(["childId", "parentId"]);
    expect(errors(validateSchema({ node, link }))).toEqual(["JT005"]);
  });

  it("JT006: a self relation that states no side", () => {
    const node: any = s.model({
      id: s.string().id(),
      parents: s
        .toMany(() => node)
        .name("g")
        .through(() => link),
      children: s.toMany(() => node).name("g"),
    });
    const link: any = s
      .model({
        childId: s.string(),
        parentId: s.string(),
        child: s
          .toOne(() => node)
          .fields("childId")
          .references("id"),
        parent: s
          .toOne(() => node)
          .fields("parentId")
          .references("id"),
      })
      .id(["childId", "parentId"]);
    expect(errors(validateSchema({ node, link }))).toEqual(["JT006", "JT006"]);
  });

  it("JT006: two candidates and no name", () => {
    const schema = between(({ left, right }) =>
      s
        .model({
          ...fieldsOf(left, right),
          otherId: s.string(),
          other: s
            .toOne(() => left)
            .fields("otherId")
            .references("id"),
        })
        .id(["leftId", "rightId", "otherId"])
    );
    expect(errors(validateSchema(schema))).toEqual(["JT006"]);
  });

  it("JT007: a junction model storing a polymorphic relation", () => {
    const schema = between(({ left, right }) =>
      s
        .model({
          ...fieldsOf(left, right),
          subject: s.toOne({ left: () => left }).optional(),
        })
        .id(["leftId", "rightId"])
    );
    expect(errors(validateSchema(schema))).toContain("JT007");
  });

  it("R012: a polymorphic endpoint cannot declare the model", () => {
    const left: any = s.model({ id: s.string().id() });
    const owner: any = s.model({
      id: s.string().id(),
      lefts: s.toMany({ left: () => left }),
    });
    const inverse: any = s.model({
      id: s.string().id(),
      owners: s.toMany(() => owner).through(() => link),
    });
    const link: any = s.model({ id: s.string().id() });
    expect(
      validateSchema({ left, owner, inverse, link }).errors.length
    ).toBeGreaterThan(0);
  });

  it("JT008: no key at all, a key outside the pair, and a key that merges pairs", () => {
    const noKey = between(({ left, right }) =>
      s.model({ id: s.string().id(), ...fieldsOf(left, right) })
    );
    expect(errors(validateSchema(noKey))).toEqual(["JT008"]);
    const oneSided = between(({ left, right }) =>
      s
        .model({ ...fieldsOf(left, right), note: s.string().default("x") })
        .id(["leftId", "note"])
    );
    expect(errors(validateSchema(oneSided))).toEqual(["JT008"]);
  });

  it("JT008: a key omitting a shared column that does not follow from the row", () => {
    // `id` alone does not name a tenant's team here, so (child, parent) would
    // merge the links of two tenants and `DO NOTHING` would drop the second.
    const team: any = s
      .model({
        org: s.string(),
        id: s.string(),
        parents: s
          .toMany(() => team)
          .name("g")
          .through(() => link)
          .source("child")
          .target("parent"),
        children: s.toMany(() => team).name("g"),
      })
      .id(["org", "id"]);
    const link: any = s
      .model({
        org: s.string(),
        childId: s.string(),
        parentId: s.string(),
        child: s
          .toOne(() => team)
          .fields("org", "childId")
          .references("org", "id"),
        parent: s
          .toOne(() => team)
          .fields("org", "parentId")
          .references("org", "id"),
      })
      .id(["childId", "parentId"]);
    expect(errors(validateSchema({ team, link }))).toEqual(["JT008"]);
  });

  it("a required column with no default is legal: a write must state it", () => {
    const schema = between(({ left, right }) =>
      s
        .model({
          ...fieldsOf(left, right),
          role: s.string(),
          token: s.string().uuid(),
        })
        .id(["leftId", "rightId"])
    );
    expect(errors(validateSchema(schema))).toEqual([]);
  });

  it("JT009: one model as the junction of two pairs", () => {
    const left: any = s.model({
      id: s.string().id(),
      rights: s
        .toMany(() => right)
        .name("one")
        .through(() => link),
      others: s
        .toMany(() => right)
        .name("two")
        .through(() => link),
    });
    const right: any = s.model({
      id: s.string().id(),
      lefts: s.toMany(() => left).name("one"),
      otherLefts: s.toMany(() => left).name("two"),
    });
    const link: any = s
      .model(fieldsOf(left, right))
      .id(["leftId", "rightId"]);
    expect(errors(validateSchema({ left, right, link }))).toEqual(["JT009"]);
  });

  it("JT010: a referential action beside a model", () => {
    const schema = between(
      ({ left, right }) =>
        s.model(fieldsOf(left, right)).id(["leftId", "rightId"]),
      (relation) => relation.onDelete("cascade")
    );
    expect(errors(validateSchema(schema))).toEqual(["JT010"]);
  });

  it("R011: both endpoints declaring the junction stays the ordinary refusal", () => {
    const left: any = s.model({
      id: s.string().id(),
      rights: s.toMany(() => right).through(() => link),
    });
    const right: any = s.model({
      id: s.string().id(),
      lefts: s.toMany(() => left).through(() => link),
    });
    const link: any = s
      .model(fieldsOf(left, right))
      .id(["leftId", "rightId"]);
    expect(errors(validateSchema({ left, right, link }))).toEqual(["R011"]);
  });

  it("a shared column whose sides reference different types is the reference's refusal", () => {
    const left: any = s.model({
      id: s.string().id(),
      tenant: s.string(),
      rights: s
        .toMany(() => right)
        .through(() => link),
    }).unique(["tenant", "id"]);
    const right: any = s
      .model({
        id: s.string().id(),
        tenant: s.int(),
        lefts: s.toMany(() => left),
      })
      .unique(["tenant", "id"]);
    const link: any = s
      .model({
        tenant: s.string(),
        leftId: s.string(),
        rightId: s.string(),
        left: s
          .toOne(() => left)
          .fields("tenant", "leftId")
          .references("tenant", "id"),
        right: s
          .toOne(() => right)
          .fields("tenant", "rightId")
          .references("tenant", "id"),
      })
      .id(["leftId", "rightId"]);
    const result = validateSchema({ left, right, link });
    expect(errors(result).length).toBeGreaterThan(0);
    expect(errors(result).some((code) => code.startsWith("FK"))).toBe(true);
  });

  it("a side whose own columns are unique contradicts the collection (FK009)", () => {
    const schema = between(({ left, right }) =>
      s
        .model({
          ...fieldsOf(left, right),
          leftId: s.string().unique(),
        })
        .id(["leftId", "rightId"])
    );
    expect(errors(validateSchema(schema))).toContain("FK009");
  });

  it("a side reference that is itself illegal stops at its own code", () => {
    const schema = between(({ left, right }) =>
      s
        .model({
          leftId: s.string(),
          rightId: s.string(),
          left: s
            .toOne(() => left)
            .fields("leftId")
            .references("nothing"),
          right: s
            .toOne(() => right)
            .fields("rightId")
            .references("id"),
        })
        .id(["leftId", "rightId"])
    );
    expect(errors(validateSchema(schema))).toContain("FK002");
  });
});

describe("the name of the link row", () => {
  it("F001: no member takes it, so the key has one producer", () => {
    const named = s.model({
      id: s.string().id(),
      ["$through" as string]: s.string(),
    });
    expect(validateSchema({ named }).errors).toMatchObject([
      { code: "F001", field: "$through" },
    ]);
  });
});

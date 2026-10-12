/**
 * Recursive relation filters (`recurse` in `where`): which slots admit the
 * closure form, what it normalizes to, and every sentence it is refused with.
 * The engine reads the admitted value without re-parsing it, so the dense
 * output shape is pinned exactly.
 */

import { s } from "@schema";
import { createSchemaRegistry, parse, toJsonSchema } from "@validation";
import { UNAVAILABLE_RECURRENCE } from "@validation/relations/recurrence";
import { describe, expect, test } from "vitest";

const document = s.model({
  id: s.string().id(),
  personal: s.boolean(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => document)
    .name("documentTree")
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => document).name("documentTree"),
  grants: s.toMany(() => grant),
});

const grant = s.model({
  id: s.string().id(),
  userId: s.string(),
  documentId: s.string(),
  document: s
    .toOne(() => document)
    .fields("documentId")
    .references("id"),
  teamId: s.string().nullable(),
  team: s
    .toOne(() => team)
    .fields("teamId")
    .references("id"),
});

const team = s.model({
  id: s.string().id(),
  name: s.string(),
  parents: s
    .toMany(() => team)
    .name("teamGraph")
    .through("teamParent")
    .source("childId")
    .target("parentId"),
  children: s.toMany(() => team).name("teamGraph"),
  grants: s.toMany(() => grant),
});

const compoundNode = s
  .model({
    tenantId: s.string(),
    localId: s.string(),
    label: s.string(),
    parentTenantId: s.string().nullable(),
    parentLocalId: s.string().nullable(),
    parent: s
      .toOne(() => compoundNode)
      .name("compoundTree")
      .fields("parentTenantId", "parentLocalId")
      .references("tenantId", "localId"),
    children: s.toMany(() => compoundNode).name("compoundTree"),
  })
  .id(["tenantId", "localId"]);

// A self relation on a model without a complete primary key.
const keyless = s.model({
  code: s.string().unique(),
  parentCode: s.string().nullable(),
  parent: s
    .toOne(() => keyless)
    .name("keylessTree")
    .fields("parentCode")
    .references("code"),
  children: s.toMany(() => keyless).name("keylessTree"),
});

// A self variant carrier and the inverse bound to its storage.
const thread = s.model({
  id: s.string().id(),
  replyTo: s
    .toOne({ thread: () => thread }, { values: { thread: "thread.reply.v1" } })
    .name("threadReply")
    .optional(),
  replies: s.toMany(() => thread).name("threadReply"),
});

// Target fields literally named `recurse` and `self`, on an eligible self
// relation and on an ineligible one.
const oddNode = s.model({
  id: s.string().id(),
  recurse: s.string(),
  self: s.boolean(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => oddNode)
    .name("oddTree")
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => oddNode).name("oddTree"),
  holders: s.toMany(() => oddHolder),
});

const oddHolder = s.model({
  id: s.string().id(),
  nodeId: s.string(),
  node: s
    .toOne(() => oddNode)
    .fields("nodeId")
    .references("id"),
});

const schemas = createSchemaRegistry({
  document,
  grant,
  team,
  compoundNode,
  keyless,
  thread,
  oddNode,
  oddHolder,
}).proxy;

const filters = {
  documentParent: schemas.document.relations.parent.filter,
  documentChildren: schemas.document.relations.children.filter,
  documentGrants: schemas.document.relations.grants.filter,
  teamParents: schemas.team.relations.parents.filter,
  teamChildren: schemas.team.relations.children.filter,
  compoundParent: schemas.compoundNode.relations.parent.filter,
  compoundChildren: schemas.compoundNode.relations.children.filter,
};

function issueOf(result: {
  issues?: readonly { message: string; path?: readonly PropertyKey[] }[];
}) {
  const issue = result.issues?.[0];
  if (!issue) throw new Error("Expected an admission issue");
  return issue;
}

/** The dense admitted closure the engine reads without re-parsing. */
const closure = (
  recurse: { depth: number | false; cycles: string },
  arms: {
    self?: boolean;
    some?: unknown;
    every?: unknown;
    none?: unknown;
  }
) => ({
  recurse,
  self: arms.self,
  some: arms.some,
  every: arms.every,
  none: arms.none,
  is: undefined,
  isNot: undefined,
});

const FK_DEFAULT = { depth: 100, cycles: "reject" };
const GRAPH_DEFAULT = { depth: 100, cycles: "prevent" };

describe("recursive filter — admission", () => {
  test("admits the closure form on both ends of a foreign key, dense", () => {
    expect(
      parse(filters.documentParent, {
        recurse: true,
        self: true,
        some: { grants: { some: { userId: "u" } } },
      })
    ).toStrictEqual({
      value: closure(FK_DEFAULT, {
        self: true,
        some: { grants: { some: { userId: { equals: "u" } } } },
      }),
    });
    expect(
      parse(filters.documentChildren, {
        recurse: { depth: 2 },
        every: { personal: false },
        none: { personal: true },
      })
    ).toStrictEqual({
      value: closure(
        { depth: 2, cycles: "reject" },
        {
          every: { personal: { equals: false } },
          none: { personal: { equals: true } },
        }
      ),
    });
  });

  test("admits the closure form on both directions of a self junction", () => {
    for (const filter of [filters.teamParents, filters.teamChildren]) {
      expect(
        parse(filter, { recurse: true, self: false, some: { name: "x" } })
      ).toStrictEqual({
        value: closure(GRAPH_DEFAULT, {
          self: false,
          some: { name: { equals: "x" } },
        }),
      });
    }
  });

  test("admits the closure form on a compound primary key", () => {
    for (const filter of [filters.compoundParent, filters.compoundChildren]) {
      expect(
        parse(filter, { recurse: { depth: false }, some: { label: "x" } })
      ).toStrictEqual({
        value: closure(
          { depth: false, cycles: "reject" },
          { some: { label: { equals: "x" } } }
        ),
      });
    }
  });

  test("normalizes the recurrence bag exactly as select does", () => {
    const admitted = (
      recurse: { depth: number | false; cycles: string },
      self?: boolean
    ) => ({ value: closure(recurse, { self, some: {} }) });
    for (const recurse of [true, {}, { depth: undefined }]) {
      expect(
        parse(filters.documentParent, { recurse, some: {} })
      ).toStrictEqual(admitted(FK_DEFAULT));
    }
    expect(
      parse(filters.documentParent, {
        recurse: { depth: false },
        self: false,
        some: {},
      })
    ).toStrictEqual(admitted({ depth: false, cycles: "reject" }, false));
    for (const depth of [1, 1000]) {
      expect(
        parse(filters.documentChildren, { recurse: { depth }, some: {} })
      ).toStrictEqual(admitted({ depth, cycles: "reject" }));
    }
    expect(
      parse(filters.teamChildren, {
        recurse: { preventCycles: false },
        some: {},
      })
    ).toStrictEqual(admitted({ depth: 100, cycles: "allow" }));
    expect(
      parse(filters.teamChildren, {
        recurse: { depth: false, preventCycles: true },
        some: {},
      })
    ).toStrictEqual(admitted({ depth: false, cycles: "prevent" }));
  });

  test("refuses an output budget, which a filter has nothing to bound", () => {
    for (const filter of [filters.documentChildren, filters.teamChildren]) {
      expect(
        parse(filter, { recurse: { maxOccurrences: 10 }, some: {} }).issues
      ).toBeDefined();
    }
  });

  test("admits the closure form inside nested relation filters and logic", () => {
    expect(
      parse(schemas.grant.args.findMany, {
        where: {
          team: {
            children: {
              recurse: true,
              self: true,
              some: {
                OR: [
                  { grants: { some: { userId: "u" } } },
                  { parents: { recurse: { depth: 1 }, none: {} } },
                ],
              },
            },
          },
        },
      })
    ).toStrictEqual({
      value: {
        where: {
          team: {
            is: {
              children: closure(GRAPH_DEFAULT, {
                self: true,
                some: {
                  OR: [
                    { grants: { some: { userId: { equals: "u" } } } },
                    {
                      parents: closure(
                        { depth: 1, cycles: "prevent" },
                        { none: {} }
                      ),
                    },
                  ],
                },
              }),
            },
          },
        },
      },
    });
  });

  test("leaves every ordinary filter unchanged", () => {
    expect(
      parse(filters.documentParent, { is: { personal: true } })
    ).toStrictEqual({ value: { is: { personal: { equals: true } } } });
    expect(parse(filters.documentParent, { personal: true })).toStrictEqual({
      value: { is: { personal: { equals: true } } },
    });
    expect(parse(filters.documentParent, null)).toStrictEqual({
      value: { is: null },
    });
    expect(
      parse(filters.documentChildren, { some: { personal: true } })
    ).toStrictEqual({ value: { some: { personal: { equals: true } } } });
    expect(parse(filters.documentGrants, { none: {} })).toStrictEqual({
      value: { none: {} },
    });
  });

  test("reads recurse and self spelled undefined as absent, on every form", () => {
    const unspelled = { recurse: undefined, self: undefined };
    // An eligible slot and one that cannot recurse.
    for (const filter of [filters.documentChildren, filters.documentGrants]) {
      for (const value of [{ recurse: undefined }, { self: undefined }]) {
        expect(parse(filter, { none: {}, ...value })).toStrictEqual({
          value: { none: {} },
        });
      }
    }
    const some = { some: { personal: true } };
    const ordinary = { value: { some: { personal: { equals: true } } } };
    const is = { value: { is: { personal: { equals: true } } } };
    expect(
      parse(filters.documentParent, { is: { personal: true }, ...unspelled })
    ).toStrictEqual(is);
    expect(
      parse(filters.documentParent, { personal: true, ...unspelled })
    ).toStrictEqual(is);
    // The toggle a caller writes: one spelling, either form.
    for (const deep of [true, false]) {
      expect(
        parse(filters.documentChildren, {
          recurse: deep ? true : undefined,
          self: deep ? true : undefined,
          ...some,
        })
      ).toStrictEqual(
        deep
          ? {
              value: closure(FK_DEFAULT, {
                self: true,
                some: ordinary.value.some,
              }),
            }
          : ordinary
      );
    }
    // A spelled `self` is kept for the ordinary language to refuse.
    expect(
      issueOf(
        parse(filters.documentChildren, { ...some, ...unspelled, self: true })
      )
    ).toEqual({ message: "Unknown key: self", path: ["self"] });
  });
});

describe("recursive filter — refusals", () => {
  test("refuses recurse on every slot that cannot recurse, with the select sentence", () => {
    const ineligible = [
      filters.documentGrants,
      schemas.grant.relations.document.filter,
      schemas.team.relations.grants.filter,
      schemas.keyless.relations.parent.filter,
      schemas.keyless.relations.children.filter,
      schemas.thread.relations.replies.filter,
    ];
    for (const filter of ineligible) {
      expect(issueOf(parse(filter, { recurse: true, some: {} }))).toEqual({
        message: UNAVAILABLE_RECURRENCE,
        path: ["recurse"],
      });
    }
    expect(UNAVAILABLE_RECURRENCE).toBe(
      "recurse is available only on an ordinary self relation (a foreign key or a junction, never variant storage) whose model has a complete primary key"
    );
  });

  test("reports the recurse sentence, not the first unknown key, on an ineligible slot", () => {
    expect(
      issueOf(
        parse(filters.documentGrants, { recurse: true, self: true, some: {} })
      ).message
    ).toBe(UNAVAILABLE_RECURRENCE);
    expect(
      issueOf(
        parse(filters.documentGrants, { self: true, recurse: true, some: {} })
      ).message
    ).toBe(UNAVAILABLE_RECURRENCE);
  });

  test("keeps a variant carrier's own refusal of recurse", () => {
    expect(
      issueOf(
        parse(schemas.thread.args.findMany, {
          where: { replyTo: { recurse: true } },
        })
      ).message
    ).toContain("Unknown key: recurse");
  });

  test("refuses an out-of-range depth and a foreign-key cycle policy", () => {
    for (const depth of [0, 1001, 1.5]) {
      const refusal = issueOf(
        parse(filters.documentParent, { recurse: { depth }, some: {} })
      ).message;
      // The very refusal the select side gives the same bag.
      expect(refusal).toBe(
        issueOf(
          parse(schemas.document.relations.parent.include, {
            recurse: { depth },
          })
        ).message
      );
      expect(refusal).toContain(
        Number.isInteger(depth)
          ? "recurse.depth must be a positive safe integer between 1 and 1000"
          : "Expected integer"
      );
    }
    for (const preventCycles of [true, false]) {
      expect(
        issueOf(
          parse(filters.documentChildren, {
            recurse: { preventCycles },
            some: {},
          })
        ).message
      ).toContain(
        "preventCycles applies only to a junction graph; a foreign-key recursion rejects every cycle it reaches"
      );
    }
    for (const [filter, include, recurse, sentence, path] of [
      [
        filters.teamChildren,
        schemas.team.relations.children.include,
        { depth: false, preventCycles: false },
        "Expected literal: true, or depth: Expected integer, or preventCycles: Expected literal: true",
        ["recurse"],
      ],
      [
        filters.documentParent,
        schemas.document.relations.parent.include,
        { depht: 2 },
        "Unknown key: depht",
        ["recurse", "depht"],
      ],
    ] as const) {
      const refusal = issueOf(parse(filter, { recurse, some: {} }));
      expect(refusal.message).toBe(
        issueOf(parse(include, { recurse })).message
      );
      expect(refusal).toEqual({ message: sentence, path });
    }
  });

  test("refuses is and isNot beside recurse", () => {
    for (const clause of ["is", "isNot"] as const) {
      expect(
        issueOf(
          parse(filters.documentParent, {
            recurse: true,
            some: {},
            [clause]: { personal: true },
          })
        ).message
      ).toBe(`${clause} cannot be combined with recurse`);
      expect(
        issueOf(
          parse(filters.documentParent, {
            [clause]: { personal: true },
            recurse: true,
          })
        ).message
      ).toBe(`${clause} cannot be combined with recurse`);
    }
  });

  test("refuses a closure that names no quantifier", () => {
    for (const [slot, filter] of [
      ["parent", filters.documentParent],
      ["children", filters.documentChildren],
      ["children", filters.teamChildren],
    ] as const) {
      for (const value of [
        { recurse: true },
        { recurse: true, self: true },
        { recurse: true, some: undefined },
      ]) {
        expect(issueOf(parse(filter, value)).message).toBe(
          `Relation filter '${slot}' requires one of: some, every, none.`
        );
      }
    }
  });

  test("refuses self and the to-many quantifiers without recurse", () => {
    expect(
      issueOf(parse(filters.documentChildren, { self: true, some: {} })).message
    ).toBe("Unknown key: self");
    // On a to-one slot both fall into the shorthand: the target `where`
    // reports the key it does not know.
    expect(
      issueOf(parse(filters.documentParent, { self: true, some: {} })).message
    ).toBe("Unknown key: self");
    expect(
      issueOf(parse(filters.documentParent, { some: { personal: true } }))
        .message
    ).toBe("Unknown key: some");
    // `recurse: false` is spelled, so it meets the closure form and fails there.
    expect(
      issueOf(parse(filters.documentChildren, { recurse: false, some: {} }))
        .path
    ).toEqual(["recurse"]);
  });
});

describe("recursive filter — the collision rule", () => {
  test("a spelled recurse always selects the closure form on a to-one slot", () => {
    // The target's `recurse` field is not reachable through the shorthand.
    expect(
      parse(schemas.oddNode.relations.parent.filter, { recurse: "x" }).issues
    ).toBeDefined();
    expect(
      issueOf(parse(schemas.oddHolder.relations.node.filter, { recurse: "x" }))
    ).toEqual({ message: UNAVAILABLE_RECURRENCE, path: ["recurse"] });
    // It is reached through `is`.
    expect(
      parse(schemas.oddHolder.relations.node.filter, { is: { recurse: "x" } })
    ).toStrictEqual({ value: { is: { recurse: { equals: "x" } } } });
    expect(
      parse(schemas.oddNode.relations.parent.filter, { is: { recurse: "x" } })
    ).toStrictEqual({ value: { is: { recurse: { equals: "x" } } } });
  });

  test("a target field named self still filters through the shorthand", () => {
    expect(
      parse(schemas.oddNode.relations.parent.filter, { self: true })
    ).toStrictEqual({ value: { is: { self: { equals: true } } } });
    // Spelled `undefined` it is absent, like `recurse`: `{}` names no quantifier.
    expect(
      parse(schemas.oddNode.relations.parent.filter, { self: undefined })
    ).toStrictEqual(parse(schemas.oddNode.relations.parent.filter, {}));
  });
});

describe("recursive filter — JSON Schema", () => {
  const alternatives = (schema: Parameters<typeof toJsonSchema>[0]) =>
    (toJsonSchema(schema) as { anyOf?: { properties?: object }[] }).anyOf ?? [];
  const closureMembers = (schema: Parameters<typeof toJsonSchema>[0]) =>
    alternatives(schema).filter(
      (member) =>
        member.properties !== undefined &&
        "recurse" in member.properties &&
        "self" in member.properties
    );

  test("lists the closure member beside the ordinary alternatives", () => {
    // null, explicit, shorthand, closure.
    expect(alternatives(filters.documentParent)).toHaveLength(4);
    expect(closureMembers(filters.documentParent)).toHaveLength(1);
    // ordinary object, closure.
    expect(alternatives(filters.teamChildren)).toHaveLength(2);
    expect(closureMembers(filters.teamChildren)).toHaveLength(1);
    // An ineligible slot lists its ordinary object alone.
    expect(alternatives(filters.documentGrants)).toHaveLength(1);
    expect(closureMembers(filters.documentGrants)).toHaveLength(0);
  });
});

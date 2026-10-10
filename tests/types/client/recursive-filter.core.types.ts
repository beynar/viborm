import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";

/**
 * Recursive relation filters (`recurse` in `where`): the two Pyxel spellings
 * compile with a contextually typed quantifier, and every form the runtime
 * refuses is a type error too. Assertions live in `@ts-expect-error`: one that
 * stops being an error fails this file (TS2578).
 */

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
  members: s.toMany(() => teamMember),
  grants: s.toMany(() => accessGrant).name("grantOnTeam"),
  holds: s.toMany(() => accessGrant).name("grantToTeam"),
});

const teamMember = s.model({
  id: s.string().id(),
  userId: s.string(),
  teamId: s.string(),
  team: s
    .toOne(() => team)
    .fields("teamId")
    .references("id"),
});

const document = s.model({
  id: s.string().id(),
  personal: s.boolean().default(false),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => document)
    .name("documentTree")
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => document).name("documentTree"),
  grants: s.toMany(() => accessGrant).name("grantOnDocument"),
});

const page = s.model({
  id: s.string().id(),
  title: s.string(),
  grants: s.toMany(() => accessGrant).name("grantOnPage"),
});

const accessGrant = s.model({
  id: s.string().id(),
  level: s.enum(["read", "edit", "full"]),
  userId: s.string().nullable(),
  teamId: s.string().nullable(),
  team: s
    .toOne(() => team)
    .name("grantOnTeam")
    .fields("teamId")
    .references("id"),
  granteeTeamId: s.string().nullable(),
  granteeTeam: s
    .toOne(() => team)
    .name("grantToTeam")
    .fields("granteeTeamId")
    .references("id"),
  documentId: s.string().nullable(),
  document: s
    .toOne(() => document)
    .name("grantOnDocument")
    .fields("documentId")
    .references("id"),
  pageId: s.string().nullable(),
  page: s
    .toOne(() => page)
    .name("grantOnPage")
    .fields("pageId")
    .references("id"),
});

// A target field literally named `recurse` or `self` beside a self relation.
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
});

const client = createClient({
  schema: { team, teamMember, document, page, accessGrant, oddNode },
  driver: new PGliteDriver(),
});

const userId = "user";

// =============================================================================
// THE TWO PYXEL SPELLINGS
// =============================================================================

const grantedDocument = {
  parent: {
    recurse: true,
    self: true,
    some: { grants: { some: { userId } } },
  },
} as const;
const personalRoot = {
  parent: {
    recurse: true,
    self: true,
    some: { parentId: null, personal: true },
  },
} as const;

client.document.findFirst({ where: { id: "d", ...grantedDocument } });
client.document.findMany({ where: personalRoot });
client.document.count({ where: grantedDocument });
client.document.updateMany({
  where: grantedDocument,
  data: { personal: true },
});
client.document.deleteMany({ where: personalRoot });

const levels: ("edit" | "full")[] = ["edit", "full"];
client.page.findFirst({
  where: {
    id: "p",
    grants: {
      some: {
        level: { in: levels },
        granteeTeam: {
          children: {
            recurse: true,
            self: true,
            some: {
              OR: [
                { members: { some: { userId } } },
                { grants: { some: { userId, level: "full" } } },
              ],
            },
          },
        },
      },
    },
  },
});
client.page.updateMany({
  where: {
    grants: {
      some: {
        granteeTeam: {
          children: {
            recurse: true,
            self: true,
            some: { members: { some: { userId } } },
          },
        },
      },
    },
  },
  data: { title: "t" },
});

// Every option form of each topology, every quantifier, on both cardinalities.
client.document.findMany({
  where: {
    children: { recurse: { depth: 3 }, every: { personal: false } },
    parent: { recurse: { depth: false }, none: { personal: true } },
  },
});
client.team.findMany({
  where: {
    parents: { recurse: { depth: 2, preventCycles: false }, some: {} },
    children: { recurse: { depth: false, preventCycles: true }, none: {} },
  },
});
// The ordinary forms are unchanged beside the recursive one.
client.document.findMany({
  where: {
    parent: { is: { personal: true } },
    children: { some: { personal: true } },
    grants: { none: { level: "read" } },
  },
});
// `recurse` and `self` spelled `undefined` are absent, so a toggle is one call
// (the runtime pins the same spellings).
const findTree = (deep: boolean) =>
  client.document.findMany({
    where: {
      children: { recurse: deep ? true : undefined, some: { personal: true } },
      parent: { is: { personal: true }, recurse: undefined, self: undefined },
      grants: { some: {}, recurse: undefined, self: undefined },
    },
  });
findTree(false);

// =============================================================================
// CONTEXTUAL TYPING — the quantifier is the target model's full `where`
// =============================================================================

client.document.findMany({
  where: {
    parent: {
      recurse: true,
      // @ts-expect-error - "personl" is not a field of document
      some: { personl: true },
    },
  },
});

client.page.findMany({
  where: {
    grants: {
      some: {
        granteeTeam: {
          children: {
            recurse: true,
            // @ts-expect-error - "nme" is not a field of team
            some: { nme: "x" },
          },
        },
      },
    },
  },
});

// =============================================================================
// REFUSALS — each runtime refusal is a type error
// =============================================================================

client.document.findMany({
  where: {
    // @ts-expect-error - grants is not a self relation
    grants: { recurse: true, some: {} },
  },
});

client.team.findMany({
  where: {
    // @ts-expect-error - members is not a self relation
    members: { recurse: true, self: true, some: {} },
  },
});

client.document.findMany({
  where: {
    parent: {
      // @ts-expect-error - a foreign-key recursion has no cycle flag
      recurse: { depth: 2, preventCycles: true },
      some: {},
    },
  },
});

client.team.findMany({
  where: {
    children: {
      // @ts-expect-error - an exhaustive junction walk always prevents cycles
      recurse: { depth: false, preventCycles: false },
      some: {},
    },
  },
});

client.document.findMany({
  where: {
    // @ts-expect-error - a to-one slot takes some/every/none only with recurse
    parent: { some: { personal: true } },
  },
});

client.document.findMany({
  where: {
    // @ts-expect-error - self without recurse (to-many)
    children: { self: true, some: {} },
  },
});

client.document.findMany({
  where: {
    // @ts-expect-error - self without recurse (to-one)
    parent: { self: true, is: { personal: true } },
  },
});

client.document.findMany({
  where: {
    // @ts-expect-error - is cannot be combined with recurse
    parent: { recurse: true, some: {}, is: { personal: true } },
  },
});

client.document.findMany({
  where: {
    // @ts-expect-error - the explicit filter cannot carry recurse
    parent: { is: { personal: true }, recurse: true },
  },
});

client.document.findMany({
  // @ts-expect-error - a recurse bag typo is sealed beside a real key
  where: {
    parent: { recurse: { depth: 2, depht: 3 }, some: {} },
  },
});

const misspelledRecurrence = {
  children: { recurse: { depth: 2, depht: 3 }, some: {} },
} as const;
// @ts-expect-error - the typo is sealed after argument forwarding too
client.document.findMany({ where: misspelledRecurrence });

const nestedMisspelledRecurrence = {
  grants: {
    some: {
      granteeTeam: {
        children: { recurse: { depth: 2, depht: 3 }, some: {} },
      },
    },
  },
} as const;
// @ts-expect-error - the typo is sealed inside a nested relation filter
client.page.findMany({ where: nestedMisspelledRecurrence });

// =============================================================================
// THE COLLISION RULE
// =============================================================================

// A field named `self` still filters through the shorthand.
client.oddNode.findMany({ where: { parent: { self: true } } });
// A field named `recurse` is reached through `is`.
client.oddNode.findMany({ where: { parent: { is: { recurse: "x" } } } });

client.oddNode.findMany({
  where: {
    // @ts-expect-error - a spelled recurse always selects the recursive filter
    parent: { recurse: "x" },
  },
});

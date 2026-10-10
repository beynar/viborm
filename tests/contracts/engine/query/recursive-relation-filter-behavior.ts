// biome-ignore-all lint/suspicious/noMisplacedAssertion: expectChangeWalkingItsModel is invoked only from registered tests.
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

/**
 * Recursive relation filters (`recurse` in `where`) through public entry
 * points, on a real database: a filter on an ordinary self relation, foreign
 * key or junction, quantifies over the relation's transitive closure.
 *
 * Every expected answer comes from {@link closureOf}, a pure breadth-first
 * oracle over the seeded graph that imports no engine owner, or is written
 * by hand from the owner's specification (the Pyxel acceptance cases). The
 * schema's `team` and `document` models are the specification's own.
 *
 * World. Documents (foreign key `parentId`): the chain R (personal) <- A <-
 * G <- D3, the written cycle C1 <-> C2 (the specification's A <-> B), the lone
 * L, and a seeded random functional graph r00..r59 whose cycles the seed
 * decides. Teams (junction `teamParent`): Ventes (V) > Ventes Nord (VN) >
 * Nord Est (NE), the diamond DT > DL, DR > DB, the cycle cyc1 <-> cyc2, the
 * lone X, and a seeded random graph t00..t59 of up to two parents each.
 * People: Dan is a member of Ventes Nord; Lea holds `full` on Ventes and is
 * no member; Mia is a member of Ventes only; Eve of DB; Zed of cyc2. Uma
 * holds a `read` grant on document R, Vic an `edit` grant on C1. The random
 * part's people are Ivy and Jon, so no random row changes a fixed answer.
 *
 * Every change reads the statement's snapshot: an `updateMany`/`deleteMany`
 * whose closure walks the model it changes, or a model its delete cascades
 * into, matches the rows it matched before any write, on every provider.
 */

export function recursiveFilterSchema() {
  const team = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    name: s.string(),
    parents: s
      .toMany(() => team)
      .name("teamGraph")
      .through("teamParent")
      .source("childId")
      .target("parentId")
      .onDelete({ source: "cascade", target: "restrict" }),
    children: s.toMany(() => team).name("teamGraph"),
    members: s.toMany(() => teamMember),
    grants: s.toMany(() => accessGrant).name("grantOnTeam"),
    holds: s.toMany(() => accessGrant).name("grantToTeam"),
  });
  const teamMember = s
    .model({
      teamId: s.string(),
      userId: s.string(),
      team: s
        .toOne(() => team)
        .fields("teamId")
        .references("id"),
    })
    .id(["teamId", "userId"]);
  const document = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    ownerId: s.string(),
    personal: s.boolean().default(false),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => document)
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => document),
    grants: s.toMany(() => accessGrant),
    // Not in the specification's model: the inverse every relation needs
    // (R002) of the page that lives in a document.
    pages: s.toMany(() => page),
  });
  const page = s.model({
    id: s.string().id(),
    title: s.string(),
    documentId: s.string().nullable(),
    document: s
      .toOne(() => document)
      .fields("documentId")
      .references("id"),
    grants: s.toMany(() => accessGrant),
  });
  /** A grant ON a team (`full` = its lead), TO a team, on a document or a page. */
  const accessGrant = s.model({
    id: s.string().id(),
    level: s.string(),
    userId: s.string().nullable(),
    teamId: s.string().nullable(),
    team: s
      .toOne(() => team)
      .fields("teamId")
      .references("id")
      .name("grantOnTeam"),
    granteeTeamId: s.string().nullable(),
    granteeTeam: s
      .toOne(() => team)
      .fields("granteeTeamId")
      .references("id")
      .name("grantToTeam"),
    documentId: s.string().nullable(),
    document: s
      .toOne(() => document)
      .fields("documentId")
      .references("id"),
    pageId: s.string().nullable(),
    page: s
      .toOne(() => page)
      .fields("pageId")
      .references("id"),
  });
  return { team, teamMember, document, page, accessGrant };
}

/**
 * Holders and their folders: deleting a holder deletes its folders, and
 * deleting a folder leaves its children without a parent (setNull), so a
 * delete of holders changes the folders its own filter walks.
 */
function cascadeSchema() {
  const holder = s.model({
    id: s.string().id(),
    folders: s.toMany(() => folder),
  });
  const folder = s.model({
    id: s.string().id(),
    label: s.string(),
    holderId: s.string(),
    holder: s
      .toOne(() => holder)
      .fields("holderId")
      .references("id")
      .onDelete("cascade"),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => folder)
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => folder),
  });
  return { holder, folder };
}

interface DocumentRow {
  readonly id: string;
  readonly organizationId: string;
  readonly ownerId: string;
  readonly personal: boolean;
  readonly parentId: string | null;
}
interface TeamRow {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
}
interface TeamLink {
  readonly childId: string;
  readonly parentId: string;
}
interface MemberRow {
  readonly teamId: string;
  readonly userId: string;
}
interface PageRow {
  readonly id: string;
  readonly title: string;
  readonly documentId: string | null;
}
interface GrantRow {
  readonly id: string;
  readonly level: string;
  readonly userId: string | null;
  readonly teamId: string | null;
  readonly granteeTeamId: string | null;
  readonly documentId: string | null;
  readonly pageId: string | null;
}

export interface RecursiveFilterWorld {
  readonly documents: readonly DocumentRow[];
  readonly teams: readonly TeamRow[];
  readonly teamLinks: readonly TeamLink[];
  readonly members: readonly MemberRow[];
  readonly pages: readonly PageRow[];
  readonly grants: readonly GrantRow[];
}

/**
 * A deterministic generator (Park-Miller, exact in doubles): the random graph
 * is a fixture, the same rows on every provider and every run.
 */
function seeded(seed: number): () => number {
  const modulus = 2_147_483_647;
  let state = seed % modulus;
  return () => {
    state = (state * 48_271) % modulus;
    return state / modulus;
  };
}

const RANDOM_NODES = 60;
const RANDOM_SEED = 20_261_014;
const OWNERS = ["ana", "ben", "cid"] as const;
const RANDOM_PEOPLE = ["ivy", "jon"] as const;

const grant = (
  id: string,
  level: string,
  fields: Partial<Omit<GrantRow, "id" | "level">>
): GrantRow => ({
  id,
  level,
  userId: null,
  teamId: null,
  granteeTeamId: null,
  documentId: null,
  pageId: null,
  ...fields,
});

export function recursiveFilterWorld(seed = RANDOM_SEED): RecursiveFilterWorld {
  const random = seeded(seed);
  const pick = <T>(values: readonly [T, ...T[]]): T =>
    values[Math.floor(random() * values.length)] ?? values[0];
  const name = (prefix: string, index: number) =>
    `${prefix}${String(index).padStart(2, "0")}`;
  // Any other random node: never the node itself.
  const other = (prefix: string, self: number) =>
    name(
      prefix,
      (self + 1 + Math.floor(random() * (RANDOM_NODES - 1))) % RANDOM_NODES
    );

  const documents: DocumentRow[] = (
    [
      ["R", null, "ana", true],
      ["A", "R", "ben", false],
      ["G", "A", "ana", false],
      ["D3", "G", "cid", false],
      ["C1", "C2", "ben", false],
      ["C2", "C1", "cid", false],
      ["L", null, "ana", false],
    ] as const
  ).map(([id, parentId, ownerId, personal]) => ({
    id,
    organizationId: "o1",
    ownerId,
    personal,
    parentId,
  }));
  const grants: GrantRow[] = [
    grant("g-uma-R", "read", { userId: "uma", documentId: "R" }),
    grant("g-vic-C1", "edit", { userId: "vic", documentId: "C1" }),
    grant("g-lea-V", "full", { userId: "lea", teamId: "V" }),
  ];
  for (let index = 0; index < RANDOM_NODES; index++) {
    const id = name("r", index);
    documents.push({
      id,
      organizationId: pick(["o1", "o2"]),
      ownerId: pick(OWNERS),
      personal: random() < 0.3,
      parentId: random() < 0.15 ? null : other("r", index),
    });
    if (random() < 0.35)
      grants.push(
        grant(`g-${id}`, pick(["read", "edit"]), {
          userId: pick(RANDOM_PEOPLE),
          documentId: id,
        })
      );
  }

  const teams: TeamRow[] = (
    [
      ["V", "Ventes"],
      ["VN", "Ventes Nord"],
      ["NE", "Nord Est"],
      ["DT", "Diamond top"],
      ["DL", "Diamond left"],
      ["DR", "Diamond right"],
      ["DB", "Diamond bottom"],
      ["cyc1", "Cycle one"],
      ["cyc2", "Cycle two"],
      ["X", "Lone"],
    ] as const
  ).map(([id, title]) => ({ id, organizationId: "o1", name: title }));
  const teamLinks: TeamLink[] = (
    [
      ["VN", "V"],
      ["NE", "VN"],
      ["DL", "DT"],
      ["DR", "DT"],
      ["DB", "DL"],
      ["DB", "DR"],
      ["cyc1", "cyc2"],
      ["cyc2", "cyc1"],
    ] as const
  ).map(([childId, parentId]) => ({ childId, parentId }));
  const members: MemberRow[] = [
    { teamId: "VN", userId: "dan" },
    { teamId: "V", userId: "mia" },
    { teamId: "DB", userId: "eve" },
    { teamId: "cyc2", userId: "zed" },
  ];
  for (let index = 0; index < RANDOM_NODES; index++) {
    const id = name("t", index);
    teams.push({
      id,
      organizationId: pick(["o1", "o2"]),
      name: `Team ${index}`,
    });
    const parents = new Set<string>();
    const count = Math.floor(random() * 3);
    while (parents.size < count) parents.add(other("t", index));
    for (const parentId of parents) teamLinks.push({ childId: id, parentId });
    if (random() < 0.25)
      members.push({ teamId: id, userId: pick(RANDOM_PEOPLE) });
    if (random() < 0.3)
      grants.push(
        grant(`g-${id}`, pick(["full", "edit"]), {
          userId: pick(RANDOM_PEOPLE),
          teamId: id,
        })
      );
  }

  const pages: PageRow[] = [
    { id: "pv", title: "Ventes plan", documentId: "L" },
    { id: "pvn", title: "Ventes Nord plan", documentId: "L" },
    { id: "pdt", title: "Diamond notes", documentId: "L" },
    { id: "pcy", title: "Cycle notes", documentId: "L" },
    { id: "pg", title: "Grandchild page", documentId: "G" },
    { id: "pc", title: "Cycle page", documentId: "C2" },
  ];
  grants.push(
    grant("g-pv", "edit", { pageId: "pv", granteeTeamId: "V" }),
    grant("g-pvn", "edit", { pageId: "pvn", granteeTeamId: "VN" }),
    grant("g-pdt", "read", { pageId: "pdt", granteeTeamId: "DT" }),
    grant("g-pcy", "edit", { pageId: "pcy", granteeTeamId: "cyc1" })
  );
  return { documents, teams, teamLinks, members, pages, grants };
}

/** The seeded database and its client. */
export async function openRecursiveFilterFixture(driver: AnyDriver) {
  const world = recursiveFilterWorld();
  const client = createClient({ schema: recursiveFilterSchema(), driver });
  await syncLiveSchema(client);
  // Parents are written once every row exists: the random graph points
  // forward and the cycles point both ways.
  await client.document.createMany({
    data: world.documents.map((row) => ({ ...row, parentId: null })),
  });
  for (const row of world.documents)
    if (row.parentId !== null)
      await client.document.update({
        where: { id: row.id },
        data: { parentId: row.parentId },
      });
  await client.team.createMany({ data: [...world.teams] });
  for (const team of world.teams) {
    const parents = world.teamLinks
      .filter((link) => link.childId === team.id)
      .map((link) => ({ id: link.parentId }));
    if (parents.length > 0)
      await client.team.update({
        where: { id: team.id },
        data: { parents: { connect: parents } },
      });
  }
  await client.teamMember.createMany({ data: [...world.members] });
  await client.page.createMany({ data: [...world.pages] });
  await client.accessGrant.createMany({ data: [...world.grants] });
  // A real database plans on statistics. Fresh tables have none: PostgreSQL
  // then overestimates the walk and JIT-compiles every statement for seconds.
  if (client.$driver.dialect === "postgresql")
    await client.$executeRawUnsafe("ANALYZE");
  return { client, world };
}

export type RecursiveFilterFixture = Awaited<
  ReturnType<typeof openRecursiveFilterFixture>
>;
type Client = RecursiveFilterFixture["client"];

// ---------------------------------------------------------------- the oracle

/** A hop of a relation: from a row to one row the relation reaches. */
export type Hop = readonly [from: string, to: string];

/**
 * The closure of `start` over `hops`: every row reached by 1..depth hops,
 * plus `start` itself (hop 0) when `self` holds. Breadth first over a set, so
 * a cycle terminates and a diamond's meeting row is reached once; a cycle
 * back to `start` makes it a member even without `self`.
 */
export function closureOf(
  hops: readonly Hop[],
  start: string,
  { depth, self }: { readonly depth: number | false; readonly self: boolean }
): ReadonlySet<string> {
  const next = new Map<string, string[]>();
  for (const [from, to] of hops)
    next.set(from, [...(next.get(from) ?? []), to]);
  const reached = new Set<string>(self ? [start] : []);
  let frontier = [start];
  for (let hop = 1; frontier.length > 0; hop++) {
    if (depth !== false && hop > depth) break;
    const found: string[] = [];
    for (const row of frontier)
      for (const to of next.get(row) ?? [])
        if (!reached.has(to)) {
          reached.add(to);
          found.push(to);
        }
    frontier = found;
  }
  return reached;
}

type Quantifier = "some" | "every" | "none";

/** `some`, `every` and `none` over a closure, `every` true when it is empty. */
function quantify(
  quantifier: Quantifier,
  members: ReadonlySet<string>,
  holds: (id: string) => boolean
): boolean {
  const matching = [...members].filter(holds).length;
  if (quantifier === "some") return matching > 0;
  if (quantifier === "none") return matching === 0;
  return matching === members.size;
}

type Slot =
  | { readonly model: "document"; readonly relation: "parent" | "children" }
  | { readonly model: "team"; readonly relation: "parents" | "children" };

const SLOTS: readonly Slot[] = [
  { model: "document", relation: "parent" },
  { model: "document", relation: "children" },
  { model: "team", relation: "parents" },
  { model: "team", relation: "children" },
];

/** One hop of each slot, read from the world rather than the database. */
export function hopsOf(world: RecursiveFilterWorld, slot: Slot): Hop[] {
  if (slot.model === "document") {
    const up = world.documents.flatMap((row): Hop[] =>
      row.parentId === null ? [] : [[row.id, row.parentId]]
    );
    return slot.relation === "parent"
      ? up
      : up.map(([child, parent]) => [parent, child]);
  }
  return world.teamLinks.map(({ childId, parentId }) =>
    slot.relation === "parents" ? [childId, parentId] : [parentId, childId]
  );
}

interface Predicate {
  readonly label: string;
  readonly where: object;
  readonly holds: (id: string) => boolean;
}

function predicatesOf(
  world: RecursiveFilterWorld,
  model: Slot["model"]
): Predicate[] {
  const everything: Predicate = { label: "{}", where: {}, holds: () => true };
  if (model === "document") {
    const row = (id: string) => world.documents.find((doc) => doc.id === id);
    return [
      everything,
      {
        label: "personal",
        where: { personal: true },
        holds: (id) => row(id)?.personal === true,
      },
      {
        label: "owned by cid",
        where: { ownerId: "cid" },
        holds: (id) => row(id)?.ownerId === "cid",
      },
      {
        label: "granted to ivy",
        where: { grants: { some: { userId: "ivy" } } },
        holds: (id) =>
          world.grants.some(
            (entry) => entry.documentId === id && entry.userId === "ivy"
          ),
      },
    ];
  }
  const row = (id: string) => world.teams.find((team) => team.id === id);
  return [
    everything,
    {
      label: "in o2",
      where: { organizationId: "o2" },
      holds: (id) => row(id)?.organizationId === "o2",
    },
    {
      label: "Jon a member",
      where: { members: { some: { userId: "jon" } } },
      holds: (id) =>
        world.members.some(
          (member) => member.teamId === id && member.userId === "jon"
        ),
    },
    {
      label: "led by someone",
      where: { grants: { some: { level: "full" } } },
      holds: (id) =>
        world.grants.some(
          (entry) => entry.teamId === id && entry.level === "full"
        ),
    },
  ];
}

const DEPTHS = [
  { recurse: { depth: 1 }, depth: 1 },
  { recurse: { depth: 2 }, depth: 2 },
  { recurse: true, depth: 100 },
  { recurse: { depth: false }, depth: false },
] as const;

const idsOf = (model: Slot["model"], world: RecursiveFilterWorld) =>
  model === "document"
    ? world.documents.map((row) => row.id)
    : world.teams.map((row) => row.id);

/** The rows the oracle admits, sorted: the provider's collation never orders. */
function expectedIds(
  world: RecursiveFilterWorld,
  slot: Slot,
  quantifier: Quantifier,
  depth: number | false,
  self: boolean,
  holds: (id: string) => boolean
): string[] {
  const hops = hopsOf(world, slot);
  return idsOf(slot.model, world)
    .filter((id) =>
      quantify(quantifier, closureOf(hops, id, { depth, self }), holds)
    )
    .sort();
}

const sorted = (rows: readonly { readonly id: string }[]) =>
  rows.map((row) => row.id).sort();

/** A where built from data: the matrix's typing is the shape's, not a literal's. */
async function readIds(
  client: Client,
  model: Slot["model"],
  where: object
): Promise<string[]> {
  return model === "document"
    ? sorted(await client.document.findMany({ where, select: { id: true } }))
    : sorted(await client.team.findMany({ where, select: { id: true } }));
}

const byId = (a: { readonly id: string }, b: { readonly id: string }) =>
  a.id.localeCompare(b.id);

/**
 * A change whose closure walks the model it changes answers `applied.result`
 * and leaves `applied.state`: the statement's snapshot on every provider, as
 * MySQL reads the matching keys before any write.
 */
export async function expectChangeWalkingItsModel(
  state: () => Promise<unknown>,
  change: () => PromiseLike<unknown>,
  applied: { readonly result: unknown; readonly state: unknown }
): Promise<void> {
  expect(await change()).toEqual(applied.result);
  expect(await state()).toEqual(applied.state);
}

/** Every document in the world's fields, by key. */
const documentRows = async (client: Client): Promise<DocumentRow[]> =>
  (
    await client.document.findMany({
      select: {
        id: true,
        organizationId: true,
        ownerId: true,
        personal: true,
        parentId: true,
      },
    })
  ).sort(byId);

/**
 * The rows a deleteMany leaves: the children of a deleted row lose their
 * parent (setNull).
 */
const deleting = (
  rows: readonly DocumentRow[],
  gone: ReadonlySet<string>
): DocumentRow[] =>
  rows
    .filter((row) => !gone.has(row.id))
    .map((row) =>
      row.parentId !== null && gone.has(row.parentId)
        ? { ...row, parentId: null }
        : row
    );

// ------------------------------------------------- the Pyxel access fragments

const EDIT = ["edit", "full"] as const;
const READ = ["read", "edit", "full"] as const;

/** Case 1: a grant to a team reaches its members and lead, and every team below it. */
const teamAccess = (userId: string, levels: readonly string[]) => ({
  grants: {
    some: {
      level: { in: [...levels] },
      granteeTeam: {
        children: {
          recurse: true as const,
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
});

/** Case 2: a grant on the document itself or on any ancestor. */
const documentAccess = (userId: string, levels: readonly string[]) => ({
  parent: {
    recurse: true as const,
    self: true,
    some: { grants: { some: { userId, level: { in: [...levels] } } } },
  },
});

/** A document is personal when its root is. */
const personal = {
  parent: {
    recurse: true,
    self: true,
    some: { parentId: null, personal: true },
  },
} as const;

/** The `where` fragment a caller spreads into any page query (the spec's `may.page`). */
const mayPage = (userId: string, levels: readonly string[]) => ({
  OR: [
    teamAccess(userId, levels),
    { document: documentAccess(userId, levels) },
  ],
});

const FIXED_DOCUMENTS = ["R", "A", "G", "D3", "C1", "C2", "L"];
/** The fixed documents under the personal root R, which Uma's grant is on. */
const ROOTED = ["A", "D3", "G", "R"];

export interface RecursiveFilterProvider {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  /** Empties a database that outlives its driver (a server's). */
  readonly reset?: () => Promise<void>;
}

export function runRecursiveRelationFilterBehavior(
  provider: RecursiveFilterProvider
): void {
  const open = async () => {
    await provider.reset?.();
    return openRecursiveFilterFixture(provider.createDriver());
  };

  // Reads share one seeded database; each change below seeds its own.
  describe(`${provider.name}: recursive relation filters`, () => {
    let context: RecursiveFilterFixture;

    beforeAll(async () => {
      context = await open();
    });
    afterAll(async () => {
      await context.client.$disconnect();
    });

    test("the database holds the oracle's graph", async () => {
      const { client, world } = context;
      expect(await documentRows(client)).toEqual(
        [...world.documents].sort(byId)
      );
      const teams = await client.team.findMany({
        select: { id: true, parents: { select: { id: true } } },
      });
      expect(
        teams
          .flatMap((team) =>
            team.parents.map((parent) => `${team.id}>${parent.id}`)
          )
          .sort()
      ).toEqual(
        world.teamLinks.map((link) => `${link.childId}>${link.parentId}`).sort()
      );
    });

    for (const slot of SLOTS)
      for (const quantifier of ["some", "every", "none"] as const)
        test(`${slot.model}.${slot.relation}: ${quantifier} over the closure, at depth 1, 2, true and false, with and without self, per row`, async () => {
          const { client, world } = context;
          const actual: [string, string[]][] = [];
          const expected: [string, string[]][] = [];
          for (const { recurse, depth } of DEPTHS)
            for (const self of [false, true])
              for (const predicate of predicatesOf(world, slot.model)) {
                const label = `${JSON.stringify(recurse)} self=${self} ${quantifier} ${predicate.label}`;
                const where = {
                  [slot.relation]: {
                    recurse,
                    self,
                    [quantifier]: predicate.where,
                  },
                };
                actual.push([label, await readIds(client, slot.model, where)]);
                expected.push([
                  label,
                  expectedIds(
                    world,
                    slot,
                    quantifier,
                    depth,
                    self,
                    predicate.holds
                  ),
                ]);
              }
          expect(actual).toEqual(expected);
        });

    test("an empty closure: some is false, every and none are true; self makes it non-empty", async () => {
      const { client } = context;
      const lone = async (where: object) =>
        (await readIds(client, "document", where)).includes("L");
      expect({
        some: await lone({ children: { recurse: true, some: {} } }),
        every: await lone({
          children: { recurse: true, every: { ownerId: "nobody" } },
        }),
        none: await lone({ children: { recurse: true, none: {} } }),
        selfSome: await lone({
          children: { recurse: true, self: true, some: {} },
        }),
        selfEvery: await lone({
          children: { recurse: true, self: true, every: { ownerId: "nobody" } },
        }),
      }).toEqual({
        some: false,
        every: true,
        none: true,
        selfSome: true,
        selfEvery: false,
      });
      // The same on a junction's lone team.
      const loneTeam = await client.team.findMany({
        where: {
          id: "X",
          parents: { recurse: { depth: false }, every: { id: "nobody" } },
          children: { recurse: { depth: false }, none: {} },
        },
        select: { id: true },
      });
      expect(sorted(loneTeam)).toEqual(["X"]);
    });

    test("a junction's preventCycles admits the same closure", async () => {
      const { client, world } = context;
      const slot = { model: "team", relation: "children" } as const;
      for (const preventCycles of [true, false]) {
        const rows = await client.team.findMany({
          where: {
            children: {
              recurse: { depth: 3, preventCycles },
              some: { organizationId: "o2" },
            },
          },
          select: { id: true },
        });
        expect(sorted(rows)).toEqual(
          expectedIds(world, slot, "some", 3, false, (id) =>
            world.teams.some(
              (team) => team.id === id && team.organizationId === "o2"
            )
          )
        );
      }
    });

    test("every read verb takes the closure: findFirst, count, exist, aggregate and groupBy", async () => {
      const { client, world } = context;
      const where = {
        parent: { recurse: { depth: 2 }, self: true, some: { ownerId: "cid" } },
      } as const;
      const matching = expectedIds(
        world,
        { model: "document", relation: "parent" },
        "some",
        2,
        true,
        (id) =>
          world.documents.some((row) => row.id === id && row.ownerId === "cid")
      );
      for (const id of FIXED_DOCUMENTS) {
        const first = await client.document.findFirst({
          where: { AND: [{ id }, where] },
          select: { id: true },
        });
        expect([id, first?.id ?? null]).toEqual([
          id,
          matching.includes(id) ? id : null,
        ]);
      }
      expect(await client.document.count({ where })).toBe(matching.length);
      expect(await client.document.exist({ where })).toBe(matching.length > 0);
      expect(
        (await client.document.aggregate({ where, _count: { _all: true } }))
          ._count._all
      ).toBe(matching.length);
      const grouped = await client.document.groupBy({
        by: ["organizationId"],
        where,
        _count: { _all: true },
      });
      const byOrganization = (organizationId: string) =>
        matching.filter((id) =>
          world.documents.some(
            (row) => row.id === id && row.organizationId === organizationId
          )
        ).length;
      expect(
        grouped
          .map((row) => [row.organizationId, row._count._all] as const)
          .sort(([a], [b]) => a.localeCompare(b))
      ).toEqual(
        ["o1", "o2"]
          .map(
            (organizationId) =>
              [organizationId, byOrganization(organizationId)] as const
          )
          .filter(([, count]) => count > 0)
      );
    });

    test("a relation projection's where and a _count filter take the closure", async () => {
      const { client, world } = context;
      const where = {
        children: {
          recurse: true,
          self: true,
          some: { members: { some: { userId: "jon" } } },
        },
      } as const;
      const admitted = new Set(
        expectedIds(
          world,
          { model: "team", relation: "children" },
          "some",
          100,
          true,
          (id) =>
            world.members.some(
              (member) => member.teamId === id && member.userId === "jon"
            )
        )
      );
      const teams = await client.team.findMany({
        select: {
          id: true,
          children: { where, select: { id: true } },
          _count: { select: { children: { where } } },
        },
      });
      const actual = teams
        .map(
          (team) =>
            [team.id, sorted(team.children), team._count.children] as const
        )
        .sort(([a], [b]) => a.localeCompare(b));
      const expected = world.teams
        .map((team) => {
          const children = world.teamLinks
            .filter((link) => link.parentId === team.id)
            .map((link) => link.childId)
            .filter((id) => admitted.has(id))
            .sort();
          return [team.id, children, children.length] as const;
        })
        .sort(([a], [b]) => a.localeCompare(b));
      expect(actual).toEqual(expected);
    });

    test("a recursive select's per-hop where takes a closure", async () => {
      const { client, world } = context;
      // Keep a node when a personal row is within two hops above it.
      const keep = new Set(
        expectedIds(
          world,
          { model: "document", relation: "parent" },
          "some",
          2,
          false,
          (id) => world.documents.some((row) => row.id === id && row.personal)
        )
      );
      interface Node {
        readonly id: string;
        readonly children: readonly Node[];
      }
      const below = (id: string): Node[] =>
        world.documents
          .filter((row) => row.parentId === id && keep.has(row.id))
          .map((row) => ({ id: row.id, children: below(row.id) }));
      expect(
        await client.document.findUnique({
          where: { id: "R" },
          select: {
            id: true,
            children: {
              recurse: { depth: false },
              where: {
                parent: { recurse: { depth: 2 }, some: { personal: true } },
              },
              select: { id: true },
            },
          },
        })
      ).toEqual({ id: "R", children: below("R") });
      // Over the junction: the diamond's branches that reach Eve's team.
      expect(
        await client.team.findUnique({
          where: { id: "DT" },
          select: {
            id: true,
            children: {
              recurse: { depth: 2 },
              orderBy: { id: "asc" },
              where: {
                children: {
                  recurse: true,
                  self: true,
                  some: { members: { some: { userId: "eve" } } },
                },
              },
              select: { id: true },
            },
          },
        })
      ).toEqual({
        id: "DT",
        children: [
          { id: "DL", children: [{ id: "DB" }] },
          { id: "DR", children: [{ id: "DB" }] },
        ],
      });
    });

    test("AND, OR and NOT compose with a closure; closures nest in relation filters and in each other", async () => {
      const { client, world } = context;
      const parentHops = hopsOf(world, {
        model: "document",
        relation: "parent",
      });
      const childHops = hopsOf(world, {
        model: "document",
        relation: "children",
      });
      const row = (id: string) => world.documents.find((doc) => doc.id === id);
      const ancestorPersonal = (id: string) =>
        [...closureOf(parentHops, id, { depth: false, self: false })].some(
          (member) => row(member)?.personal === true
        );
      const all = world.documents.map((doc) => doc.id);
      const closure = {
        parent: { recurse: { depth: false }, some: { personal: true } },
      } as const;
      expect(
        await readIds(client, "document", {
          AND: [closure, { ownerId: "ana" }],
        })
      ).toEqual(
        all
          .filter((id) => ancestorPersonal(id) && row(id)?.ownerId === "ana")
          .sort()
      );
      expect(
        await readIds(client, "document", { OR: [closure, { id: "L" }] })
      ).toEqual(all.filter((id) => ancestorPersonal(id) || id === "L").sort());
      expect(await readIds(client, "document", { NOT: closure })).toEqual(
        all.filter((id) => !ancestorPersonal(id)).sort()
      );
      // A closure inside another relation filter, both cardinalities.
      const grants = await client.accessGrant.findMany({
        where: { document: closure },
        select: { id: true },
      });
      expect(sorted(grants)).toEqual(
        world.grants
          .filter(
            (entry) =>
              entry.documentId !== null && ancestorPersonal(entry.documentId)
          )
          .map((entry) => entry.id)
          .sort()
      );
      expect(
        await readIds(client, "document", {
          children: { some: { parent: { is: closure } } },
        })
      ).toEqual(
        all
          .filter((id) =>
            world.documents.some(
              (child) => child.parentId === id && ancestorPersonal(id)
            )
          )
          .sort()
      );
      // A closure inside a closure: an ancestor with a child owned by cid.
      const childOwnedByCid = (id: string) =>
        [...closureOf(childHops, id, { depth: 1, self: false })].some(
          (member) => row(member)?.ownerId === "cid"
        );
      expect(
        await readIds(client, "document", {
          parent: {
            recurse: true,
            some: {
              children: { recurse: { depth: 1 }, some: { ownerId: "cid" } },
            },
          },
        })
      ).toEqual(
        all
          .filter((id) =>
            [...closureOf(parentHops, id, { depth: 100, self: false })].some(
              childOwnedByCid
            )
          )
          .sort()
      );
    });

    test("Pyxel case 1: a grant to Ventes reaches Dan in Ventes Nord, and Lea who leads Ventes without being a member", async () => {
      const { client } = context;
      const may = async (userId: string, id: string) =>
        (
          await client.page.findFirst({
            where: { id, ...mayPage(userId, EDIT) },
            select: { id: true },
          })
        )?.id ?? null;
      expect(await may("dan", "pv")).toBe("pv");
      expect(await may("lea", "pv")).toBe("pv");
      expect(await may("mia", "pv")).toBe("pv");
      // Ventes Nord's own grant reaches Dan; Lea leads the team above it.
      expect(await may("dan", "pvn")).toBe("pvn");
      expect(await may("lea", "pvn")).toBeNull();
    });

    test("Pyxel case 1: a grant to Ventes Nord does not reach Mia, a member of Ventes only", async () => {
      const { client } = context;
      expect(
        await client.page.findFirst({
          where: { id: "pvn", ...mayPage("mia", EDIT) },
        })
      ).toBeNull();
      expect(
        await client.team.findMany({
          where: {
            id: "VN",
            children: {
              recurse: true,
              self: true,
              some: { members: { some: { userId: "mia" } } },
            },
          },
        })
      ).toEqual([]);
    });

    test("a junction walk reads the related domain at every hop", async () => {
      // Ventes and Nord Est are hidden wherever a relation reaches them, never
      // at the root. Each is two hops from the other: the first hop reaches
      // Ventes Nord, the second the hidden end.
      const hidden = context.client.$extends({
        name: "test.hiddenTeams",
        rows: {
          control: "hidden",
          default: "on",
          models: {
            team: { on: { related: { id: { notIn: ["V", "NE"] } } }, off: {} },
          },
        },
      });
      const teams = async (where: object, mode: "on" | "off") =>
        sorted(
          await hidden.team.findMany({
            where: { id: { in: ["V", "VN", "NE"] }, ...where },
            select: { id: true },
            hidden: mode,
          })
        );
      const reachNordEst = { children: { recurse: true, some: { id: "NE" } } };
      const belowVentes = { parents: { recurse: true, some: { id: "V" } } };
      expect(await teams(reachNordEst, "on")).toEqual([]);
      expect(await teams(reachNordEst, "off")).toEqual(["V", "VN"]);
      expect(await teams(belowVentes, "on")).toEqual([]);
      expect(await teams(belowVentes, "off")).toEqual(["NE", "VN"]);
    });

    test("the written cycles A <-> B and cyc1 <-> cyc2 terminate with the oracle's rows", async () => {
      const { client } = context;
      expect(
        await readIds(client, "document", {
          id: { in: FIXED_DOCUMENTS },
          ...documentAccess("vic", EDIT),
        })
      ).toEqual(["C1", "C2"]);
      // No root above a cycle: neither member is personal.
      expect(
        await readIds(client, "document", {
          id: { in: ["C1", "C2"] },
          ...personal,
        })
      ).toEqual([]);
      // A walk that comes back to its start makes the start a member, even
      // without self.
      expect(
        await readIds(client, "team", {
          children: { recurse: { depth: false }, some: { id: "cyc1" } },
        })
      ).toEqual(["cyc1", "cyc2"]);
      expect(
        await readIds(client, "document", {
          parent: { recurse: true, some: { id: "C1" } },
        })
      ).toEqual(["C1", "C2"]);
    });

    test("the diamond terminates and each team is counted once", async () => {
      const { client } = context;
      const below = { parents: { recurse: true, some: { id: "DT" } } } as const;
      expect(await readIds(client, "team", below)).toEqual(["DB", "DL", "DR"]);
      expect(await client.team.count({ where: below })).toBe(3);
      expect(
        await client.team.findUnique({
          where: { id: "DT" },
          select: {
            _count: {
              select: {
                children: {
                  where: {
                    children: {
                      recurse: true,
                      self: true,
                      some: { members: { some: { userId: "eve" } } },
                    },
                  },
                },
              },
            },
          },
        })
      ).toEqual({ _count: { children: 2 } });
      expect(
        sorted(
          await client.page.findMany({
            where: mayPage("eve", READ),
            select: { id: true },
          })
        )
      ).toEqual(["pdt"]);
    });
  });

  describe(`${provider.name}: recursive relation filters in changes`, () => {
    let context: RecursiveFilterFixture;

    beforeEach(async () => {
      context = await open();
    });
    afterEach(async () => {
      await context.client.$disconnect();
    });

    test("updateMany and deleteMany walk the model they change: the oracle's rows, on every provider", async () => {
      const { client, world } = context;
      const holds =
        (field: (row: DocumentRow) => boolean) =>
        (id: string): boolean =>
          world.documents.some((row) => row.id === id && field(row));
      const documents = () => documentRows(client);

      // documents, upward: rows with a personal ancestor.
      const touched = new Set(
        expectedIds(
          world,
          { model: "document", relation: "parent" },
          "some",
          100,
          false,
          holds((row) => row.personal)
        )
      );
      const updated = [...world.documents]
        .sort(byId)
        .map((row) =>
          touched.has(row.id) ? { ...row, organizationId: "touched" } : row
        );
      await expectChangeWalkingItsModel(
        documents,
        () =>
          client.document.updateMany({
            where: { parent: { recurse: true, some: { personal: true } } },
            data: { organizationId: "touched" },
          }),
        { result: { count: touched.size }, state: updated }
      );

      // documents, downward: a descendant within two hops owned by cid. The
      // set is the statement's snapshot.
      const gone = new Set(
        expectedIds(
          world,
          { model: "document", relation: "children" },
          "some",
          2,
          false,
          holds((row) => row.ownerId === "cid")
        )
      );
      await expectChangeWalkingItsModel(
        documents,
        () =>
          client.document.deleteMany({
            where: {
              children: { recurse: { depth: 2 }, some: { ownerId: "cid" } },
            },
          }),
        { result: { count: gone.size }, state: deleting(updated, gone) }
      );

      // teams, through the junction: rows at or below a team of o2.
      const teams = async () =>
        (await client.team.findMany({ select: { id: true, name: true } })).sort(
          byId
        );
      const renamed = new Set(
        expectedIds(
          world,
          { model: "team", relation: "parents" },
          "some",
          100,
          true,
          (id) =>
            world.teams.some(
              (team) => team.id === id && team.organizationId === "o2"
            )
        )
      );
      const named = [...world.teams].sort(byId).map(({ id, name }) => ({
        id,
        name: renamed.has(id) ? "touched" : name,
      }));
      await expectChangeWalkingItsModel(
        teams,
        () =>
          client.team.updateMany({
            where: {
              parents: {
                recurse: true,
                self: true,
                some: { organizationId: "o2" },
              },
            },
            data: { name: "touched" },
          }),
        { result: { count: renamed.size }, state: named }
      );
      // The leaf below Ventes with no members: Nord Est.
      await expectChangeWalkingItsModel(
        teams,
        () =>
          client.team.deleteMany({
            where: {
              parents: { recurse: true, some: { id: "V" } },
              children: { none: {} },
              members: { none: {} },
            },
          }),
        { result: { count: 1 }, state: named.filter(({ id }) => id !== "NE") }
      );
    });

    test("a nested updateMany whose filter walks its own model, on every provider", async () => {
      const { client } = context;
      // R's one child A has D3 (cid) two hops below it.
      await expectChangeWalkingItsModel(
        () =>
          client.document.findMany({
            where: { id: { in: ["R", "A"] } },
            select: { id: true, ownerId: true, personal: true },
            orderBy: { id: "asc" },
          }),
        () =>
          client.document.update({
            where: { id: "R" },
            data: {
              ownerId: "zoe",
              children: {
                updateMany: {
                  where: {
                    children: { recurse: true, some: { ownerId: "cid" } },
                  },
                  data: { personal: true },
                },
              },
            },
          }),
        {
          result: expect.objectContaining({ id: "R", ownerId: "zoe" }),
          state: [
            { id: "A", ownerId: "ben", personal: true },
            { id: "R", ownerId: "zoe", personal: true },
          ],
        }
      );
    });

    test("recurse: true follows 100 hops; { depth: false } follows the chain to its end", async () => {
      const { client } = context;
      // deep000 <- deep001 <- ... <- deep101: one hop longer than 100.
      const chain = Array.from(
        { length: 102 },
        (_, index) => `deep${String(index).padStart(3, "0")}`
      );
      await client.document.createMany({
        data: chain.map((id, index) => ({
          id,
          organizationId: "o3",
          ownerId: "ana",
          parentId: chain[index - 1] ?? null,
        })),
      });
      const below = (recurse: true | { readonly depth: false }) =>
        readIds(client, "document", {
          organizationId: "o3",
          parent: { recurse, some: { id: "deep000" } },
        });
      expect(await below(true)).toEqual(chain.slice(1, 101));
      expect(await below({ depth: false })).toEqual(chain.slice(1));
    });

    test("Pyxel: the same fragment filters findMany, count, updateMany and deleteMany, on every provider", async () => {
      const { client } = context;
      const pages = async (userId: string, levels: readonly string[]) =>
        sorted(
          await client.page.findMany({
            where: mayPage(userId, levels),
            select: { id: true },
          })
        );
      expect({
        dan: await pages("dan", EDIT),
        lea: await pages("lea", EDIT),
        mia: await pages("mia", EDIT),
        eve: await pages("eve", READ),
        eveEditing: await pages("eve", EDIT),
        zed: await pages("zed", EDIT),
        uma: await pages("uma", READ),
        umaEditing: await pages("uma", EDIT),
        vic: await pages("vic", EDIT),
        nobody: await pages("nobody", READ),
      }).toEqual({
        dan: ["pv", "pvn"],
        lea: ["pv"],
        mia: ["pv"],
        eve: ["pdt"],
        eveEditing: [],
        zed: ["pcy"],
        uma: ["pg"],
        umaEditing: [],
        vic: ["pc"],
        nobody: [],
      });
      expect(await client.page.count({ where: mayPage("dan", EDIT) })).toBe(2);
      // The change targets `page`; the closures walk `team` and `document`.
      expect(
        await client.page.updateMany({
          where: mayPage("dan", EDIT),
          data: { title: "edited by Dan" },
        })
      ).toEqual({ count: 2 });
      expect(
        await client.page.updateMany({
          where: { OR: [mayPage("vic", EDIT), mayPage("uma", READ)] },
          data: { title: "edited through a document" },
        })
      ).toEqual({ count: 2 });
      expect(
        (
          await client.page.findMany({ select: { id: true, title: true } })
        ).sort((a, b) => a.id.localeCompare(b.id))
      ).toEqual([
        { id: "pc", title: "edited through a document" },
        { id: "pcy", title: "Cycle notes" },
        { id: "pdt", title: "Diamond notes" },
        { id: "pg", title: "edited through a document" },
        { id: "pv", title: "edited by Dan" },
        { id: "pvn", title: "edited by Dan" },
      ]);
      expect(
        await client.page.deleteMany({ where: mayPage("mia", EDIT) })
      ).toEqual({ count: 1 });
      expect(
        await client.page.deleteMany({ where: mayPage("eve", READ) })
      ).toEqual({ count: 1 });
      expect(
        sorted(await client.page.findMany({ select: { id: true } }))
      ).toEqual(["pc", "pcy", "pg", "pvn"]);
    });

    test("Pyxel case 2: a grant on the root document reaches its grandchild, in every verb", async () => {
      const { client, world } = context;
      const access = (levels: readonly string[]) => ({
        id: { in: FIXED_DOCUMENTS },
        ...documentAccess("uma", levels),
      });
      expect(
        (
          await client.document.findFirst({
            where: { id: "G", ...documentAccess("uma", READ) },
            select: { id: true },
          })
        )?.id
      ).toBe("G");
      expect(
        await client.document.findFirst({
          where: { id: "L", ...documentAccess("uma", READ) },
        })
      ).toBeNull();
      expect(await readIds(client, "document", access(READ))).toEqual(ROOTED);
      expect(await client.document.count({ where: access(READ) })).toBe(4);
      // The grant is `read`: an `edit` check does not reach anything.
      expect(await client.document.count({ where: access(EDIT) })).toBe(0);
      const owned = [...world.documents]
        .sort(byId)
        .map((row) =>
          ROOTED.includes(row.id) ? { ...row, ownerId: "uma" } : row
        );
      await expectChangeWalkingItsModel(
        () => documentRows(client),
        () =>
          client.document.updateMany({
            where: access(READ),
            data: { ownerId: "uma" },
          }),
        { result: { count: 4 }, state: owned }
      );
      await expectChangeWalkingItsModel(
        () => documentRows(client),
        () =>
          client.document.deleteMany({
            where: { id: { in: ["G", "D3"] }, ...documentAccess("uma", READ) },
          }),
        { result: { count: 2 }, state: deleting(owned, new Set(["G", "D3"])) }
      );
    });

    test("Pyxel case 2: a personal root makes its grandchild personal, in every verb", async () => {
      const { client, world } = context;
      expect(
        (
          await client.document.findFirst({
            where: { id: "G", ...personal },
            select: { id: true },
          })
        )?.id
      ).toBe("G");
      const fixed = { id: { in: FIXED_DOCUMENTS }, ...personal };
      expect(await readIds(client, "document", fixed)).toEqual(ROOTED);
      expect(await client.document.count({ where: fixed })).toBe(4);
      // Through a page, the change of another model: allowed everywhere.
      expect(
        await client.page.updateMany({
          where: { document: personal },
          data: { title: "personal" },
        })
      ).toEqual({ count: 1 });
      expect(
        await client.page.findUnique({
          where: { id: "pg" },
          select: { title: true },
        })
      ).toEqual({ title: "personal" });
      await expectChangeWalkingItsModel(
        () => documentRows(client),
        () => client.document.deleteMany({ where: fixed }),
        {
          result: { count: 4 },
          state: deleting([...world.documents].sort(byId), new Set(ROOTED)),
        }
      );
    });
  });

  // MySQL fires a delete's referential actions row by row, inside the
  // statement, where a correlated filter would read them for later rows.
  describe(`${provider.name}: recursive relation filters in a cascading delete`, () => {
    test("a deleteMany whose closure walks a model its delete cascades into matches the rows it matched before the delete", async () => {
      await provider.reset?.();
      const client = createClient({
        schema: cascadeSchema(),
        driver: provider.createDriver(),
      });
      try {
        await syncLiveSchema(client);
        // R (label root, held by h1) <- M (h2) <- X (h3).
        const seed = async () => {
          await client.folder.deleteMany({});
          await client.holder.deleteMany({});
          await client.holder.createMany({
            data: [{ id: "h1" }, { id: "h2" }, { id: "h3" }],
          });
          for (const [id, label, holderId, parentId] of [
            ["R", "root", "h1", null],
            ["M", "m", "h2", "R"],
            ["X", "x", "h3", "M"],
          ] as const)
            await client.folder.create({
              data: { id, label, holderId, parentId },
            });
        };
        const holders = async () =>
          sorted(await client.holder.findMany({ select: { id: true } }));
        const belowRoot = {
          parent: { recurse: true, some: { label: "root" } },
        } as const;
        await seed();
        // Deleting h2 first would take M, and X's root with it.
        expect(
          await client.holder.deleteMany({
            where: { folders: { some: belowRoot } },
          })
        ).toEqual({ count: 2 });
        expect(await holders()).toEqual(["h1"]);
        await seed();
        // Deleting h1 first would leave M, then X, with no root above them.
        expect(
          await client.holder.deleteMany({
            where: { folders: { none: belowRoot } },
          })
        ).toEqual({ count: 1 });
        expect(await holders()).toEqual(["h2", "h3"]);
      } finally {
        await client.$disconnect();
      }
    });
  });
}

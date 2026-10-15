/**
 * K5 (plan §4.5): a `rows.verbs` entry's declared projection key
 * (`evidence`) and read-gated fields (`reads`), with predicates written by
 * hand over the rbac-app fixture (`ownerId` against a `who` control). The
 * oracle-bound witnesses run the compiled §1.1 policy on every database
 * (`rbac-evidence-behavior.ts`); these pin what they do not reach:
 * admission's refusals, a gated unique key, a recursive projection, a value
 * a call supplies, and that a model without declarations keeps its bytes.
 */

import {
  ClientInitializationError,
  NestedWriteError,
  ValidationError,
} from "@errors";
import {
  createRbacAppClient,
  loadRbacSeed,
  type RbacAppClient,
} from "@tests/contracts/public-client/rbac-app-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { failure } from "@tests/fixtures/failure";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { seed } from "@tests/package/fixtures/rbac-app/seed";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

type Row = Record<string, unknown>;
type Delegate = Record<string, (args?: object) => Promise<any>>;
type Loose = Record<string, Delegate> & { $extends(d: object): Loose };

const OWNER = "user-05";
const mine = { ownerId: { control: "who" } };

/** Documents and users with hand-written predicates; K5's declarations by `k5`. */
const definition = (
  k5: { document?: object; user?: object; organization?: object } = {},
  name = "k5",
  control = "as"
) => ({
  name,
  controls: { who: { oneOf: seed.user.map((user) => user.id) } },
  rows: {
    control,
    default: "all",
    models: {},
    verbs: {
      document: {
        predicates: { all: {}, mine, archived: { archivedAt: { not: null } } },
        read: "all",
        update: "all",
        ...k5.document,
      },
      user: {
        predicates: { all: {}, self: { id: { control: "who" } } },
        read: "all",
        ...k5.user,
      },
      organization: {
        predicates: { all: {} },
        read: "all",
        ...k5.organization,
      },
    },
  },
});
const DECLARED = {
  document: {
    evidence: { as: "$own", names: ["mine", "archived"] },
    reads: { title: "mine" },
  },
  user: { reads: { email: "self" } },
};

describe("K5: declared projection keys and read-gated fields", () => {
  let base: RbacAppClient;
  let db: Loose;
  const statements: string[] = [];
  const metered = (client: Loose) =>
    client.$extends({
      name: "meter",
      statement: (context: { statement: { toStatement(): string } }) => {
        statements.push(context.statement.toStatement());
        return context.statement;
      },
    });
  beforeAll(async () => {
    base = createRbacAppClient(createInMemorySQLite3Driver());
    await syncLiveSchema(base);
    await loadRbacSeed(base);
    db = metered((base as unknown as Loose).$extends(definition(DECLARED)));
  });
  afterAll(async () => {
    await base.$disconnect();
  });
  const apply = (k5: Parameters<typeof definition>[0]) => () =>
    (base as unknown as Loose).$extends(definition(k5));

  test("admission refuses a key not spelled `$` and an identifier, an unknown name, and a gate on a key, a foreign key, a relation or no field", async () => {
    const refused = [
      [
        { document: { evidence: { as: "own", names: ["mine"] } } },
        "evidence.as",
      ],
      [
        { document: { evidence: { as: "$own", names: ["nope"] } } },
        "evidence.names.0",
      ],
      [{ document: { reads: { title: "nope" } } }, "reads.title"],
      [{ document: { reads: { id: "mine" } } }, "reads.id"],
      [
        { document: { reads: { organizationId: "mine" } } },
        "reads.organizationId",
      ],
      [{ document: { reads: { parent: "mine" } } }, "reads.parent"],
      [{ document: { reads: { nothing: "mine" } } }, "reads.nothing"],
    ] as const;
    for (const [k5, at] of refused) {
      const error = await failure(Promise.resolve().then(apply(k5)));
      expect(error, at).toBeInstanceOf(ClientInitializationError);
      expect((error as Error).message, at).toContain(`at "${at}"`);
    }
    // A member of a compound key is a key too.
    const compound = await failure(
      Promise.resolve().then(() =>
        (base as unknown as Loose).$extends({
          name: "compound",
          rows: {
            control: "as",
            default: "all",
            models: {},
            verbs: {
              teamMember: {
                predicates: { all: {} },
                read: "all",
                reads: { teamId: "all" },
              },
            },
          },
        })
      )
    );
    expect(compound).toBeInstanceOf(ClientInitializationError);
    expect((compound as Error).message).toContain('at "reads.teamId"');
  });

  test("two extensions of one chain declaring one key on one model are refused", async () => {
    const once = (base as unknown as Loose).$extends(
      definition({ document: { evidence: { as: "$own", names: ["mine"] } } })
    );
    const error = await failure(
      Promise.resolve().then(() =>
        once.$extends({
          ...definition(
            { document: { evidence: { as: "$own", names: ["all"] } } },
            "again",
            "as2"
          ),
          controls: {},
        })
      )
    );
    expect(error).toBeInstanceOf(ClientInitializationError);
    expect((error as Error).message).toContain('"$own" is declared by two');
  });

  test("the key reports each name beside read, at the root and nested; a list reports its names; an invalid value or an undeclared key is a ValidationError at its path", async () => {
    const rows = (await db.document!.findMany!({
      who: OWNER,
      where: { parentId: null },
      select: {
        id: true,
        $own: true,
        children: { select: { id: true, $own: ["archived"] } },
      },
    })) as Row[];
    expect(rows).toHaveLength(seed.document.filter((d) => !d.parentId).length);
    for (const row of rows) {
      const document = seed.document.find((d) => d.id === row.id)!;
      expect(row.$own).toEqual({
        mine: document.ownerId === OWNER,
        archived: document.archivedAt !== null,
      });
      for (const child of row.children as Row[]) {
        const stored = seed.document.find((d) => d.id === child.id)!;
        expect(child).toEqual({
          id: stored.id,
          $own: { archived: stored.archivedAt !== null },
        });
      }
    }
    for (const value of [["owner"], [], "yes", 1]) {
      const error = await failure(
        db.document!.findMany!({ who: OWNER, select: { $own: value } })
      );
      expect(error, String(value)).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues[0]!.path).toBe("select.$own");
    }
    const undeclared = await failure(
      db.user!.findMany!({ who: OWNER, select: { id: true, $own: true } })
    );
    expect(undeclared).toBeInstanceOf(ValidationError);
    expect((undeclared as ValidationError).issues[0]!.path).toContain("$own");
  });

  test("a value the call supplies is read per call: two callers, one statement each, two answers", async () => {
    for (const who of [OWNER, "user-06"]) {
      statements.length = 0;
      const rows = (await db.document!.findMany!({
        who,
        select: { id: true, $own: ["mine"] },
      })) as Row[];
      expect(statements).toHaveLength(1);
      for (const row of rows)
        expect((row.$own as Row).mine).toBe(
          seed.document.find((d) => d.id === row.id)!.ownerId === who
        );
    }
  });

  test("a gated unique key reads as absent in a unique lookup, a cursor and a connect", async () => {
    const [self, other] = seed.user;
    const find = (email: string) =>
      db.user!.findUnique!({
        who: self!.id,
        where: { email },
        select: { id: true },
      });
    expect(await find(self!.email)).toEqual({ id: self!.id });
    expect(await find(other!.email)).toBeNull();
    const rows = (await db.user!.findMany!({ who: self!.id })) as Row[];
    for (const row of rows)
      expect("email" in row, String(row.id)).toBe(row.id === self!.id);
    const paged = await db.user!.findMany!({
      who: self!.id,
      cursor: { email: other!.email },
      select: { id: true },
    });
    expect(paged).toEqual([]);
    // A connect by a gated unique key: the hidden target is a missing one.
    const document = seed.document.find((d) => d.ownerId === self!.id)!;
    const connect = (email: string) =>
      db.document!.update!({
        who: self!.id,
        where: { id: document.id },
        data: { owner: { connect: { email } } },
        select: { ownerId: true },
      });
    expect(await failure(connect(other!.email))).toBeInstanceOf(
      NestedWriteError
    );
    expect(await connect(self!.email)).toEqual({ ownerId: self!.id });
  });

  test("a recursive projection carries the gate at every hop; a select naming the field fails at the hop's path", async () => {
    const roots = (await db.document!.findMany!({
      who: OWNER,
      where: { parentId: null },
      include: { children: { recurse: { depth: false } } },
    })) as Row[];
    let seen = 0;
    let gated = 0;
    const walk = (rows: Row[]) => {
      for (const row of rows) {
        seen += 1;
        const stored = seed.document.find((d) => d.id === row.id)!;
        if (stored.ownerId === OWNER) expect(row.title).toBe(stored.title);
        else {
          gated += 1;
          expect("title" in row, stored.id).toBe(false);
        }
        walk((row.children as Row[] | undefined) ?? []);
      }
    };
    walk(roots);
    expect(seen).toBe(seed.document.length);
    expect(gated).toBeGreaterThan(0);
    const named = await failure(
      db.document!.findMany!({
        who: OWNER,
        where: { parentId: null, ownerId: OWNER },
        select: {
          id: true,
          title: true,
          children: {
            recurse: { depth: false },
            select: { id: true, title: true },
          },
        },
      })
    );
    expect(named).toBeInstanceOf(ValidationError);
    expect((named as ValidationError).issues[0]!.path).toBe(
      "select.children.select.title"
    );
  });

  test("an update writing a gated field arithmetically reads its stored value; its result carries the field where the gate holds", async () => {
    const id = seed.document.find((d) => d.ownerId !== OWNER)!.id;
    const row = (await db.document!.update!({
      who: OWNER,
      where: { id },
      data: { position: { increment: 1 } },
    })) as Row;
    expect(row.position).toBe(
      seed.document.find((d) => d.id === id)!.position + 1
    );
    expect("title" in row).toBe(false);
    await db.document!.update!({
      who: OWNER,
      where: { id },
      data: { position: { decrement: 1 } },
    });
  });

  test("a model without declarations keeps its bytes; a declared key unasked and no gate keeps the model's", async () => {
    const plain = metered((base as unknown as Loose).$extends(definition()));
    const capture = async (client: Loose, model: string, args: object) => {
      statements.length = 0;
      await client[model]!.findMany!({ who: OWNER, ...args });
      return [...statements];
    };
    for (const [model, args] of [
      ["organization", { include: { members: true } }],
      ["organization", { where: { members: { some: { role: "admin" } } } }],
    ] as const)
      expect(await capture(db, model, args)).toEqual(
        await capture(plain, model, args)
      );
    const keyed = metered(
      (base as unknown as Loose).$extends(
        definition({ organization: { evidence: { as: "$k", names: ["all"] } } })
      )
    );
    expect(await capture(keyed, "organization", {})).toEqual(
      await capture(plain, "organization", {})
    );
  });
});

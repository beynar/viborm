import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import {
  ForbiddenError,
  NestedWriteError,
  NotFoundError,
  QueryEngineError,
  UniqueConstraintError,
  UnsupportedOperationError,
} from "@errors";
import { s } from "@schema";
import { v } from "@src/validation";
import { failure } from "@tests/fixtures/failure";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * K4, the produced row (rbac plan §4.4, R4, OD-13 ruled one statement): a
 * `rows` member's `verbs` judge the row a write produces as a value, against
 * the rows as they stand before the write, inside the statement that writes
 * it. A created row is judged at `place`, an updated row at the predicates
 * that judged its old row (WITH CHECK) and its written fields' `moves`; a
 * refused row is written by no statement, before any constraint, and the
 * call reports `ForbiddenError` at the root, `NestedWriteError` nested.
 *
 * Fixture (hand-computed below): folders, with integer keys a database
 * generates (`increment`), owned by a user and granted to others at `view`
 * or `edit`; items filed in folders. ann owns folder 1 and holds `edit` on
 * folder 2 (bob's, grant 1) and `view` on folder 3 (bob's, grant 2); carl
 * views folder 2 (grant 3); folder 4 is carl's and hidden from ann. Folder
 * 5 is ann's, under folder 1.
 *
 * The plain `rows` declaration is the policy: a folder is read where the
 * caller owns it or holds a grant, edited where it owns it or holds `edit`;
 * a folder is placed by its owner, at the root or under a folder it edits,
 * and its parent never inside its own subtree; a grant is placed and moved
 * only on a folder the caller edits; an item is read and edited with its
 * folder, placed in a folder the caller edits and moved only into one.
 */

const user = s.model({ id: s.string().id(), name: s.string() });
const folder = s.model({
  id: s.int().id().increment(),
  name: s.string(),
  ownerId: s.string(),
  parentId: s.int().nullable(),
  parent: s
    .toOne(() => folder)
    .fields("parentId")
    .references("id")
    .name("tree"),
  children: s.toMany(() => folder).name("tree"),
  grants: s.toMany(() => grant),
  items: s.toMany(() => item),
});
const grant = s.model({
  id: s.int().id().increment(),
  folderId: s.int(),
  folder: s
    .toOne(() => folder)
    .fields("folderId")
    .references("id"),
  userId: s.string(),
  level: s.string(),
  code: s.string().unique(),
});
const item = s.model({
  id: s.int().id().increment(),
  folderId: s.int(),
  folder: s
    .toOne(() => folder)
    .fields("folderId")
    .references("id"),
  title: s.string().unique(),
  views: s.int().default(0),
  tags: s.string().array().default([]),
});
/** A row that writes no field of its own: every value is the database's. */
const tick = s.model({ id: s.int().id().increment() });
/** A model nobody updates: its `update` verb is left out, so false. */
const counter = s.model({ id: s.int().id(), n: s.int() });
export const producedRowSchema = { user, folder, grant, item, tick, counter };

const me = { control: "user" };
const viewFolder = {
  OR: [{ ownerId: me }, { grants: { some: { userId: me } } }],
};
const editFolder = {
  OR: [{ ownerId: me }, { grants: { some: { userId: me, level: "edit" } } }],
};
/** The new parent outside the folder's own subtree. */
export const policy = {
  name: "policy",
  controls: { user: { schema: v.string(), required: true } },
  rows: {
    control: "as",
    default: "all",
    models: {},
    verbs: {
      folder: {
        predicates: {
          view: viewFolder,
          edit: editFolder,
          place: {
            ownerId: me,
            OR: [{ parentId: null }, { parent: { is: editFolder } }],
          },
        },
        read: "view",
        update: "edit",
        delete: "edit",
        place: "place",
        moves: { parentId: "place" },
        acyclic: ["parent"],
      },
      grant: {
        predicates: {
          view: { folder: { is: viewFolder } },
          admin: { folder: { is: editFolder } },
        },
        read: "view",
        update: "admin",
        delete: "admin",
        place: "admin",
        moves: { folderId: "admin" },
      },
      item: {
        predicates: {
          view: { folder: { is: viewFolder } },
          edit: { folder: { is: editFolder } },
          tagged: { NOT: { tags: { has: "secret" } } },
        },
        read: "view",
        update: "edit",
        delete: "edit",
        place: "edit",
        moves: { folderId: "edit", tags: "tagged" },
      },
      tick: {
        predicates: { anyone: {} },
        read: "anyone",
        update: "anyone",
        place: "anyone",
      },
      counter: { predicates: { anyone: {} }, read: "anyone" },
    },
  },
};

const WRITES = /^(INSERT|UPDATE)/m;
/** An INSERT reading its rows from their typed values, kept where judged. */
const JUDGED_INSERT = /^INSERT INTO .* SELECT .* UNION ALL SELECT /;
/** An UPDATE whose candidates are kept, by key, where their new rows hold. */
const JUDGED_UPDATE = / GROUP BY .* HAVING MIN\(/;

export interface ProducedRowSubstrate {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  /** Creates the fixture's tables on an empty database (default: push). */
  readonly prepare?: (client: ProducedRowClient) => Promise<void>;
  readonly release?: () => Promise<void>;
  /**
   * The provider hands back a key it generates: RETURNING, the batch
   * scratch, or an insert id (false for SQLite without RETURNING, whose
   * driver reports no insert id).
   */
  readonly generatedKeys?: boolean;
}

export function createProducedRowClient(driver: AnyDriver) {
  return createClient({ schema: producedRowSchema, driver });
}
export type ProducedRowClient = ReturnType<typeof createProducedRowClient>;

type Row = Record<string, unknown>;
interface Delegate {
  create(args: object): Promise<Row>;
  createMany(args: object): Promise<{ count: number }>;
  update(args: object): Promise<Row>;
  updateMany(args: object): Promise<{ count: number }>;
  upsert(args: object): Promise<Row>;
  findMany(args?: object): Promise<Row[]>;
  deleteMany(args?: object): Promise<{ count: number }>;
}
type Loose = Record<string, Delegate>;
interface Extensible {
  $extends(definition: object): Extensible;
}

/**
 * The fixture's rows, keyed 1.. in insertion order: generated by the
 * database where it hands keys back (so its sequence moves past them), else
 * written.
 */
export async function seedProducedRows(
  base: ProducedRowClient,
  generated: boolean
) {
  const db = base as unknown as Loose;
  const keyed = <T extends { id: number }>(rows: T[]) =>
    generated ? rows.map(({ id: _id, ...row }) => row) : rows;
  await db.user!.createMany({
    data: [
      { id: "ann", name: "Ann" },
      { id: "bob", name: "Bob" },
      { id: "carl", name: "Carl" },
    ],
  });
  await db.folder!.createMany({
    data: keyed([
      { id: 1, name: "ann's", ownerId: "ann", parentId: null },
      { id: 2, name: "bob's shared", ownerId: "bob", parentId: null },
      { id: 3, name: "bob's viewed", ownerId: "bob", parentId: null },
      { id: 4, name: "carl's", ownerId: "carl", parentId: null },
    ]),
  });
  await db.folder!.createMany({
    data: keyed([{ id: 5, name: "ann's inner", ownerId: "ann", parentId: 1 }]),
  });
  await db.grant!.createMany({
    data: keyed([
      { id: 1, folderId: 2, userId: "ann", level: "edit", code: "g1" },
      { id: 2, folderId: 3, userId: "ann", level: "view", code: "g2" },
      { id: 3, folderId: 2, userId: "carl", level: "view", code: "g3" },
    ]),
  });
  await db.counter!.createMany({ data: [{ id: 1, n: 0 }] });
  await db.item!.createMany({
    data: keyed([
      { id: 1, folderId: 1, title: "i1", tags: [] },
      { id: 2, folderId: 2, title: "i2", tags: [] },
      { id: 3, folderId: 3, title: "i3", tags: [] },
      { id: 4, folderId: 4, title: "i4", tags: [] },
    ]),
  });
}

/** Keys the tests write themselves, clear of the seed and of a sequence. */
let next = 1000;
const key = () => next++;

export function runProducedRowBehavior(substrate: ProducedRowSubstrate): void {
  describe(`${substrate.name}: the produced row (K4)`, () => {
    let base: ProducedRowClient;
    let statements: string[];
    let db: Loose;
    beforeEach(async () => {
      base = createProducedRowClient(substrate.createDriver());
      if (substrate.prepare) await substrate.prepare(base);
      else await syncLiveSchema(base);
      await seedProducedRows(base, substrate.generatedKeys !== false);
      statements = [];
      // The policy is plain data, typed loosely: its shape is the witness.
      const extensible = base as unknown as Extensible;
      db = extensible.$extends(policy).$extends({
        name: "statements",
        statement(context: { statement: { toStatement(): string } }) {
          statements.push(context.statement.toStatement());
          return context.statement;
        },
      }) as unknown as Loose;
    });
    afterEach(async () => {
      await base?.$disconnect();
      await substrate.release?.();
    });
    const plain = () => base as unknown as Loose;
    const as = (user: string) => ({ user });
    const titles = async () =>
      (
        await plain().item!.findMany({
          select: { title: true, folderId: true },
          orderBy: { title: "asc" },
        })
      ).map((row) => `${row.title}@${row.folderId}`);
    const folders = async () =>
      (
        await plain().folder!.findMany({
          select: { id: true, name: true, parentId: true },
          orderBy: { id: "asc" },
        })
      ).map((row) => `${row.id}:${row.name}<${row.parentId}`);
    const SEEDED = ["i1@1", "i2@2", "i3@3", "i4@4"];

    test("W-P1: a root create is judged at its placement: in a folder the caller edits it is written, elsewhere ForbiddenError and nothing is", async () => {
      expect(
        await db.item!.create({
          data: { id: key(), folderId: 2, title: "new" },
          ...as("ann"),
        })
      ).toMatchObject({ folderId: 2, title: "new" });
      // A folder ann views, one hidden from her, one that does not exist:
      // the same refusal (W-P16).
      for (const folderId of [3, 4, 99])
        expect(
          await failure(
            db.item!.create({
              data: { id: key(), folderId, title: `x${folderId}` },
              ...as("ann"),
            })
          ),
          `folder ${folderId}`
        ).toBeInstanceOf(ForbiddenError);
      expect(await titles()).toEqual([...SEEDED, "new@2"]);
    });

    test("the refusal comes before any constraint: a refused create over a taken unique key or a missing target is ForbiddenError, an admitted one UniqueConstraintError", async () => {
      expect(
        await failure(
          db.item!.create({
            data: { id: key(), folderId: 4, title: "i1" },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(ForbiddenError);
      expect(
        await failure(
          db.item!.create({
            data: { id: key(), folderId: 1, title: "i1" },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(UniqueConstraintError);
    });

    test("W-P15: a grant cannot justify itself: the judgement sees the rows before the write", async () => {
      // ann views folder 3 only; a grant of edit on it to ann would make
      // ann an editor of folder 3, and so its own administrator.
      expect(
        await failure(
          db.grant!.create({
            data: {
              id: key(),
              folderId: 3,
              userId: "ann",
              level: "edit",
              code: "self",
            },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(ForbiddenError);
      // carl's second row would be justified by his first, in one statement.
      expect(
        await failure(
          db.grant!.createMany({
            data: [
              {
                id: key(),
                folderId: 4,
                userId: "carl",
                level: "edit",
                code: "ok",
              },
              {
                id: key(),
                folderId: 2,
                userId: "carl",
                level: "edit",
                code: "chained",
              },
            ],
            ...as("carl"),
          })
        )
      ).toBeInstanceOf(ForbiddenError);
      const codes = (
        await plain().grant!.findMany({
          select: { code: true },
          orderBy: { code: "asc" },
        })
      ).map((row) => row.code);
      expect(codes).toEqual(["g1", "g2", "g3"]);
    });

    test("W-P2: createMany is judged row by row in its statement: one refused row refuses them all", async () => {
      expect(
        await failure(
          db.item!.createMany({
            data: [
              { id: key(), folderId: 1, title: "a" },
              { id: key(), folderId: 4, title: "b" },
            ],
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(ForbiddenError);
      expect(await titles()).toEqual(SEEDED);
      expect(
        await db.item!.createMany({
          data: [
            { id: key(), folderId: 1, title: "a" },
            { id: key(), folderId: 2, title: "b" },
          ],
          ...as("ann"),
        })
      ).toEqual({ count: 2 });
    });

    test("W-P4, W-P9: a nested create under a parent created by the same call is judged against that parent's values; a refused child rolls the call back", async () => {
      const created = await db.folder!.create({
        data: {
          id: key(),
          name: "tree",
          ownerId: "ann",
          children: {
            create: [
              {
                id: key(),
                name: "leaf",
                ownerId: "ann",
                items: { create: [{ id: key(), title: "deep" }] },
              },
            ],
          },
          items: { create: [{ id: key(), title: "top" }] },
        },
        include: { children: { include: { items: true } }, items: true },
        ...as("ann"),
      });
      expect(created).toMatchObject({
        name: "tree",
        items: [{ title: "top" }],
        children: [{ name: "leaf", items: [{ title: "deep" }] }],
      });
      // Under a parent the caller does not edit, the child is refused, and
      // the whole call with it.
      const before = await folders();
      expect(
        await failure(
          db.folder!.create({
            data: {
              id: key(),
              name: "theirs",
              ownerId: "ann",
              children: {
                create: [{ id: key(), name: "child", ownerId: "bob" }],
              },
            },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(NestedWriteError);
      // A refused root carrying children is the root's refusal, wherever
      // the children's statements ride (one batch on a batch-only driver).
      expect(
        await failure(
          db.folder!.create({
            data: {
              id: key(),
              name: "not ann's",
              ownerId: "bob",
              children: {
                create: [{ id: key(), name: "child", ownerId: "ann" }],
              },
              items: { create: [{ id: key(), title: "under not ann's" }] },
            },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(ForbiddenError);
      expect(await folders()).toEqual(before);
    });

    test.runIf(substrate.generatedKeys !== false)(
      "W-P4: keys the database generates reach the rows judged after them, inside one call",
      async () => {
        const created = await db.folder!.create({
          data: {
            name: "generated",
            ownerId: "ann",
            children: {
              create: [
                {
                  name: "generated leaf",
                  ownerId: "ann",
                  items: { create: [{ title: "generated item" }] },
                },
              ],
            },
          },
          include: { children: { include: { items: true } } },
          ...as("ann"),
        });
        const leaf = (created.children as Row[])[0]!;
        expect(leaf).toMatchObject({
          parentId: created.id,
          items: [{ title: "generated item", folderId: leaf.id }],
        });
        expect(
          await failure(
            db.folder!.create({
              data: {
                name: "generated, refused",
                ownerId: "ann",
                children: { create: [{ name: "not mine", ownerId: "carl" }] },
              },
              ...as("ann"),
            })
          )
        ).toBeInstanceOf(NestedWriteError);
        expect(await folders()).not.toContain("generated, refused");
      }
    );

    test("W-P5, W-P16: an update's new row is judged at what judged its old row: a move into a folder the caller does not edit is ForbiddenError, hidden and missing alike", async () => {
      expect(
        await db.item!.update({
          where: { title: "i1" },
          data: { folderId: 2 },
          ...as("ann"),
        })
      ).toMatchObject({ folderId: 2 });
      for (const folderId of [3, 4, 99])
        expect(
          await failure(
            db.item!.update({
              where: { title: "i2" },
              data: { folderId },
              ...as("ann"),
            })
          ),
          `folder ${folderId}`
        ).toBeInstanceOf(ForbiddenError);
      expect(await titles()).toEqual(["i1@2", "i2@2", "i3@3", "i4@4"]);
    });

    test("WITH CHECK: an update may not produce a row the caller could not have written", async () => {
      // ann edits folder 1 as its owner: handing it to carl leaves a row she
      // would not edit.
      expect(
        await failure(
          db.folder!.update({
            where: { id: 1 },
            data: { ownerId: "carl" },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(ForbiddenError);
      // A rename keeps the row editable.
      expect(
        await db.folder!.update({
          where: { id: 1 },
          data: { name: "renamed" },
          ...as("ann"),
        })
      ).toMatchObject({ name: "renamed", ownerId: "ann" });
    });

    test("a judgement that is false whatever the row is still judges only the rows the write takes", async () => {
      // `counter` is read by anyone and updated by nobody: no row is a
      // candidate, and its new row's predicate is a constant false.
      expect(
        await failure(
          db.counter!.update({ where: { id: 1 }, data: { n: 2 }, ...as("ann") })
        )
      ).toBeInstanceOf(NotFoundError);
      expect(
        await db.counter!.updateMany({ data: { n: 2 }, ...as("ann") })
      ).toEqual({ count: 0 });
    });

    test("only the rows a write takes are judged: a row it reads and does not write never refuses it", async () => {
      // i3 is in folder 3, which ann views and does not edit: its new row
      // would be refused, but it is no candidate of these writes.
      expect(
        await failure(
          db.item!.update({
            where: { title: "i3" },
            data: { views: 5 },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(NotFoundError);
      expect(
        await db.item!.updateMany({ data: { views: 5 }, ...as("ann") })
      ).toEqual({ count: 2 });
    });

    test("one statement's rows are judged against the rows before it: a row it writes first never decides a row it writes later", async () => {
      // ann administers both grants on folder 2 through grant 1. Written
      // one row after the other, grant 3's new row would see grant 1
      // already at view, and ann no longer an editor of folder 2.
      expect(
        await db.grant!.updateMany({
          where: { folderId: 2 },
          data: { level: "view" },
          ...as("ann"),
        })
      ).toEqual({ count: 2 });
    });

    test("updateMany refuses the whole statement when one row's new row is refused", async () => {
      expect(
        await failure(
          db.item!.updateMany({ data: { folderId: 3 }, ...as("ann") })
        )
      ).toBeInstanceOf(ForbiddenError);
      expect(await titles()).toEqual(SEEDED);
      expect(
        await db.item!.updateMany({
          where: { folderId: { in: [1, 2] } },
          data: { folderId: 2, views: { increment: 1 } },
          ...as("ann"),
        })
      ).toEqual({ count: 2 });
      expect(await titles()).toEqual(["i1@2", "i2@2", "i3@3", "i4@4"]);
    });

    test("W-P6: a connect move is judged on the row whose key it writes: ForbiddenError at the root, NestedWriteError from the other side", async () => {
      expect(
        await failure(
          db.item!.update({
            where: { title: "i1" },
            data: { folder: { connect: { id: 3 } } },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(ForbiddenError);
      // A hidden target is not found, as any nested lookup.
      expect(
        await failure(
          db.item!.update({
            where: { title: "i1" },
            data: { folder: { connect: { id: 4 } } },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(NestedWriteError);
      // From the folder's side, the item's row is the one written.
      expect(
        await failure(
          db.folder!.update({
            where: { id: 3 },
            data: { items: { connect: { title: "i1" } } },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(NestedWriteError);
      expect(await titles()).toEqual(SEEDED);
      expect(
        await db.folder!.update({
          where: { id: 2 },
          data: { items: { connect: { title: "i1" } } },
          ...as("ann"),
        })
      ).toMatchObject({ id: 2 });
      expect(await titles()).toEqual(["i1@2", "i2@2", "i3@3", "i4@4"]);
    });

    test("W-P3: upsert, the create arm at placement and the update arm at what judged its old row", async () => {
      expect(
        await failure(
          db.item!.upsert({
            where: { title: "fresh" },
            create: { id: key(), folderId: 3, title: "fresh" },
            update: {},
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(ForbiddenError);
      expect(
        await failure(
          db.item!.upsert({
            where: { title: "i1" },
            create: { id: key(), folderId: 1, title: "i1" },
            update: { folderId: 3 },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(ForbiddenError);
      expect(
        await db.item!.upsert({
          where: { title: "fresh" },
          create: { id: key(), folderId: 2, title: "fresh" },
          update: {},
          ...as("ann"),
        })
      ).toMatchObject({ folderId: 2 });
      expect(await titles()).toEqual(["fresh@2", ...SEEDED]);
    });

    test("W-P4: connectOrCreate's create arm is judged at placement", async () => {
      expect(
        await failure(
          db.folder!.update({
            where: { id: 3 },
            data: {
              items: {
                connectOrCreate: {
                  where: { title: "coc" },
                  create: { id: key(), title: "coc" },
                },
              },
            },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(NestedWriteError);
      expect(
        await failure(
          db.item!.create({
            data: {
              id: key(),
              title: "holder",
              folder: {
                connectOrCreate: {
                  where: { id: 77 },
                  create: { id: 77, name: "bob's new", ownerId: "bob" },
                },
              },
            },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(NestedWriteError);
      expect(await titles()).toEqual(SEEDED);
      expect(await folders()).not.toContain("77:bob's new<null");
    });

    test("W-P14: a parent cycle is refused: a folder cannot move under itself or its own descendant", async () => {
      for (const parentId of [1, 5])
        expect(
          await failure(
            db.folder!.update({
              where: { id: 1 },
              data: { parentId },
              ...as("ann"),
            })
          ),
          `under ${parentId}`
        ).toBeInstanceOf(ForbiddenError);
      expect(
        await failure(
          db.folder!.update({
            where: { id: 1 },
            data: { parent: { connect: { id: 5 } } },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(ForbiddenError);
      expect(await folders()).toContain("1:ann's<null");
      expect(
        await db.folder!.update({
          where: { id: 5 },
          data: { parentId: null },
          ...as("ann"),
        })
      ).toMatchObject({ parentId: null });
    });

    test("a value only the database computes is judged where it is read: a list append is refused where its move reads the list, a defaults-only create always", async () => {
      const issued = statements.length;
      // `tags` is read by its move: its appended value cannot be judged
      // before it exists.
      expect(
        await failure(
          db.item!.update({
            where: { title: "i1" },
            data: { tags: { push: "secret" } },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(QueryEngineError);
      expect(
        await failure(db.tick!.create({ data: {}, ...as("ann") }))
      ).toBeInstanceOf(UnsupportedOperationError);
      expect(statements.slice(issued).join("\n")).not.toMatch(WRITES);
      // A whole list is a value: it is judged as any.
      expect(
        await failure(
          db.item!.update({
            where: { title: "i1" },
            data: { tags: { set: ["secret"] } },
            ...as("ann"),
          })
        )
      ).toBeInstanceOf(ForbiddenError);
      expect(
        await db.item!.update({
          where: { title: "i1" },
          data: { tags: { set: ["x"] } },
          ...as("ann"),
        })
      ).toMatchObject({ tags: ["x"] });
    });

    test("one judged create and one judged move are each one statement carrying its judgement", async () => {
      const from = statements.length;
      await db.item!.create({
        data: { id: key(), folderId: 2, title: "sql" },
        ...as("ann"),
      });
      const created = statements.slice(from);
      await db.item!.update({
        where: { title: "sql" },
        data: { folderId: 1 },
        ...as("ann"),
      });
      const moved = statements.slice(from + created.length);
      const insert = created.filter((text) => text.startsWith("INSERT"));
      const update = moved.filter((text) => text.startsWith("UPDATE"));
      expect(insert).toHaveLength(1);
      expect(insert[0]).toMatch(JUDGED_INSERT);
      expect(update).toHaveLength(1);
      expect(update[0]).toMatch(JUDGED_UPDATE);
      for (const text of [...insert, ...update])
        expect(text).toContain("__viborm_assert__");
    });

    test("a set update that writes nothing its judgement reads states its judgement once: in its candidates", async () => {
      const from = statements.length;
      expect(
        await db.item!.updateMany({ data: { views: 7 }, ...as("ann") })
      ).toEqual({ count: 2 });
      const update = statements
        .slice(from)
        .filter((text) => text.startsWith("UPDATE"));
      expect(update).toHaveLength(1);
      expect(update[0]).not.toContain("__viborm_assert__");
      expect(update[0]).not.toMatch(JUDGED_UPDATE);
    });

    test("a model with no verbs keeps its statements", async () => {
      expect(
        await db.user!.create({
          data: { id: "dan", name: "Dan" },
          ...as("ann"),
        })
      ).toMatchObject({ id: "dan" });
      expect(statements.join("\n")).not.toContain("__viborm_assert__");
    });
  });
}

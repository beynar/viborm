/**
 * Creation timestamps are INSERT-ONLY (issue #47).
 *
 * `.now()` on `s.dateTime()`, `s.date()` and `s.time()` declares a creation
 * timestamp: insertable and defaulted on create, never assigned by an update.
 * The rule is read once per model field from the field's effective generator
 * (`getScalarsSchemas`, `src/validation/scalars/index.ts`), which leaves the
 * field's `update` schema absent; every update surface — root `update`,
 * `updateMany`, `upsert.update`, and each nested update position, which all
 * project `core.update` — then refuses the key as an unknown key, however it is
 * spelled. Create positions are untouched.
 *
 * Static pins: `tests/types/client/insert-only-timestamps.core.types.ts`.
 * Engine counters: `tests/contracts/public-client/insert-only-timestamps.core.test.ts`.
 * Live providers: `tests/providers/local/{sqlite3,pglite}-insert-only-timestamps.test.ts`.
 */

import { s } from "@schema";
import { createSchemaRegistry, parse } from "@validation";
import { afterEach, describe, expect, test, vi } from "vitest";

const CREATED = "2026-01-01T00:00:00.000Z";
const LATER = "2026-02-01T00:00:00.000Z";

const unknownKey = (key: string) => `Unknown key: ${key}`;

/** The first issue's message and path, or `undefined` when the parse passed. */
const refusal = (schema: Parameters<typeof parse>[0], value: unknown) => {
  const result = parse(schema, value);
  const issue = result.issues?.[0];
  return issue
    ? { message: issue.message, path: issue.path?.map(String) }
    : undefined;
};

// -----------------------------------------------------------------------------
// One model per temporal kind, plus the modifier-precedence and
// no-updatable-scalar shapes.
// -----------------------------------------------------------------------------

const stamped = s.model({
  id: s.string().id(),
  title: s.string(),
  createdAt: s.dateTime().now(),
  bornOn: s.date().nullable().now(),
  openedAt: s.time().now().map("opened_at"),
  updatedAt: s.dateTime().updatedAt(),
  editedAt: s.dateTime(),
  dueOn: s.date().default(new Date(CREATED)),
  // Modifier precedence: the generator standing LAST decides.
  nowThenUpdatedAt: s.dateTime().now().updatedAt(),
  updatedAtThenNow: s.dateTime().updatedAt().now(),
  // A modifier that keeps the generator keeps the restriction, even when it
  // replaces the inserted value.
  nowWithLiteral: s.dateTime().now().default(new Date(CREATED)),
  notes: s.toMany(() => note),
});

const note = s.model({
  id: s.string().id(),
  body: s.string(),
  createdAt: s.dateTime().now().map("created_at"),
  stampedId: s.string(),
  stamped: s
    .toOne(() => stamped)
    .fields("stampedId")
    .references("id"),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => note)
    .name("Thread")
    .fields("parentId")
    .references("id"),
  replies: s.toMany(() => note).name("Thread"),
});

// Every scalar is insert-only: the update schema has no scalar entry at all,
// and a relation update must still be admitted.
const moment = s.model({
  at: s.dateTime().now().id(),
  tags: s.toMany(() => tag),
});
const tag = s.model({
  id: s.string().id(),
  label: s.string(),
  momentAt: s.dateTime(),
  moment: s
    .toOne(() => moment)
    .fields("momentAt")
    .references("at"),
});

const registry = createSchemaRegistry({ stamped, note, moment, tag });
const schemas = registry.proxy;

const INSERT_ONLY = ["createdAt", "bornOn", "openedAt"] as const;

describe("insert-only timestamps: create positions", () => {
  test("an omitted creation timestamp is generated on create, for all three kinds", () => {
    const result = parse(schemas.stamped.core.create, {
      id: "s1",
      title: "t",
      editedAt: CREATED,
    });
    if (result.issues) throw new Error(result.issues[0]!.message);
    expect(typeof result.value.createdAt).toBe("string");
    expect(typeof result.value.bornOn).toBe("string");
    expect(typeof result.value.openedAt).toBe("string");
  });

  test("an explicit creation timestamp is accepted on create, for all three kinds", () => {
    const result = parse(schemas.stamped.core.create, {
      id: "s1",
      title: "t",
      editedAt: CREATED,
      createdAt: new Date(CREATED),
      bornOn: null,
      openedAt: "10:30:00",
    });
    if (result.issues) throw new Error(result.issues[0]!.message);
    expect(result.value.createdAt).toBe(CREATED);
    expect(result.value.bornOn).toBeNull();
    expect(result.value.openedAt).toBe("10:30:00");
  });

  test("createMany, nested create, upsert.create and connectOrCreate.create stay insert contexts", () => {
    expect(
      refusal(schemas.stamped.args.createMany, {
        data: [{ id: "s1", title: "t", editedAt: CREATED, createdAt: CREATED }],
      })
    ).toBeUndefined();
    expect(
      refusal(schemas.stamped.args.create, {
        data: {
          id: "s1",
          title: "t",
          editedAt: CREATED,
          notes: { create: { id: "n1", body: "b", createdAt: CREATED } },
        },
      })
    ).toBeUndefined();
    expect(
      refusal(schemas.stamped.args.upsert, {
        where: { id: "s1" },
        create: { id: "s1", title: "t", editedAt: CREATED, createdAt: CREATED },
        update: { title: "u" },
      })
    ).toBeUndefined();
    expect(
      refusal(schemas.stamped.args.update, {
        where: { id: "s1" },
        data: {
          notes: {
            connectOrCreate: {
              where: { id: "n1" },
              create: { id: "n1", body: "b", createdAt: CREATED },
            },
          },
        },
      })
    ).toBeUndefined();
  });
});

describe("insert-only timestamps: the scalar update schema", () => {
  test.each(
    INSERT_ONLY
  )("%s is refused directly, inside { set }, and spelled undefined", (key) => {
    const value = key === "openedAt" ? "11:00:00" : LATER;
    for (const spelled of [value, { set: value }, undefined]) {
      expect(refusal(schemas.stamped.core.update, { [key]: spelled })).toEqual({
        message: unknownKey(key),
        path: [key],
      });
    }
  });

  test.each(INSERT_ONLY)("%s is refused beside a valid key", (key) => {
    expect(
      refusal(schemas.stamped.core.update, { title: "u", [key]: LATER })
    ).toEqual({ message: unknownKey(key), path: [key] });
  });

  test("ordinary temporal fields, `.default(v)` alone and `.updatedAt()` stay updatable", () => {
    const result = parse(schemas.stamped.core.update, {
      editedAt: LATER,
      dueOn: { set: "2026-02-01" },
      updatedAt: LATER,
    });
    if (result.issues) throw new Error(result.issues[0]!.message);
    expect(result.value).toEqual({
      editedAt: { set: LATER },
      dueOn: { set: "2026-02-01" },
      updatedAt: { set: LATER },
    });
  });

  test("the generator standing last decides: `.now().updatedAt()` is updatable, `.updatedAt().now()` is not", () => {
    expect(
      refusal(schemas.stamped.core.update, { nowThenUpdatedAt: LATER })
    ).toBeUndefined();
    expect(
      refusal(schemas.stamped.core.update, { updatedAtThenNow: LATER })
    ).toEqual({
      message: unknownKey("updatedAtThenNow"),
      path: ["updatedAtThenNow"],
    });
  });

  test("`.now().default(v)` keeps the generator, so it stays insert-only", () => {
    expect(
      refusal(schemas.stamped.core.update, { nowWithLiteral: LATER })
    ).toEqual({
      message: unknownKey("nowWithLiteral"),
      path: ["nowWithLiteral"],
    });
  });

  test("scalarUpdate — upsert's scalar-only update surface — is the same owner", () => {
    expect(
      refusal(schemas.stamped.core.scalarUpdate, {
        title: "u",
        createdAt: undefined,
      })
    ).toEqual({ message: unknownKey("createdAt"), path: ["createdAt"] });
    expect(
      refusal(schemas.stamped.core.scalarUpdate, { title: "u" })
    ).toBeUndefined();
  });

  test("the creation timestamp stays filterable, orderable and selectable", () => {
    expect(
      refusal(schemas.stamped.core.where, { createdAt: { lt: LATER } })
    ).toBeUndefined();
    expect(
      refusal(schemas.stamped.core.orderBy, { createdAt: "desc" })
    ).toBeUndefined();
    expect(
      refusal(schemas.stamped.core.select, { createdAt: true })
    ).toBeUndefined();
  });
});

describe("insert-only timestamps: every update placement", () => {
  const refusedAt = (path: readonly string[]) => ({
    message: unknownKey("createdAt"),
    path: [...path, "createdAt"],
  });
  // A to-many verb takes one payload or an array of them, and that union
  // reports every member's refusal in one sentence.
  const refusedInUnion = {
    message: expect.stringContaining(unknownKey("createdAt")),
  };

  test("root update, updateMany and upsert.update", () => {
    expect(
      refusal(schemas.stamped.args.update, {
        where: { id: "s1" },
        data: { title: "u", createdAt: LATER },
      })
    ).toEqual(refusedAt(["data"]));
    expect(
      refusal(schemas.stamped.args.updateMany, {
        where: {},
        data: { title: "u", createdAt: { set: LATER } },
      })
    ).toEqual(refusedAt(["data"]));
    expect(
      refusal(schemas.stamped.args.upsert, {
        where: { id: "s1" },
        create: { id: "s1", title: "t", editedAt: CREATED },
        update: { title: "u", createdAt: LATER },
      })
    ).toEqual(refusedAt(["update"]));
  });

  test("nested to-many update, updateMany and upsert.update", () => {
    expect(
      refusal(schemas.stamped.args.update, {
        where: { id: "s1" },
        data: {
          notes: {
            update: {
              where: { id: "n1" },
              data: { body: "b", createdAt: LATER },
            },
          },
        },
      })
    ).toMatchObject(refusedInUnion);
    expect(
      refusal(schemas.stamped.args.update, {
        where: { id: "s1" },
        data: {
          notes: {
            updateMany: { where: {}, data: { body: "b", createdAt: LATER } },
          },
        },
      })
    ).toMatchObject(refusedInUnion);
    expect(
      refusal(schemas.stamped.args.update, {
        where: { id: "s1" },
        data: {
          notes: {
            upsert: {
              where: { id: "n1" },
              create: { id: "n1", body: "b" },
              update: { body: "b", createdAt: LATER },
            },
          },
        },
      })
    ).toMatchObject(refusedInUnion);
  });

  test("nested to-one update and upsert.update", () => {
    expect(
      refusal(schemas.note.args.update, {
        where: { id: "n1" },
        data: { stamped: { update: { title: "u", createdAt: LATER } } },
      })
    ).toMatchObject(refusedInUnion);
    expect(
      refusal(schemas.note.args.update, {
        where: { id: "n1" },
        data: {
          stamped: {
            upsert: {
              create: { id: "s1", title: "t", editedAt: CREATED },
              update: { title: "u", createdAt: LATER },
            },
          },
        },
      })
    ).toMatchObject(refusedInUnion);
  });

  test("self-referential nesting refuses the key at every depth", () => {
    expect(
      refusal(schemas.note.args.update, {
        where: { id: "n1" },
        data: {
          replies: {
            update: {
              where: { id: "n2" },
              data: {
                replies: {
                  updateMany: { where: {}, data: { createdAt: LATER } },
                },
              },
            },
          },
        },
      })
    ).toMatchObject(refusedInUnion);
    expect(
      refusal(schemas.note.args.update, {
        where: { id: "n1" },
        data: { parent: { update: { body: "b", createdAt: LATER } } },
      })
    ).toMatchObject(refusedInUnion);
    // The same nesting without the timestamp is admitted.
    expect(
      refusal(schemas.note.args.update, {
        where: { id: "n1" },
        data: {
          replies: {
            update: {
              where: { id: "n2" },
              data: {
                replies: { updateMany: { where: {}, data: { body: "b" } } },
              },
            },
          },
        },
      })
    ).toBeUndefined();
  });

  test("a model with no updatable scalar still admits a relation update", () => {
    expect(
      refusal(schemas.moment.args.update, {
        where: { at: CREATED },
        data: { tags: { connect: { id: "t1" } } },
      })
    ).toBeUndefined();
    expect(
      refusal(schemas.moment.args.update, {
        where: { at: CREATED },
        data: { at: LATER },
      })
    ).toEqual({ message: unknownKey("at"), path: ["data", "at"] });
    expect(
      refusal(schemas.tag.args.update, {
        where: { id: "t1" },
        data: { moment: { update: { at: LATER } } },
      })
    ).toMatchObject({ message: unknownKey("at") });
  });
});

describe("insert-only timestamps: interned validators do not carry permission", () => {
  // Two fields whose scalar flags are identical (non-null, scalar, with time
  // zone), so their update validators share one interning key; only the
  // generator differs. The datetime interner is module-global and every cell
  // above has already filled that key, so each cell here loads a FRESH module
  // graph: the pair's own declaration order then decides which field reaches
  // the empty interner first (`fromObject` builds entries in declaration
  // order). Were the rule keyed by flags, the created-first order would lend
  // the plain field the refusal and the plain-first order would lend the
  // creation timestamp the permission.
  const freshPair = async (order: "created first" | "plain first") => {
    vi.resetModules();
    const [{ s: fresh }, { createSchemaRegistry: freshRegistry }] =
      await Promise.all([import("@schema"), import("@validation")]);
    const id = fresh.string().id();
    const model =
      order === "created first"
        ? fresh.model({
            id,
            created: fresh.dateTime().now(),
            plain: fresh.dateTime(),
          })
        : fresh.model({
            id,
            plain: fresh.dateTime(),
            created: fresh.dateTime().now(),
          });
    return freshRegistry({ model }).proxy.model;
  };

  afterEach(() => {
    vi.resetModules();
  });

  test("the creation timestamp declared, and built, first", async () => {
    const { core, scalars } = await freshPair("created first");
    expect(refusal(core.update, { created: LATER })).toEqual({
      message: unknownKey("created"),
      path: ["created"],
    });
    expect(refusal(core.update, { plain: LATER })).toBeUndefined();
    expect(scalars.created.update).toBeUndefined();
    expect(scalars.plain.update).toBeDefined();
  });

  test("the plain field declared, and built, first", async () => {
    const { core, scalars } = await freshPair("plain first");
    expect(refusal(core.update, { plain: LATER })).toBeUndefined();
    expect(refusal(core.update, { created: LATER })).toEqual({
      message: unknownKey("created"),
      path: ["created"],
    });
    expect(scalars.created.update).toBeUndefined();
    expect(scalars.plain.update).toBeDefined();
  });

  test("the field's own record says it has no update schema, and keeps the rest", async () => {
    const { scalars } = await freshPair("created first");
    expect(scalars.created.update).toBeUndefined();
    expect(scalars.created.create).toBeDefined();
    expect(scalars.created.filter).toBeDefined();
    expect(scalars.plain.update).toBeDefined();
  });
});

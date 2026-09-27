/**
 * CREATION TIMESTAMPS ARE INSERT-ONLY, seen from a client call (#47).
 *
 * A `.now()` field on `s.dateTime()`, `s.date()` or `s.time()` has no update
 * schema (`getScalarsSchemas`, `src/validation/scalars/index.ts`), so the update
 * input names the key as `?: never`. These probes enter through the public
 * client, spell the refused key BESIDE a real one (a lone key would be refused
 * by weak-type detection alone), cover every update placement, and hold the
 * payload in a variable too — a key that is merely absent from the type would
 * refuse only the fresh literal. Nothing here is called; only the types matter.
 *
 * Runtime twins: `tests/unit/operation-schemas/update/insert-only-timestamps.core.test.ts`
 * and `tests/contracts/public-client/insert-only-timestamps.core.test.ts`.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { expectTypeOf } from "vitest";

const LATER = new Date("2026-02-01T00:00:00.000Z");

const event = s.model({
  id: s.string().id(),
  title: s.string(),
  createdAt: s.dateTime().now(),
  bornOn: s.date().nullable().now(),
  openedAt: s.time().now().map("opened_at"),
  updatedAt: s.dateTime().updatedAt(),
  editedAt: s.dateTime(),
  nowThenUpdatedAt: s.dateTime().now().updatedAt(),
  updatedAtThenNow: s.dateTime().updatedAt().now(),
  nowWithLiteral: s.dateTime().now().default(LATER),
  notes: s.toMany(() => note),
});

// Self-referential and mutually recursive with `event`: the rule must not
// collapse recursive model inference.
const note = s.model({
  id: s.string().id(),
  body: s.string(),
  createdAt: s.dateTime().now(),
  eventId: s.string(),
  event: s
    .toOne(() => event)
    .fields("eventId")
    .references("id"),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => note)
    .name("Thread")
    .fields("parentId")
    .references("id"),
  replies: s.toMany(() => note).name("Thread"),
});

// No scalar of `moment` is updatable.
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

const client = createClient({
  schema: { event, note, moment, tag },
  driver: new PGliteDriver(),
});

// =============================================================================
// REFUSED — fresh literal, beside a real key, at every placement
// =============================================================================

export const _rootUpdate = () =>
  client.event.update({
    where: { id: "e1" },
    data: {
      title: "u",
      // @ts-expect-error - a creation timestamp is not an update key
      createdAt: LATER,
    },
  });

export const _rootUpdateSet = () =>
  client.event.update({
    where: { id: "e1" },
    data: {
      title: "u",
      // @ts-expect-error - `{ set }` is refused the same way
      createdAt: { set: LATER },
    },
  });

export const _dateAndTime = () =>
  client.event.update({
    where: { id: "e1" },
    data: {
      title: "u",
      // @ts-expect-error - `s.date().nullable().now()` is insert-only
      bornOn: null,
      // @ts-expect-error - `s.time().now().map(...)` is insert-only
      openedAt: "11:00:00",
    },
  });

export const _generatorPrecedence = () =>
  client.event.update({
    where: { id: "e1" },
    data: {
      nowThenUpdatedAt: LATER,
      // @ts-expect-error - `.updatedAt().now()`: the last generator is `now`
      updatedAtThenNow: LATER,
      // @ts-expect-error - `.now().default(v)` keeps the `now` generator
      nowWithLiteral: LATER,
    },
  });

export const _updateMany = () =>
  client.event.updateMany({
    where: {},
    data: {
      title: "u",
      // @ts-expect-error - refused in bulk too
      createdAt: LATER,
    },
  });

export const _upsertUpdate = () =>
  client.event.upsert({
    where: { id: "e1" },
    create: { id: "e1", title: "t", editedAt: LATER, createdAt: LATER },
    update: {
      title: "u",
      // @ts-expect-error - the update arm is an update
      createdAt: LATER,
    },
  });

// A to-many verb takes one payload or an array of them; TypeScript reports a
// refused key inside that union on the VERB, so the directive sits there. Each
// has an accepted twin below that differs only by the refused key.
export const _nestedToMany = () =>
  client.event.update({
    where: { id: "e1" },
    data: {
      notes: {
        // @ts-expect-error - nested update
        update: {
          where: { id: "n1" },
          data: { body: "b", createdAt: LATER },
        },
        // @ts-expect-error - nested updateMany
        updateMany: {
          where: {},
          data: { body: "b", createdAt: LATER },
        },
        // @ts-expect-error - nested upsert's update arm
        upsert: {
          where: { id: "n1" },
          create: { id: "n1", body: "b", createdAt: LATER },
          update: { body: "b", createdAt: LATER },
        },
      },
    },
  });

export const _nestedToManyAccepted = () =>
  client.event.update({
    where: { id: "e1" },
    data: {
      notes: {
        update: { where: { id: "n1" }, data: { body: "b" } },
        updateMany: { where: {}, data: { body: "b" } },
        upsert: {
          where: { id: "n1" },
          create: { id: "n1", body: "b", createdAt: LATER },
          update: { body: "b" },
        },
      },
    },
  });

export const _nestedToOne = () =>
  client.note.update({
    where: { id: "n1" },
    data: {
      event: {
        update: {
          title: "u",
          // @ts-expect-error - nested to-one update
          createdAt: LATER,
        },
      },
    },
  });

export const _selfNested = () =>
  client.note.update({
    where: { id: "n1" },
    data: {
      replies: {
        // @ts-expect-error - two self-referential levels down
        update: {
          where: { id: "n2" },
          data: {
            replies: {
              updateMany: { where: {}, data: { body: "b", createdAt: LATER } },
            },
          },
        },
      },
    },
  });

export const _selfNestedAccepted = () =>
  client.note.update({
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
  });

// =============================================================================
// REFUSED — non-fresh payloads
// =============================================================================

const heldData = { title: "u", createdAt: LATER };
export const _heldData = () =>
  // @ts-expect-error - a payload held in a variable is refused too
  client.event.update({ where: { id: "e1" }, data: heldData });

const heldArgs = {
  where: { id: "e1" },
  data: { title: "u", createdAt: LATER },
};
// @ts-expect-error - so are held arguments
export const _heldArgs = () => client.event.update(heldArgs);

const heldBulk = { title: "u", createdAt: { set: LATER } };
export const _heldBulk = () =>
  // @ts-expect-error - held bulk data
  client.event.updateMany({ where: {}, data: heldBulk });

// =============================================================================
// COMPILES, REFUSED AT RUNTIME — an explicit `undefined`
// =============================================================================

// TypeScript admits `undefined` for every optional key, and `?: never` is an
// optional key, so an explicit `createdAt: undefined` type-checks, fresh or
// held. The runtime refuses it (`Unknown key: createdAt`; runtime twins: the
// files named in this header).
// Pinned without a directive: were the type to start refusing it, this file
// would stop compiling and the docs sentence saying it compiles would be stale.
export const _explicitUndefined = () =>
  client.event.update({
    where: { id: "e1" },
    data: { title: "u", createdAt: undefined },
  });

const heldUndefined = { title: "u", createdAt: undefined };
export const _heldUndefined = () =>
  client.event.update({ where: { id: "e1" }, data: heldUndefined });

// =============================================================================
// ACCEPTED
// =============================================================================

const createData = {
  id: "e1",
  title: "t",
  editedAt: LATER,
  createdAt: LATER,
  bornOn: LATER,
  openedAt: "10:30:00",
};
export const _createHeld = () => client.event.create({ data: createData });

export const _createPlacements = () => [
  client.event.create({
    data: {
      id: "e1",
      title: "t",
      editedAt: LATER,
      createdAt: LATER,
      notes: { create: { id: "n1", body: "b", createdAt: LATER } },
    },
  }),
  client.event.createMany({
    data: [{ id: "e1", title: "t", editedAt: LATER, createdAt: LATER }],
  }),
  client.event.update({
    where: { id: "e1" },
    data: {
      notes: {
        connectOrCreate: {
          where: { id: "n1" },
          create: { id: "n1", body: "b", createdAt: LATER },
        },
      },
    },
  }),
];

const updatableData = {
  title: "u",
  editedAt: LATER,
  updatedAt: LATER,
  nowThenUpdatedAt: { set: LATER },
};
export const _updatable = () =>
  client.event.update({ where: { id: "e1" }, data: updatableData });

export const _noUpdatableScalar = () =>
  client.moment.update({
    where: { at: LATER },
    data: { tags: { connect: { id: "t1" } } },
  });

export const _filterAndRead = async () => {
  const found = await client.note.findFirst({
    where: { createdAt: { lt: LATER } },
    orderBy: { createdAt: "desc" },
    include: { replies: true, event: true },
  });
  if (found) {
    expectTypeOf(found.createdAt).toEqualTypeOf<Date>();
    expectTypeOf(found.event.createdAt).toEqualTypeOf<Date>();
    expectTypeOf(found.replies[0]!.createdAt).toEqualTypeOf<Date>();
  }
};

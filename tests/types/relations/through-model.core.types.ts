/**
 * A declared model as the junction, entered through the public client as a
 * caller spells it, with a typo beside a real key at each level.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";

const teamParent = s
  .model({
    organizationId: s.string(),
    childId: s.string(),
    parentId: s.string(),
    note: s.string().default("linked"),
    remark: s.string().nullable(),
    child: s
      .toOne(() => team)
      .fields("organizationId", "childId")
      .references("organizationId", "id"),
    parent: s
      .toOne(() => team)
      .fields("organizationId", "parentId")
      .references("organizationId", "id"),
  })
  .id(["childId", "parentId"]);
const team = s
  .model({
    id: s.string().id(),
    organizationId: s.string(),
    parents: s
      .toMany(() => team)
      .name("graph")
      .through(() => teamParent)
      .source("child")
      .target("parent"),
    children: s.toMany(() => team).name("graph"),
    plain: s.toMany(() => tag).through("team_tag"),
  })
  .unique(["organizationId", "id"]);
const tag = s.model({
  id: s.string().id(),
  teams: s.toMany(() => team),
});

const seat = s
  .model({
    roomId: s.string(),
    guestId: s.string(),
    role: s.string(),
    rank: s.int().default(1),
    room: s
      .toOne(() => room)
      .fields("roomId")
      .references("id"),
    guest: s
      .toOne(() => guest)
      .fields("guestId")
      .references("id"),
  })
  .id(["roomId", "guestId"]);
const room = s.model({
  id: s.string().id(),
  guests: s
    .toMany(() => guest)
    .through(() => seat)
    .source("room")
    .target("guest"),
});
const guest = s.model({
  id: s.string().id(),
  rooms: s.toMany(() => room),
});

function clients() {
  return {
    db: createClient({
      schema: { team, teamParent, tag },
      driver: new PGliteDriver(),
    }),
    seats: createClient({
      schema: { seat, room, guest },
      driver: new PGliteDriver(),
    }),
  };
}
declare const { db, seats }: ReturnType<typeof clients>;

export async function reads() {
  const selected = await db.team.findMany({
    select: {
      id: true,
      parents: {
        select: { id: true, $through: { select: { note: true } } },
      },
    },
  });
  const held: {
    id: string;
    parents: { id: string; $through: { note: string } }[];
  }[] = selected;
  const included = await db.team.findMany({
    include: { parents: { include: { $through: true } } },
  });
  const note: string = included[0]!.parents[0]!.$through.note;
  const remark: string | null = included[0]!.parents[0]!.$through.remark;
  const fromTheOtherEnd = await db.team.findMany({
    select: { children: { select: { id: true, $through: true } } },
  });
  const onlyRows = await db.team.findMany({ include: { parents: true } });
  // @ts-expect-error an include of target rows carries no link row
  const absent = onlyRows[0]!.parents[0]!.$through;
  // @ts-expect-error $through is the selected columns, not every column
  const unselected = selected[0]!.parents[0]!.$through.childId;

  await db.team.findMany({
    select: {
      parents: {
        // @ts-expect-error no $through on a walk
        select: { id: true, $through: true },
        recurse: { depth: false },
      },
    },
  });
  await db.team.findMany({
    select: {
      parents: {
        select: {
          id: true,
          // @ts-expect-error a column typo beside a real column
          $through: { select: { note: true, nope: true } },
        },
      },
    },
  });
  await db.team.findMany({
    select: {
      parents: {
        select: {
          id: true,
          // @ts-expect-error a relation beside a real column
          $through: { select: { note: true, child: true } },
        },
      },
    },
  });
  await db.team.findMany({
    // @ts-expect-error no link row on a string .through()
    select: { plain: { select: { id: true, $through: true } } },
  });
  return [held, note, remark, fromTheOtherEnd, absent, unselected];
}

export async function filters() {
  await db.team.findMany({
    where: {
      parents: {
        some: { id: "x", $through: { note: "y", childId: { in: ["a"] } } },
      },
    },
  });
  await db.team.findMany({
    where: {
      children: { none: { $through: { note: "y" } } },
      parents: { every: { $through: { note: "y" } } },
    },
  });
  await db.team.findMany({
    select: {
      parents: { where: { $through: { note: "x" } }, select: { id: true } },
    },
  });
  await db.team.findMany({
    // @ts-expect-error a column typo beside a real column
    where: { parents: { some: { $through: { note: "y", nope: "x" } } } },
  });
  await db.team.findMany({
    // @ts-expect-error no $through in a walk's filter
    where: {
      parents: {
        recurse: { depth: false },
        some: { id: "x", $through: { note: "y" } },
      },
    },
  });
  await db.team.findMany({
    // @ts-expect-error no link row on a string .through()
    where: { plain: { some: { id: "x", $through: { note: "y" } } } },
  });
  await db.team.findMany({
    select: {
      parents: {
        // @ts-expect-error a column typo in a nested where
        where: { $through: { note: "x", nope: "y" } },
        select: { id: true },
      },
    },
  });
}

export async function writes() {
  await seats.room.update({
    where: { id: "r" },
    data: { guests: { connect: { id: "g", $through: { role: "x" } } } },
  });
  await seats.room.update({
    where: { id: "r" },
    data: { guests: { create: { id: "g", $through: { role: "x", rank: 2 } } } },
  });
  await seats.room.update({
    where: { id: "r" },
    data: {
      guests: {
        connectOrCreate: {
          where: { id: "g" },
          create: { id: "g" },
          $through: { role: "x" },
        },
      },
    },
  });
  await seats.room.update({
    where: { id: "r" },
    data: { guests: { set: [{ id: "g", $through: { role: "x" } }] } },
  });
  await seats.guest.update({
    where: { id: "g" },
    data: { rooms: { connect: { id: "r", $through: { role: "x" } } } },
  });
  await seats.room.create({
    data: {
      id: "r",
      guests: { connect: { id: "g", $through: { role: "x" } } },
    },
  });
  // Every other column of this link fills itself, so `$through` is optional.
  await db.team.update({
    where: { id: "a" },
    data: { parents: { connect: { id: "b" } } },
  });
  await db.team.update({
    where: { id: "a" },
    data: { parents: { connect: { id: "b", $through: { note: "n" } } } },
  });

  await seats.room.update({
    where: { id: "r" },
    // @ts-expect-error role has no default, so a link must state it
    data: { guests: { connect: { id: "g" } } },
  });
  await seats.room.update({
    where: { id: "r" },
    // @ts-expect-error a member column is filled from the two rows
    data: {
      guests: { connect: { id: "g", $through: { role: "x", guestId: "g" } } },
    },
  });
  await seats.room.update({
    where: { id: "r" },
    // @ts-expect-error a typo beside a real column
    data: {
      guests: { connect: { id: "g", $through: { role: "x", nope: 1 } } },
    },
  });
  await seats.room.update({
    where: { id: "r" },
    data: {
      guests: {
        // @ts-expect-error the column's own type
        connect: { id: "g", $through: { role: 1 } },
      },
    },
  });
  await db.teamParent.update({
    where: { childId_parentId: { childId: "a", parentId: "b" } },
    // @ts-expect-error no link row on a to-one
    data: { child: { connect: { id: "b", $through: { note: "n" } } } },
  });
  await db.team.update({
    where: { id: "a" },
    // @ts-expect-error no link row on a string .through()
    data: { plain: { connect: { id: "b", $through: { note: "n" } } } },
  });
}

export function reservedName() {
  // @ts-expect-error `$through` is reserved
  return s.model({ id: s.string().id(), $through: s.string() });
}

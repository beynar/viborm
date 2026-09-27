/** Public input and result proof for issue #54. */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { expectTypeOf } from "vitest";

const record = s.model({
  id: s.string().id(),
  label: s.string(),
  touchedAt: s.dateTime().updatedAt(),
  touchedOn: s.date().updatedAt(),
  touchedTime: s.time().updatedAt(),
  history: s.dateTime().array().updatedAt(),
  children: s.toMany(() => child),
});

const child = s.model({
  id: s.string().id(),
  label: s.string(),
  touchedAt: s.dateTime().updatedAt(),
  recordId: s.string(),
  record: s
    .toOne(() => record)
    .fields("recordId")
    .references("id"),
});

export const _updatedAtPublicTypes = async () => {
  const client = createClient({
    schema: { record, child },
    driver: new PGliteDriver(),
  });

  const updated = await client.record.update({
    where: { id: "r1" },
    data: {},
  });
  expectTypeOf(updated.touchedAt).toEqualTypeOf<Date>();
  expectTypeOf(updated.touchedOn).toEqualTypeOf<Date>();
  expectTypeOf(updated.touchedTime).toEqualTypeOf<string>();

  await client.record.updateMany({ data: {} });
  await client.record.upsert({
    where: { id: "r1" },
    create: { id: "r1", label: "created", history: [] },
    update: {},
  });
  await client.record.update({
    where: { id: "r1" },
    data: {
      touchedAt: new Date(),
      touchedOn: new Date(),
      touchedTime: "04:05:06",
      history: [new Date()],
      children: {
        update: { where: { id: "c1" }, data: {} },
        updateMany: { where: {}, data: {} },
      },
    },
  });
};

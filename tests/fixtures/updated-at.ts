// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers are invoked only from registered tests.
/** Shared live-provider contract for issue #54. */

import type { VibORMClient, VibORMConfig } from "@client/client";
import { s } from "@schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { expect, test } from "vitest";

const CREATED = new Date("2026-01-01T01:02:03.000Z");
const EXPLICIT = new Date("2026-02-03T04:05:06.000Z");
const CREATED_TIME = "01:02:03";
const EXPLICIT_TIME = "04:05:06";

let childAdmissions = 0;
const CHILD_ADMISSION_BASE = Date.parse("2026-06-01T00:00:00.000Z");
const childAdmissionValue = (admission: number) =>
  new Date(CHILD_ADMISSION_BASE + admission).toISOString();
const countChildAdmission: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "updated-at-live-test",
    validate: (_value) => {
      childAdmissions += 1;
      return { value: childAdmissionValue(childAdmissions) };
    },
  },
};

export function createUpdatedAtSchema(prefix = "issue54_updated_at") {
  const record = s
    .model({
      id: s.string().id(),
      label: s.string(),
      touchedAt: s.dateTime().updatedAt().default(CREATED),
      touchedOn: s.date().updatedAt(),
      touchedTime: s.time().updatedAt(),
      createdAt: s.dateTime().now(),
      ordinaryAt: s.dateTime().default(CREATED),
      children: s.toMany(() => child),
    })
    .map(`${prefix}_records`);

  const child = s
    .model({
      id: s.string().id(),
      label: s.string(),
      touchedAt: s.dateTime().updatedAt().schema(countChildAdmission),
      recordId: s.string(),
      record: s
        .toOne(() => record)
        .fields("recordId")
        .references("id"),
      logs: s.toMany(() => log),
    })
    .map(`${prefix}_children`);

  const log = s
    .model({
      id: s.string().id(),
      message: s.string(),
      childId: s.string(),
      child: s
        .toOne(() => child)
        .fields("childId")
        .references("id"),
    })
    .map(`${prefix}_logs`);

  return { record, child, log };
}

export const updatedAtSchema = createUpdatedAtSchema();

type UpdatedAtClient = VibORMClient<VibORMConfig<typeof updatedAtSchema>>;

function expectCurrentDateAndTime(
  touchedOn: Date,
  touchedTime: string,
  before: number,
  after: number
) {
  const beforeDate = new Date(before).toISOString().slice(0, 10);
  const afterDate = new Date(after).toISOString().slice(0, 10);
  const actualDate = touchedOn.toISOString().slice(0, 10);
  expect(actualDate >= beforeDate && actualDate <= afterDate).toBe(true);

  let timeIsInRange = false;
  const firstUtcDay = Date.parse(`${beforeDate}T00:00:00.000Z`);
  const lastUtcDay = Date.parse(`${afterDate}T00:00:00.000Z`);
  for (let day = firstUtcDay; day <= lastUtcDay; day += 86_400_000) {
    const candidate = Date.parse(
      `${new Date(day).toISOString().slice(0, 10)}T${touchedTime}.000Z`
    );
    if (candidate <= after && candidate + 999 >= before) timeIsInRange = true;
  }
  expect(timeIsInRange).toBe(true);
}

function expectCurrentTemporalValues(
  value: { touchedAt: Date; touchedOn: Date; touchedTime: string },
  before: number,
  after: number
) {
  expect(value.touchedAt.getTime()).toBeGreaterThanOrEqual(before);
  expect(value.touchedAt.getTime()).toBeLessThanOrEqual(after);
  expectCurrentDateAndTime(value.touchedOn, value.touchedTime, before, after);
}

async function seed(client: UpdatedAtClient, id = "r1") {
  return client.record.create({
    data: {
      id,
      label: "seeded",
      touchedAt: CREATED,
      touchedOn: CREATED,
      touchedTime: CREATED_TIME,
      createdAt: CREATED,
      ordinaryAt: CREATED,
      children: {
        create: [
          { id: `${id}-c1`, label: "one", touchedAt: CREATED.toISOString() },
          { id: `${id}-c2`, label: "two", touchedAt: CREATED.toISOString() },
        ],
      },
    },
  });
}

export function updatedAtCells(getClient: () => UpdatedAtClient): void {
  test("root update and an explicit empty update refresh temporal fields only", async () => {
    const client = getClient();
    await seed(client);

    let before = Date.now();
    const renamed = await client.record.update({
      where: { id: "r1" },
      data: { label: "renamed" },
    });
    let after = Date.now();
    expectCurrentTemporalValues(renamed, before, after);
    expect(renamed.createdAt).toEqual(CREATED);
    expect(renamed.ordinaryAt).toEqual(CREATED);

    await client.record.update({
      where: { id: "r1" },
      data: { touchedAt: CREATED },
    });
    before = Date.now();
    const empty = await client.record.update({
      where: { id: "r1" },
      data: {},
    });
    after = Date.now();
    expectCurrentTemporalValues(empty, before, after);
  });

  test("explicit update values win", async () => {
    const client = getClient();
    await seed(client);

    const updated = await client.record.update({
      where: { id: "r1" },
      data: {
        touchedAt: EXPLICIT,
        touchedOn: EXPLICIT,
        touchedTime: EXPLICIT_TIME,
      },
    });
    expect(updated.touchedAt).toEqual(EXPLICIT);
    expect(updated.touchedOn).toEqual(new Date("2026-02-03T00:00:00.000Z"));
    expect(updated.touchedTime).toBe(EXPLICIT_TIME);
  });

  test("updateMany admits one shared template occurrence", async () => {
    const client = getClient();
    await seed(client, "r1");
    await seed(client, "r2");

    const before = Date.now();
    await expect(
      client.record.updateMany({ data: { label: "bulk" } })
    ).resolves.toEqual({ count: 2 });
    const after = Date.now();
    const rows = await client.record.findMany({ orderBy: { id: "asc" } });
    for (const row of rows) expectCurrentTemporalValues(row, before, after);
    expect(rows[0]!.touchedAt).toEqual(rows[1]!.touchedAt);
  });

  test("upsert refreshes only its update arm and keeps create behavior", async () => {
    const client = getClient();
    await seed(client);

    let before = Date.now();
    const updated = await client.record.upsert({
      where: { id: "r1" },
      create: { id: "r1", label: "unused" },
      update: { label: "upserted" },
    });
    let after = Date.now();
    expectCurrentTemporalValues(updated, before, after);

    before = Date.now();
    const created = await client.record.upsert({
      where: { id: "r3" },
      create: { id: "r3", label: "created" },
      update: { label: "unused" },
    });
    after = Date.now();
    expect(created.touchedAt).toEqual(CREATED);
    expectCurrentDateAndTime(
      created.touchedOn,
      created.touchedTime,
      before,
      after
    );

    const explicit = await client.record.create({
      data: {
        id: "r4",
        label: "explicit",
        touchedAt: EXPLICIT,
        touchedOn: EXPLICIT,
        touchedTime: EXPLICIT_TIME,
      },
    });
    expect(explicit.touchedAt).toEqual(EXPLICIT);
  });

  test("nested update admits once; a relation-bearing series admits its template and members", async () => {
    const client = getClient();
    await seed(client);
    childAdmissions = 0;

    await client.record.update({
      where: { id: "r1" },
      data: {
        children: {
          update: {
            where: { id: "r1-c1" },
            data: { label: "single" },
          },
        },
      },
    });
    const first = await client.child.findUniqueOrThrow({
      where: { id: "r1-c1" },
    });
    expect(childAdmissions).toBe(1);
    expect(first.touchedAt).toEqual(new Date(childAdmissionValue(1)));

    childAdmissions = 0;
    await client.record.update({
      where: { id: "r1" },
      data: {
        children: {
          updateMany: {
            where: {},
            data: {
              label: "many",
              logs: { create: { message: "audit" } },
            },
          },
        },
      },
    });
    expect(childAdmissions).toBe(3);
    const children = await client.child.findMany({ orderBy: { id: "asc" } });
    expect(children.map(({ touchedAt }) => touchedAt)).toEqual([
      new Date(childAdmissionValue(2)),
      new Date(childAdmissionValue(3)),
    ]);
    await expect(client.log.count({})).resolves.toBe(2);

    childAdmissions = 0;
    await client.record.update({
      where: { id: "r1" },
      data: {
        children: {
          updateMany: {
            where: { id: "missing" },
            data: {
              label: "unused",
              logs: { create: { message: "never" } },
            },
          },
        },
      },
    });
    expect(childAdmissions).toBe(1);
    await expect(client.log.count({})).resolves.toBe(2);
  });
}

/**
 * `.updatedAt()` is an update-admission default, shared by every placement.
 * The field-specific wrapper lives above the scalar-kind update interner: an
 * omitted occurrence reads the wall clock once and becomes the ordinary
 * `{ set: value }` language, while an explicit value wins.
 */

import { s } from "@schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createSchemaRegistry, parse, toJsonSchema, v } from "@validation";
import { afterEach, describe, expect, test, vi } from "vitest";

const CREATED = "2026-01-01T01:02:03.000Z";
const NOW = "2026-09-27T17:42:31.456Z";
const EXPLICIT = "2026-02-03T04:05:06.000Z";

const project = s.model({
  id: s.string().id(),
  title: s.string(),
  touchedAt: s.dateTime().updatedAt(),
  touchedOn: s.date().updatedAt(),
  touchedTime: s.time().updatedAt(),
  createdAt: s.dateTime().now(),
  ordinaryDefault: s.dateTime().default(new Date(CREATED)),
  overriddenCreate: s.dateTime().updatedAt().default(new Date(CREATED)),
  replacedCreate: s.dateTime().default(new Date(CREATED)).updatedAt(),
  tasks: s.toMany(() => task),
});

const task = s.model({
  id: s.string().id(),
  title: s.string(),
  touchedAt: s.dateTime().updatedAt(),
  projectId: s.string(),
  project: s
    .toOne(() => project)
    .fields("projectId")
    .references("id"),
});

const schemas = createSchemaRegistry({ project, task }).proxy;

const listStamped = s.model({
  id: s.string().id(),
  history: s.dateTime().array(),
  plain: s.dateTime().array(),
});
const listSchemas = createSchemaRegistry({ listStamped }).proxy.listStamped;

const parsed = (schema: Parameters<typeof parse>[0], input: unknown) => {
  const result = parse(schema, input);
  if (result.issues) throw new Error(result.issues[0]!.message);
  return result.value;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("`.updatedAt()` admission", () => {
  test("omission reads the wall clock for DateTime, Date and Time only", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    expect(parsed(schemas.project.core.update, { title: "renamed" })).toEqual({
      title: { set: "renamed" },
      touchedAt: { set: NOW },
      touchedOn: { set: "2026-09-27" },
      touchedTime: { set: "17:42:31.000" },
      overriddenCreate: { set: NOW },
      replacedCreate: { set: NOW },
    });
  });

  test("an explicit value wins, while an explicit empty object refreshes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    expect(
      parsed(schemas.project.core.update, {
        touchedAt: EXPLICIT,
        touchedOn: new Date(EXPLICIT),
        touchedTime: "04:05:06",
        overriddenCreate: { set: EXPLICIT },
      })
    ).toEqual({
      touchedAt: { set: EXPLICIT },
      touchedOn: { set: "2026-02-03" },
      touchedTime: { set: "04:05:06.000" },
      overriddenCreate: { set: EXPLICIT },
      replacedCreate: { set: NOW },
    });
    expect(parsed(schemas.project.core.update, {})).toMatchObject({
      touchedAt: { set: NOW },
      touchedOn: { set: "2026-09-27" },
      touchedTime: { set: "17:42:31.000" },
    });
  });

  test("create keeps its own default and explicit-value behavior", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    expect(
      parsed(schemas.project.core.create, { id: "p1", title: "one" })
    ).toMatchObject({
      touchedAt: NOW,
      touchedOn: "2026-09-27",
      touchedTime: "17:42:31.000",
      createdAt: NOW,
      ordinaryDefault: CREATED,
      overriddenCreate: CREATED,
      replacedCreate: NOW,
    });
    expect(
      parsed(schemas.project.core.create, {
        id: "p2",
        title: "two",
        touchedAt: EXPLICIT,
      })
    ).toMatchObject({ touchedAt: EXPLICIT });
  });

  test("temporal lists require explicit values and refuse scalar updatedAt generation", () => {
    expect(() => s.dateTime().array().updatedAt()).toThrow("Scalar generation");
    expect(() => s.dateTime().updatedAt().array()).toThrow("Scalar generation");
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    expect(parsed(listSchemas.core.update, {})).not.toHaveProperty("history");
    expect(
      parsed(listSchemas.core.update, { history: [EXPLICIT] })
    ).toMatchObject({ history: { set: [EXPLICIT] } });
  });

  test("JSON Schema sees the wrapper without admitting a timestamp", () => {
    let admissions = 0;
    const countAdmission: StandardSchemaV1<string, string> = {
      "~standard": {
        version: 1,
        vendor: "updated-at-json-test",
        validate: (value) => {
          admissions += 1;
          return typeof value === "string"
            ? { value }
            : { issues: [{ message: "Expected string" }] };
        },
      },
    };
    const jsonModel = s.model({
      id: s.string().id(),
      touchedAt: s.dateTime().updatedAt().schema(countAdmission),
    });
    const update = createSchemaRegistry({ jsonModel }).proxy.jsonModel.core
      .update;

    expect(() => toJsonSchema(update)).not.toThrow();
    expect(admissions).toBe(0);
    expect(toJsonSchema(update)).toMatchObject({
      properties: { touchedAt: { anyOf: expect.any(Array) } },
    });
    expect(admissions).toBe(0);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(parsed(update, {})).toEqual({ touchedAt: { set: NOW } });
    expect(admissions).toBe(1);
  });

  test("filter-only access leaves the field's update variant lazy", () => {
    const custom: StandardSchemaV1<string, string> = {
      "~standard": {
        version: 1,
        vendor: "updated-at-lazy-test",
        validate: (value) =>
          typeof value === "string"
            ? { value }
            : { issues: [{ message: "Expected string" }] },
      },
    };
    const lazyModel = s.model({
      id: s.string().id(),
      touchedAt: s.dateTime().updatedAt().schema(custom),
    });
    const updateSpy = vi.spyOn(v, "shorthandUpdate");

    try {
      const field = createSchemaRegistry({ lazyModel }).proxy.lazyModel.scalars
        .touchedAt;
      expect(updateSpy).not.toHaveBeenCalled();

      expect(field.filter).toBeDefined();
      expect(updateSpy).not.toHaveBeenCalled();

      const update = field.update;
      expect(updateSpy).toHaveBeenCalledOnce();
      expect(field.update).toBe(update);
      expect(updateSpy).toHaveBeenCalledOnce();
    } finally {
      updateSpy.mockRestore();
    }
  });

  test("root, bulk, upsert and nested update placements share the rule", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    expect(
      parsed(schemas.project.args.update, {
        where: { id: "p1" },
        data: { title: "root" },
      })
    ).toMatchObject({ data: { touchedAt: { set: NOW } } });
    expect(
      parsed(schemas.project.args.updateMany, {
        where: {},
        data: { title: "bulk" },
      })
    ).toMatchObject({ data: { touchedAt: { set: NOW } } });
    expect(
      parsed(schemas.project.args.upsert, {
        where: { id: "p1" },
        create: { id: "p1", title: "create" },
        update: { title: "upsert" },
      })
    ).toMatchObject({ update: { touchedAt: { set: NOW } } });
    expect(
      parsed(schemas.project.args.update, {
        where: { id: "p1" },
        data: {
          tasks: {
            updateMany: { where: {}, data: { title: "nested" } },
          },
        },
      })
    ).toMatchObject({
      data: {
        tasks: {
          updateMany: [{ data: { touchedAt: { set: NOW } }, where: {} }],
        },
      },
    });
  });
});

describe("`.updatedAt()` field ownership", () => {
  const freshPair = async (order: "generated first" | "plain first") => {
    vi.resetModules();
    const [{ s: fresh }, { createSchemaRegistry: freshRegistry }] =
      await Promise.all([import("@schema"), import("@validation")]);
    const id = fresh.string().id();
    const model =
      order === "generated first"
        ? fresh.model({
            id,
            generated: fresh.dateTime().updatedAt(),
            plain: fresh.dateTime(),
          })
        : fresh.model({
            id,
            plain: fresh.dateTime(),
            generated: fresh.dateTime().updatedAt(),
          });
    return freshRegistry({ model }).proxy.model;
  };

  test.each([
    "generated first",
    "plain first",
  ] as const)("does not leak through the datetime interner when declared %s", async (order) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { core } = await freshPair(order);
    expect(parsed(core.update, {})).toEqual({
      generated: { set: NOW },
    });
  });
});

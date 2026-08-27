import {
  bigInt,
  blob,
  boolean,
  date,
  dateTime,
  decimal,
  enumScalar,
  int,
  json,
  number,
  point,
  string,
  time,
  vector,
} from "@schema/scalars";
import { isGeneratorDefault } from "@schema/scalars/common";
import { parse } from "@validation";
import v from "@validation/primitives/v";
import { describe, expect, it } from "vitest";

const nativeType = { db: "pg", type: "contract_type" } as const;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_TIME_PATTERN = /^\d{2}:\d{2}:\d{2}$/;
const USER_PREFIX_PATTERN = /^usr-/;

const MAP_CASES = [
  ["string", () => string(nativeType)],
  ["int", () => int(nativeType)],
  ["number", () => number(nativeType)],
  ["decimal", () => decimal(nativeType)],
  ["boolean", () => boolean(nativeType)],
  ["datetime", () => dateTime(nativeType)],
  ["date", () => date(nativeType)],
  ["time", () => time(nativeType)],
  ["bigint", () => bigInt(nativeType)],
  ["json", () => json(nativeType)],
  ["blob", () => blob(nativeType)],
  ["vector", () => vector(nativeType)],
  ["point", () => point(nativeType)],
  ["enum", () => enumScalar(["A", "B"], nativeType)],
] as const;

const ID_CASES = [
  ["string", () => string(), () => string().id()],
  ["int", () => int(), () => int().id()],
  ["number", () => number(), () => number().id()],
  ["decimal", () => decimal(), () => decimal().id()],
  ["datetime", () => dateTime(), () => dateTime().id()],
  ["date", () => date(), () => date().id()],
  ["time", () => time(), () => time().id()],
  ["bigint", () => bigInt(), () => bigInt().id()],
] as const;

const UNIQUE_CASES = [
  ["string", () => string(), () => string().unique()],
  ["int", () => int(), () => int().unique()],
  ["number", () => number(), () => number().unique()],
  ["decimal", () => decimal(), () => decimal().unique()],
  ["datetime", () => dateTime(), () => dateTime().unique()],
  ["date", () => date(), () => date().unique()],
  ["time", () => time(), () => time().unique()],
  ["bigint", () => bigInt(), () => bigInt().unique()],
] as const;

const SCHEMA_CASES = [
  [
    "string",
    () => {
      const before = string();
      const schema = v.string();
      return { before, after: before.schema(schema), schema, value: "value" };
    },
  ],
  [
    "int",
    () => {
      const before = int();
      const schema = v.integer();
      return { before, after: before.schema(schema), schema, value: 42 };
    },
  ],
  [
    "number",
    () => {
      const before = number();
      const schema = v.number();
      return { before, after: before.schema(schema), schema, value: 4.2 };
    },
  ],
  [
    "decimal",
    () => {
      const before = decimal();
      const schema = v.string();
      return { before, after: before.schema(schema), schema, value: "4.2" };
    },
  ],
  [
    "datetime",
    () => {
      const before = dateTime();
      const schema = v.string();
      return {
        before,
        after: before.schema(schema),
        schema,
        value: "2026-08-07T12:00:00.000Z",
      };
    },
  ],
  [
    "date",
    () => {
      const before = date();
      const schema = v.string();
      return {
        before,
        after: before.schema(schema),
        schema,
        value: "2026-08-07",
      };
    },
  ],
  [
    "time",
    () => {
      const before = time();
      const schema = v.string();
      return {
        before,
        after: before.schema(schema),
        schema,
        value: "12:00:00",
      };
    },
  ],
  [
    "bigint",
    () => {
      const before = bigInt();
      const schema = v.bigint();
      return { before, after: before.schema(schema), schema, value: 42n };
    },
  ],
  [
    "json",
    () => {
      const before = json();
      const schema = v.json();
      return {
        before,
        after: before.schema(schema),
        schema,
        value: { valid: true },
      };
    },
  ],
] as const;

describe("scalar modifier contracts", () => {
  it.each(
    MAP_CASES
  )("maps %s immutably and preserves its native type", (_name, create) => {
    const before = create();
    const after = before.map("stored_value");

    expect(after).not.toBe(before);
    expect(before["~"].state.columnName).toBeUndefined();
    expect(after["~"].state.columnName).toBe("stored_value");
    expect(after["~"].nativeType).toBe(nativeType);
  });

  it.each(
    ID_CASES
  )("marks %s IDs as unique without mutating the source", (_name, create, createId) => {
    const before = create();
    const after = createId();

    expect(before["~"].state.isId).toBe(false);
    expect(before["~"].state.isUnique).toBe(false);
    expect(after["~"].state.isId).toBe(true);
    expect(after["~"].state.isUnique).toBe(true);
  });

  it.each(
    UNIQUE_CASES
  )("marks %s unique without making it an ID", (_name, create, createUnique) => {
    const before = create();
    const after = createUnique();

    expect(before["~"].state.isUnique).toBe(false);
    expect(after["~"].state.isId).toBe(false);
    expect(after["~"].state.isUnique).toBe(true);
  });

  it.each(
    SCHEMA_CASES
  )("retains the custom %s schema in its rebuilt base", (_name, createCase) => {
    const { after, before, schema, value } = createCase();

    expect(before["~"].state.schema).toBeUndefined();
    expect(after["~"].state.schema).toBe(schema);
    expect(parse(after["~"].state.base, value).issues).toBeUndefined();
  });

  it.each([
    ["int", () => int().increment()],
    ["bigint", () => bigInt().increment()],
  ] as const)("configures portable %s increment generation", (_name, create) => {
    expect(create()["~"].state).toMatchObject({
      autoGenerate: { kind: "increment" },
      default: undefined,
      disallowZero: true,
      hasDefault: true,
      optional: true,
    });
  });

  it.each([
    ["datetime", () => dateTime().withoutTimezone()],
    ["time", () => time().withoutTimezone()],
  ] as const)("turns off timezone storage for %s", (_name, create) => {
    expect(create()["~"].state.withTimezone).toBe(false);
  });

  it.each([
    [
      "date",
      () => {
        const before = date();
        return { before, after: before.nullable() };
      },
    ],
    [
      "time",
      () => {
        const before = time();
        return { before, after: before.nullable() };
      },
    ],
  ] as const)("makes %s nullable without mutating its source", (_name, createCase) => {
    const { after, before } = createCase();

    expect(before["~"].state.nullable).toBe(false);
    expect(before["~"].state.hasDefault).toBe(false);
    expect(after["~"].state).toMatchObject({
      nullable: true,
      hasDefault: true,
      default: null,
      optional: true,
    });
    expect(parse(after["~"].state.base, null).issues).toBeUndefined();
  });

  it.each([
    [
      "date",
      () => {
        const before = date();
        return {
          before,
          after: before.array(),
          value: ["2026-08-07", "2026-08-08"],
        };
      },
    ],
    [
      "time",
      () => {
        const before = time();
        return {
          before,
          after: before.array(),
          value: ["12:00:00", "13:30:00"],
        };
      },
    ],
  ] as const)("makes %s arrays without mutating its source", (_name, createCase) => {
    const { after, before, value } = createCase();

    expect(before["~"].state.array).toBe(false);
    expect(after["~"].state.array).toBe(true);
    expect(parse(after["~"].state.base, value).issues).toBeUndefined();
  });

  it.each([
    [
      "date",
      () => {
        const before = date();
        return {
          before,
          after: before.default("2026-08-07"),
          value: "2026-08-07",
        };
      },
    ],
    [
      "time",
      () => {
        const before = time();
        return { before, after: before.default("12:00:00"), value: "12:00:00" };
      },
    ],
    [
      "number",
      () => {
        const before = number();
        return { before, after: before.default(4.2), value: 4.2 };
      },
    ],
    [
      "decimal",
      () => {
        const before = decimal();
        return { before, after: before.default("4.2"), value: "4.2" };
      },
    ],
  ] as const)("stores an explicit %s default without mutating its source", (_name, createCase) => {
    const { after, before, value } = createCase();

    expect(before["~"].state.hasDefault).toBe(false);
    expect(after["~"].state).toMatchObject({
      hasDefault: true,
      default: value,
      optional: true,
    });
  });

  it("stores a reusable database enum name", () => {
    const before = enumScalar(["PENDING", "ACTIVE"]);
    const after = before.name("status");

    expect("enumName" in before["~"].state).toBe(false);
    expect(after["~"].state.enumName).toBe("status");
  });
});

describe("temporal generated defaults", () => {
  const cases = [
    ["date", () => date().now(), () => date().updatedAt(), ISO_DATE_PATTERN],
    [
      "datetime",
      () => dateTime().now(),
      () => dateTime().updatedAt(),
      ISO_TIMESTAMP_PATTERN,
    ],
    ["time", () => time().now(), () => time().updatedAt(), ISO_TIME_PATTERN],
  ] as const;

  it.each(
    cases
  )("generates valid current values for %s", (_name, createNow, createUpdatedAt, pattern) => {
    for (const [create, autoGenerate] of [
      [createNow, "now"],
      [createUpdatedAt, "updatedAt"],
    ] as const) {
      const state = create()["~"].state;
      expect(state.autoGenerate).toEqual({ kind: autoGenerate });
      expect(state.hasDefault).toBe(true);
      expect(state.optional).toBe(true);
      const generate = state.default;
      expect(generate).toBeTypeOf("function");
      if (typeof generate !== "function") {
        throw new TypeError("Temporal generated default must be callable");
      }
      expect(generate()).toMatch(pattern);
    }
  });
});

describe("generator default identity", () => {
  it("distinguishes a generator's installed closure from a caller's own function default", () => {
    // The serializer relies on this to refuse a custom function default
    // beside a generator instead of silently emitting `generate` alone.
    const generated = string().uuid()["~"].state.default;
    expect(isGeneratorDefault(generated)).toBe(true);
    const overridden = string()
      .uuid()
      .default(() => "fixed")["~"].state.default;
    expect(isGeneratorDefault(overridden)).toBe(false);
    expect(isGeneratorDefault("not a function")).toBe(false);
  });
});

describe("string generated defaults", () => {
  const cases = [
    ["uuid", () => string().uuid(), () => string().uuid("usr")],
    ["ulid", () => string().ulid(), () => string().ulid("usr")],
    ["nanoid", () => string().nanoid(), () => string().nanoid(12, "usr")],
    ["cuid", () => string().cuid(), () => string().cuid("usr")],
  ] as const;

  it.each(
    cases
  )("generates prefixed and unprefixed %s values", (_name, createPlain, createPrefixed) => {
    for (const [create, prefix] of [
      [createPlain, undefined],
      [createPrefixed, "usr-"],
    ] as const) {
      const generate = create()["~"].state.default;
      expect(generate).toBeTypeOf("function");
      if (typeof generate !== "function") {
        throw new TypeError("String generated default must be callable");
      }
      const generated = generate();
      expect(generated).toBeTypeOf("string");
      if (prefix) expect(generated).toMatch(USER_PREFIX_PATTERN);
      else expect(generated).not.toMatch(USER_PREFIX_PATTERN);
    }
  });
});

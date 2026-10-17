import { actorContract } from "@src/permissions/actor";
import { v } from "@src/validation";
import { describe, expect, test, vi } from "vitest";

describe("actor binding completeness", () => {
  test("required objects, records, arrays and union members use native completeness", () => {
    const member = v.object({ id: v.string() });
    const schema = actorContract(
      v.object({
        userId: v.string(),
        profile: v.optional(member),
        records: v.record(v.string(), member),
        members: v.array(member),
        objectArray: v.object({ id: v.string() }, { array: true }),
        identity: v.union([
          v.object({ kind: v.literal("user"), userId: v.string() }),
          v.object({ kind: v.literal("service"), serviceId: v.string() }),
        ]),
      })
    ).schema;
    const valid = {
      userId: "u",
      records: { a: { id: "a" } },
      members: [{ id: "a" }],
      objectArray: [{ id: "a" }],
      identity: { kind: "user", userId: "u" },
    };
    const validate = schema["~standard"].validate;
    expect(validate(valid)).toHaveProperty("value");
    for (const patch of [
      { userId: undefined },
      { profile: {} },
      { records: { a: {} } },
      { members: [{}] },
      { objectArray: [{}] },
      { identity: { kind: "user" } },
    ])
      expect(validate({ ...valid, ...patch })).toHaveProperty("issues");
  });

  test("defaults, object transforms and pipe actions run once and schemas stay unchanged", () => {
    const fallback = vi.fn(() => "fallback");
    const transform = vi.fn((value: unknown) => value);
    const action = vi.fn((value: unknown) => value);
    const nested = v.object({ id: v.string() }, { transform });
    const original = v.object({
      id: v.optional(v.string(), fallback),
      nested: v.pipe(nested, v.transformAction(action)),
    });
    const schema = actorContract(original).schema;
    expect(schema["~standard"].validate({ nested: { id: "n" } })).toEqual({
      value: { id: "fallback", nested: { id: "n" } },
    });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(transform).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
    expect(original.options).toBeUndefined();
    expect(nested.options).not.toHaveProperty("partial");
  });
});

test("optional union and pipe members keep optional binding and dependency metadata", () => {
  const schema = actorContract(
    v.object({
      union: v.union([v.string(), v.optional(v.string())]),
      pipe: v.pipe(
        v.optional(v.string()),
        v.transformAction((value) => value)
      ),
      wrapped: v.nullable(v.optional(v.string())),
    })
  );
  expect(schema.schema["~standard"].validate({})).toHaveProperty("value");
  for (const path of ["union", "pipe", "wrapped"])
    expect(schema.availabilityPath(path)).toBe(path);
});

test("omitted actor keys are not policy paths and hidden recursion is refused", () => {
  const actor = actorContract(
    v.object({ id: v.string(), ignored: v.string() }, { omit: ["ignored"] })
  );
  expect(actor.hasPath("ignored")).toBe(false);
  const recursive = v.object({
    child: v.union([v.string(), v.optional(() => recursive)]),
  });
  expect(() => actorContract(recursive)).toThrow("actor schema is recursive");
});

test("nested nullable unions and transformed objects publish uncertain actor paths", () => {
  const schema = actorContract(
    v.object({
      nested: v.union([v.string(), v.union([v.literal(null), v.number()])]),
      profile: v.object({ id: v.string() }, { transform: (value) => value }),
    })
  );
  expect(schema.availabilityPath("nested")).toBe("nested");
  expect(schema.availabilityPath("profile.id")).toBe("profile.id");
});

test("required actor parsing preserves sparse callback inputs and outputs", () => {
  const transform = vi.fn((value: unknown) => value);
  const refuse = vi.fn(() => undefined);
  const schema = actorContract(
    v.object(
      { id: v.string(), optional: v.optional(v.string()) },
      { transform, refuse }
    )
  );
  expect(
    schema.schema["~standard"].validate({ id: "u", optional: undefined })
  ).toEqual({ value: { id: "u" } });
  expect(transform).toHaveBeenCalledExactlyOnceWith({ id: "u" });
  expect(refuse).toHaveBeenCalledExactlyOnceWith({ id: "u" });
  const plain = actorContract(
    v.object({ id: v.string(), optional: v.optional(v.string()) })
  );
  expect(plain.availabilityPath("id")).toBeUndefined();
  expect(plain.schema["~standard"].validate({ id: "u" })).toEqual({
    value: { id: "u" },
  });
});

test("JSON and custom scalar schemas expose possibly absent outputs", () => {
  const actor = actorContract(
    v.object({
      json: v.json(),
      custom: v.string({ schema: v.coerce(v.string(), () => null) }),
      union: v.union([
        v.number(),
        v.string({ schema: v.coerce(v.string(), () => null) }),
      ]),
    })
  );
  expect(actor.availabilityPath("json")).toBe("json");
  expect(actor.availabilityPath("custom")).toBe("custom");
  expect(actor.availabilityPath("union")).toBe("union");
});

test("actor callbacks share the owned parsed object and retain their mutations", async () => {
  let parsed: Record<string, unknown> | undefined;
  const refuse = vi.fn((value: Record<string, unknown>) => {
    expect(Object.hasOwn(value, "optional")).toBe(false);
    parsed = value;
    value.marker = "from refusal";
    value.optional = undefined;
    return undefined;
  });
  const transform = vi.fn((value: unknown) => {
    expect(value).toBe(parsed);
    expect(value).toEqual({
      id: "u",
      marker: "from refusal",
      optional: undefined,
    });
    return value;
  });
  const actor = actorContract(
    v.object(
      { id: v.string(), optional: v.optional(v.string()) },
      { refuse, transform }
    )
  );
  const input = Object.freeze({ id: "u" });
  const result = await actor.schema["~standard"].validate(input);
  expect(result).toEqual({ value: parsed });
  if ("value" in result) expect(result.value).toBe(parsed);
  expect(parsed).not.toBe(input);
  expect(input).toEqual({ id: "u" });
  expect(refuse).toHaveBeenCalledTimes(1);
  expect(transform).toHaveBeenCalledTimes(1);
});

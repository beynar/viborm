import { s } from "@schema";
import { actorContract } from "@src/permissions/actor";
import { v } from "@src/validation";
import { expect, test } from "vitest";
import { compilePolicy } from "./compiled-view";

test("JSON arrays are required containers even though individual JSON values may be null", () => {
  const actor = actorContract(
    v.object({ payload: v.json(), payloads: v.json({ array: true }) })
  );
  expect(
    actor.schema["~standard"].validate({ payload: null, payloads: [null] })
  ).toEqual({ value: { payload: null, payloads: [null] } });
  expect(
    actor.schema["~standard"].validate({ payload: null, payloads: null })
  ).toHaveProperty("issues");
});

test("explicit dense actor objects preserve undefined members at their transform boundary", () => {
  const inputs: unknown[] = [];
  const actor = actorContract(
    v.object(
      { id: v.string(), optional: v.optional(v.string()) },
      {
        partial: false,
        transform(value) {
          inputs.push(value);
          return value;
        },
      }
    )
  );
  expect(actor.schema["~standard"].validate({ id: "alice" })).toEqual({
    value: { id: "alice", optional: undefined },
  });
  expect(inputs).toEqual([{ id: "alice", optional: undefined }]);
  expect(inputs[0]).toHaveProperty("optional", undefined);
});

test("lazy actor members retain required nested fields", () => {
  const actor = actorContract(
    v.object({
      profile: v.lazyRef(() =>
        v.object({ id: v.string(), nickname: v.optional(v.string()) })
      ),
    })
  );
  expect(actor.hasPath("profile.id")).toBe(true);
  expect(actor.hasPath("profile.nickname")).toBe(true);
  expect(actor.schema["~standard"].validate({ profile: {} })).toHaveProperty(
    "issues"
  );
  expect(
    actor.schema["~standard"].validate({ profile: { id: "alice" } })
  ).toEqual({ value: { profile: { id: "alice" } } });
});

test("record entries take any key and unknown paths remain unknown", () => {
  const actor = actorContract(
    v.object({
      memberships: v.record(v.string(), v.object({ id: v.string() })),
    })
  );
  expect(actor.hasPath("memberships.team.id")).toBe(true);
  expect(actor.hasPath("unknown.id")).toBe(false);
  expect(actor.schema["~standard"].validate({ memberships: {} })).toEqual({
    value: { memberships: {} },
  });
});

const schema = {
  document: s.model({ id: s.string().id(), attributes: s.json() }),
};

test("an optional actor value is read as written: no guard is added, and a missing one closes the permission at the call", () => {
  const compiled = compilePolicy(
    {
      actor: v.object({ expected: v.optional(v.json()) }),
      models: {
        document: {
          read: { attributes: { not: { equals: { actor: "expected" } } } },
        },
      },
    },
    schema
  );
  const predicate = JSON.stringify(compiled.models.document!.predicates.read);
  expect(predicate).toContain(
    '"attributes":{"not":{"equals":{"control":"actor","path":"expected"}}}'
  );
  expect(predicate).not.toContain('"exists"');
});

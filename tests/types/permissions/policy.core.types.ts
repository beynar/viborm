/**
 * The declaration types of `viborm/permissions` (plan §1.1, §4.2 K2(e), §11.2 F8):
 * predicates are opaque data, never a model's `where` type; the names a
 * declaration spells are checked: actor paths against the actor schema's
 * output (structurally, with a visited set and no depth number), action names
 * in `operations`, `fields` and `actions` against the model's actions, and,
 * where the policy meets a schema, model and field names against it.
 */

import { type ActorPaths, permissions } from "@src/permissions";
import { v } from "@src/validation";
import { schema } from "@tests/package/fixtures/permissions-app/schema";
import { describe, expectTypeOf, test } from "vitest";
import { Actor, blog, policy, storedPolicy } from "./acceptance-policy";

describe("the acceptance policy", () => {
  test("compiles against the fixture's schema", () => {
    policy.compile(schema);
    storedPolicy.compile(schema);
    blog.compile(schema);
  });
});

describe("actor paths", () => {
  test("are the actor schema's output paths; a record's keys are any string", () => {
    type Paths = ActorPaths<{
      userId: string;
      session?: string;
      key?: { id: string; scopes: Record<string, string[]> };
    }>;
    expectTypeOf<"key.scopes.page">().toExtend<Paths>();
    expectTypeOf<"session">().toExtend<Paths>();
    expectTypeOf<"key.id">().toExtend<Paths>();
    expectTypeOf<"key.ide">().not.toExtend<Paths>();
  });

  test("end on a recursive type without a depth number", () => {
    interface Node {
      id: string;
      parent?: Node;
    }
    expectTypeOf<ActorPaths<Node>>().toEqualTypeOf<"id" | "parent">();
  });

  test("a structural subtype nested in a wider ancestor is still walked", () => {
    type Paths = ActorPaths<{
      userId: string;
      key?: { userId: string; id: string };
    }>;
    expectTypeOf<"key.id">().toExtend<Paths>();
  });

  test("global mandatory restrictions and control predicates check actor paths", () => {
    permissions({
      actor: Actor,
      mandatory: { $if: { control: "actor", path: "key", exists: false } },
      models: { page: { read: {} } },
    });
    // @ts-expect-error - literal mandatory restrictions use the actor schema's paths
    permissions({
      actor: Actor,
      mandatory: { ownerId: { actor: "usrId" } },
      models: { page: { read: {} } },
    });
    // @ts-expect-error - explicit control conditions also check the path
    permissions({
      actor: Actor,
      models: {
        page: {
          read: {
            AND: [
              { ownerId: { actor: "userId" } },
              { $if: { control: "actor", path: "kee", exists: false } },
            ],
          },
        },
      },
    });
  });

  test("an unspelled actor path is refused at permissions()", () => {
    // @ts-expect-error - "usrId" is not a path of the actor schema
    permissions({
      actor: Actor,
      models: { page: { read: { ownerId: { actor: "usrId" } } } },
    });
    // @ts-expect-error - a condition on an undeclared path
    permissions({
      actor: Actor,
      models: { organization: { export: { actor: { netwrk: "office" } } } },
    });
  });

  test("a tenant names a path of the actor schema", () => {
    permissions({
      actor: Actor,
      tenant: { field: "organizationId", actor: "organizationId" },
      models: { page: { read: {} } },
    });
    // @ts-expect-error - "orgId" is not a path of the actor schema
    permissions({
      actor: Actor,
      tenant: { field: "organizationId", actor: "orgId" },
      models: { page: { read: {} } },
    });
  });
});

describe("action names", () => {
  test("mandatory is a restriction and the retired within key is rejected", () => {
    permissions({
      actor: Actor,
      models: {
        page: { mandatory: { ownerId: { actor: "userId" } }, read: {} },
      },
    });
    // @ts-expect-error - within must never become an action granting read
    permissions({
      actor: Actor,
      models: { page: { within: { ownerId: { actor: "userId" } }, read: {} } },
    });
  });

  test("retired arms cannot be a model key or an explicit action", () => {
    // @ts-expect-error - a held config cannot retain the former grant property
    permissions({ actor: Actor, models: { page: { arms: {}, read: {} } } });
    const stale = { actor: Actor, models: { page: { arms: [{}], read: {} } } };
    // @ts-expect-error - old arrays are refused even in non-fresh declarations
    permissions(stale);
    // @ts-expect-error - an explicit graph cannot reintroduce the retired key
    permissions({
      actor: Actor,
      models: { page: { actions: { read: [], arms: ["read"] }, read: {} } },
    });
  });

  test("groups name individual actions and reject ambiguous bindings", () => {
    permissions({
      actor: Actor,
      models: {
        page: {
          actions: { read: [], update: [], export: [] },
          " read ,\tupdate, export ": { ownerId: { actor: "userId" } },
          operations: { update: "update" },
          fields: { title: { read: "read" } },
        },
      },
    });
    // @ts-expect-error - explicit graphs check every group member
    permissions({
      actor: Actor,
      models: { page: { actions: { read: [], update: [] }, "read, edti": {} } },
    });
    // @ts-expect-error - empty members are not permissions
    permissions({ actor: Actor, models: { page: { "read, ": {} } } });
    // @ts-expect-error - duplicate members are likely a mistake
    permissions({ actor: Actor, models: { page: { "read, read": {} } } });
    // @ts-expect-error - overlapping bindings cannot silently replace each other
    permissions({
      actor: Actor,
      models: { page: { "read, update": {}, update: {} } },
    });
    // @ts-expect-error - overlapping groups are also ambiguous
    permissions({
      actor: Actor,
      models: { page: { "read, update": {}, "update, full": {} } },
    });
    // @ts-expect-error - restrictions cannot be mixed into grants
    permissions({ actor: Actor, models: { page: { "read, mandatory": {} } } });
    // @ts-expect-error - retired names cannot be hidden in a group
    permissions({ actor: Actor, models: { page: { "read, arms": {} } } });
    // @ts-expect-error - graph nodes are individual names, not groups
    permissions({
      actor: Actor,
      models: { page: { actions: { read: [], "update, full": [] } } },
    });
    // @ts-expect-error - graph edges name one action
    permissions({
      actor: Actor,
      models: { page: { actions: { read: [], update: ["read, update"] } } },
    });
  });

  test("operations and fields name the model's actions", () => {
    // @ts-expect-error - `remove` is not an action of page
    permissions({
      actor: Actor,
      models: { page: { read: {}, operations: { delete: "remove" } } },
    });
    // @ts-expect-error - `full` is not an action of a model with its own actions
    permissions({
      actor: Actor,
      models: {
        document: {
          actions: { read: [] },
          fields: { ownerId: { write: "full" } },
        },
      },
    });
    // @ts-expect-error - an action implies one the model does not declare
    permissions({
      actor: Actor,
      models: { document: { actions: { read: [], update: ["veiw"] } } },
    });
  });

  test("the retired global levels are refused: each model declares its graph", () => {
    permissions({
      actor: Actor,
      models: {
        page: {
          actions: { read: [], update: ["read"], full: ["update"] },
          read: {},
          full: {},
        },
      },
    });
    // @ts-expect-error - levels was removed, beside the policy's real keys
    permissions({
      actor: Actor,
      levels: ["read", "update", "full"],
      models: { page: { read: {} } },
    });
    const leveled = {
      actor: Actor,
      levels: ["read", "update", "full"],
      models: { page: { read: {} } },
    };
    // @ts-expect-error - held in a variable, levels is still refused
    permissions(leveled);
  });

  test("without a graph a model's actions are create, read, update and delete", () => {
    permissions({
      actor: Actor,
      models: {
        page: {
          actions: { read: [], publish: ["read"] },
          read: {},
          publish: {},
        },
      },
    });
    // @ts-expect-error - a custom action outside a graph was removed
    permissions({ actor: Actor, models: { page: { read: {}, publish: {} } } });
    // @ts-expect-error - a misspelt action beside a real one
    permissions({ actor: Actor, models: { page: { read: {}, raed: {} } } });
    // @ts-expect-error - a misspelt member of a group
    permissions({ actor: Actor, models: { page: { "read, updaet": {} } } });
    const misspelt = { actor: Actor, models: { page: { read: {}, raed: {} } } };
    // @ts-expect-error - held in a variable, the misspelt action is still refused
    permissions(misspelt);
    // @ts-expect-error - an operation names an action without a graph only if it is CRUD
    permissions({
      actor: Actor,
      models: { page: { read: {}, operations: { delete: "full" } } },
    });
  });

  test("a rule key names an action: the blog's `delete`", () => {
    permissions({
      actor: v.object({ userId: v.string() }),
      models: {
        page: {
          read: {},
          delete: { ownerId: { actor: "userId" } },
          operations: { delete: "delete" },
        },
      },
    });
  });
});

describe("schema names", () => {
  test("models and fields are the schema's", () => {
    const misspelt = permissions({
      actor: Actor,
      models: { pages: { read: {} } },
    });
    // @ts-expect-error - the schema has no model `pages`
    misspelt.compile(schema);
    const field = permissions({
      actor: Actor,
      models: {
        collection: { read: {}, fields: { budjet: { read: "read" } } },
      },
    });
    // @ts-expect-error - collection has no field `budjet`
    field.compile(schema);
    const create = permissions({
      actor: Actor,
      models: { page: { read: {}, create: { titel: "x" } } },
    });
    // @ts-expect-error - a create names a field page does not have
    create.compile(schema);
  });
});

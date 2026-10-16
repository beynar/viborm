/**
 * The declaration types of `viborm/rbac` (plan §1.1, §4.2 K2(e), §11.2 F8):
 * predicates are opaque data, never a model's `where` type; the names a
 * declaration spells are checked: actor paths against the actor schema's
 * output (structurally, with a visited set and no depth number), action names
 * in `operations`, `fields` and `actions` against the model's actions, and,
 * where the policy meets a schema, model and field names against it.
 */

import { type ActorPaths, rbac } from "@src/rbac";
import { v } from "@src/validation";
import { schema } from "@tests/package/fixtures/rbac-app/schema";
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

  test("explicit limits and control predicates check actor paths", () => {
    rbac({
      actor: Actor,
      limit: { $if: { control: "actor", path: "key", exists: false } },
      models: { page: { view: {} } },
    });
    // @ts-expect-error - literal limits use the actor schema's paths
    rbac({
      actor: Actor,
      limit: { ownerId: { actor: "usrId" } },
      models: { page: { view: {} } },
    });
    // @ts-expect-error - explicit control conditions also check the path
    rbac({
      actor: Actor,
      models: {
        page: {
          view: {
            AND: [
              { ownerId: { actor: "userId" } },
              { $if: { control: "actor", path: "kee", exists: false } },
            ],
          },
        },
      },
    });
  });

  test("an unspelled actor path is refused at rbac()", () => {
    // @ts-expect-error - "usrId" is not a path of the actor schema
    rbac({
      actor: Actor,
      models: { page: { view: { ownerId: { actor: "usrId" } } } },
    });
    // @ts-expect-error - a condition on an undeclared path
    rbac({
      actor: Actor,
      models: { organization: { export: { actor: { netwrk: "office" } } } },
    });
  });
});

describe("action names", () => {
  test("operations and fields name the model's actions", () => {
    // @ts-expect-error - `remove` is not an action of page
    rbac({
      actor: Actor,
      levels: ["view", "edit", "full"],
      models: { page: { view: {}, operations: { delete: "remove" } } },
    });
    // @ts-expect-error - `full` is not an action of a model with its own actions
    rbac({
      actor: Actor,
      models: {
        document: {
          actions: { view: [] },
          fields: { ownerId: { write: "full" } },
        },
      },
    });
    // @ts-expect-error - an action implies one the model does not declare
    rbac({
      actor: Actor,
      models: { document: { actions: { view: [], edit: ["veiw"] } } },
    });
  });

  test("a rule key names an action: the blog's `delete`", () => {
    rbac({
      actor: v.object({ userId: v.string() }),
      models: {
        page: {
          view: {},
          delete: { ownerId: { actor: "userId" } },
          operations: { delete: "delete" },
        },
      },
    });
  });
});

describe("schema names", () => {
  test("models and fields are the schema's", () => {
    const misspelt = rbac({ actor: Actor, models: { pages: { view: {} } } });
    // @ts-expect-error - the schema has no model `pages`
    misspelt.compile(schema);
    const field = rbac({
      actor: Actor,
      models: {
        collection: { view: {}, fields: { budjet: { read: "view" } } },
      },
    });
    // @ts-expect-error - collection has no field `budjet`
    field.compile(schema);
    const create = rbac({
      actor: Actor,
      models: { page: { view: {}, create: { titel: "x" } } },
    });
    // @ts-expect-error - a create names a field page does not have
    create.compile(schema);
  });
});

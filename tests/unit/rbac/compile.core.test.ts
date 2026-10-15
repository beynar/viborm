/**
 * The compiler of `viborm/rbac` (plan §3.2 R1, R6, R9; §3.3 D2, D3, D7, D9,
 * D10; §4.2 K2(e); §4.3 K3): a declaration and the schema it governs in,
 * plain data out. No engine: these read the compiled data itself. Its rows
 * on a database are `tests/contracts/public-client/rbac-compiled-policy-behavior.ts`'s.
 */

import { ClientInitializationError } from "@errors";
import {
  type CompiledModel,
  everyone,
  grant,
  keyLimit,
  member,
  owner,
  type RbacConfig,
  type Rule,
  rbac,
  role,
  team,
  up,
} from "@src/rbac";
import { compilePolicy } from "@src/rbac/compile";
import { v } from "@src/validation";
import { schema } from "@tests/package/fixtures/rbac-app/schema";
import {
  Actor,
  blog,
  policy,
  storedPolicy,
} from "@tests/types/rbac/acceptance-policy";
import { describe, expect, test } from "vitest";

const me = { control: "actor", path: "userId" };
const NOWHERE = { OR: [] };
const compile = (config: Omit<RbacConfig, "actor"> & { actor?: object }) =>
  compilePolicy({ actor: Actor, ...config } as RbacConfig, schema);
/** The message of the `ClientInitializationError` `run` throws, or what it did instead. */
const refusalOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof ClientInitializationError
      ? error.message
      : `not a ClientInitializationError: ${String(error)}`;
  }
  return "no refusal";
};
const LEVELS = ["view", "edit", "full"] as const;

describe("the acceptance policy (§1.1)", () => {
  const compiled = policy.compile(schema);

  test("compiles to the same plain data every time", () => {
    expect(JSON.stringify(policy.compile(schema))).toBe(
      JSON.stringify(compiled)
    );
    expect(JSON.parse(JSON.stringify(compiled))).toEqual(compiled);
  });

  test("names every model of the schema; an unlisted one holds nothing (R9)", () => {
    expect(Object.keys(compiled.models)).toEqual(Object.keys(schema));
    for (const unlisted of ["session", "apiKey", "rolePermission"])
      expect(compiled.models[unlisted]).toEqual({
        predicates: {},
        writes: {},
        reads: {},
        modes: {},
      });
  });

  test("its verbs, written and read fields, modes and placement", () => {
    const uses = Object.fromEntries(
      Object.entries(compiled.models).map(([name, { predicates, ...rest }]) => [
        name,
        { ...rest, predicates: Object.keys(predicates) },
      ])
    );
    expect(uses).toMatchSnapshot();
  });

  test("its predicates for the identity models, as data", () => {
    const { organization, member, user } = compiled.models;
    expect({ organization, member, user }).toMatchSnapshot();
  });

  test("the blog compiles whole", () => {
    expect(blog.compile(schema)).toMatchSnapshot();
  });

  test("the stored-role variant differs only in the ceiling", () => {
    const stored = storedPolicy.compile(schema);
    expect(stored.models.organization).toEqual(compiled.models.organization);
    expect(stored.models.member!.predicates.view).not.toEqual(
      compiled.models.member!.predicates.view
    );
    expect(JSON.stringify(stored.models.member!.predicates.view)).toContain(
      '"permissions":{"some":{"role":"reader","action":"view"}}'
    );
  });
});

describe("R1: P(M, a) = within(a) ∧ limit(a) ∧ (⋁ rule(b ⊒ a) ∨ ⋁ arms(a))", () => {
  test("a rule written at an action that implies a holds at a", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: { page: { view: { title: "v" }, full: { title: "f" } } },
    }).models.page!;
    expect(predicates.view).toEqual({ OR: [{ title: "v" }, { title: "f" }] });
    expect(predicates.edit).toEqual({ title: "f" });
    expect(predicates.full).toEqual({ title: "f" });
  });

  test("each function is evaluated once per declared action, at that action and its model", () => {
    const calls: string[] = [];
    const arm = (action: string, model: { name: string }) => {
      calls.push(`${model.name}.${action}`);
      return { title: action };
    };
    const { predicates } = compile({
      levels: LEVELS,
      models: { page: { arms: [arm] } },
    }).models.page!;
    expect(calls).toEqual(["page.view", "page.edit", "page.full"]);
    expect(predicates.edit).toEqual({ title: "edit" });
  });

  test("within and the limit are conjoined with every action", () => {
    const { predicates } = compile({
      levels: LEVELS,
      limit: (action) => ({ icon: action }),
      models: { page: { within: { color: "c" }, edit: { title: "e" } } },
    }).models.page!;
    expect(predicates.view).toEqual({
      AND: [{ color: "c" }, { icon: "view" }, { title: "e" }],
    });
  });

  test("an action with no rule and no arm is false, and so is one a rule folds false", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: {
        page: { view: {}, edit: { group: "full" } },
        pageGroup: { view: {} },
      },
    }).models.page!;
    expect(predicates.view).toEqual({});
    expect(predicates.full).toEqual(NOWHERE);
    expect(predicates.edit).toEqual(NOWHERE);
  });

  test("a rule key that is no action of the model names one implying view (D3)", () => {
    const { predicates, modes } = compile({
      levels: LEVELS,
      models: { team: { view: { name: "v" }, invite: { name: "i" } } },
    }).models.team!;
    expect(Object.keys(modes)).toEqual(["view", "edit", "full", "invite"]);
    expect(predicates.view).toEqual({ OR: [{ name: "v" }, { name: "i" }] });
    expect(predicates.edit).toEqual(NOWHERE);
  });

  test("a model's own actions replace the levels, implied transitively", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: {
        document: {
          actions: { view: [], comment: ["view"], edit: ["comment"] },
          edit: { title: "e" },
        },
      },
    }).models.document!;
    expect(Object.keys(predicates)).toEqual(["view", "comment", "edit"]);
    expect(predicates.view).toEqual({ title: "e" });
  });

  test("logical and relation filters fold what compiles false, and keep the rest as written", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: {
        page: {
          view: {
            NOT: { group: "full" },
            title: "t",
            group: { label: "x" },
            owner: { isNot: { OR: [] } },
          },
          edit: { NOT: {}, title: "never" },
          full: { group: null },
        },
        pageGroup: { view: {} },
      },
    }).models.page!;
    expect(predicates.view).toEqual({
      OR: [{ title: "t", group: { label: "x" } }, { group: null }],
    });
    expect(predicates.edit).toEqual({ group: null });
  });

  test("a rule that is neither a where nor a function is refused", () => {
    expect(
      refusalOf(() =>
        compile({ levels: LEVELS, models: { page: { view: true as never } } })
      )
    ).toContain(
      "models.page.view: a rule is a where object or a function of the action"
    );
  });

  test("a domain and a placement that fold false match nothing", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: {
        page: {
          view: {},
          domains: { none: { group: "full" } },
          create: { group: "full" },
        },
        pageGroup: { view: {} },
      },
    }).models.page!;
    expect(predicates.none).toEqual(NOWHERE);
    expect(predicates.create).toEqual(NOWHERE);
  });

  test("a quantifier over a false body folds: `every` holds only where nothing is related", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: {
        pageGroup: { view: { pages: { every: { group: "full" } } } },
        page: {},
      },
    }).models.pageGroup!;
    expect(predicates.view).toEqual({ pages: { none: {} } });
  });

  test("a relation whose value is an action is the target's predicate at it, inlined (D7)", () => {
    const compiled = compile({
      levels: LEVELS,
      models: {
        page: { view: { group: "edit" } },
        pageGroup: { edit: { label: "x" } },
      },
    });
    expect(compiled.models.page!.predicates.view).toEqual({
      group: { is: compiled.models.pageGroup!.predicates.edit },
    });
  });
});

describe("the actor's facts (K2, R6)", () => {
  test("{ actor: path } in a value position is the actor's field", () => {
    const { predicates } = compile({
      models: {
        page: { view: { ownerId: { actor: "userId" }, title: { in: ["a"] } } },
      },
    }).models.page!;
    expect(predicates.view).toEqual({ ownerId: me, title: { in: ["a"] } });
  });

  test("{ actor: { path: value } } in a filter is a condition; null is absence", () => {
    const { predicates } = compile({
      models: {
        organization: {
          view: { plan: "pro", actor: { network: "office", session: null } },
        },
      },
    }).models.organization!;
    expect(predicates.view).toEqual({
      AND: [
        { plan: "pro" },
        { $if: { control: "actor", path: "network", equals: "office" } },
        { $if: { control: "actor", path: "session", exists: false } },
      ],
    });
  });

  test("W-D10: a path the actor schema does not declare is refused, wherever it is spelled", () => {
    expect(
      refusalOf(() =>
        compile({
          models: { page: { view: { ownerId: { actor: "usrId" } } } },
        })
      )
    ).toContain('models.page.view reads actor path "usrId"');
    expect(
      refusalOf(() =>
        compile({
          models: { page: { view: { actor: { key: { idd: "k" } } } } },
        })
      )
    ).toContain('reads actor path "key.idd"');
    expect(
      refusalOf(() =>
        compile({
          models: {
            page: {
              view: { $if: { control: "actor", path: "nope", exists: true } },
            },
          },
        })
      )
    ).toContain('reads actor path "nope"');
    expect(
      refusalOf(() =>
        compile({
          limit: keyLimit({ when: "credential", scopes: "key.scopes" }),
          models: { page: { view: {} } },
        })
      )
    ).toContain('limit reads actor path "credential"');
    // A record's keys are any key: a key's scopes per model.
    expect(() =>
      compile({
        limit: keyLimit({ when: "key", scopes: "key.scopes" }),
        models: { page: { view: {} } },
      })
    ).not.toThrow();
  });

  test("a condition on a list, or on a value that is not an object of facts, is refused", () => {
    expect(
      refusalOf(() =>
        compile({ models: { page: { view: { actor: { network: ["a"] } } } } })
      )
    ).toContain('tests actor path "network" against a list');
    expect(
      refusalOf(() =>
        compile({ models: { page: { view: { actor: "userId" } } } })
      )
    ).toContain("not an object of its facts");
  });

  test("the actor schema must be a walkable object schema with finite paths", () => {
    expect(refusalOf(() => rbac({ actor: v.string(), models: {} }))).toContain(
      "object schema"
    );
    expect(
      refusalOf(() =>
        rbac({
          actor: v.object({
            a: v.object({ b: v.string() }, { strict: false }),
          }),
          models: {},
        })
      )
    ).toContain('admits unknown keys at "a"');
    const node: object = v.object({
      id: v.string(),
      parent: v.optional(() => node as never),
    });
    expect(
      refusalOf(() => rbac({ actor: v.object({ node }), models: {} }))
    ).toContain('recursive at "node.parent"');
  });
});

describe("verbs, fields, modes and placement (K3, OD-3, R4)", () => {
  test("operations default to view, edit and the top level when the actions are exactly the levels", () => {
    const { models } = compile({
      levels: LEVELS,
      models: {
        page: { view: {} },
        team: { view: {}, invite: {} },
        member: { view: {}, operations: { delete: "edit" } },
      },
    });
    const verbs = ({ read, update, delete: remove }: CompiledModel) => ({
      read,
      update,
      delete: remove,
    });
    expect(verbs(models.page!)).toEqual({
      read: "view",
      update: "edit",
      delete: "full",
    });
    // `invite` makes team's actions more than the levels: nothing deletes it.
    expect(verbs(models.team!)).toEqual({
      read: "view",
      update: "edit",
      delete: undefined,
    });
    expect(verbs(models.member!)).toEqual({
      read: "view",
      update: "edit",
      delete: "edit",
    });
  });

  test("written and read fields name their actions; modes are the actions and domains", () => {
    const { models } = compile({
      levels: LEVELS,
      models: {
        collection: {
          view: {},
          fields: {
            budget: { read: "full", write: "edit" },
            owner: { write: "full" },
          },
          domains: { mine: owner("ownerId") },
        },
      },
    });
    const collection = models.collection!;
    expect(collection.writes).toEqual({ budget: "edit", owner: "full" });
    expect(collection.reads).toEqual({ budget: "full" });
    expect(collection.modes).toEqual({
      view: "view",
      edit: "edit",
      full: "full",
      mine: "mine",
    });
    expect(collection.predicates.mine).toEqual({ ownerId: me });
  });

  test("placement is within, the limit and create at the create action", () => {
    const { models } = compile({
      levels: LEVELS,
      limit: (action) => ({ icon: action }),
      models: {
        page: {
          within: (action) => ({ color: action }),
          view: {},
          create: { ownerId: { actor: "userId" } },
          operations: { create: "full" },
        },
      },
    });
    expect(models.page!.place).toBe("create");
    expect(models.page!.predicates.create).toEqual({
      AND: [{ color: "full" }, { icon: "full" }, { ownerId: me }],
    });
  });

  test("declaration errors are refused, naming where", () => {
    expect(refusalOf(() => compile({ models: { pages: {} } }))).toContain(
      "models.pages: the schema has no such model"
    );
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { fields: { titel: { write: "edit" } } } },
        })
      )
    ).toContain("models.page.fields.titel: page has no such field");
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { fields: { title: { write: "admin" } } } },
        })
      )
    ).toContain('models.page.fields.title.write names "admin"');
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { operations: { delete: "remove" } } },
        })
      )
    ).toContain('models.page.operations.delete names "remove"');
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { operations: { erase: "full" } as never } },
        })
      )
    ).toContain("models.page.operations.erase: not an operation");
    expect(
      refusalOf(() =>
        compile({
          models: { document: { actions: { view: [], edit: ["veiw"] } } },
        })
      )
    ).toContain('models.document.actions.edit implies "veiw"');
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { fields: { groupId: { read: "full" } } } },
        })
      )
    ).toContain("a key or relation cannot be read-gated");
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { domains: { edit: {} } } },
        })
      )
    ).toContain(
      "models.page.domains.edit: an action or placement has that name"
    );
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { view: { group: "veiw" } }, pageGroup: {} },
        })
      )
    ).toContain(
      'models.page.view reads group at "veiw", which pageGroup does not declare'
    );
  });

  test("an action may not take a declaration key's name", () => {
    expect(
      refusalOf(() =>
        compile({
          models: { document: { actions: { view: [], create: ["view"] } } },
        })
      )
    ).toContain(
      'models.document: "create" is a key of the declaration, not an action'
    );
  });

  test("a predicate that reads itself through its relations is refused", () => {
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { document: { view: { parent: "view" } } },
        })
      )
    ).toContain(
      "models.document.view reads itself: document.view → document.view"
    );
  });
});

describe("the helpers (D2)", () => {
  const at = (rule: Rule, model = "page", action = "view") =>
    compile({ levels: LEVELS, models: { [model]: { [action]: rule } } }).models[
      model
    ]!.predicates[action];

  test("owner, everyone and up", () => {
    expect(at(owner("ownerId"))).toEqual({ ownerId: me });
    expect(at(everyone(), "accessGrant")).toEqual({ everyone: true });
    expect(at(up("parent", owner("ownerId")), "document")).toEqual({
      parent: { recurse: { depth: false }, self: true, some: { ownerId: me } },
    });
  });

  test("member: the via relation, the ceiling at each action, the owner's own members", () => {
    const capped = member({
      via: "organization",
      ceiling: { reader: "view", admin: "full" },
    });
    const { predicates } = compile({
      levels: LEVELS,
      models: { page: { arms: [capped] } },
    }).models.page!;
    expect(predicates.view).toEqual({
      organization: {
        is: {
          members: { some: { userId: me, role: { in: ["reader", "admin"] } } },
        },
      },
    });
    expect(predicates.edit).toEqual({
      organization: {
        is: { members: { some: { userId: me, role: { in: ["admin"] } } } },
      },
    });
    expect(
      at(member({ via: "organization", roles: ["admin"] }), "organization")
    ).toEqual({
      members: { some: { userId: me, role: { in: ["admin"] } } },
    });
    expect(
      at(
        member({ via: "organization", ceiling: { reader: "view" } }),
        "page",
        "edit"
      )
    ).toEqual(NOWHERE);
    expect(refusalOf(() => at(member({ via: "organisation" })))).toContain(
      'member({ via: "organisation" }) on page'
    );
    expect(
      refusalOf(() =>
        at(
          member({
            via: "organization",
            ceiling: { relation: "permissions", action: "action" },
          })
        )
      )
    ).toContain("a stored ceiling enumerates its roles");
  });

  test("team, role and grant.to", () => {
    expect(
      at(
        team("granteeTeam", { below: "children", memberOf: "members" }),
        "accessGrant"
      )
    ).toEqual({
      granteeTeam: {
        is: {
          children: {
            recurse: { depth: false },
            self: true,
            some: { members: { some: { userId: me } } },
          },
        },
      },
    });
    expect(
      at(role("granteeRole", { via: "organization" }), "accessGrant")
    ).toEqual({
      OR: ["admin", "member", "reader"].map((name) => ({
        granteeRole: name,
        organization: { is: { members: { some: { userId: me, role: name } } } },
      })),
    });
    expect(
      refusalOf(() => at(role("role", { via: "organization" }), "member"))
    ).toContain('role("role") on member: the field is not an enum');
    const given = grant.to([everyone()], {
      relation: "grants",
      level: "level",
      actions: "actions",
    });
    expect(at(given, "page", "edit")).toEqual({
      grants: {
        some: {
          AND: [
            {
              OR: [
                { level: { in: ["edit", "full"] } },
                { actions: { hasSome: ["edit", "full"] } },
              ],
            },
            { everyone: true },
          ],
        },
      },
    });
  });

  test("grant.administer: one thing at least, each attached one administered; placement bounds the contents", () => {
    const grants = grant.administer(
      { page: "full" },
      { level: "level", actions: "actions" }
    );
    const compiled = compile({
      levels: LEVELS,
      models: {
        accessGrant: { edit: grants.admin, create: grants.place },
        page: { full: { title: "t" } },
      },
    });
    const full = compiled.models.page!.predicates.full;
    const { predicates } = compiled.models.accessGrant!;
    const admin = {
      AND: [
        { pageId: { not: null } },
        { OR: [{ pageId: null }, { page: { is: full } }] },
      ],
    };
    expect(predicates.edit).toEqual(admin);
    const held = (name: string) => compiled.models.page!.predicates[name];
    expect(predicates.create).toEqual({
      AND: [
        ...admin.AND,
        ...LEVELS.map((name) => ({
          OR: [
            { pageId: null },
            { NOT: { actions: { has: name } } },
            { page: { is: held(name) } },
          ],
        })),
        ...LEVELS.map((name) => ({
          OR: [
            { pageId: null },
            { level: null },
            { level: { not: name } },
            { page: { is: held(name) } },
          ],
        })),
      ],
    });
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: {
            accessGrant: {
              edit: grant.administer({ grants: "full" }, {}).admin,
            },
          },
        })
      )
    ).toContain('"grants" is not a to-one relation with a single-field key');
  });

  test("grant.administer without stored actions bounds the level only; keyLimit ids without a tree", () => {
    const { models } = compile({
      levels: LEVELS,
      limit: keyLimit({
        when: "key",
        scopes: "key.scopes",
        ids: { page: { path: "key.resources.document" } },
      }),
      models: {
        accessGrant: {
          create: grant.administer({ page: "full" }, { level: "level" }).place,
        },
        page: { full: {} },
      },
    });
    expect(JSON.stringify(models.accessGrant!.predicates.create)).not.toContain(
      '"has"'
    );
    expect(JSON.stringify(models.page!.predicates.view)).toContain(
      '{"id":{"in":{"control":"actor","path":"key.resources.document"}}}'
    );
  });

  test("keyLimit: unlimited without a key; the scopes meet ↑a; ids through the tree", () => {
    const { predicates } = compile({
      levels: LEVELS,
      limit: keyLimit({
        when: "key",
        scopes: "key.scopes",
        ids: {
          document: { path: "key.resources.document", through: "parent" },
        },
      }),
      models: {
        document: { actions: { view: [], share: ["view"] }, view: {} },
      },
    }).models.document!;
    const ids = { control: "actor", path: "key.resources.document" };
    expect(predicates.share).toEqual(NOWHERE);
    expect(predicates.view).toEqual({
      OR: [
        { $if: { control: "actor", path: "key", exists: false } },
        {
          AND: [
            {
              $if: {
                control: "actor",
                path: "key.scopes.document",
                hasSome: ["view", "share"],
              },
            },
            {
              OR: [
                { $if: { ...ids, equals: "all" } },
                {
                  parent: {
                    recurse: { depth: false },
                    self: true,
                    some: { id: { in: ids } },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  });
});

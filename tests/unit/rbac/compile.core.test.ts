/**
 * The compiler of `viborm/rbac` (plan §3.2 R1, R6, R9; §3.3 D2, D3, D7, D9,
 * D10; §4.2 K2(e); §4.3 K3): a declaration and the schema it governs in,
 * plain data out. No engine: these read the compiled data itself. Its rows
 * on a database are `tests/contracts/public-client/rbac-compiled-policy-behavior.ts`'s.
 */

import { ClientInitializationError } from "@errors";
import {
  type CompiledModel,
  type RbacConfig,
  type Rule,
  rbac,
} from "@src/rbac";
import { compilePolicy } from "@src/rbac/compile";
import { v } from "@src/validation";
import { schema } from "@tests/package/fixtures/rbac-app/schema";
import {
  Actor,
  blog,
  liveCredential,
  policy,
  storedPolicy,
  tokenRestrictions,
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
        predicates: { create: NOWHERE },
        writes: {},
        reads: {},
        modes: {},
        place: "create",
        moves: {},
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
      '"permissions":{"some":{"role":"reader","action":{"in":["view","edit","full"]}}}'
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

  test("a callback distinguishes an unlisted related model from a missing relation", () => {
    compile({
      models: {
        page: {
          view: (_action, model) => {
            const owner = model.related("owner");
            expect(owner?.name).toBe("user");
            expect(owner?.actions).toEqual([]);
            expect(owner?.leveled).toBe(false);
            expect(model.related("unknownRelation")).toBeUndefined();
            return {};
          },
        },
      },
    });
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
    expect(
      Object.keys(predicates).filter(
        (name) => name !== "create" && !name.startsWith("move:")
      )
    ).toEqual(["view", "comment", "edit"]);
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

  test("some and is with an impossible body match no rows", () => {
    const { models } = compile({
      models: {
        page: { view: { owner: { is: { OR: [] } } } },
        pageGroup: { view: { pages: { some: { OR: [] } } } },
      },
    });
    expect(models.page!.predicates.view).toEqual(NOWHERE);
    expect(models.pageGroup!.predicates.view).toEqual(NOWHERE);
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

  test.each([
    { every: { OR: [] }, none: { id: "blocked" } },
    { none: { id: "blocked" }, every: { OR: [] } },
  ])("a false every keeps its empty-relation requirement beside none: %j", (pages) => {
    const { predicates } = compile({
      levels: LEVELS,
      models: { pageGroup: { view: { pages } }, page: { view: {} } },
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

  test("explicit actor parameters retain their path and reject misspellings", () => {
    expect(
      compile({ models: { page: { view: { ownerId: me } } } }).models.page!
        .predicates.view
    ).toEqual({ ownerId: me });
    expect(
      refusalOf(() =>
        compile({
          models: {
            page: { view: { ownerId: { control: "actor", path: "usrId" } } },
          },
        })
      )
    ).toContain('reads actor path "usrId"');
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
          limit: {
            $if: { control: "actor", path: "credential", exists: false },
          },
          models: { page: { view: {} } },
        })
      )
    ).toContain('limit reads actor path "credential"');
    // A record's keys are any key: a key's scopes per model.
    expect(() =>
      compile({
        limit: tokenRestrictions,
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
          domains: { mine: { ownerId: { actor: "userId" } } },
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

  test("placement is within, the limit and create at the create action, and every key's target visible (R4)", () => {
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
        organization: { view: {} },
        user: { view: {} },
      },
    });
    expect(models.page!.place).toBe("create");
    // A required key reads its target visible; a nullable one may be null; a
    // key to a model the policy does not list (pageGroup) only null (R9).
    expect(models.page!.predicates.create).toEqual({
      AND: [
        { color: "full" },
        { icon: "full" },
        { ownerId: me },
        { organization: { is: { icon: "view" } } },
        { OR: [{ ownerId: null }, { owner: { is: { icon: "view" } } }] },
        { groupId: null },
      ],
    });
    // A model that declares no create:, and one the policy does not list,
    // place nothing.
    expect(models.organization!.predicates.create).toEqual(NOWHERE);
    expect(models.pageGroup!.predicates.create).toEqual(NOWHERE);
    expect(models.pageGroup!.place).toBe("create");
  });

  test("moves: an update writing what the placement reads is placed again, a written key's target visible; what judged the old row is not restated (OD-14, D9)", () => {
    const { models } = compile({
      levels: LEVELS,
      models: {
        page: {
          view: {},
          edit: { title: "e" },
          create: { groupId: null, ownerId: { actor: "userId" } },
        },
        organization: { view: {} },
        user: { view: {} },
      },
    });
    const { moves, predicates } = models.page!;
    expect(moves).toEqual({
      groupId: "move:groupId",
      ownerId: "move:ownerId",
      organizationId: "move:organizationId",
    });
    const created = [{ groupId: null }, { ownerId: me }];
    // The key's own `groupId: null` is the placement's: said once.
    expect(predicates["move:groupId"]).toEqual({ AND: created });
    expect(predicates["move:ownerId"]).toEqual({
      AND: [...created, { OR: [{ ownerId: null }, { owner: { is: {} } }] }],
    });
    // Not read by the placement: only its target, visible.
    expect(predicates["move:organizationId"]).toEqual({
      organization: { is: {} },
    });
    // What the read and update verbs judge on the new row is dropped.
    const judged = compile({
      levels: LEVELS,
      models: {
        page: {
          view: { personal: false },
          edit: { title: "e" },
          create: { personal: false, title: "e" },
        },
        organization: { view: {} },
        user: { view: {} },
        pageGroup: { view: {} },
      },
    }).models.page!.predicates;
    // `view` reads every rule above it (R1): only `edit`'s title is implied.
    expect(judged["move:personal"]).toEqual({ personal: false });
    expect(judged.create).toEqual({
      AND: [
        { personal: false },
        { title: "e" },
        { organization: { is: {} } },
        { OR: [{ ownerId: null }, { owner: { is: {} } }] },
        { OR: [{ groupId: null }, { group: { is: {} } }] },
      ],
    });
  });

  test("a placement drops a conjunct only where another provably implies it, with the actor values it reads", () => {
    const { models } = compile({
      levels: LEVELS,
      models: {
        page: {
          view: {},
          create: {
            AND: [
              { group: { label: "x" } },
              { group: { label: "x" } },
              { NOT: { title: { in: ["a", "b"] } } },
              { NOT: { title: { in: ["a"] } } },
              { title: { in: ["c"] } },
              { title: { in: ["c", "d"] } },
              { grants: { some: {} } },
              { color: { actor: "userId" } },
              { OR: [{ color: { actor: "userId" } }, { icon: "i" }] },
              { OR: [{ icon: "i" }, { position: 1 }] },
            ],
          },
        },
        organization: { view: {} },
        user: { view: {} },
        pageGroup: { operations: { read: "edit" }, edit: { label: "x" } },
      },
    });
    const { predicates, moves } = models.page!;
    expect(predicates.create).toEqual({
      AND: [
        { group: { label: "x" } },
        { NOT: { title: { in: ["a", "b"] } } },
        { title: { in: ["c"] } },
        { grants: { some: {} } },
        { color: me },
        // `color` alone implies it, but it reads no actor value of its own…
        { OR: [{ icon: "i" }, { position: 1 }] },
        { organization: { is: {} } },
        { OR: [{ ownerId: null }, { owner: { is: {} } }] },
        // …and a group read at `edit` (its read verb) is not one `label: x`
        // spells as a shorthand: kept.
        { OR: [{ groupId: null }, { group: { is: { label: "x" } } }] },
      ],
    });
    // A relation the row does not hold joins on the fields its key references.
    expect(Object.keys(moves)).toContain("id");
    // A listed model with no action (no levels, no rule) has no projection key.
    expect(
      compile({ models: { collection: {} } }).models.collection!.evidence
    ).toBeUndefined();
  });

  test("acyclic: the self relations holding a key that a predicate recurses over, wherever it is read (R4)", () => {
    const { models } = compile({
      levels: LEVELS,
      models: {
        document: {
          view: {
            parent: {
              recurse: { depth: false },
              self: true,
              some: { ownerId: { actor: "userId" } },
            },
          },
        },
        accessGrant: { view: { document: "view" } },
        team: {
          view: {
            parents: {
              is: {
                children: {
                  recurse: { depth: false },
                  self: true,
                  some: { members: { some: { userId: { actor: "userId" } } } },
                },
              },
            },
          },
        },
      },
    });
    expect(models.document!.acyclic).toEqual(["parent"]);
    // A many-to-many walk holds no key: no acyclic relation.
    expect(models.team!.acyclic).toBeUndefined();
    expect(models.accessGrant!.acyclic).toBeUndefined();
  });

  test("evidence: the projection key on every listed model with actions, ordered where they are exactly the levels (D6)", () => {
    const { models } = compile({
      levels: LEVELS,
      models: {
        page: { view: {} },
        organization: { view: {}, invite: {} },
        document: { actions: { view: [], share: ["view"] }, view: {} },
      },
    });
    expect(models.page!.evidence).toEqual({
      as: "$access",
      names: ["view", "edit", "full"],
      ordered: true,
    });
    expect(models.organization!.evidence).toEqual({
      as: "$access",
      names: ["view", "edit", "full", "invite"],
    });
    expect(models.document!.evidence).toEqual({
      as: "$access",
      names: ["view", "share"],
    });
    expect(models.user!.evidence).toBeUndefined();
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
          models: { page: { domains: { edit: {} } } },
        })
      )
    ).toContain(
      'models.page.domains.edit: an action, a domain, the placement or a move already has the name "edit"'
    );
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { domains: { "move:groupId": {} } } },
        })
      )
    ).toContain(
      'models.page.domains.move:groupId: an action, a domain, the placement or a move already has the name "move:groupId"'
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

  test("no action or domain takes the default mode's name: one `as` name space for every model", () => {
    const message =
      'models.page: "default" is the mode a call takes by default, not an action or a domain';
    expect(
      refusalOf(() => compile({ models: { page: { view: {}, default: {} } } }))
    ).toContain(message);
    expect(
      refusalOf(() =>
        compile({ models: { page: { view: {}, domains: { default: {} } } } })
      )
    ).toContain(message);
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

describe("explicit application rules", () => {
  const at = (rule: Rule, model = "page", action = "view") =>
    compile({ levels: LEVELS, models: { [model]: { [action]: rule } } }).models[
      model
    ]!.predicates[action];

  test("scalar comparisons and recursive predicates compile without schema conventions", () => {
    expect(at({ ownerId: { actor: "userId" } })).toEqual({ ownerId: me });
    expect(at({ everyone: true }, "accessGrant")).toEqual({ everyone: true });
    expect(
      at(
        {
          parent: {
            recurse: { depth: false },
            self: true,
            some: { ownerId: { actor: "userId" } },
          },
        },
        "document"
      )
    ).toEqual({
      parent: { recurse: { depth: false }, self: true, some: { ownerId: me } },
    });
  });

  test("an action callback can express a role ceiling using the implication graph", () => {
    const capped: Rule = (action, model) => ({
      organization: {
        is: {
          members: {
            some: {
              userId: { actor: "userId" },
              role: {
                in: model.above(action).includes("view")
                  ? ["reader", "admin"]
                  : ["admin"],
              },
            },
          },
        },
      },
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
  });

  test("a grant callback can cover levels and actions with explicit recipient conditions", () => {
    const given: Rule = (action, model) => ({
      grants: {
        some: {
          AND: [
            {
              OR: [
                { level: { in: model.above(action) } },
                { actions: { hasSome: model.above(action) } },
              ],
            },
            { everyone: true },
          ],
        },
      },
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

  test("explicit grant placement bounds contents beyond what administering already implies", () => {
    const adminRule = {
      AND: [
        { pageId: { not: null } },
        { OR: [{ pageId: null }, { page: "edit" }] },
      ],
    };
    const placeRule = {
      AND: [
        adminRule,
        ...LEVELS.map((action) => ({
          OR: [
            { pageId: null },
            { NOT: { actions: { has: action } } },
            { page: action },
          ],
        })),
        ...LEVELS.map((level) => ({
          OR: [
            { pageId: null },
            { level: null },
            { level: { not: level } },
            { page: level },
          ],
        })),
      ],
    };
    const compiled = compile({
      levels: LEVELS,
      models: {
        accessGrant: { edit: adminRule, create: placeRule },
        page: { edit: { title: "e" }, full: { title: "f" } },
        organization: { view: {} },
      },
    });
    const held = (name: string) => compiled.models.page!.predicates[name];
    const { predicates } = compiled.models.accessGrant!;
    const admin = {
      AND: [
        { pageId: { not: null } },
        { OR: [{ pageId: null }, { page: { is: held("edit") } }] },
      ],
    };
    expect(predicates.edit).toEqual(admin);
    // P(page, edit) implies P(page, view) and itself: those bounds, and the
    // page's own visibility, are what administering already says. `full`
    // is above `edit`: its bounds stay. Keys to models the policy does not
    // list are null.
    expect(held("view")).toEqual(held("edit"));
    expect(predicates.create).toEqual({
      AND: [
        ...admin.AND,
        {
          OR: [
            { pageId: null },
            { NOT: { actions: { has: "full" } } },
            { page: { is: held("full") } },
          ],
        },
        {
          OR: [
            { pageId: null },
            { level: null },
            { level: { not: "full" } },
            { page: { is: held("full") } },
          ],
        },
        { organization: { is: {} } },
        { groupId: null },
        { documentId: null },
        { collectionId: null },
        { userId: null },
        { granteeTeamId: null },
        { grantedBy: null },
      ],
    });
    // A move of the page key: the placement and its target, without what the
    // update verb (`edit`, the administering conjunction) already judges.
    const bounds = (predicates.create as { AND: object[] }).AND.slice(2, 4);
    expect(predicates["move:pageId"]).toEqual({ AND: bounds });
  });

  test("a token can restrict exact row ids without a recursive traversal", () => {
    const { models } = compile({
      levels: LEVELS,
      limit: {
        OR: [
          { $if: { control: "actor", path: "key", exists: false } },
          { id: { in: { actor: "key.resources.document" } } },
        ],
      },
      models: { page: { full: {} } },
    });
    expect(JSON.stringify(models.page!.predicates.view)).toContain(
      '{"id":{"in":{"control":"actor","path":"key.resources.document"}}}'
    );
  });

  test("explicit token restrictions allow no-key requests, use implied scopes, and traverse resource subtrees", () => {
    const { predicates } = compile({
      levels: LEVELS,
      limit: tokenRestrictions,
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

// The review of 2026-10-16 (docs/architecture/rbac-extension-review-2026-10-16.md):
// a definition that would judge less than it says is refused when applied.
describe("definitions refused before they widen (review 2026-10-16)", () => {
  test("a declaration key or a level mistyped is refused; a model that lists its actions refuses every other key (FDOCS-1)", () => {
    expect(
      refusalOf(() =>
        compile({ levels: LEVELS, models: { page: { whithin: {}, view: {} } } })
      )
    ).toContain('models.page.whithin: spelled like "within"');
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { view: {}, edti: { title: "e" } } },
        })
      )
    ).toContain('models.page.edti: spelled like "edit"');
    expect(
      refusalOf(() =>
        compile({
          models: {
            document: {
              actions: { view: [], publish: ["view"] },
              view: {},
              pubish: {},
            },
          },
        })
      )
    ).toContain(
      "models.document.pubish: neither an action document lists in `actions`"
    );
    // A rule key that is no level and no near miss still names an action.
    expect(
      compile({ levels: LEVELS, models: { page: { view: {}, invite: {} } } })
        .models.page!.evidence?.names
    ).toEqual(["view", "edit", "full", "invite"]);
  });

  test("an unknown policy key and a field entry's unknown key are refused (FDOCS-2)", () => {
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          limits: {},
          models: { page: { view: {} } },
        } as never)
      )
    ).toContain('"limits" is not a key of the policy');
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: {
            page: { view: {}, fields: { title: { reed: "view" } } },
          } as never,
        })
      )
    ).toContain("models.page.fields.title.reed: a field entry takes only");
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { view: {}, fields: { title: "full" } } } as never,
        })
      )
    ).toContain("models.page.fields.title: a field entry takes only");
  });

  test("the implication prover compares values structurally: a bigint compiles, NaN is no null (Fprinciples-2, Fprinciples-6)", () => {
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: {
            document: {
              within: { sizeBytes: { lt: 10n } },
              view: {},
              create: { sizeBytes: { gte: 1n }, ownerId: { actor: "userId" } },
            },
          },
        })
      )
    ).toBe("no refusal");
  });

  test("the prover drops a conjunct only where an absent actor value makes what implies it false too, never through a $if arm (Fprinciples-6)", () => {
    // `other` implies `mine` arm by arm, but reads `userId` in one arm only,
    // and that arm is guarded: absent `userId` with `network: "office"`,
    // `other` holds while `mine` does not (R6), so `mine` stays.
    const mine = { OR: [{ ownerId: { actor: "userId" } }, { personal: true }] };
    const other = {
      OR: [
        { AND: [{ actor: { network: "office" } }, { personal: true }] },
        {
          AND: [
            { actor: { network: "home" } },
            { ownerId: { actor: "userId" } },
          ],
        },
      ],
    };
    const { predicates } = compile({
      levels: LEVELS,
      models: {
        page: { view: {}, create: { AND: [mine, other] } },
        organization: { view: {} },
        user: { view: {} },
        pageGroup: { view: {} },
      },
    }).models.page!;
    expect(JSON.stringify(predicates.create)).toContain(
      '{"OR":[{"ownerId":{"control":"actor","path":"userId"}},{"personal":true}]}'
    );
    // A relation's shorthand body is implied at its target: `in ["x"]`
    // implies `in ["x", "y"]`, which is dropped.
    const narrowed = compile({
      levels: LEVELS,
      models: {
        page: {
          view: {},
          create: {
            AND: [
              { group: { icon: { in: ["x"] } } },
              { group: { icon: { in: ["x", "y"] } } },
            ],
          },
        },
        organization: { view: {} },
        user: { view: {} },
        pageGroup: { view: {} },
      },
    }).models.page!.predicates.create as { AND: Record<string, unknown>[] };
    expect(narrowed.AND).toContainEqual({ group: { icon: { in: ["x"] } } });
    expect(narrowed.AND).not.toContainEqual({
      group: { icon: { in: ["x", "y"] } },
    });
    // An arm read under its own `$if … exists` (a live credential): an absent value
    // folds the arm away, so it falsifies nothing; the conjunct said twice
    // is said once.
    const live = compile({
      levels: LEVELS,
      models: {
        user: { view: {}, create: { AND: [liveCredential, liveCredential] } },
      },
    }).models.user!.predicates.create;
    expect(live).toEqual(
      compile({
        levels: LEVELS,
        models: { user: { view: {}, create: liveCredential } },
      }).models.user!.predicates.create
    );
    // A guarded conjunction inside an arm (`{ actor: … }` beside a filter):
    // its values falsify, its own test asserts nothing carried.
    const office = {
      OR: [
        { AND: [{ actor: { network: "office" } }, { name: "x" }] },
        { name: "y" },
      ],
    };
    const twice = compile({
      levels: LEVELS,
      models: { user: { view: {}, create: { AND: [office, office] } } },
    }).models.user!.predicates.create;
    expect(twice).toEqual(
      compile({
        levels: LEVELS,
        models: { user: { view: {}, create: office } },
      }).models.user!.predicates.create
    );
    // Dates compare by their instant: the same one is said once, another kept.
    const dated = (other: Date) =>
      compile({
        levels: LEVELS,
        models: {
          page: {
            view: {},
            create: {
              AND: [
                { createdAt: { gt: new Date(0) } },
                { createdAt: { gt: other } },
              ],
            },
          },
          organization: { view: {} },
          user: { view: {} },
          pageGroup: { view: {} },
        },
      }).models.page!.predicates.create as { AND: object[] };
    const kept = (other: Date) =>
      dated(other).AND.filter((member) => "createdAt" in member).length;
    expect(kept(new Date(0))).toBe(1);
    expect(kept(new Date(1))).toBe(2);
    // A value is never walked as a clause: the date reaches the predicate.
    expect(
      (dated(new Date(1)).AND[0] as { createdAt: { gt: unknown } }).createdAt.gt
    ).toEqual(new Date(0));
    // NaN equals nothing, null included: neither conjunct implies the other.
    const nan = compile({
      levels: LEVELS,
      models: {
        page: {
          view: {},
          create: {
            AND: [
              { position: { equals: null } },
              { position: { equals: Number.NaN } },
            ],
          },
        },
        organization: { view: {} },
        user: { view: {} },
        pageGroup: { view: {} },
      },
    }).models.page!.predicates.create as {
      AND: Record<string, { equals: unknown }>[];
    };
    expect(
      nan.AND.some((member) => Number.isNaN(member.position?.equals))
    ).toBe(true);
  });
});

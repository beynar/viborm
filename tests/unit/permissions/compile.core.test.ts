/**
 * The compiler of `viborm/permissions` (plan §3.2 R1, R6, R9; §3.3 D2, D3, D7, D9,
 * D10; §4.2 K2(e); §4.3 K3): a declaration and the schema it governs in,
 * plain data out. No engine: these read the compiled data itself. Its rows
 * on a database are `tests/contracts/public-client/permissions-compiled-policy-behavior.ts`'s.
 */

import { ClientInitializationError } from "@errors";
import {
  type CompiledModel,
  type PermissionsConfig,
  type PolicyModel,
  permissions,
  type Rule,
} from "@src/permissions";
import { compilePolicy, evidenceOf } from "@src/permissions/compile";
import { v } from "@src/validation";
import { schema } from "@tests/package/fixtures/permissions-app/schema";
import {
  Actor,
  blog,
  liveCredential,
  policy,
  storedPolicy,
  tokenRestrictions,
} from "@tests/types/permissions/acceptance-policy";
import { describe, expect, test } from "vitest";

const me = { control: "actor", path: "userId" };
const NOWHERE = { OR: [] };
const RETIRED_ARMS = /arms.*(removed|retired)/;
// Existing compiler witnesses inspect row semantics independently of the new
// credential envelope. Exact scope predicates are witnessed separately below.
function withoutScopeEnvelope<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    if (
      Object.getPrototypeOf(node) !== Object.prototype &&
      Object.getPrototypeOf(node) !== null
    )
      return node;
    const record = node as Record<string, unknown>;
    const branches = record.OR;
    if (
      Object.keys(record).length === 1 &&
      Array.isArray(branches) &&
      branches.length === 2 &&
      branches.every(
        (branch) =>
          branch !== null &&
          typeof branch === "object" &&
          Object.keys(branch).length === 1 &&
          "$if" in branch
      ) &&
      branches[0].$if?.control === "scopes" &&
      branches[0].$if?.path === "unrestricted" &&
      branches[0].$if?.equals === true &&
      Object.keys(branches[0].$if).length === 3 &&
      branches[1].$if?.control === "scopes" &&
      branches[1].$if?.path === "allowed" &&
      typeof branches[1].$if?.has === "string" &&
      Object.keys(branches[1].$if).length === 3
    )
      return {};
    const result = Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, walk(item)])
    );
    if (Object.keys(result).length === 1 && Array.isArray(result.AND)) {
      const parts = result.AND.filter(
        (part) =>
          !part || typeof part !== "object" || Object.keys(part).length !== 0
      );
      return parts.length === 0
        ? {}
        : parts.length === 1
          ? parts[0]
          : { AND: parts };
    }
    return result;
  };
  return walk(value) as T;
}
const compile = (
  config: Omit<PermissionsConfig, "actor"> & { actor?: object }
) =>
  withoutScopeEnvelope(
    compilePolicy({ actor: Actor, ...config } as PermissionsConfig, schema)
  );
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
const LEVELS = ["read", "update", "full"] as const;

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
        predicates: { $create: NOWHERE },
        writes: {},
        reads: {},
        modes: {},
        place: "$create",
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
    expect(stored.models.member!.predicates.read).not.toEqual(
      compiled.models.member!.predicates.read
    );
    expect(JSON.stringify(stored.models.member!.predicates.read)).toContain(
      '"permissions":{"some":{"role":"reader","action":{"in":["read","update","full"]}}}'
    );
  });
});

describe("R1: P(M, a) = mandatory ∧ scope(a) ∧ ⋁ rule(b ⊒ a)(b)", () => {
  test.each([
    ["read", "update", "read"],
    ["read", "update", "update"],
  ])("repeated levels %j cannot reverse the permission ladder", (...levels) => {
    const declarations: PermissionsConfig["models"][] = [
      { page: { read: {} } },
      {},
    ];
    for (const models of declarations)
      expect(refusalOf(() => compile({ levels, models }))).toContain(
        "levels must list each action only once"
      );
  });

  test("explicit action equivalence remains valid", () => {
    const { predicates } = compile({
      models: {
        page: { actions: { read: ["update"], update: ["read"] }, read: {} },
      },
    }).models.page!;
    expect(predicates.read).toEqual({});
    expect(predicates.update).toEqual({});
  });

  test("an explicit role table denies an unknown requested target action", () => {
    const roles: Readonly<Record<string, readonly string[]>> = {
      read: ["reader"],
    };
    const { predicates } = compile({
      models: {
        user: { actions: { read: [] }, read: {} },
        page: {
          actions: { read: [], update: ["read"] },
          read: {},
          update: {
            owner: {
              is: (action: string) => ({
                name: { in: roles[action] ?? [], not: "banned" },
              }),
            },
          },
        },
      },
    }).models.page!;
    expect(predicates.update).toEqual({
      owner: { is: { name: { in: [], not: "banned" } } },
    });
  });

  test("prototype-spelled actions and domains remain own predicates and modes", () => {
    for (const page of [
      {
        actions: { read: [], ["__proto__"]: [] },
        read: {},
        ["__proto__"]: { title: "private" },
      },
      { read: {}, domains: { ["__proto__"]: { title: "private" } } },
    ]) {
      const compiled = compile({ models: { page } }).models.page!;
      expect(Object.hasOwn(compiled.predicates, "__proto__")).toBe(true);
      expect(compiled.predicates.__proto__).toEqual({ title: "private" });
      expect(Object.hasOwn(compiled.modes, "__proto__")).toBe(true);
      expect(compiled.modes.__proto__).toBe("__proto__");
    }
  });

  test("a rule written at an action that implies a holds at a", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: { page: { read: { title: "v" }, full: { title: "f" } } },
    }).models.page!;
    expect(predicates.read).toEqual({ OR: [{ title: "v" }, { title: "f" }] });
    expect(predicates.update).toEqual({ title: "f" });
    expect(predicates.full).toEqual({ title: "f" });
  });

  test("an inherited branch another branch provably contains is dropped; one it does not is kept", () => {
    // `inOrg(update)` admits members and admins, `inOrg(read)` readers too:
    // the update branch is contained in the read one, so P(read) is one
    // branch, as the plan's one-branch form had it; the rows are the same.
    const inOrg = (action: string) => ({
      organization: {
        is: {
          members: {
            some: {
              userId: { actor: "userId" },
              role: {
                in:
                  action === "read"
                    ? ["reader", "member", "admin"]
                    : ["member", "admin"],
              },
            },
          },
        },
      },
    });
    const { predicates } = compile({
      levels: LEVELS,
      models: { page: { "read, update, full": inOrg } },
    }).models.page!;
    const roles = (clause: unknown) =>
      (
        clause as {
          organization: {
            is: { members: { some: { role: { in: string[] } } } };
          };
        }
      ).organization.is.members.some.role.in;
    expect(Object.keys(predicates.read!)).toEqual(["organization"]);
    expect(roles(predicates.read)).toEqual(["reader", "member", "admin"]);
    expect(roles(predicates.update)).toEqual(["member", "admin"]);
    expect(roles(predicates.full)).toEqual(["member", "admin"]);
    // Two branches neither of which contains the other both stay.
    const apart = compile({
      levels: LEVELS,
      models: { page: { read: { title: "a" }, full: { personal: true } } },
    }).models.page!.predicates;
    expect(apart.read).toEqual({ OR: [{ title: "a" }, { personal: true }] });
  });

  test("a shared rule is evaluated once per declared action, at that action and its model", () => {
    const calls: string[] = [];
    const shared = (action: string, model: { name: string }) => {
      calls.push(`${model.name}.${action}`);
      return { title: action };
    };
    const { predicates } = compile({
      levels: LEVELS,
      models: { page: { read: shared, update: shared, full: shared } },
    }).models.page!;
    expect(calls).toEqual(["page.read", "page.update", "page.full"]);
    expect(predicates.update).toEqual({
      OR: [{ title: "update" }, { title: "full" }],
    });
  });

  test("a nested callback receives only immutable name and action metadata", () => {
    compile({
      models: {
        page: {
          read: {
            owner: {
              is: (_action: string, model: PolicyModel) => {
                expect(model).toEqual({ name: "user", actions: [] });
                expect(Object.isFrozen(model)).toBe(true);
                expect(Object.isFrozen(model.actions)).toBe(true);
                return {};
              },
            },
          },
        },
      },
    });
  });

  test("an inherited callback retains its declared action", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: {
        page: {
          full: (action) => (action === "update" ? NOWHERE : { title: action }),
        },
      },
    }).models.page!;
    expect(predicates.read).toEqual({ title: "full" });
    expect(predicates.update).toEqual({ title: "full" });
    expect(predicates.full).toEqual({ title: "full" });
  });

  test("nested callbacks inherit the declared action and read the related model", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: {
        page: {
          full: {
            OR: [
              {
                owner: {
                  is: (action: string, model: { name: string }) => ({
                    name: `${model.name}.${action}`,
                  }),
                },
              },
              (action: string) => ({ title: action }),
            ],
          },
        },
      },
    }).models.page!;
    expect(predicates.read).toEqual({
      OR: [{ owner: { is: { name: "user.full" } } }, { title: "full" }],
    });
    expect(predicates.update).toEqual({
      OR: [{ owner: { is: { name: "user.full" } } }, { title: "full" }],
    });
  });

  test("a branched action graph shares a rule without granting an unrelated action", () => {
    const shared: Rule = (action) => ({ title: action });
    const { predicates } = compile({
      models: {
        page: {
          actions: {
            read: [],
            comment: ["read"],
            update: ["comment"],
            share: ["update"],
            export: ["read"],
          },
          comment: shared,
          share: shared,
        },
      },
    }).models.page!;
    expect(predicates.read).toEqual({
      OR: [{ title: "comment" }, { title: "share" }],
    });
    expect(predicates.update).toEqual({ title: "share" });
    expect(predicates.share).toEqual({ title: "share" });
    expect(predicates.export).toEqual(NOWHERE);
  });

  test.each([
    "read,update",
    "read, update",
    " \tread\r\n,\n update\t ",
  ])("a grouped rule %j is the same declaration as individual assignments", (key) => {
    const rule = { title: "allowed" };
    const grouped = compile({
      levels: LEVELS,
      models: { page: { mandatory: { color: "blue" }, [key]: rule } },
    }).models.page!;
    const separate = compile({
      levels: LEVELS,
      models: {
        page: { mandatory: { color: "blue" }, read: rule, update: rule },
      },
    }).models.page!;
    expect(grouped).toEqual(separate);
    expect(grouped.predicates.read).toEqual({
      AND: [{ color: "blue" }, { title: "allowed" }],
    });
    expect(grouped.predicates.full).toEqual(NOWHERE);
    expect(grouped.read).toBe("read");
    expect(grouped.update).toBe("update");
    expect(grouped.delete).toBeUndefined();
    expect(grouped.evidence).toEqual({
      as: "$access",
      names: ["read", "update", "full"],
    });
  });

  test("a grouped dynamic rule evaluates once at each declared action and never grants an unrelated branch", () => {
    const calls: string[] = [];
    const shared: Rule = (action, model) => {
      calls.push(`${model.name}.${action}`);
      return action === "update" ? NOWHERE : { title: action };
    };
    const { predicates } = compile({
      models: {
        page: {
          actions: {
            read: [],
            comment: ["read"],
            update: ["comment"],
            share: ["update"],
            export: ["read"],
          },
          "comment, share": shared,
        },
      },
    }).models.page!;
    expect(calls).toEqual(["page.comment", "page.share"]);
    expect(predicates.read).toEqual({
      OR: [{ title: "comment" }, { title: "share" }],
    });
    expect(predicates.comment).toEqual({
      OR: [{ title: "comment" }, { title: "share" }],
    });
    expect(predicates.update).toEqual({ title: "share" });
    expect(predicates.share).toEqual({ title: "share" });
    expect(predicates.export).toEqual(NOWHERE);
  });

  test("implicit grouped actions use individual names in evidence, modes and operation bindings", () => {
    const config = {
      actor: Actor,
      levels: LEVELS,
      models: {
        page: {
          "invite, archive": { title: "allowed" },
          operations: { update: "invite", delete: "archive" },
        },
      },
    };
    const result = compile(config).models.page!;
    const evidence = evidenceOf(config, "page");
    expect(evidence).toEqual({
      names: ["read", "update", "full", "invite", "archive"],
    });
    expect(result.evidence?.names).toEqual(evidence.names);
    expect(result.modes).toEqual({
      read: "read",
      update: "update",
      full: "full",
      invite: "invite",
      archive: "archive",
    });
    expect(result.update).toBe("invite");
    expect(result.delete).toBe("archive");
    expect(result.predicates.read).toEqual(NOWHERE);
    expect(result.predicates.update).toEqual(NOWHERE);
  });

  test("group syntax preserves the source key in relation and actor-path errors", () => {
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { "read, update": { owner: "missingAction" } } },
        })
      )
    ).toContain('models.page.read, update reads owner at "missingAction"');
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: {
            page: { "read, update": { ownerId: { actor: "missingActor" } } },
          },
        })
      )
    ).toContain('models.page.read, update reads actor path "missingActor"');
  });

  test("spaces and dots never split individual action names", () => {
    const result = compile({
      models: {
        page: {
          actions: { "read write": [], "read.write": [] },
          "read write": { title: "space" },
          "read.write": { title: "dot" },
        },
      },
    }).models.page!;
    expect(result.evidence?.names).toEqual(["read write", "read.write"]);
    expect(result.predicates["read write"]).toEqual({ title: "space" });
    expect(result.predicates["read.write"]).toEqual({ title: "dot" });
    expect(result.predicates.read).toBeUndefined();
    expect(result.predicates.write).toBeUndefined();
  });

  test.each([
    ",read",
    "read,",
    "read,,update",
    "read, \t\r\n,update",
  ])("an empty action in %j is refused before a grant is compiled", (key) => {
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { [key]: {} } },
        })
      )
    ).toContain("an action group cannot contain an empty member");
  });

  test("duplicate members and overlapping groups cannot silently override a rule", () => {
    for (const page of [
      { "read,read": {} },
      { "read, update": {}, update: { title: "different" } },
      { update: {}, "read, update": {} },
      { "read, update": {}, "update, full": {} },
      { "read, update": undefined, read: {} },
    ])
      expect(
        refusalOf(() => compile({ levels: LEVELS, models: { page } }))
      ).toContain("already has a rule at models.page.");
  });

  test.each([
    "mandatory",
    "actions",
    "operations",
    "fields",
    "domains",
    "within",
    "arms",
  ])("a group cannot reinterpret %j as an action", (key) => {
    const message = refusalOf(() =>
      compile({
        levels: LEVELS,
        models: { page: { [`read, ${key}`]: {} } },
      })
    );
    expect(message).not.toBe("no refusal");
    expect(message).toContain(`models.page.read, ${key}`);
  });

  test("every member receives typo protection or explicit graph validation", () => {
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { "read, updaet": {} } },
        })
      )
    ).toContain('models.page.read, updaet: spelled like "update"');
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { "read, mandatroy": {} } },
        })
      )
    ).toContain('models.page.read, mandatroy: spelled like "mandatory"');
    expect(
      refusalOf(() =>
        compile({
          models: {
            page: {
              actions: { read: [], update: ["read"] },
              "read, invite": {},
            },
          },
        })
      )
    ).toContain('unknown action "invite"');
  });

  test("levels and graph nodes or edges cannot declare grouped action names", () => {
    const configs: Omit<PermissionsConfig, "actor">[] = [
      { levels: ["read", "update, full"], models: { page: { read: {} } } },
      {
        levels: ["read, update"],
        models: { page: { actions: { read: [] }, read: {} } },
      },
      {
        models: {
          page: { actions: { read: [], "update, full": ["read"] }, read: {} },
        },
      },
      {
        models: {
          page: { actions: { read: [], update: ["read, full"] }, read: {} },
        },
      },
    ];
    for (const config of configs)
      expect(refusalOf(() => compile(config))).toContain(
        "is not an individual action; commas group rules only"
      );
  });

  test("retired arms is rejected rather than interpreted as a permission", () => {
    for (const page of [
      { arms: [{}], read: {} },
      { arms: {}, read: {} },
      { actions: { read: [], arms: ["read"] }, arms: {}, read: {} },
      { actions: { read: [], arms: ["read"] }, read: {} },
    ]) {
      expect(
        refusalOf(() =>
          Reflect.apply(compile, undefined, [{ models: { page } }])
        )
      ).toMatch(RETIRED_ARMS);
    }
  });

  test("an OR in mandatory restricts grants but grants nothing by itself", () => {
    const mandatory = {
      OR: [{ title: "public" }, { ownerId: { actor: "userId" } }],
    };
    const closed = compile({ levels: LEVELS, models: { page: { mandatory } } })
      .models.page!;
    expect(closed.predicates.read).toEqual(NOWHERE);
    expect(closed.predicates.update).toEqual(NOWHERE);
    const granted = compile({
      levels: LEVELS,
      models: { page: { mandatory, update: { icon: "editable" } } },
    }).models.page!;
    expect(granted.predicates.update).toEqual({
      AND: [
        { OR: [{ title: "public" }, { ownerId: me }] },
        { icon: "editable" },
      ],
    });
  });

  test("the former restriction name cannot silently become a grant", () => {
    expect(
      refusalOf(() =>
        compile({
          models: { page: { within: { title: "private" }, read: {} } },
        })
      )
    ).toContain('models.page.within was renamed to "mandatory"');
    expect(
      refusalOf(() =>
        compile({
          models: { page: { actions: { read: [], within: [] }, read: {} } },
        })
      )
    ).toContain('"within" is a retired declaration key');
  });

  test("global and model mandatory restrictions are conjoined with every action", () => {
    const { predicates } = compile({
      levels: LEVELS,
      mandatory: { icon: "restricted" },
      models: { page: { mandatory: { color: "c" }, update: { title: "e" } } },
    }).models.page!;
    expect(predicates.read).toEqual({
      AND: [{ color: "c" }, { icon: "restricted" }, { title: "e" }],
    });
  });

  test("an action with no rule and no arm is false, and so is one a rule folds false", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: {
        page: { read: {}, update: { group: "full" } },
        pageGroup: { read: {} },
      },
    }).models.page!;
    expect(predicates.read).toEqual({});
    expect(predicates.full).toEqual(NOWHERE);
    expect(predicates.update).toEqual(NOWHERE);
  });

  test("a custom rule key declares an independent action", () => {
    const { predicates, modes } = compile({
      levels: LEVELS,
      models: { team: { read: { name: "v" }, invite: { name: "i" } } },
    }).models.team!;
    expect(Object.keys(modes)).toEqual(["read", "update", "full", "invite"]);
    expect(predicates.read).toEqual({ name: "v" });
    expect(predicates.update).toEqual(NOWHERE);
  });

  test("a model's own actions replace the levels, implied transitively", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: {
        document: {
          actions: { read: [], comment: ["read"], update: ["comment"] },
          update: { title: "e" },
        },
      },
    }).models.document!;
    expect(
      Object.keys(predicates).filter(
        (name) => name !== "$create" && !name.startsWith("move:")
      )
    ).toEqual(["read", "comment", "update"]);
    expect(predicates.read).toEqual({ title: "e" });
  });

  test("logical and relation filters fold what compiles false, and keep the rest as written", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: {
        page: {
          read: {
            NOT: { group: "full" },
            title: "t",
            group: { label: "x" },
            owner: { isNot: { OR: [] } },
          },
          update: { NOT: {}, title: "never" },
          full: { group: null },
        },
        pageGroup: { read: {} },
      },
    }).models.page!;
    expect(predicates.read).toEqual({
      OR: [{ title: "t", group: { label: "x" } }, { group: null }],
    });
    expect(predicates.update).toEqual({ group: null });
  });

  test("a rule that is neither a where nor a function is refused", () => {
    expect(
      refusalOf(() =>
        compile({ levels: LEVELS, models: { page: { read: 42 as never } } })
      )
    ).toContain(
      "models.page.read: a rule is a boolean, a where object or a function of the action"
    );
  });

  test("a domain and a placement that fold false match nothing", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: {
        page: {
          read: {},
          domains: { none: { group: "full" } },
          create: { group: "full" },
        },
        pageGroup: { read: {} },
      },
    }).models.page!;
    expect(predicates.none).toEqual(NOWHERE);
    expect(predicates["$create"]).toEqual(NOWHERE);
  });

  test("some and is with an impossible body match no rows", () => {
    const { models } = compile({
      models: {
        page: { read: { owner: { is: { OR: [] } } } },
        pageGroup: { read: { pages: { some: { OR: [] } } } },
      },
    });
    expect(models.page!.predicates.read).toEqual(NOWHERE);
    expect(models.pageGroup!.predicates.read).toEqual(NOWHERE);
  });

  test("a quantifier over a false body folds: `every` holds only where nothing is related", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: {
        pageGroup: { read: { pages: { every: { group: "full" } } } },
        page: {},
      },
    }).models.pageGroup!;
    expect(predicates.read).toEqual({ pages: { none: {} } });
  });

  test.each([
    { every: { OR: [] }, none: { id: "blocked" } },
    { none: { id: "blocked" }, every: { OR: [] } },
  ])("a false every keeps its empty-relation requirement beside none: %j", (pages) => {
    const { predicates } = compile({
      levels: LEVELS,
      models: { pageGroup: { read: { pages } }, page: { read: {} } },
    }).models.pageGroup!;
    expect(predicates.read).toEqual({ pages: { none: {} } });
  });

  test("a relation whose value is an action is the target's predicate at it, inlined (D7)", () => {
    const compiled = compile({
      levels: LEVELS,
      models: {
        page: { read: { group: "update" } },
        pageGroup: { update: { label: "x" } },
      },
    });
    expect(compiled.models.page!.predicates.read).toEqual({
      group: { is: compiled.models.pageGroup!.predicates.update },
    });
  });
});

describe("the actor's facts (K2, R6)", () => {
  test("{ actor: path } in a value position is the actor's field", () => {
    const { predicates } = compile({
      models: {
        page: { read: { ownerId: { actor: "userId" }, title: { in: ["a"] } } },
      },
    }).models.page!;
    expect(predicates.read).toEqual({ ownerId: me, title: { in: ["a"] } });
  });

  test("explicit actor parameters retain their path and reject misspellings", () => {
    expect(
      compile({ models: { page: { read: { ownerId: me } } } }).models.page!
        .predicates.read
    ).toEqual({ ownerId: me });
    expect(
      refusalOf(() =>
        compile({
          models: {
            page: { read: { ownerId: { control: "actor", path: "usrId" } } },
          },
        })
      )
    ).toContain('reads actor path "usrId"');
  });

  test("{ actor: { path: value } } in a filter is a condition; null is absence", () => {
    const { predicates } = compile({
      models: {
        organization: {
          read: { plan: "pro", actor: { network: "office", session: null } },
        },
      },
    }).models.organization!;
    expect(predicates.read).toEqual({
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
          models: { page: { read: { ownerId: { actor: "usrId" } } } },
        })
      )
    ).toContain('models.page.read reads actor path "usrId"');
    expect(
      refusalOf(() =>
        compile({
          models: { page: { read: { actor: { key: { idd: "k" } } } } },
        })
      )
    ).toContain('reads actor path "key.idd"');
    expect(
      refusalOf(() =>
        compile({
          models: {
            page: {
              read: { $if: { control: "actor", path: "nope", exists: true } },
            },
          },
        })
      )
    ).toContain('reads actor path "nope"');
    expect(
      refusalOf(() =>
        compile({
          mandatory: {
            $if: { control: "actor", path: "credential", exists: false },
          },
          models: { page: { read: {} } },
        })
      )
    ).toContain('mandatory reads actor path "credential"');
    // A record's keys are any key: a key's scopes per model.
    expect(() =>
      compile({
        models: { page: { read: tokenRestrictions } },
      })
    ).not.toThrow();
  });

  test("a condition on a list, or on a value that is not an object of facts, is refused", () => {
    expect(
      refusalOf(() =>
        compile({ models: { page: { read: { actor: { network: ["a"] } } } } })
      )
    ).toContain('tests actor path "network" against a list');
    expect(
      refusalOf(() =>
        compile({ models: { page: { read: { actor: "userId" } } } })
      )
    ).toContain("not an object of its facts");
  });

  test("the actor schema must be a walkable object schema with finite paths", () => {
    expect(
      refusalOf(() => permissions({ actor: v.string(), models: {} }))
    ).toContain("object schema");
    expect(
      refusalOf(() =>
        permissions({
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
      refusalOf(() => permissions({ actor: v.object({ node }), models: {} }))
    ).toContain('recursive at "node.parent"');
  });
});

describe("verbs, fields, modes and placement (K3, OD-3, R4)", () => {
  test("operations default to read, update and delete independently of levels and extra actions", () => {
    const { models } = compile({
      levels: LEVELS,
      models: {
        page: { read: {} },
        team: { read: {}, invite: {} },
        member: { read: {}, operations: { delete: "update" } },
        collection: { read: {}, operations: { delete: "full" } },
        bookmark: { read: {}, delete: {} },
      },
    });
    const verbs = ({ read, update, delete: remove }: CompiledModel) => ({
      read,
      update,
      delete: remove,
    });
    expect(verbs(models.page!)).toEqual({
      read: "read",
      update: "update",
      delete: undefined,
    });
    // Adding an action does not change which action delete requires.
    expect(verbs(models.team!)).toEqual({
      read: "read",
      update: "update",
      delete: undefined,
    });
    expect(verbs(models.member!)).toEqual({
      read: "read",
      update: "update",
      delete: "update",
    });
    expect(verbs(models.collection!)).toEqual({
      read: "read",
      update: "update",
      delete: "full",
    });
    expect(verbs(models.bookmark!)).toEqual({
      read: "read",
      update: "update",
      delete: "delete",
    });
  });

  test("written and read fields name their actions; modes are the actions and domains", () => {
    const { models } = compile({
      levels: LEVELS,
      models: {
        collection: {
          read: {},
          fields: {
            budget: { read: "full", write: "update" },
            owner: { write: "full" },
          },
          domains: { mine: { ownerId: { actor: "userId" } } },
        },
      },
    });
    const collection = models.collection!;
    expect(collection.writes).toEqual({
      budget: "update",
      owner: "$write:owner",
    });
    expect(collection.reads).toEqual({ budget: "full" });
    expect(collection.modes).toEqual({
      read: "read",
      update: "update",
      full: "full",
      mine: "mine",
    });
    expect(collection.predicates.mine).toEqual({ ownerId: me });
  });

  test("placement combines mandatory and the independent create action, and every key's target visible (R4)", () => {
    const { models } = compile({
      levels: LEVELS,
      mandatory: { icon: "restricted" },
      models: {
        page: {
          mandatory: { color: "restricted" },
          read: {},
          create: { ownerId: { actor: "userId" } },
        },
        organization: { read: {} },
        user: { read: {} },
      },
    });
    expect(models.page!.place).toBe("$create");
    // A required key reads its target visible; a nullable one may be null; a
    // key to a model the policy does not list (pageGroup) only null (R9).
    expect(models.page!.predicates["$create"]).toEqual({
      AND: [
        { color: "restricted" },
        { icon: "restricted" },
        { ownerId: me },
        { organization: { is: { icon: "restricted" } } },
        { OR: [{ ownerId: null }, { owner: { is: { icon: "restricted" } } }] },
        { groupId: null },
      ],
    });
    // A model that declares no create:, and one the policy does not list,
    // place nothing.
    expect(models.organization!.predicates["$create"]).toEqual(NOWHERE);
    expect(models.pageGroup!.predicates["$create"]).toEqual(NOWHERE);
    expect(models.pageGroup!.place).toBe("$create");
  });

  test("an empty relation predicate cannot discharge restricted foreign-key visibility", () => {
    const { models } = compile({
      models: {
        page: { create: { group: { is: {} } } },
        pageGroup: { read: { id: "allowed" } },
        organization: { read: true },
        user: { read: true },
      },
    });
    // A group existing is insufficient: the proposed page must also reference
    // an allowed group. Simplification must retain that independent boundary.
    expect(models.page!.predicates["$create"]).toEqual({
      AND: [
        { group: { is: {} } },
        { organization: { is: {} } },
        { OR: [{ ownerId: null }, { owner: { is: {} } }] },
        { OR: [{ groupId: null }, { group: { is: { id: "allowed" } } }] },
      ],
    });
  });

  test("moves: an update writing what the placement reads is placed again, a written key's target visible; what judged the old row is not restated (OD-14, D9)", () => {
    const { models } = compile({
      levels: LEVELS,
      models: {
        page: {
          read: {},
          update: { title: "e" },
          create: { groupId: null, ownerId: { actor: "userId" } },
        },
        organization: { read: {} },
        user: { read: {} },
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
          read: { personal: false },
          update: { title: "e" },
          create: { personal: false, title: "e" },
        },
        organization: { read: {} },
        user: { read: {} },
        pageGroup: { read: {} },
      },
    }).models.page!.predicates;
    // `read` reads every rule above it (R1): only `update`'s title is implied.
    expect(judged["move:personal"]).toEqual({ personal: false });
    expect(judged["$create"]).toEqual({
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
          read: {},
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
        organization: { read: {} },
        user: { read: {} },
        pageGroup: { operations: { read: "update" }, update: { label: "x" } },
      },
    });
    const { predicates, moves } = models.page!;
    expect(predicates["$create"]).toEqual({
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
        // …and a group read at `update` (its read verb) is not one `label: x`
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
          read: {
            parent: {
              recurse: { depth: false },
              self: true,
              some: { ownerId: { actor: "userId" } },
            },
          },
        },
        accessGrant: { read: { document: "read" } },
        team: {
          read: {
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

  test("evidence: the same boolean-map projection on every listed model with actions (D6)", () => {
    const { models } = compile({
      levels: LEVELS,
      models: {
        page: { read: {} },
        organization: { read: {}, invite: {} },
        document: { actions: { read: [], share: ["read"] }, read: {} },
      },
    });
    expect(models.page!.evidence).toEqual({
      as: "$access",
      names: ["read", "update", "full"],
    });
    expect(models.organization!.evidence).toEqual({
      as: "$access",
      names: ["read", "update", "full", "invite"],
    });
    expect(models.document!.evidence).toEqual({
      as: "$access",
      names: ["read", "share"],
    });
    expect(models.user!.evidence).toBeUndefined();
  });

  test("declaration errors are refused, naming where", () => {
    expect(
      refusalOf(() =>
        compile({ models: { page: { operations: { delete: "remove" } } } })
      )
    ).toContain(
      'models.page.operations.delete names "remove", which page does not declare. Declared actions: none. Add its rule or choose a declared action.'
    );
    expect(refusalOf(() => compile({ models: { pages: {} } }))).toContain(
      "models.pages: the schema has no such model"
    );
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { fields: { titel: { write: "update" } } } },
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
    ).toContain(
      'models.page.operations.delete names "remove", which page does not declare. Declared actions: read, update, full. Add its rule or choose a declared action.'
    );
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { operations: { erase: "full" } as never } },
        })
      )
    ).toContain("models.page.operations.erase: not a configurable operation");
    expect(
      refusalOf(() =>
        compile({
          models: { document: { actions: { read: [], update: ["veiw"] } } },
        })
      )
    ).toContain('models.document.actions.update implies "veiw"');
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { domains: { update: {} } } },
        })
      )
    ).toContain(
      'models.page.domains.update: an action, a domain, the placement or a move already has the name "update"'
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
          models: { page: { read: { group: "veiw" } }, pageGroup: {} },
        })
      )
    ).toContain(
      'models.page.read reads group at "veiw", which pageGroup does not declare'
    );
  });

  test("an action may not take a declaration key's name", () => {
    expect(
      refusalOf(() =>
        compile({
          models: { document: { actions: { read: [], mandatory: ["read"] } } },
        })
      )
    ).toContain(
      'models.document: "mandatory" is a key of the declaration, not an action'
    );
  });

  test("no action or domain takes the default mode's name: one `as` name space for every model", () => {
    const message =
      'models.page: "default" is the mode a call takes by default, not an action or a domain';
    expect(
      refusalOf(() => compile({ models: { page: { read: {}, default: {} } } }))
    ).toContain(message);
    expect(
      refusalOf(() =>
        compile({ models: { page: { read: {}, domains: { default: {} } } } })
      )
    ).toContain(message);
  });

  test("a predicate that reads itself through its relations is refused", () => {
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { document: { read: { parent: "read" } } },
        })
      )
    ).toContain(
      "models.document.read reads itself: document.read → document.read"
    );
  });
});

describe("explicit application rules", () => {
  const at = (rule: Rule, model = "page", action = "read") =>
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

  test("an action callback can express an explicit role ceiling", () => {
    const capped: Rule = (action) => ({
      organization: {
        is: {
          members: {
            some: {
              userId: { actor: "userId" },
              role: {
                in: action === "read" ? ["reader", "admin"] : ["admin"],
              },
            },
          },
        },
      },
    });
    const { predicates } = compile({
      levels: LEVELS,
      models: { page: { full: capped } },
    }).models.page!;
    expect(predicates.read).toEqual({
      organization: {
        is: {
          members: { some: { userId: me, role: { in: ["admin"] } } },
        },
      },
    });
    expect(predicates.update).toEqual({
      organization: {
        is: { members: { some: { userId: me, role: { in: ["admin"] } } } },
      },
    });
  });

  test("a grant callback can cover levels and actions with explicit recipient conditions", () => {
    const grantActions: Readonly<Record<string, readonly string[]>> = {
      read: ["read", "update", "full"],
      update: ["update", "full"],
      full: ["full"],
    };
    const given: Rule = (action) => ({
      grants: {
        some: {
          AND: [
            {
              OR: [
                { level: { in: grantActions[action] ?? [] } },
                { actions: { hasSome: grantActions[action] ?? [] } },
              ],
            },
            { everyone: true },
          ],
        },
      },
    });
    expect(at(given, "page", "update")).toEqual({
      grants: {
        some: {
          AND: [
            {
              OR: [
                { level: { in: ["update", "full"] } },
                { actions: { hasSome: ["update", "full"] } },
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
        { OR: [{ pageId: null }, { page: "update" }] },
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
        accessGrant: { update: adminRule, create: placeRule },
        page: { update: { title: "e" }, full: { title: "f" } },
        organization: { read: {} },
      },
    });
    const held = (name: string) => compiled.models.page!.predicates[name];
    const { predicates } = compiled.models.accessGrant!;
    const admin = {
      AND: [
        { pageId: { not: null } },
        { OR: [{ pageId: null }, { page: { is: held("update") } }] },
      ],
    };
    expect(predicates.update).toEqual(admin);
    // P(page, update) implies P(page, read) and itself: those bounds, and the
    // page's own visibility, are what administering already says. `full`
    // is above `update`: its bounds stay. Keys to models the policy does not
    // list are null.
    expect(held("read")).toEqual(held("update"));
    expect(predicates["$create"]).toEqual({
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
    // update verb (`update`, the administering conjunction) already judges.
    const bounds = (predicates["$create"] as { AND: object[] }).AND.slice(2, 4);
    expect(predicates["move:pageId"]).toEqual({ AND: bounds });
  });

  test("a token can restrict exact row ids without a recursive traversal", () => {
    const { models } = compile({
      levels: LEVELS,
      mandatory: {
        OR: [
          { $if: { control: "actor", path: "key", exists: false } },
          { id: { in: { actor: "key.resources.document" } } },
        ],
      },
      models: { page: { full: {} } },
    });
    expect(JSON.stringify(models.page!.predicates.read)).toContain(
      '{"id":{"in":{"control":"actor","path":"key.resources.document"}}}'
    );
  });

  test("explicit token restrictions allow no-key requests, use implied scopes, and traverse resource subtrees", () => {
    const { predicates } = compile({
      levels: LEVELS,
      models: {
        document: {
          actions: policy.config.models.document.actions,
          read: tokenRestrictions,
        },
      },
    }).models.document!;
    const ids = { control: "actor", path: "key.resources.document" };
    expect(predicates.share).toEqual(NOWHERE);
    expect(predicates.read).toEqual({
      OR: [
        { $if: { control: "actor", path: "key", exists: false } },
        {
          AND: [
            {
              $if: {
                control: "actor",
                path: "key.scopes.document",
                hasSome: [
                  "read",
                  "comment",
                  "archive",
                  "update",
                  "share",
                  "export",
                  "create",
                ],
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
        compile({
          levels: LEVELS,
          models: { page: { mandatroy: {}, read: {} } },
        })
      )
    ).toContain('models.page.mandatroy: spelled like "mandatory"');
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { read: {}, updaet: { title: "e" } } },
        })
      )
    ).toContain('models.page.updaet: spelled like "update"');
    expect(
      refusalOf(() =>
        compile({
          models: {
            document: {
              actions: { read: [], publish: ["read"] },
              read: {},
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
      compile({ levels: LEVELS, models: { page: { read: {}, invite: {} } } })
        .models.page!.evidence?.names
    ).toEqual(["read", "update", "full", "invite"]);
  });

  test("an unknown policy key and a field entry's unknown key are refused (FDOCS-2)", () => {
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          limits: {},
          models: { page: { read: {} } },
        } as never)
      )
    ).toContain('"limits" is not a key of the policy');
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: {
            page: { read: {}, fields: { title: { reed: "read" } } },
          } as never,
        })
      )
    ).toContain("models.page.fields.title.reed: a field entry takes only");
    expect(
      refusalOf(() =>
        compile({
          levels: LEVELS,
          models: { page: { read: {}, fields: { title: "full" } } } as never,
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
              mandatory: { sizeBytes: { lt: 10n } },
              read: {},
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
        page: { read: {}, create: { AND: [mine, other] } },
        organization: { read: {} },
        user: { read: {} },
        pageGroup: { read: {} },
      },
    }).models.page!;
    expect(JSON.stringify(predicates["$create"])).toContain(
      '{"OR":[{"ownerId":{"control":"actor","path":"userId"}},{"personal":true}]}'
    );
    // A relation's shorthand body is implied at its target: `in ["x"]`
    // implies `in ["x", "y"]`, which is dropped.
    const narrowed = compile({
      levels: LEVELS,
      models: {
        page: {
          read: {},
          create: {
            AND: [
              { group: { icon: { in: ["x"] } } },
              { group: { icon: { in: ["x", "y"] } } },
            ],
          },
        },
        organization: { read: {} },
        user: { read: {} },
        pageGroup: { read: {} },
      },
    }).models.page!.predicates["$create"] as { AND: Record<string, unknown>[] };
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
        user: { read: {}, create: { AND: [liveCredential, liveCredential] } },
      },
    }).models.user!.predicates["$create"];
    expect(live).toEqual(
      compile({
        levels: LEVELS,
        models: { user: { read: {}, create: liveCredential } },
      }).models.user!.predicates["$create"]
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
      models: { user: { read: {}, create: { AND: [office, office] } } },
    }).models.user!.predicates["$create"];
    expect(twice).toEqual(
      compile({
        levels: LEVELS,
        models: { user: { read: {}, create: office } },
      }).models.user!.predicates["$create"]
    );
    // Dates compare by their instant: the same one is said once, another kept.
    const dated = (other: Date) =>
      compile({
        levels: LEVELS,
        models: {
          page: {
            read: {},
            create: {
              AND: [
                { createdAt: { gt: new Date(0) } },
                { createdAt: { gt: other } },
              ],
            },
          },
          organization: { read: {} },
          user: { read: {} },
          pageGroup: { read: {} },
        },
      }).models.page!.predicates["$create"] as { AND: object[] };
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
          read: {},
          create: {
            AND: [
              { position: { equals: null } },
              { position: { equals: Number.NaN } },
            ],
          },
        },
        organization: { read: {} },
        user: { read: {} },
        pageGroup: { read: {} },
      },
    }).models.page!.predicates["$create"] as {
      AND: Record<string, { equals: unknown }>[];
    };
    expect(
      nan.AND.some((member) => Number.isNaN(member.position?.equals))
    ).toBe(true);
  });
});

describe("credential scope envelopes", () => {
  test("compiled scopes use the same transitive graph: update and delete reach read, create does not", () => {
    const compiled = compilePolicy(
      {
        actor: Actor,
        models: {
          page: {
            actions: {
              read: [],
              update: [],
              full: ["update"],
              create: [],
              delete: [],
            },
            "create, update, delete, full": true,
          },
        },
      },
      schema
    );
    expect(compiled.scopes["page.update"]).toEqual(
      expect.arrayContaining(["page.update", "page.read"])
    );
    expect(compiled.scopes["page.create"]).toEqual(["page.create"]);
    expect(compiled.scopes["page.delete"]).toEqual(
      expect.arrayContaining(["page.delete", "page.read"])
    );
    expect(compiled.scopes["page.full"]).toEqual(
      expect.arrayContaining(["page.full", "page.update", "page.read"])
    );
    expect(compiled.scopes["page.read"]).toEqual(["page.read"]);
    expect(JSON.stringify(compiled.models.page!.predicates.read)).toContain(
      '"control":"scopes"'
    );
    expect(JSON.stringify(compiled.models.page!.predicates.read)).toContain(
      '"has":"page.read"'
    );
  });
  test("explicit false defeats inherited grants, and unrelated actions do not implicitly grant read", () => {
    const compiled = compile({
      models: {
        page: { read: false, update: true },
        organization: { invite: true },
      },
    });
    expect(compiled.models.page!.predicates.read).toEqual(NOWHERE);
    expect(compiled.models.page!.predicates.update).toEqual({});
    expect(compiled.models.organization!.read).toBeUndefined();
  });
  test("mandatory cannot depend on an action, even in nested logical or relation predicates", () => {
    for (const mandatory of [
      () => ({}),
      { AND: [() => ({})] },
      { owner: { is: () => ({}) } },
    ]) {
      expect(
        refusalOf(() =>
          compile({ models: { page: { mandatory, read: true } } } as never)
        )
      ).toContain("mandatory");
    }
  });
});

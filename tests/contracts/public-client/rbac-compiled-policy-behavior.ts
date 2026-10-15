import type { CompiledPolicy, ModelPolicy } from "@src/rbac";
import { grant, member, notBanned, session, up } from "@src/rbac";
import { compilePolicy, verbsOf } from "@src/rbac/compile";
import {
  createRbacAppClient,
  loadRbacSeed,
  type RbacAppClient,
  type RbacAppSubstrate,
} from "@tests/contracts/public-client/rbac-app-behavior";
import {
  actionsOf,
  createOracle,
  GOVERNED_MODELS,
  type GovernedModel,
  MODEL_ACTIONS,
  type OracleOptions,
  rowKey,
} from "@tests/package/fixtures/rbac-app/oracle";
import { schema } from "@tests/package/fixtures/rbac-app/schema";
import {
  type Actor,
  actors,
  seed,
} from "@tests/package/fixtures/rbac-app/seed";
import {
  Actor as ActorSchema,
  policy,
  storedPolicy,
} from "@tests/types/rbac/acceptance-policy";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

/**
 * The compiled policy against the oracle (plan §3.3 D2, D3, D9; §7 W-H1,
 * W-A1..W-A6): `rbac(§1.1).compile(schema)` is plain data, its K3 part
 * (`verbsOf`) handed to a plain extension's `rows.verbs`, whose modes name each
 * `(model, action)` predicate, conjoined by K3 with the model's read
 * predicate (R2). Its `actor` control is a call argument (K1 admission, K2
 * parameters and conditions), on the seeded rbac-app fixture with no other
 * layer. The oracle is read without tombstones (`tombstones: false`): soft
 * delete is not composed here, so a tombstoned membership or grant still
 * counts, on both sides.
 *
 * The oracle never sees an engine result; a disagreement names the actor,
 * the model and the action.
 */

type Row = Record<string, unknown>;
interface Delegate {
  findMany(args: object): Promise<Row[]>;
  update(args: object): Promise<Row>;
}
const MODE = "as";
const NOWHERE = { OR: [] };

/**
 * The action modes of every governed model, each naming its compiled
 * predicate: K3 ANDs the model's `read` with it (R2); false where the model
 * lacks the action.
 */
function observedModes(compiled: CompiledPolicy) {
  const names = [...new Set(MODEL_ACTIONS.map(([, action]) => action))];
  const models: Record<string, Record<string, { root: object | string }>> = {};
  for (const model of GOVERNED_MODELS) {
    const { predicates } = compiled.models[model]!;
    models[model] = Object.fromEntries([
      ["none", { root: NOWHERE }],
      ...names.map((action) => [
        action,
        { root: Object.hasOwn(predicates, action) ? action : NOWHERE },
      ]),
    ]);
  }
  return models;
}

/**
 * A plain extension carrying the compiled policy as K3 declares it: every
 * model's compiled predicates and verbs are its `verbs`, so an unlisted model reads nothing
 * (R9). The actor is an argument.
 */
const extensionOf = (name: string, compiled: CompiledPolicy) => ({
  name,
  controls: { actor: { schema: ActorSchema, required: true } },
  rows: {
    control: MODE,
    default: "none",
    models: observedModes(compiled),
    verbs: verbsOf(compiled),
  },
});

export function runCompiledPolicyBehavior(substrate: RbacAppSubstrate): void {
  const oracle = createOracle(seed);
  const judged = substrate.actors ?? Object.keys(actors);
  const timeout = substrate.timeout;
  const now = new Date();
  const without = (options: Partial<OracleOptions> = {}): OracleOptions => ({
    now,
    tombstones: false,
    ...options,
  });

  describe(`${substrate.name}: the compiled policy against the oracle`, () => {
    let base: RbacAppClient;
    const clients = new Map<string, unknown>();
    const governed = (compiled: CompiledPolicy, name: string) => {
      let client = clients.get(name);
      if (client === undefined) {
        client = base.$extends(extensionOf(name, compiled) as never);
        clients.set(name, client);
      }
      return client as Record<string, Delegate>;
    };
    const declared = () => governed(policy.compile(schema), "declared");

    /** The root rows the compiled predicate selects for one actor at (model, action). */
    const select = async (
      client: Record<string, Delegate>,
      actor: Actor,
      model: GovernedModel,
      action: string
    ) => {
      const rows = await client[model]!.findMany({
        [MODE]: action,
        actor,
        select:
          model === "teamMember"
            ? { teamId: true, userId: true }
            : { id: true },
      });
      return rows.map((row) => rowKey(model, row)).sort();
    };
    beforeAll(async () => {
      base = createRbacAppClient(substrate.createDriver());
      await substrate.prepare(base);
      await loadRbacSeed(base);
    }, timeout ?? 120_000);

    afterAll(async () => {
      await base?.$disconnect();
      await substrate.release?.();
    }, timeout ?? 120_000);

    // PGlite answers in microtasks: without a macrotask turn between tests,
    // a run longer than a minute starves the worker's RPC with vitest
    // ("Timeout calling onTaskUpdate") although every test passed.
    afterEach(() => new Promise((resolve) => setImmediate(resolve)));

    for (const name of judged) {
      test(
        `W-H1: the helpers' compiled predicates select the oracle's rows for ${name}, at every (model, action)`,
        async () => {
          const actor = actors[name]!;
          for (const [model, action] of MODEL_ACTIONS)
            expect(
              await select(declared(), actor, model, action),
              `${model}.${action}`
            ).toEqual(oracle.rows(actor, model, action, without()));
        },
        timeout
      );
    }

    test(
      "W-A1: R1 per action: each model's actions are the oracle's, and their row sets differ",
      async () => {
        const compiled = policy.compile(schema);
        for (const model of GOVERNED_MODELS)
          expect(Object.keys(compiled.models[model]!.modes), model).toEqual([
            ...actionsOf(model),
            ...(model === "page" ? ["given"] : []),
          ]);
        // Some actor holds a document at one action and not at another: the
        // actions are distinct predicates, not one ladder read at its top.
        let distinct = 0;
        for (const name of judged) {
          const actor = actors[name]!;
          const held = new Map<string, string[]>();
          for (const action of actionsOf("document")) {
            const rows = await select(declared(), actor, "document", action);
            expect(rows, `${name} document.${action}`).toEqual(
              oracle.rows(actor, "document", action, without())
            );
            held.set(action, rows);
          }
          const [share, exported] = [held.get("share")!, held.get("export")!];
          if (share.some((id) => !exported.includes(id))) distinct += 1;
          if (exported.some((id) => !share.includes(id))) distinct += 1;
        }
        expect(distinct).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-A2: stored grant actions: document actions held only through a grant's `actions`",
      async () => {
        // The same policy whose grants carry no `actions`: what it loses is what the stored lists give.
        const given = grant.to([], { relation: "grants", level: "level" });
        const levelsOnly = rebuild((models) => ({
          ...models,
          document: {
            ...models.document,
            arms: [...models.document.arms.slice(0, 2), up("parent", given)],
          },
        }));
        const stripped = governed(levelsOnly, "levels-only");
        let lost = 0;
        for (const name of judged) {
          const actor = actors[name]!;
          for (const action of ["comment", "archive", "share", "export"]) {
            const full = await select(declared(), actor, "document", action);
            expect(full, `${name} document.${action}`).toEqual(
              oracle.rows(actor, "document", action, without())
            );
            lost +=
              full.length -
              (await select(stripped, actor, "document", action)).length;
          }
        }
        expect(lost).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-A3: the role ceiling caps every arm: a reader granted edit holds view",
      async () => {
        const uncapped = rebuild((models) => {
          const inOrg = member({
            via: "organization",
            user: { AND: [notBanned(), session()] },
          });
          return Object.fromEntries(
            Object.entries(models).map(([model, entry]) => [
              model,
              "within" in entry ? { ...entry, within: inOrg } : entry,
            ])
          );
        });
        const open = governed(uncapped, "uncapped");
        let capped = 0;
        // The pages and documents a grant above view reaches: where a cap shows.
        const capping = MODEL_ACTIONS.filter(
          ([model, action]) =>
            (model === "page" || model === "document") && action !== "view"
        );
        for (const name of judged) {
          const actor = actors[name]!;
          for (const [model, action] of capping) {
            const held = await select(declared(), actor, model, action);
            expect(held, `${name} ${model}.${action}`).toEqual(
              oracle.rows(actor, model, action, without())
            );
            capped +=
              (await select(open, actor, model, action)).length - held.length;
          }
        }
        expect(capped).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-A4: a request fact folds both ways: export needs the office network",
      async () => {
        let exported = 0;
        for (const name of judged) {
          const actor = actors[name]!;
          for (const network of ["office", "public"]) {
            const at = { ...actor, network };
            const rows = await select(declared(), at, "organization", "export");
            expect(rows, `${name} on ${network}`).toEqual(
              oracle.rows(at, "organization", "export", without())
            );
            if (network === "public") expect(rows).toEqual([]);
            else exported += rows.length;
          }
        }
        expect(exported).toBeGreaterThan(0);
      },
      timeout
    );

    test(
      "W-A5: a row attribute: a plan downgrade is seen at once",
      async () => {
        const organizations = base as unknown as Record<string, Delegate>;
        const pro = seed.organization.filter((o) => o.plan === "pro");
        const holders = judged.filter(
          (name) =>
            oracle.rows(actors[name]!, "organization", "export", without())
              .length > 0
        );
        expect(holders.length).toBeGreaterThan(0);
        try {
          for (const { id } of pro)
            await organizations.organization!.update({
              where: { id },
              data: { plan: "free" },
            });
          for (const name of holders)
            expect(
              await select(declared(), actors[name]!, "organization", "export"),
              name
            ).toEqual([]);
        } finally {
          for (const { id } of pro)
            await organizations.organization!.update({
              where: { id },
              data: { plan: "pro" },
            });
        }
        for (const name of holders)
          expect(
            await select(declared(), actors[name]!, "organization", "export")
          ).toEqual(
            oracle.rows(actors[name]!, "organization", "export", without())
          );
      },
      timeout
    );

    for (const name of judged) {
      test(
        `W-A6: the stored ceiling selects the oracle's stored rows for ${name}, which are the declared ones on this seed`,
        async () => {
          const stored = governed(storedPolicy.compile(schema), "stored");
          const actor = actors[name]!;
          for (const [model, action] of MODEL_ACTIONS) {
            const rows = await select(stored, actor, model, action);
            expect(rows, `${model}.${action}`).toEqual(
              oracle.rows(actor, model, action, without({ ceiling: "stored" }))
            );
            expect(rows, `${model}.${action} declared`).toEqual(
              oracle.rows(actor, model, action, without())
            );
          }
        },
        timeout
      );
    }
  });
}

/** The acceptance policy with some models replaced, compiled. */
function rebuild(
  models: (
    models: typeof policy.config.models
  ) => Readonly<Record<string, ModelPolicy>>
): CompiledPolicy {
  return compilePolicy(
    { ...policy.config, models: models(policy.config.models) },
    schema
  );
}

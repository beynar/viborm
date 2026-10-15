import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import {
  createOracle,
  type GovernedModel,
  MODEL_ACTIONS,
  rowKey,
} from "@tests/package/fixtures/rbac-app/oracle";
import {
  ADMINISTERED,
  type AdministeredThing,
  and,
  handRules,
  type RuleOptions,
} from "@tests/package/fixtures/rbac-app/rules";
import { schema } from "@tests/package/fixtures/rbac-app/schema";
import {
  type Actor,
  actors,
  type RbacSeed,
  seed,
} from "@tests/package/fixtures/rbac-app/seed";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * The RBAC acceptance estate on one substrate (plan §6.1 U0, §7): the §1.1
 * fixture's schema pushed, its deterministic seed loaded, and the policy
 * written by hand (`rules.ts`, the W-H1 reference) executed through the BASE
 * client, compared row for row with the independent oracle (`oracle.ts`).
 * Nothing here uses `viborm/rbac`, which does not exist yet: this pins the
 * seed, the oracle and the hand rules against each other on every database
 * the witness matrix names, so each later unit proves against an estate that
 * already agrees with itself.
 *
 * The oracle never sees an engine result. When the hand rules and the oracle
 * disagree, one of the two misreads plan §1.1, or the engine answers a plain
 * `where` wrongly; the failure names the actor, the model and the action.
 */

export interface RbacAppSubstrate {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  /** Creates the fixture's tables on an empty database. */
  readonly prepare: (client: RbacAppClient) => Promise<void>;
  /** Releases what `prepare` created, after the client disconnected. */
  readonly release?: () => Promise<void>;
  /** The actors to judge (default: every seeded actor); remote substrates sample. */
  readonly actors?: readonly string[];
  /** Per-test timeout, for remote or slow substrates. */
  readonly timeout?: number;
}

export function createRbacAppClient(driver: AnyDriver) {
  return createClient({ schema, driver });
}
export type RbacAppClient = ReturnType<typeof createRbacAppClient>;

type Row = Record<string, unknown>;
interface LooseDelegate {
  createMany(args: { data: readonly Row[] }): Promise<{ count: number }>;
  findMany(args?: object): Promise<Row[]>;
  count(args?: object): Promise<number>;
  update(args: object): Promise<Row>;
}
const delegate = (client: RbacAppClient, model: string) =>
  (client as unknown as Record<string, LooseDelegate>)[model] as LooseDelegate;

/** Insertion order: every row's foreign keys point at rows already written. */
const LOAD_ORDER = [
  "organization",
  "user",
  "session",
  "apiKey",
  "member",
  "rolePermission",
  "team",
  "teamMember",
  "pageGroup",
  "page",
  "collection",
] as const;

const depthOf = (data: RbacSeed) => {
  const parents = new Map(data.document.map((d) => [d.id, d.parentId]));
  return (id: string) => {
    let depth = 1;
    for (let at = parents.get(id); at; at = parents.get(at)) depth += 1;
    return depth;
  };
};

/** Loads the seed through the base client's public writes. */
export async function loadRbacSeed(client: RbacAppClient, data = seed) {
  for (const model of LOAD_ORDER) {
    await delegate(client, model).createMany({
      data: data[model] as unknown as Row[],
    });
  }
  const parentsOf = new Map<string, string[]>();
  for (const { childId, parentId } of data.teamParent) {
    parentsOf.set(childId, [...(parentsOf.get(childId) ?? []), parentId]);
  }
  for (const [childId, parentIds] of parentsOf) {
    await delegate(client, "team").update({
      where: { id: childId },
      data: { parents: { connect: parentIds.map((id) => ({ id })) } },
    });
  }
  // Documents by depth, so a statement never references a parent it inserts.
  const depth = depthOf(data);
  const levels = new Map<number, Row[]>();
  for (const row of data.document) {
    const at = depth(row.id);
    levels.set(at, [...(levels.get(at) ?? []), row as unknown as Row]);
  }
  for (const at of [...levels.keys()].sort((a, b) => a - b)) {
    await delegate(client, "document").createMany({
      data: levels.get(at) ?? [],
    });
  }
  await delegate(client, "accessGrant").createMany({
    data: data.accessGrant as unknown as Row[],
  });
}

const keyColumns = (model: GovernedModel) =>
  model === "teamMember" ? { teamId: true, userId: true } : { id: true };

const TOMBSTONED = new Set(["page", "member", "teamMember", "accessGrant"]);

export function runRbacAppBehavior(substrate: RbacAppSubstrate): void {
  const oracle = createOracle(seed);
  const judged = substrate.actors ?? Object.keys(actors);
  const timeout = substrate.timeout;

  describe(`${substrate.name}: the RBAC acceptance estate`, () => {
    let client: RbacAppClient;
    const now = new Date();

    beforeAll(async () => {
      client = createRbacAppClient(substrate.createDriver());
      await substrate.prepare(client);
      await loadRbacSeed(client);
    }, timeout ?? 120_000);

    afterAll(async () => {
      await client?.$disconnect();
      await substrate.release?.();
    }, timeout ?? 120_000);

    test(
      "the seed loads whole, on every model and the team graph",
      async () => {
        for (const model of [
          ...LOAD_ORDER,
          "document",
          "accessGrant",
        ] as const) {
          expect(await delegate(client, model).count(), model).toBe(
            seed[model].length
          );
        }
        const teams = await delegate(client, "team").findMany({
          select: { id: true, parents: { select: { id: true } } },
        });
        const edges = teams
          .flatMap((team) =>
            (team.parents as { id: string }[]).map(
              (parent) => `${team.id}>${parent.id}`
            )
          )
          .sort();
        expect(edges).toEqual(
          seed.teamParent.map((e) => `${e.childId}>${e.parentId}`).sort()
        );
        const grants = await delegate(client, "accessGrant").findMany({
          select: { id: true, actions: true, level: true },
        });
        const stored = new Map(grants.map((g) => [g.id, g]));
        for (const grant of seed.accessGrant) {
          expect(stored.get(grant.id), grant.id).toEqual({
            id: grant.id,
            actions: grant.actions,
            level: grant.level,
          });
        }
      },
      timeout
    );

    /**
     * The hand rules with `grants.admin` resolved first (rules.ts
     * `administered`): the things the actor administers, read with their own
     * predicates, root default included (a tombstoned page administers
     * nothing).
     */
    const rulesFor = async (actor: Actor, options: RuleOptions) => {
      const plain = handRules(actor, options);
      const administered = {} as Record<AdministeredThing, string[]>;
      for (const [, , thing, action] of ADMINISTERED) {
        const where = plain.predicate(thing, action);
        const root =
          where !== null && TOMBSTONED.has(thing)
            ? and({ deletedAt: null }, where)
            : where;
        const rows =
          root === null
            ? []
            : await delegate(client, thing).findMany({
                where: root,
                select: { id: true },
              });
        administered[thing] = rows.map((row) => String(row.id));
      }
      return handRules(actor, { ...options, administered });
    };

    /** The root rows the hand rules select at (model, action). */
    const observe = async (
      rules: Awaited<ReturnType<typeof rulesFor>>,
      model: GovernedModel,
      action: string,
      deleted: "default" | "with"
    ) => {
      const where = rules.observed(model, action);
      if (where === null) return [];
      const root =
        TOMBSTONED.has(model) && deleted === "default"
          ? and({ deletedAt: null }, where)
          : where;
      const rows = await delegate(client, model).findMany({
        where: root,
        select: keyColumns(model),
      });
      return rows.map((row) => rowKey(model, row)).sort();
    };

    /** Every pair's answer beside the oracle's. */
    const answers = async (
      name: string,
      options: RuleOptions & { readonly deleted?: "default" | "with" },
      models: readonly (readonly [GovernedModel, string])[] = MODEL_ACTIONS
    ) => {
      const actor = actors[name] as Actor;
      const rules = await rulesFor(actor, options);
      const deleted = options.deleted ?? "default";
      const answered: { label: string; got: string[]; want: string[] }[] = [];
      for (const [model, action] of models) {
        const got = await observe(rules, model, action, deleted);
        answered.push({
          label: `${name} ${model}.${action} (${deleted}, ${options.ceiling ?? "declared"})`,
          got,
          want: oracle.rows(actor, model, action, {
            now,
            deleted,
            ceiling: options.ceiling,
          }),
        });
      }
      return answered;
    };

    for (const name of judged) {
      test(
        `the hand-written policy selects the oracle's rows for ${name}, at every (model, action)`,
        async () => {
          const answered = await answers(name, { now });
          for (const { label, got, want } of answered) {
            expect(got, label).toEqual(want);
          }
          expect(answered).toHaveLength(MODEL_ACTIONS.length);
        },
        timeout
      );
    }

    test(
      'tombstoned roots under `deleted: "with"` and the stored-role ceiling agree with the oracle',
      async () => {
        const tombstoned = MODEL_ACTIONS.filter(([model]) =>
          TOMBSTONED.has(model)
        );
        for (const name of judged.slice(0, 8)) {
          for (const { label, got, want } of [
            ...(await answers(name, { now, deleted: "with" }, tombstoned)),
            ...(await answers(name, { now, ceiling: "stored" })),
          ]) {
            expect(got, label).toEqual(want);
          }
        }
      },
      timeout
    );
  });
}

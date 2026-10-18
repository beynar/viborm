// biome-ignore-all lint/suspicious/noMisplacedAssertion: node:assert oracles are called by the manual campaign.
// biome-ignore-all lint/suspicious/noBitwiseOperators: seeded PRNG arithmetic intentionally uses unsigned 32-bit words.
import assert from "node:assert/strict";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import { defaultOmit } from "@client/default-omit-extension";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { QueryResult } from "@drivers/types";
import { ForbiddenError, NotFoundError, QueryError } from "@errors";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type { ReplayTape } from "@tests/raptor3/harness/protocol";
import { Recorder } from "@tests/raptor3/harness/recorder";
import { v } from "@validation";
import Database from "better-sqlite3";

const ROLLBACK_ERROR = /manual-dst deliberate rollback/;

class RecordedDriver extends SQLite3Driver {
  dispatches = 0;
  readonly #recorder: Recorder;
  constructor(database: Database.Database, recorder: Recorder) {
    super({ client: database });
    this.#recorder = recorder;
  }
  protected override async execute<T>(
    database: Database.Database,
    sql: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.dispatches++;
    this.#recorder.record({
      kind: "dispatch",
      sql,
      parameters,
      transactionOpen: database.inTransaction,
    });
    const result = await super.execute<T>(database, sql, parameters);
    await this.#recorder.complete({
      sql,
      parameters,
      rows: result.rows,
      transactionOpen: database.inTransaction,
    });
    return result;
  }
}

interface Row {
  id: string;
  tenantId: string;
  ownerId: string;
  published: boolean;
  score: number;
  secret: string;
  deleted: boolean;
}
interface Actor {
  tenantId: string;
  userId?: string;
  admin: boolean;
}
type Action = "create" | "read" | "update" | "delete";
type Scope = `post.${Action}` | "organization.read";
const actions: Action[] = ["create", "read", "update", "delete"];
const scopeSets: (Scope[] | undefined)[] = [
  undefined,
  [],
  ["post.read", "organization.read"],
  ["post.update", "organization.read"],
  ["post.delete"],
  ["post.create"],
  [
    "post.read",
    "post.create",
    "post.update",
    "post.delete",
    "organization.read",
  ],
];
const actors: Actor[] = [
  { tenantId: "a", userId: "alice", admin: false },
  { tenantId: "a", userId: "bob", admin: false },
  { tenantId: "b", userId: "alice", admin: false },
  { tenantId: "b", userId: "bob", admin: true },
  { tenantId: "a", admin: false },
  { tenantId: "a", admin: true },
];

// Independent application oracle. It never reads compiled policies or ORM SQL.
function allows(
  row: Row,
  actor: Actor,
  scopes: Scope[] | undefined,
  action: Action
) {
  const scoped =
    scopes === undefined ||
    scopes.includes(`post.${action}`) ||
    (action === "read" &&
      (scopes.includes("post.update") || scopes.includes("post.delete")));
  const owned = actor.userId !== undefined && row.ownerId === actor.userId;
  const grant =
    action === "create" || action === "update"
      ? owned
      : action === "delete"
        ? actor.admin
        : row.published || owned || actor.admin;
  return row.tenantId === actor.tenantId && scoped && grant;
}
const ids = (rows: readonly { id: string }[]) =>
  rows.map((row) => row.id).sort();

export async function runExtensionSeed(
  seed: number,
  steps = 48,
  replay?: ReplayTape
) {
  const recorder = new Recorder(seed, replay, 100_000);
  const trace: {
    step: number;
    operation: string;
    actor: Actor;
    scopes: Scope[] | undefined;
    target: string;
  }[] = [];
  let state = (seed ^ 0x24_3f_6a_88) >>> 0;
  const pick = (length: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor((state / 0x1_00_00_00_00) * length);
  };
  return recorder.control(async () => {
    const database = new Database(":memory:");
    const organization = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      tenantId: s.string(),
      organization: s
        .toOne(() => organization)
        .fields("tenantId")
        .references("id"),
      ownerId: s.string(),
      published: s.boolean(),
      score: s.int(),
      secret: s.string(),
      deletedAt: s.dateTime().nullable(),
    });
    const schema = { organization, post };
    const driver = new RecordedDriver(database, recorder);
    const base = createClient({ schema, driver });
    const model = new Map<string, Row>();
    let nextId = 0;
    let failAfter = 0;
    const operations = [
      "read",
      "unique",
      "aggregate",
      "relations",
      "create",
      "createMany",
      "update",
      "updateMany",
      "delete",
      "deleteMany",
      "restore",
      "move",
      "access",
      "cache",
      "rollback",
      "fault",
      "upsert",
      "arrayTransaction",
    ];
    try {
      await syncLiveSchema(base);
      await base.organization.createMany({ data: [{ id: "a" }, { id: "b" }] });
      for (let i = 0; i < 12; i++) {
        const row: Row = {
          id: `p${nextId++}`,
          tenantId: i < 6 ? "a" : "b",
          ownerId: i % 2 ? "alice" : "bob",
          published: i % 3 === 0,
          score: i,
          secret: `secret-${i}`,
          deleted: i % 5 === 0,
        };
        model.set(row.id, row);
        await base.post.create({
          data: {
            id: row.id,
            tenantId: row.tenantId,
            ownerId: row.ownerId,
            published: row.published,
            score: row.score,
            secret: row.secret,
            deletedAt: row.deleted ? new Date("2025-01-01T00:00:00Z") : null,
          },
        });
      }
      const tombstones = softDelete({
        models: { post: { deletedAt: "deletedAt" } },
      });
      const policy = permissions({
        actor: v.object({
          tenantId: v.string(),
          userId: v.optional(v.string()),
          admin: v.boolean(),
        }),
        cache: "allow",
        models: {
          organization: {
            mandatory: { id: { actor: "tenantId" } },
            read: true,
          },
          post: {
            mandatory: { tenantId: { actor: "tenantId" } },
            read: {
              OR: [{ published: true }, { ownerId: { actor: "userId" } }],
            },
            update: { ownerId: { actor: "userId" } },
            delete: { actor: { admin: true } },
            create: { ownerId: { actor: "userId" } },
          },
        },
      });
      const db = base
        .$extends(defaultOmit<typeof schema>()({ post: { secret: true } }))
        .$extends(cache({ driver: new MemoryCache(), version: "manual-dst" }))
        .$extends(tombstones.rows)
        .$extends(policy)
        .$extends(tombstones.methods)
        .$extends({
          name: "manual-dst-fault",
          statement(context) {
            if (failAfter > 0 && --failAfter === 0) {
              recorder.record({
                kind: "injected-failure",
                cut: "statement-transform",
              });
              throw new Error("manual-dst injected statement failure");
            }
            return context.statement;
          },
        });
      // A statement transform disables caching by contract. The cached chain
      // must be built without that transform, while retaining the same policies.
      const cached = base
        .$extends(
          cache({ driver: new MemoryCache(), version: "manual-dst-cache" })
        )
        .$extends(tombstones.rows)
        .$extends(policy);
      const rawState = () =>
        database
          .prepare(
            "SELECT id, tenantId, ownerId, published, score, secret, deletedAt IS NOT NULL AS deleted FROM post ORDER BY id"
          )
          .all();
      const assertState = () =>
        assert.deepEqual(
          rawState(),
          [...model.values()]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((row) => ({
              ...row,
              published: Number(row.published),
              deleted: Number(row.deleted),
            }))
        );
      async function refused(
        call: () => Promise<unknown>,
        error: typeof ForbiddenError | typeof NotFoundError
      ) {
        await assert.rejects(call, error);
      }
      for (let step = 0; step < steps; step++) {
        // Each seed exercises every operation, then explores a generated suffix.
        const operation =
          operations[
            step < operations.length ? step : pick(operations.length)
          ]!;
        const actor = actors[pick(actors.length)]!;
        const scopes = scopeSets[pick(scopeSets.length)];
        const target = [...model.values()][pick(model.size)]!;
        const view = db.$as(actor, scopes);
        const visible = [...model.values()].filter(
          (row) => !row.deleted && allows(row, actor, scopes, "read")
        );
        const writable = (action: Action) =>
          [...model.values()].filter(
            (row) => !row.deleted && allows(row, actor, scopes, action)
          );
        trace.push({ step, operation, actor, scopes, target: target.id });
        recorder.record({ kind: "cut", name: `step:${step}:${operation}` });
        if (operation === "read") {
          const rows = await view.post.findMany({ orderBy: { id: "asc" } });
          assert.deepEqual(ids(rows), ids(visible));
          assert(
            rows.every((row) => !("secret" in row)),
            "default omit leaked secret"
          );
          assert.equal(await view.post.count(), visible.length);
        } else if (operation === "unique") {
          const row = await view.post.findUnique({ where: { id: target.id } });
          assert.equal(
            row?.id ?? null,
            visible.some((row) => row.id === target.id) ? target.id : null
          );
        } else if (operation === "aggregate") {
          const rows = await view.post.groupBy({
            by: ["published"],
            _count: { _all: true },
            _sum: { score: true },
          });
          const expected = [false, true].flatMap((published) => {
            const group = visible.filter((row) => row.published === published);
            return group.length
              ? [
                  {
                    published,
                    _count: { _all: group.length },
                    _sum: {
                      score: group.reduce((sum, row) => sum + row.score, 0),
                    },
                  },
                ]
              : [];
          });
          assert.deepEqual(
            rows.sort((a, b) => Number(a.published) - Number(b.published)),
            expected
          );
        } else if (operation === "relations") {
          const rows = await view.organization.findMany({
            include: {
              posts: { select: { id: true }, orderBy: { id: "asc" } },
            },
          });
          assert.deepEqual(
            rows.map((row) => ({ id: row.id, posts: ids(row.posts) })),
            scopes === undefined || scopes.includes("organization.read")
              ? [{ id: actor.tenantId, posts: ids(visible) }]
              : []
          );
        } else if (operation === "create" || operation === "createMany") {
          const proposed: Row = {
            id: `p${nextId++}`,
            tenantId: pick(3)
              ? actor.tenantId
              : actor.tenantId === "a"
                ? "b"
                : "a",
            ownerId: actor.userId ?? "alice",
            published: !!pick(2),
            score: pick(50),
            secret: "new",
            deleted: false,
          };
          const data = {
            id: proposed.id,
            tenantId: proposed.tenantId,
            ownerId: proposed.ownerId,
            published: proposed.published,
            score: proposed.score,
            secret: proposed.secret,
          };
          const proposals =
            operation === "create"
              ? [proposed]
              : [
                  proposed,
                  {
                    ...proposed,
                    id: `p${nextId++}`,
                    tenantId: pick(2)
                      ? proposed.tenantId
                      : proposed.tenantId === "a"
                        ? "b"
                        : "a",
                  },
                ];
          const run = () =>
            operation === "create"
              ? view.post.create({ data })
              : view.post.createMany({
                  data: proposals.map(({ deleted, ...row }) => row),
                });
          if (proposals.every((row) => allows(row, actor, scopes, "create"))) {
            await run();
            for (const row of proposals) model.set(row.id, row);
          } else await refused(run, ForbiddenError);
        } else if (operation === "update" || operation === "move") {
          const nextTenant = target.tenantId === "a" ? "b" : "a";
          const run = () =>
            view.post.update({
              where: { id: target.id },
              data:
                operation === "move"
                  ? { tenantId: nextTenant }
                  : { score: { increment: 1 } },
            });
          if (target.deleted || !allows(target, actor, scopes, "update"))
            await refused(run, NotFoundError);
          else if (operation === "move") await refused(run, ForbiddenError);
          else {
            await run();
            target.score++;
          }
        } else if (operation === "updateMany") {
          const rows = writable("update");
          assert.equal(
            (await view.post.updateMany({ data: { score: { increment: 1 } } }))
              .count,
            rows.length
          );
          for (const row of rows) row.score++;
        } else if (operation === "delete" || operation === "deleteMany") {
          if (operation === "deleteMany") {
            const rows = writable("delete");
            assert.equal((await view.post.deleteMany({})).count, rows.length);
            for (const row of rows) row.deleted = true;
          } else if (target.deleted || !allows(target, actor, scopes, "delete"))
            await refused(
              () => view.post.delete({ where: { id: target.id } }),
              NotFoundError
            );
          else {
            await view.post.delete({ where: { id: target.id } });
            target.deleted = true;
          }
        } else if (operation === "restore") {
          const run = () => view.post.restore({ where: { id: target.id } });
          if (
            target.deleted &&
            allows(target, actor, scopes, "update") &&
            allows(target, actor, scopes, "delete")
          ) {
            await run();
            target.deleted = false;
          } else await refused(run, NotFoundError);
        } else if (operation === "access") {
          for (const action of actions) {
            assert.equal(
              await view.post.can(action, { id: target.id }),
              !target.deleted &&
                allows(target, actor, scopes, "read") &&
                allows(target, actor, scopes, action)
            );
          }
        } else if (operation === "cache") {
          // Populate under one binding, then ask another binding using the same
          // cache. A write through this cache namespace must invalidate it.
          const c = cached.$as(actor, scopes).$withCache({ ttl: 60_000 });
          const select = { id: true, score: true } as const;
          const expected = () =>
            visible
              .map(({ id, score }) => ({ id, score }))
              .sort((a, b) => a.id.localeCompare(b.id));
          assert.deepEqual(
            await c.post.findMany({ select, orderBy: { id: "asc" } }),
            expected()
          );
          const dispatched = driver.dispatches;
          assert.deepEqual(
            await c.post.findMany({ select, orderBy: { id: "asc" } }),
            expected()
          );
          assert.equal(
            driver.dispatches,
            dispatched,
            "second cached read reached provider"
          );
          assert.deepEqual(
            await cached
              .$as(actor, [])
              .$withCache({ ttl: 60_000 })
              .post.findMany({ select }),
            []
          );
          const row = writable("update")[0];
          if (row) {
            await cached.$as(actor, scopes).post.update({
              where: { id: row.id },
              data: { score: { increment: 1 } },
            });
            row.score++;
          }
          const afterWrite = driver.dispatches;
          assert.deepEqual(
            await c.post.findMany({ select, orderBy: { id: "asc" } }),
            expected()
          );
          if (row)
            assert(
              driver.dispatches > afterWrite,
              "invalidated read did not reach provider"
            );
          // Other mutations deliberately use another cache namespace.
          await cached.$invalidate("*");
        } else if (operation === "upsert" || operation === "arrayTransaction") {
          const owner = db.$as(
            { tenantId: "a", userId: "alice", admin: false },
            ["post.create", "post.update"]
          );
          const row: Row = {
            id: `p${nextId++}`,
            tenantId: "a",
            ownerId: "alice",
            published: false,
            score: pick(50),
            secret: "batch",
            deleted: false,
          };
          const { deleted, ...data } = row;
          if (operation === "upsert") {
            await owner.post.upsert({
              where: { id: row.id },
              create: data,
              update: { score: { increment: 2 } },
            });
            model.set(row.id, row);
            assertState();
            await owner.post.upsert({
              where: { id: row.id },
              create: data,
              update: { score: { increment: 2 } },
            });
            row.score += 2;
          } else {
            const second = { ...data, id: `p${nextId++}` };
            await owner.$transaction([
              owner.post.create({ data }),
              owner.post.create({ data: second }),
            ]);
            model.set(row.id, row);
            model.set(second.id, { ...second, deleted: false });
            // A later forbidden member must roll back the preceding update.
            await assert.rejects(
              () =>
                owner.$transaction([
                  owner.post.update({
                    where: { id: row.id },
                    data: { score: { increment: 99 } },
                  }),
                  owner.post.create({
                    data: { ...data, id: `p${nextId++}`, tenantId: "b" },
                  }),
                ]),
              ForbiddenError
            );
          }
        } else if (operation === "rollback" || operation === "fault") {
          const admin = db.$as({ tenantId: "b", userId: "bob", admin: true });
          // A fresh witness prevents generated deletions from skipping rollback.
          const row: Row = {
            id: `p${nextId++}`,
            tenantId: "b",
            ownerId: "bob",
            published: false,
            score: 0,
            secret: "rollback",
            deleted: false,
          };
          const { deleted, ...data } = row;
          await admin.post.create({ data });
          model.set(row.id, row);
          await assert.rejects(
            () =>
              admin.$transaction(async (tx) => {
                await tx.post.update({
                  where: { id: row.id },
                  data: { score: { increment: 9 } },
                });
                assert.equal(
                  database
                    .prepare<[string], { score: number }>(
                      "SELECT score FROM post WHERE id = ?"
                    )
                    .get(row.id)?.score,
                  9
                );
                recorder.record({
                  kind: "cut",
                  name: "after-transaction-write",
                });
                if (operation === "rollback")
                  throw new Error("manual-dst deliberate rollback");
                failAfter = 1;
                await tx.post.count();
              }),
            operation === "fault" ? QueryError : ROLLBACK_ERROR
          );
          failAfter = 0;
        }
        assertState();
      }
      return {
        seed,
        steps,
        trace,
        tape: recorder.finish(),
        finalState: rawState(),
      };
    } catch (error) {
      throw new Error(
        `extensions seed ${seed}, trace ${JSON.stringify(trace)}`,
        { cause: error }
      );
    } finally {
      await base.$disconnect();
      if (database.open) database.close();
    }
  });
}

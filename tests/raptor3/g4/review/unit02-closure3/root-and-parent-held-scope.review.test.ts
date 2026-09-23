/**
 * G4-02 closure repair ROUND 3 — adversarial probes against the EDGE-KIND rule
 * (`commands/selection.ts` `nestedTargetAddressesConstraint`) and against the
 * two selector families NEITHER the author's 13-row scope cell NOR either of
 * this reviewer's earlier probes covered:
 *
 *  1. the ROOT verbs' own `unique: true` (`commands.ts:1164`, `:1257`) when the
 *     selector names a NON-primary-key unique. The shipped root `update` /
 *     `upsert` only spell the LOCATE through `buildWhereUnique`; when
 *     `!selectorNamesPrimaryKey()` they raise a presence guard built from
 *     `uniqueSelectorConjuncts(parent, this.parentWhere)`
 *     (`write-engine/UpdateOperation.ts:469`, `UpsertOperation.ts` three
 *     call sites) — the same recombination the nested reference family uses.
 *     Every earlier cell drove the root verbs by the PRIMARY KEY, where that
 *     guard does not exist.
 *  2. a PARENT-HELD to-one target (`relation.position === "parentHeld"`,
 *     `RecordUpdateCompiler.ts:3708-3722` `parentHeldCorrelation`), the THIRD
 *     shipped position the candidate's two-way `edge.kind` folds into
 *     "reference". Every earlier nested cell drove the relation from the
 *     parent (`owner.notes`, a child-held to-many, or `owner.tags`, a
 *     junction); none drove `note.owner`, where the FK lives on the row being
 *     updated.
 *
 * Runs only with `VIBORM_RAPTOR3_PROVIDER=mysql` and
 * `VIBORM_RAPTOR3_PROVIDER_PORT=<port>` (the cells need a `_ci` collation).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { describe, it } from "vitest";

const provider = process.env.VIBORM_RAPTOR3_PROVIDER;
const port = Number(process.env.VIBORM_RAPTOR3_PROVIDER_PORT ?? "0");

interface Outcome {
  readonly answer: string;
  readonly owners: unknown[];
  readonly notes: unknown[];
}

type Call = (
  model: string,
  operation: string,
  args: unknown
) => Promise<unknown>;

describe.runIf(provider === "mysql" && port > 0)(
  "G4-02 closure round 3 review — the root non-PK unique and the parent-held target",
  () => {
    it("answers a root verb addressed by a NON-primary-key unique the way the shipped engine does", async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const owners = `r3c3_o_${suffix}`;
      const notes = `r3c3_n_${suffix}`;

      const owner = s
        .model({
          id: s.string().id(),
          email: s.string().unique(),
          name: s.string(),
          notes: s.toMany(() => note),
        })
        .map(owners);
      const note = s
        .model({
          id: s.string().id(),
          title: s.string(),
          ownerId: s.string().nullable(),
          owner: s
            .toOne(() => owner)
            .fields("ownerId")
            .references("id"),
        })
        .map(notes);
      const schema = { owner, note };

      const connect = () =>
        new MySQL2Driver({
          options: {
            host: "127.0.0.1",
            port,
            database: "raptor3_g2",
            user: "root",
            password: "",
            connectionLimit: 2,
            connectTimeout: 10_000,
          },
        });
      const setup = connect();
      await setup._executeRaw(
        `CREATE TABLE ${owners} (id VARCHAR(191) PRIMARY KEY NOT NULL, email VARCHAR(191) NOT NULL UNIQUE, name VARCHAR(191) NOT NULL)`
      );
      await setup._executeRaw(
        `CREATE TABLE ${notes} (id VARCHAR(191) PRIMARY KEY NOT NULL, title VARCHAR(191) NOT NULL, ownerId VARCHAR(191) NULL, FOREIGN KEY(ownerId) REFERENCES ${owners}(id))`
      );
      const collation = await setup._executeRaw<{ TABLE_COLLATION: string }>(
        `SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_NAME = '${owners}'`
      );
      assert.match(
        collation.rows[0]!.TABLE_COLLATION,
        /_ci$/,
        "the cells need a case-insensitive collation to be cells at all"
      );

      const seed = async () => {
        await setup._executeRaw(`DELETE FROM ${notes}`);
        await setup._executeRaw(`DELETE FROM ${owners}`);
        await setup._executeRaw(
          `INSERT INTO ${owners} (id, email, name) VALUES ('wanted','claim@x','winner')`
        );
        await setup._executeRaw(
          `INSERT INTO ${notes} (id, title, ownerId) VALUES ('n1','T',NULL)`
        );
      };

      const run = async (
        engine: "shipped" | "candidate",
        request: (call: Call) => Promise<unknown>
      ): Promise<Outcome> => {
        await seed();
        const driver = connect();
        let answer: string;
        try {
          const client = createClient({ schema, driver });
          const candidate = createCommandEngine({ schema, driver });
          const call: Call = (model, operation, args) =>
            engine === "shipped"
              ? (
                  client as unknown as Record<
                    string,
                    Record<string, (args: unknown) => Promise<unknown>>
                  >
                )[model]![operation]!(args)
              : (
                  candidate as unknown as {
                    execute(
                      model: string,
                      operation: string,
                      args: unknown
                    ): Promise<unknown>;
                  }
                ).execute(model, operation, args);
          answer = `ok:${JSON.stringify(await request(call))}`;
        } catch (error) {
          answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
        } finally {
          await driver.disconnect();
        }
        const ownerRows = await setup._executeRaw<Record<string, unknown>>(
          `SELECT id, email, name FROM ${owners} ORDER BY id`
        );
        const noteRows = await setup._executeRaw<Record<string, unknown>>(
          `SELECT id, title, ownerId FROM ${notes} ORDER BY id`
        );
        return { answer, owners: ownerRows.rows, notes: noteRows.rows };
      };

      const cells: [string, (call: Call) => Promise<unknown>][] = [
        // --- root verbs by a NON-PK unique, collation-equal ------------------
        [
          "root update by a collation-equal NON-PK unique",
          (call) =>
            call("owner", "update", {
              where: { email: "CLAIM@X" },
              data: { name: "updated" },
            }),
        ],
        [
          "root update by a NON-PK unique, exact bytes (control)",
          (call) =>
            call("owner", "update", {
              where: { email: "claim@x" },
              data: { name: "updated" },
            }),
        ],
        [
          "root delete by a collation-equal NON-PK unique",
          (call) =>
            call("owner", "delete", { where: { email: "CLAIM@X" } }),
        ],
        [
          "root upsert by a collation-equal NON-PK unique (update arm)",
          (call) =>
            call("owner", "upsert", {
              where: { email: "CLAIM@X" },
              create: { id: "fresh", email: "CLAIM@X", name: "created" },
              update: { name: "updated" },
            }),
        ],
        [
          "root findUnique by a collation-equal NON-PK unique",
          (call) =>
            call("owner", "findUnique", { where: { email: "CLAIM@X" } }),
        ],
        [
          "root update by a collation-equal PK (control)",
          (call) =>
            call("owner", "update", {
              where: { id: "WANTED" },
              data: { name: "updated" },
            }),
        ],
        [
          "root updateMany by a collation-equal filter (must stay a filter)",
          (call) =>
            call("owner", "updateMany", {
              where: { email: "CLAIM@X" },
              data: { name: "updated" },
            }),
        ],
        // --- the parent-held to-one target ----------------------------------
        [
          "parent-held connect on a collation-equal key",
          (call) =>
            call("note", "update", {
              where: { id: "n1" },
              data: { owner: { connect: { id: "WANTED" } } },
            }),
        ],
        [
          "parent-held connect, exact bytes (control)",
          (call) =>
            call("note", "update", {
              where: { id: "n1" },
              data: { owner: { connect: { id: "wanted" } } },
            }),
        ],
        [
          "parent-held connect by a collation-equal NON-PK unique",
          (call) =>
            call("note", "update", {
              where: { id: "n1" },
              data: { owner: { connect: { email: "CLAIM@X" } } },
            }),
        ],
        [
          "parent-held connectOrCreate on a collation-equal key",
          (call) =>
            call("note", "update", {
              where: { id: "n1" },
              data: {
                owner: {
                  connectOrCreate: {
                    where: { id: "WANTED" },
                    create: { id: "WANTED", email: "new@x", name: "created" },
                  },
                },
              },
            }),
        ],
        [
          "parent-held disconnect of a linked row (no selector — control)",
          async (call) => {
            await call("note", "update", {
              where: { id: "n1" },
              data: { owner: { connect: { id: "wanted" } } },
            });
            return call("note", "update", {
              where: { id: "n1" },
              data: { owner: { disconnect: true } },
            });
          },
        ],
        [
          "parent-held update of a linked row (no selector — control)",
          async (call) => {
            await call("note", "update", {
              where: { id: "n1" },
              data: { owner: { connect: { id: "wanted" } } },
            });
            return call("note", "update", {
              where: { id: "n1" },
              data: { owner: { update: { name: "through-child" } } },
            });
          },
        ],
      ];

      const divergences: string[] = [];
      try {
        for (const [name, request] of cells) {
          const shipped = await run("shipped", request);
          const candidate = await run("candidate", request);
          // eslint-disable-next-line no-console
          console.log(
            `[${name}]\n  shipped   ${shipped.answer}\n            owners ${JSON.stringify(shipped.owners)} notes ${JSON.stringify(shipped.notes)}\n  candidate ${candidate.answer}\n            owners ${JSON.stringify(candidate.owners)} notes ${JSON.stringify(candidate.notes)}`
          );
          if (
            shipped.answer !== candidate.answer ||
            JSON.stringify(shipped.owners) !== JSON.stringify(candidate.owners) ||
            JSON.stringify(shipped.notes) !== JSON.stringify(candidate.notes)
          )
            divergences.push(name);
        }
      } finally {
        await setup._executeRaw(`DROP TABLE IF EXISTS ${notes}`);
        await setup._executeRaw(`DROP TABLE IF EXISTS ${owners}`);
        await setup.disconnect();
      }
      assert.deepEqual(divergences, [], "diverging call sites");
    }, 180_000);
  }
);

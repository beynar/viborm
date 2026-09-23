/**
 * G4-02 closure repair ROUND 3 — the one verb whose SHIPPED spelling is mixed,
 * on the edge kind round 3 widened.
 *
 * `nestedTargetAddressesConstraint` returns `true` for EVERY verb on a junction
 * edge. The shipped nested `upsert` is the one place the engine itself spells
 * the two phases differently: the planning probe is `buildFindUnique`
 * (`write-engine/RelationUpsertPart.ts:265`) and the batch GUARD is
 * `uniqueSelectorConjuncts(childScope, where)` (`:578`) — a filter. Neither the
 * author's 13-row scope cell nor this reviewer's round-5/round-6 probes put a
 * nested `upsert` on a JUNCTION edge: every `upsert` cell in the estate drives a
 * child-held to-many.
 *
 * Cells: the update arm (target present, collation-equal and exact), the create
 * arm (target absent), and `connectOrCreate` on the same edge for contrast.
 *
 * Runs only with `VIBORM_RAPTOR3_PROVIDER=mysql` and
 * `VIBORM_RAPTOR3_PROVIDER_PORT=<port>`.
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
  readonly links: unknown[];
  readonly tags: unknown[];
}

type Call = (
  model: string,
  operation: string,
  args: unknown
) => Promise<unknown>;

describe.runIf(provider === "mysql" && port > 0)(
  "G4-02 closure round 3 review — a nested upsert on a JUNCTION edge",
  () => {
    it("answers a junction upsert the way the shipped engine does", async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const owners = `r3c3u_o_${suffix}`;
      const tags = `r3c3u_t_${suffix}`;
      const links = `r3c3u_l_${suffix}`;

      const owner = s
        .model({
          id: s.string().id(),
          name: s.string(),
          tags: s
            .toMany(() => tag)
            .through(links)
            .source("ownerId")
            .target("tagId"),
        })
        .map(owners);
      const tag = s
        .model({
          id: s.string().id(),
          label: s.string(),
          owners: s.toMany(() => owner),
        })
        .map(tags);
      const schema = { owner, tag };

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
        `CREATE TABLE ${owners} (id VARCHAR(191) PRIMARY KEY NOT NULL, name VARCHAR(191) NOT NULL)`
      );
      await setup._executeRaw(
        `CREATE TABLE ${tags} (id VARCHAR(191) PRIMARY KEY NOT NULL, label VARCHAR(191) NOT NULL)`
      );
      await setup._executeRaw(
        `CREATE TABLE ${links} (ownerId VARCHAR(191) NOT NULL, tagId VARCHAR(191) NOT NULL, PRIMARY KEY (ownerId, tagId), FOREIGN KEY(ownerId) REFERENCES ${owners}(id), FOREIGN KEY(tagId) REFERENCES ${tags}(id))`
      );
      const collation = await setup._executeRaw<{ TABLE_COLLATION: string }>(
        `SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_NAME = '${tags}'`
      );
      assert.match(
        collation.rows[0]!.TABLE_COLLATION,
        /_ci$/,
        "the cells need a case-insensitive collation to be cells at all"
      );

      const seed = async (linked: boolean) => {
        await setup._executeRaw(`DELETE FROM ${links}`);
        await setup._executeRaw(`DELETE FROM ${tags}`);
        await setup._executeRaw(`DELETE FROM ${owners}`);
        await setup._executeRaw(
          `INSERT INTO ${owners} (id, name) VALUES ('wanted','winner')`
        );
        if (linked) {
          await setup._executeRaw(
            `INSERT INTO ${tags} (id, label) VALUES ('g1','tag')`
          );
          await setup._executeRaw(
            `INSERT INTO ${links} (ownerId, tagId) VALUES ('wanted','g1')`
          );
        }
      };

      const run = async (
        engine: "shipped" | "candidate",
        linked: boolean,
        request: (call: Call) => Promise<unknown>
      ): Promise<Outcome> => {
        await seed(linked);
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
        const linkRows = await setup._executeRaw<Record<string, unknown>>(
          `SELECT ownerId, tagId FROM ${links} ORDER BY ownerId, tagId`
        );
        const tagRows = await setup._executeRaw<Record<string, unknown>>(
          `SELECT id, label FROM ${tags} ORDER BY id`
        );
        return { answer, links: linkRows.rows, tags: tagRows.rows };
      };

      const cells: [string, boolean, (call: Call) => Promise<unknown>][] = [
        [
          "junction upsert, target PRESENT, collation-equal selector",
          true,
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                tags: {
                  upsert: [
                    {
                      where: { id: "G1" },
                      create: { id: "G1", label: "created" },
                      update: { label: "updated" },
                    },
                  ],
                },
              },
            }),
        ],
        [
          "junction upsert, target PRESENT, exact bytes (control)",
          true,
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                tags: {
                  upsert: [
                    {
                      where: { id: "g1" },
                      create: { id: "g1", label: "created" },
                      update: { label: "updated" },
                    },
                  ],
                },
              },
            }),
        ],
        [
          "junction upsert, target ABSENT (create arm)",
          false,
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                tags: {
                  upsert: [
                    {
                      where: { id: "G1" },
                      create: { id: "G1", label: "created" },
                      update: { label: "updated" },
                    },
                  ],
                },
              },
            }),
        ],
        [
          "junction connectOrCreate on a collation-equal key (contrast)",
          true,
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                tags: {
                  connectOrCreate: [
                    {
                      where: { id: "G1" },
                      create: { id: "G1", label: "created" },
                    },
                  ],
                },
              },
            }),
        ],
      ];

      const divergences: string[] = [];
      try {
        for (const [name, linked, request] of cells) {
          const shipped = await run("shipped", linked, request);
          const candidate = await run("candidate", linked, request);
          // eslint-disable-next-line no-console
          console.log(
            `[${name}]\n  shipped   ${shipped.answer}\n            links ${JSON.stringify(shipped.links)} tags ${JSON.stringify(shipped.tags)}\n  candidate ${candidate.answer}\n            links ${JSON.stringify(candidate.links)} tags ${JSON.stringify(candidate.tags)}`
          );
          if (
            shipped.answer !== candidate.answer ||
            JSON.stringify(shipped.links) !== JSON.stringify(candidate.links) ||
            JSON.stringify(shipped.tags) !== JSON.stringify(candidate.tags)
          )
            divergences.push(name);
        }
      } finally {
        await setup._executeRaw(`DROP TABLE IF EXISTS ${links}`);
        await setup._executeRaw(`DROP TABLE IF EXISTS ${tags}`);
        await setup._executeRaw(`DROP TABLE IF EXISTS ${owners}`);
        await setup.disconnect();
      }
      assert.deepEqual(divergences, [], "diverging call sites");
    }, 180_000);
  }
);

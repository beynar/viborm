/**
 * G4-02 closure repair ROUND 2 — adversarial probes against the NARROWED
 * discriminator scope (`relation-body.ts:214` no longer marks the
 * `disconnect`/`delete` target unique; `:357-361` prepares with
 * `verb !== "update"`; `setTargets` keeps `unique: true`).
 *
 * Round 1 of this review measured the three call sites the round-5 rule had
 * widened. These cells measure the ones round 2 LEFT unique or newly made
 * filters, plus the columns round 1's row dump could not see:
 *
 *  - the nested `upsert` probe, whose shipped counterpart is
 *    `RelationUpsertPart.ts:265` (`buildFindUnique`) while its GUARD is
 *    `:578` (`uniqueSelectorConjuncts`) — the one place the shipped engine
 *    itself spells the two halves differently. Round 1's dump projected only
 *    `id, ownerId`, so a divergent `title` was invisible;
 *  - the nested `connectOrCreate` probe on a collation-equal key (R-D4's own
 *    family, which the note pins for `connect`);
 *  - a JUNCTION `connect` / `disconnect` target, which reaches neither of the
 *    two changed call sites through the reference path;
 *  - a nested `delete` addressed by a COMPOUND unique selector, and a nested
 *    `update` addressed by an EXTENDED selector — the two shapes where the
 *    "verb, not the object's shape" rule has to hold;
 *  - exact-byte controls, so a cell that agrees because BOTH engines refuse is
 *    distinguishable from one that agrees because both act.
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
  readonly notes: unknown[];
  readonly parts: unknown[];
  readonly links: unknown[];
  readonly tags: unknown[];
}

describe.runIf(provider === "mysql" && port > 0)(
  "G4-02 closure round 2 review — the narrowed scope's other call sites",
  () => {
    it("answers every remaining nested call site the way the shipped engine does", async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const owners = `r3c2_o_${suffix}`;
      const notes = `r3c2_n_${suffix}`;
      const parts = `r3c2_p_${suffix}`;
      const tags = `r3c2_t_${suffix}`;
      const links = `r3c2_l_${suffix}`;

      const owner = s
        .model({
          id: s.string().id(),
          name: s.string(),
          notes: s.toMany(() => note),
          parts: s.toMany(() => part),
          tags: s
            .toMany(() => tag)
            .through(links)
            .source("ownerId")
            .target("tagId"),
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
      const part = s
        .model({
          region: s.string(),
          slug: s.string(),
          label: s.string(),
          ownerId: s.string().nullable(),
          owner: s
            .toOne(() => owner)
            .fields("ownerId")
            .references("id"),
        })
        .id(["region", "slug"])
        .map(parts);
      const tag = s
        .model({
          id: s.string().id(),
          label: s.string(),
          owners: s.toMany(() => owner),
        })
        .map(tags);
      const schema = { owner, note, part, tag };

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
        `CREATE TABLE ${notes} (id VARCHAR(191) PRIMARY KEY NOT NULL, title VARCHAR(191) NOT NULL, ownerId VARCHAR(191) NULL, FOREIGN KEY(ownerId) REFERENCES ${owners}(id))`
      );
      await setup._executeRaw(
        `CREATE TABLE ${parts} (region VARCHAR(191) NOT NULL, slug VARCHAR(191) NOT NULL, label VARCHAR(191) NOT NULL, ownerId VARCHAR(191) NULL, PRIMARY KEY (region, slug), FOREIGN KEY(ownerId) REFERENCES ${owners}(id))`
      );
      await setup._executeRaw(
        `CREATE TABLE ${tags} (id VARCHAR(191) PRIMARY KEY NOT NULL, label VARCHAR(191) NOT NULL)`
      );
      await setup._executeRaw(
        `CREATE TABLE ${links} (ownerId VARCHAR(191) NOT NULL, tagId VARCHAR(191) NOT NULL, PRIMARY KEY (ownerId, tagId), FOREIGN KEY(ownerId) REFERENCES ${owners}(id), FOREIGN KEY(tagId) REFERENCES ${tags}(id))`
      );
      const seed = async () => {
        await setup._executeRaw(`DELETE FROM ${links}`);
        await setup._executeRaw(`DELETE FROM ${notes}`);
        await setup._executeRaw(`DELETE FROM ${parts}`);
        await setup._executeRaw(`DELETE FROM ${tags}`);
        await setup._executeRaw(`DELETE FROM ${owners}`);
        await setup._executeRaw(
          `INSERT INTO ${owners} (id, name) VALUES ('wanted','winner')`
        );
        await setup._executeRaw(
          `INSERT INTO ${notes} (id, title, ownerId) VALUES ('n1','T','wanted')`
        );
        await setup._executeRaw(
          `INSERT INTO ${parts} (region, slug, label, ownerId) VALUES ('eu','alpha','p','wanted')`
        );
        await setup._executeRaw(
          `INSERT INTO ${tags} (id, label) VALUES ('g1','tag')`
        );
        await setup._executeRaw(
          `INSERT INTO ${links} (ownerId, tagId) VALUES ('wanted','g1')`
        );
      };
      const collation = await setup._executeRaw<{ TABLE_COLLATION: string }>(
        `SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_NAME = '${notes}'`
      );
      assert.match(
        collation.rows[0]!.TABLE_COLLATION,
        /_ci$/,
        "the cells need a case-insensitive collation to be cells at all"
      );

      const run = async (
        engine: "shipped" | "candidate",
        request: (
          call: (
            model: string,
            operation: string,
            args: unknown
          ) => Promise<unknown>
        ) => Promise<unknown>
      ): Promise<Outcome> => {
        await seed();
        const driver = connect();
        let answer: string;
        try {
          const client = createClient({ schema, driver });
          const candidate = createCommandEngine({ schema, driver });
          const call = (model: string, operation: string, args: unknown) =>
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
        const noteRows = await setup._executeRaw<Record<string, unknown>>(
          `SELECT id, title, ownerId FROM ${notes} ORDER BY id`
        );
        const partRows = await setup._executeRaw<Record<string, unknown>>(
          `SELECT region, slug, label, ownerId FROM ${parts} ORDER BY region, slug`
        );
        const linkRows = await setup._executeRaw<Record<string, unknown>>(
          `SELECT ownerId, tagId FROM ${links} ORDER BY ownerId, tagId`
        );
        const tagRows = await setup._executeRaw<Record<string, unknown>>(
          `SELECT id, label FROM ${tags} ORDER BY id`
        );
        return {
          answer,
          notes: noteRows.rows,
          parts: partRows.rows,
          links: linkRows.rows,
          tags: tagRows.rows,
        };
      };

      const cells: [
        string,
        (
          call: (
            model: string,
            operation: string,
            args: unknown
          ) => Promise<unknown>
        ) => Promise<unknown>,
      ][] = [
        [
          "nested upsert, collation-equal selector (the title is the evidence)",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                notes: {
                  upsert: [
                    {
                      where: { id: "N1" },
                      create: { id: "N1", title: "created" },
                      update: { title: "updated" },
                    },
                  ],
                },
              },
            }),
        ],
        [
          "nested upsert, exact-byte selector (control)",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                notes: {
                  upsert: [
                    {
                      where: { id: "n1" },
                      create: { id: "n1", title: "created" },
                      update: { title: "updated" },
                    },
                  ],
                },
              },
            }),
        ],
        [
          "nested connectOrCreate on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                notes: {
                  connectOrCreate: [
                    {
                      where: { id: "N1" },
                      create: { id: "N1", title: "created" },
                    },
                  ],
                },
              },
            }),
        ],
        [
          "nested update, exact-byte selector (control)",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                notes: {
                  update: [{ where: { id: "n1" }, data: { title: "u" } }],
                },
              },
            }),
        ],
        [
          "nested update, EXTENDED selector, collation-equal halves",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                notes: {
                  update: [
                    { where: { id: "N1", title: "t" }, data: { title: "u" } },
                  ],
                },
              },
            }),
        ],
        [
          "nested delete, COMPOUND selector, collation-equal members",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                parts: {
                  delete: [{ region_slug: { region: "EU", slug: "ALPHA" } }],
                },
              },
            }),
        ],
        [
          "nested delete, COMPOUND selector, exact bytes (control)",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                parts: {
                  delete: [{ region_slug: { region: "eu", slug: "alpha" } }],
                },
              },
            }),
        ],
        [
          "nested set, COMPOUND selector, collation-equal members",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                parts: {
                  set: [{ region_slug: { region: "EU", slug: "ALPHA" } }],
                },
              },
            }),
        ],
        [
          "junction connect on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { tags: { connect: [{ id: "G1" }] } },
            }),
        ],
        [
          "junction disconnect on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { tags: { disconnect: [{ id: "G1" }] } },
            }),
        ],
        [
          "junction disconnect, exact bytes (control)",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { tags: { disconnect: [{ id: "g1" }] } },
            }),
        ],
        [
          "junction delete on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { tags: { delete: [{ id: "G1" }] } },
            }),
        ],
        [
          "junction delete, exact bytes (control)",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { tags: { delete: [{ id: "g1" }] } },
            }),
        ],
        [
          "junction set on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { tags: { set: [{ id: "G1" }] } },
            }),
        ],
        [
          "junction update on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                tags: {
                  update: [{ where: { id: "G1" }, data: { label: "u" } }],
                },
              },
            }),
        ],
      ];

      const divergences: string[] = [];
      try {
        for (const [name, request] of cells) {
          const shipped = await run("shipped", request);
          const candidate = await run("candidate", request);
          // biome-ignore lint/suspicious/noConsole: the probe's measurement IS its output.
          console.log(
            `[${name}]\n  shipped   ${shipped.answer}\n            notes ${JSON.stringify(shipped.notes)} parts ${JSON.stringify(shipped.parts)} links ${JSON.stringify(shipped.links)} tags ${JSON.stringify(shipped.tags)}\n  candidate ${candidate.answer}\n            notes ${JSON.stringify(candidate.notes)} parts ${JSON.stringify(candidate.parts)} links ${JSON.stringify(candidate.links)} tags ${JSON.stringify(candidate.tags)}`
          );
          try {
            assert.deepEqual(candidate, shipped);
          } catch {
            divergences.push(name);
          }
        }
      } finally {
        await setup._executeRaw(`DROP TABLE ${links}`);
        await setup._executeRaw(`DROP TABLE ${notes}`);
        await setup._executeRaw(`DROP TABLE ${parts}`);
        await setup._executeRaw(`DROP TABLE ${tags}`);
        await setup._executeRaw(`DROP TABLE ${owners}`);
        await setup.disconnect();
      }
      assert.deepEqual(divergences, [], "diverging call sites");
    }, 180_000);
  }
);

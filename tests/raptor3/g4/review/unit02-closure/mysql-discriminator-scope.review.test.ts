/**
 * G4-02 CLOSURE review — adversarial probes against obligation 1, the unique
 * DISCRIMINATOR repair (`Queries.prepareSelector(model, where, unique)` +
 * `lowerOperation`'s `target.key === true` clause).
 *
 * The author's own native cell (`tests/raptor3/g4/unit02/unique-discriminator.test.ts`)
 * measures `findUnique` by key, `findUnique` by a unique non-key, `findFirst`,
 * root `update`, and a `connectOrCreate` probe. These cells measure the call
 * sites the repair ALSO changed and the author did not measure differentially:
 * root `delete`, root `upsert`'s lookup, the nested `connect` / `set` /
 * `disconnect` / `delete` target lookups (`relation-body.ts:214`, `:346`,
 * `:580`, reached through `SelectionSource.unique`), a COMPOUND unique
 * selector, and the extended unique `where`'s filter half — each against the
 * client's own shipped engine on a case-insensitive collation, where the two
 * spellings answer differently.
 *
 * Runs only with `VIBORM_RAPTOR3_PROVIDER=mysql` and
 * `VIBORM_RAPTOR3_PROVIDER_PORT=<port>`; the container is recorded in the
 * receipt beside this file.
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

describe.runIf(provider === "mysql" && port > 0)(
  "G4-02 closure review — the discriminator repair's other call sites",
  () => {
    it("answers every admitted-unique call site the way the shipped engine does", async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const owners = `r3c_disc_o_${suffix}`;
      const notes = `r3c_disc_n_${suffix}`;
      const pairs = `r3c_disc_p_${suffix}`;

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
      const pair = s
        .model({
          region: s.string(),
          slug: s.string(),
          label: s.string(),
        })
        .id(["region", "slug"])
        .map(pairs);
      const schema = { owner, note, pair };

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
      await setup._executeRaw(
        `CREATE TABLE ${pairs} (region VARCHAR(191) NOT NULL, slug VARCHAR(191) NOT NULL, label VARCHAR(191) NOT NULL, PRIMARY KEY (region, slug))`
      );
      const seed = async () => {
        await setup._executeRaw(`DELETE FROM ${notes}`);
        await setup._executeRaw(`DELETE FROM ${owners}`);
        await setup._executeRaw(`DELETE FROM ${pairs}`);
        await setup._executeRaw(
          `INSERT INTO ${owners} (id, email, name) VALUES ('wanted','claim@x','winner')`
        );
        await setup._executeRaw(
          `INSERT INTO ${notes} (id, title, ownerId) VALUES ('n1','T','wanted')`
        );
        await setup._executeRaw(
          `INSERT INTO ${pairs} (region, slug, label) VALUES ('eu','alpha','p')`
        );
      };
      const collation = await setup._executeRaw<{ TABLE_COLLATION: string }>(
        `SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_NAME = '${owners}'`
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
        const ownerRows = await setup._executeRaw<Record<string, unknown>>(
          `SELECT id, email, name FROM ${owners} ORDER BY id`
        );
        const noteRows = await setup._executeRaw<Record<string, unknown>>(
          `SELECT id, ownerId FROM ${notes} ORDER BY id`
        );
        return {
          answer,
          owners: ownerRows.rows,
          notes: noteRows.rows,
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
          "root delete by a collation-equal key",
          (call) => call("owner", "delete", { where: { id: "WANTED" } }),
        ],
        [
          "root upsert whose lookup is collation-equal",
          (call) =>
            call("owner", "upsert", {
              where: { id: "WANTED" },
              create: { id: "WANTED", email: "new@x", name: "created" },
              update: { name: "updated" },
            }),
        ],
        [
          "nested connect on a collation-equal key",
          (call) =>
            call("note", "create", {
              data: {
                id: "n2",
                title: "T",
                owner: { connect: { id: "WANTED" } },
              },
            }),
        ],
        [
          "nested set on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { notes: { set: [{ id: "N1" }] } },
            }),
        ],
        [
          "nested disconnect on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { notes: { disconnect: [{ id: "N1" }] } },
            }),
        ],
        [
          "nested delete on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { notes: { delete: [{ id: "N1" }] } },
            }),
        ],
        [
          "nested update on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { notes: { update: [{ where: { id: "N1" }, data: { title: "u" } }] } },
            }),
        ],
        [
          "nested upsert on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                notes: {
                  upsert: [
                    {
                      where: { id: "N1" },
                      create: { id: "N1", title: "c" },
                      update: { title: "u" },
                    },
                  ],
                },
              },
            }),
        ],
        [
          "compound unique selector, collation-equal members",
          (call) =>
            call("pair", "findUnique", {
              where: { region_slug: { region: "EU", slug: "ALPHA" } },
            }),
        ],
        [
          "extended unique where: the filter half stays case-sensitive",
          (call) =>
            call("owner", "findUnique", {
              where: { id: "WANTED", name: "WINNER" },
            }),
        ],
        [
          "deleteMany by a collation-equal filter",
          (call) => call("owner", "deleteMany", { where: { id: "WANTED" } }),
        ],
      ];

      const divergences: string[] = [];
      try {
        for (const [name, request] of cells) {
          const shipped = await run("shipped", request);
          const candidate = await run("candidate", request);
          // biome-ignore lint/suspicious/noConsole: the probe's measurement IS its output.
          console.log(
            `[${name}]\n  shipped   ${shipped.answer}\n            owners ${JSON.stringify(shipped.owners)} notes ${JSON.stringify(shipped.notes)}\n  candidate ${candidate.answer}\n            owners ${JSON.stringify(candidate.owners)} notes ${JSON.stringify(candidate.notes)}`
          );
          try {
            assert.deepEqual(candidate, shipped);
          } catch {
            divergences.push(name);
          }
        }
      } finally {
        await setup._executeRaw(`DROP TABLE ${notes}`);
        await setup._executeRaw(`DROP TABLE ${owners}`);
        await setup._executeRaw(`DROP TABLE ${pairs}`);
        await setup.disconnect();
      }
      assert.deepEqual(divergences, [], "diverging call sites");
    }, 180_000);
  }
);

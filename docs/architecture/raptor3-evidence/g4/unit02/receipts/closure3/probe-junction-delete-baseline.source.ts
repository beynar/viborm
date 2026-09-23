/**
 * G4-02 closure repair ROUND 3 — CLASSIFICATION probe for the reviewer's
 * finding 10 (`unit02-closure-review-followup.md`): a junction `delete`
 * addressed by the target's EXACT bytes answers `ok` on the shipped engine
 * (link row and target row both gone) and `ForeignKeyError` on the candidate.
 *
 * This is the reviewer's control cell, minimized to the one request and run
 * unchanged in two trees: the G4 candidate tree and the clean `0cc61e61`
 * worktree. It repairs nothing and asserts nothing about the candidate; it
 * prints both engines' answer and the rows, so the two trees' outputs can be
 * compared byte for byte.
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

describe.runIf(provider === "mysql" && port > 0)(
  "G4-02 round 3 classification — junction delete by exact bytes",
  () => {
    it("prints both engines' answer and rows for a junction delete", async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const owners = `r3c3_o_${suffix}`;
      const tags = `r3c3_t_${suffix}`;
      const links = `r3c3_l_${suffix}`;

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
      const seed = async () => {
        await setup._executeRaw(`DELETE FROM ${links}`);
        await setup._executeRaw(`DELETE FROM ${tags}`);
        await setup._executeRaw(`DELETE FROM ${owners}`);
        await setup._executeRaw(
          `INSERT INTO ${owners} (id, name) VALUES ('wanted','winner')`
        );
        await setup._executeRaw(
          `INSERT INTO ${tags} (id, label) VALUES ('g1','tag')`
        );
        await setup._executeRaw(
          `INSERT INTO ${links} (ownerId, tagId) VALUES ('wanted','g1')`
        );
      };
      const collation = await setup._executeRaw<{ TABLE_COLLATION: string }>(
        `SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_NAME = '${tags}'`
      );
      assert.match(collation.rows[0]!.TABLE_COLLATION, /_ci$/);

      const run = async (engine: "shipped" | "candidate") => {
        await seed();
        const driver = connect();
        let answer: string;
        try {
          const client = createClient({ schema, driver });
          const candidate = createCommandEngine({ schema, driver });
          const args = {
            where: { id: "wanted" },
            data: { tags: { delete: [{ id: "g1" }] } },
          };
          const result =
            engine === "shipped"
              ? await (
                  client as unknown as {
                    owner: { update(args: unknown): Promise<unknown> };
                  }
                ).owner.update(args)
              : await (
                  candidate as unknown as {
                    execute(
                      model: string,
                      operation: string,
                      args: unknown
                    ): Promise<unknown>;
                  }
                ).execute("owner", "update", args);
          answer = `ok:${JSON.stringify(result)}`;
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
        return {
          answer,
          links: linkRows.rows,
          tags: tagRows.rows,
        };
      };

      try {
        for (const engine of ["shipped", "candidate"] as const) {
          const outcome = await run(engine);
          // biome-ignore lint/suspicious/noConsole: the probe's measurement IS its output.
          console.log(
            `[junction delete, exact bytes] ${engine}\n  answer ${outcome.answer}\n  links ${JSON.stringify(outcome.links)} tags ${JSON.stringify(outcome.tags)}`
          );
        }
      } finally {
        await setup._executeRaw(`DROP TABLE ${links}`);
        await setup._executeRaw(`DROP TABLE ${tags}`);
        await setup._executeRaw(`DROP TABLE ${owners}`);
        await setup.disconnect();
      }
    }, 180_000);
  }
);

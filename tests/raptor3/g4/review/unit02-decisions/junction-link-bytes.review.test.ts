/**
 * Independent review probe — G4-02 DECISIONS unit, R-D4's private-guide
 * paragraph.
 *
 * `src/query-engine/raptor3/AGENTS.md` now states, as a contract:
 *
 *   "A `connect` or `connectOrCreate` stores the LOCATED row's key bytes in the
 *    foreign-key column, in EVERY POSITION (a child-held `create`, a
 *    parent-held `update`, a JUNCTION LINK)."
 *
 * The author's cell measures the two reference-held positions. The junction
 * link is asserted by no cell. This probe measures it: the bytes that land in
 * the link table's `ownerId` / `tagId` columns when the request spells either
 * side of the link with a collation-equal literal.
 *
 * Needs `VIBORM_RAPTOR3_PROVIDER=mysql` and `VIBORM_RAPTOR3_PROVIDER_PORT`.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { afterAll, assert as vitestAssert, beforeAll, describe, it } from "vitest";

const provider = process.env.VIBORM_RAPTOR3_PROVIDER;
const port = Number(process.env.VIBORM_RAPTOR3_PROVIDER_PORT ?? "0");

const OWNERS = "g4r2d_lb_owners";
const TAGS = "g4r2d_lb_tags";
const LINKS = "g4r2d_lb_links";

const owner = s
  .model({
    id: s.string().id(),
    name: s.string(),
    tags: s.toMany(() => tag).through(LINKS).source("ownerId").target("tagId"),
  })
  .map(OWNERS);
const tag = s
  .model({
    id: s.string().id(),
    label: s.string(),
    owners: s.toMany(() => owner),
  })
  .map(TAGS);
const schema = { owner, tag };

describe.runIf(provider === "mysql" && port > 0)(
  "G4-02 decisions review — the bytes a junction link stores",
  () => {
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
    let setup: MySQL2Driver;

    const dropAll = async () => {
      await setup._executeRaw(`DROP TABLE IF EXISTS ${LINKS}`);
      await setup._executeRaw(`DROP TABLE IF EXISTS ${OWNERS}`);
      await setup._executeRaw(`DROP TABLE IF EXISTS ${TAGS}`);
    };

    beforeAll(async () => {
      setup = connect();
      await dropAll();
      await setup._executeRaw(
        `CREATE TABLE ${OWNERS} (id VARCHAR(191) PRIMARY KEY NOT NULL, name VARCHAR(191) NOT NULL)`
      );
      await setup._executeRaw(
        `CREATE TABLE ${TAGS} (id VARCHAR(191) PRIMARY KEY NOT NULL, label VARCHAR(191) NOT NULL)`
      );
      await setup._executeRaw(
        `CREATE TABLE ${LINKS} (ownerId VARCHAR(191) NOT NULL, tagId VARCHAR(191) NOT NULL, PRIMARY KEY (ownerId, tagId), FOREIGN KEY(ownerId) REFERENCES ${OWNERS}(id), FOREIGN KEY(tagId) REFERENCES ${TAGS}(id))`
      );
    }, 60_000);

    afterAll(async () => {
      await dropAll();
      await setup.disconnect();
    }, 60_000);

    const seed = async () => {
      await setup._executeRaw(`DELETE FROM ${LINKS}`);
      await setup._executeRaw(`DELETE FROM ${OWNERS}`);
      await setup._executeRaw(`DELETE FROM ${TAGS}`);
      await setup._executeRaw(
        `INSERT INTO ${OWNERS} (id, name) VALUES ('wanted','winner')`
      );
      await setup._executeRaw(
        `INSERT INTO ${TAGS} (id, label) VALUES ('g1','tag')`
      );
    };

    const run = async (
      engine: "shipped" | "candidate",
      model: string,
      operation: string,
      args: unknown
    ) => {
      await seed();
      const driver = connect();
      let answer: string;
      try {
        const client = createClient({ schema, driver });
        const candidate = createCommandEngine({ schema, driver });
        const value =
          engine === "shipped"
            ? await (
                client as unknown as Record<
                  string,
                  Record<string, (args: unknown) => Promise<unknown>>
                >
              )[model]![operation]!(args)
            : await (
                candidate as unknown as {
                  execute(
                    model: string,
                    operation: string,
                    args: unknown
                  ): Promise<unknown>;
                }
              ).execute(model, operation, args);
        answer = `ok:${JSON.stringify(value)}`;
      } catch (error) {
        answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
      } finally {
        await driver.disconnect();
      }
      const links = await setup._executeRaw<Record<string, unknown>>(
        `SELECT ownerId, tagId FROM ${LINKS} ORDER BY ownerId, tagId`
      );
      const tags = await setup._executeRaw<Record<string, unknown>>(
        `SELECT id, label FROM ${TAGS} ORDER BY id`
      );
      return { answer, links: links.rows, tags: tags.rows };
    };

    it("records the link bytes for a collation-equal junction connect on both engines", async () => {
      const collation = await setup._executeRaw<{ TABLE_COLLATION: string }>(
        `SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_NAME = '${LINKS}'`
      );
      vitestAssert.match(
        String(collation.rows[0]!.TABLE_COLLATION),
        /_ci$/,
        "the cell needs a case-insensitive collation"
      );
      const cases: [string, string, string, unknown][] = [
        [
          "junction connect, TARGET spelled collation-equal",
          "owner",
          "update",
          { where: { id: "wanted" }, data: { tags: { connect: [{ id: "G1" }] } } },
        ],
        [
          "junction connect, PARENT spelled collation-equal",
          "owner",
          "update",
          { where: { id: "WANTED" }, data: { tags: { connect: [{ id: "g1" }] } } },
        ],
        [
          "junction connectOrCreate, TARGET spelled collation-equal",
          "owner",
          "update",
          {
            where: { id: "wanted" },
            data: {
              tags: {
                connectOrCreate: [
                  { where: { id: "G1" }, create: { id: "G1", label: "fresh" } },
                ],
              },
            },
          },
        ],
        [
          "junction set, TARGET spelled collation-equal",
          "owner",
          "update",
          { where: { id: "wanted" }, data: { tags: { set: [{ id: "G1" }] } } },
        ],
        [
          "root create with a junction connect spelled collation-equal",
          "owner",
          "create",
          {
            data: {
              id: "o2",
              name: "second",
              tags: { connect: [{ id: "G1" }] },
            },
          },
        ],
      ];
      const differing: string[] = [];
      const unlocated: string[] = [];
      for (const [name, model, operation, args] of cases) {
        const shipped = await run("shipped", model, operation, args);
        const candidate = await run("candidate", model, operation, args);
        // biome-ignore lint/suspicious/noConsole: the probe's output IS its receipt.
        console.log(
          `[${name}]\n  shipped   ${shipped.answer}\n            links ${JSON.stringify(shipped.links)} tags ${JSON.stringify(shipped.tags)}\n  candidate ${candidate.answer}\n            links ${JSON.stringify(candidate.links)} tags ${JSON.stringify(candidate.tags)}`
        );
        if (
          shipped.answer !== candidate.answer ||
          JSON.stringify(shipped.links) !== JSON.stringify(candidate.links) ||
          JSON.stringify(shipped.tags) !== JSON.stringify(candidate.tags)
        )
          differing.push(name);
        // The guide's claim: every byte the CANDIDATE stores in the link table
        // exists, byte for byte, in the row it located.
        for (const link of candidate.links as Record<string, string>[]) {
          const ownerId = link.ownerId ?? "";
          const tagId = link.tagId ?? "";
          if (ownerId !== ownerId.toLowerCase())
            unlocated.push(`${name}: ownerId=${ownerId}`);
          if (tagId !== tagId.toLowerCase())
            unlocated.push(`${name}: tagId=${tagId}`);
        }
      }
      // biome-ignore lint/suspicious/noConsole: the probe's output IS its receipt.
      console.log(
        `\nCANDIDATE link bytes that are NOT the located row's: ${JSON.stringify(unlocated)}\nrows where the two engines differ: ${JSON.stringify(differing)}`
      );
      assert.deepEqual(
        unlocated,
        [],
        "the guide says a junction link stores the LOCATED row's key bytes"
      );
    }, 180_000);
  }
);

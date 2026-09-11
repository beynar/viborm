import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import Database from "better-sqlite3";
import { afterAll, describe, it } from "vitest";
import { captureRaptor3Identity } from "../../../scripts/raptor3-manifest.mjs";
import type { G0ReplayRecord } from "../harness/protocol";
import {
  decodeReplayRecords,
  encodeReplayRecords,
  replayG0Run,
} from "../harness/replay";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { polishScenarios } from "./scenarios";

const records: G0ReplayRecord[] = [];
afterAll(async () => {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (!directory) return;
  await writeFile(
    join(directory, "g25-polish-corpus.json"),
    JSON.stringify({
      formatVersion: 1,
      identity: captureRaptor3Identity(),
      records: encodeReplayRecords(records),
    })
  );
});

// These cuts pin the selected G2 engine. The shipped engine observes absence
// inside a transaction and does not expose the same committed supplier prefix.
describe("G2.5 selected-engine observation lifetime and supplier fields", () => {
  for (const scenario of polishScenarios)
    for (const profile of scenario.profiles)
      it(`${scenario.id}: ${profile}`, async () => {
        const candidate = await runSQLiteWorld(scenario, profile, 0, {
          candidateFactory: createCommandEngine,
          candidateName: "commands",
        });
        records.push(candidate.record);
        candidate.fixture.assert(candidate.observation);
        const saved = decodeReplayRecords(
          encodeReplayRecords([candidate.record])
        )[0]!;
        for (let replay = 0; replay < 3; replay++) await replayG0Run(saved);
      });
});

describe("Raptor 3 compressed membership operands", () => {
  it("uses the target decimal codec for captured reference membership", async () => {
    const account = s
      .model({
        id: s.decimal({ precision: 12, scale: 2 }).id(),
        code: s.decimal({ precision: 12, scale: 2 }).unique(),
        label: s.string(),
        notes: s.toMany(() => note),
      })
      .map("g25_compression_accounts");
    const note = s
      .model({
        id: s.int().id(),
        label: s.string(),
        accountCode: s.decimal({ precision: 12, scale: 2 }),
        account: s
          .toOne(() => account)
          .fields("accountCode")
          .references("code"),
      })
      .map("g25_compression_notes");
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE g25_compression_accounts(
        id INTEGER PRIMARY KEY,
        code INTEGER NOT NULL UNIQUE,
        label TEXT NOT NULL
      );
      CREATE TABLE g25_compression_notes(
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL,
        accountCode INTEGER NOT NULL REFERENCES g25_compression_accounts(code)
      );
      INSERT INTO g25_compression_accounts VALUES
        (1000,250,'Exact'),
        (2000,25000,'Coefficient decoy');
      INSERT INTO g25_compression_notes VALUES
        (1,'Selected',250),
        (2,'Decoy',25000);
    `);
    const driver = new SQLite3Driver({ client: database });
    try {
      const value = await createCommandEngine({
        schema: { account, note },
        driver,
      }).execute("account", "update", {
        where: { id: "10.00" },
        data: {
          notes: {
            update: { where: { id: 1 }, data: { label: "Changed" } },
          },
        },
        select: {
          label: true,
          notes: { select: { id: true, label: true } },
        },
      });

      assert.deepEqual(value, {
        label: "Exact",
        notes: [{ id: 1, label: "Changed" }],
      });
      assert.deepEqual(
        database
          .prepare(
            "SELECT id,label,accountCode FROM g25_compression_notes ORDER BY id"
          )
          .all(),
        [
          { id: 1, label: "Changed", accountCode: 250 },
          { id: 2, label: "Decoy", accountCode: 25000 },
        ]
      );
    } finally {
      await driver.disconnect();
      database.close();
    }
  });

  it("uses the source decimal codec for captured compound variant junction membership", async () => {
    const note = s
      .model({ id: s.int().id(), body: s.string() })
      .map("g25_compression_junction_notes");
    const crate = s
      .model({
        tenantId: s.decimal({ precision: 12, scale: 2 }),
        code: s.string(),
        label: s.string(),
        items: s
          .toMany(
            { note: () => note },
            { values: { note: "compression.note.v1" } }
          )
          .through({
            note: {
              table: "g25_compression_crate_notes",
              source: "holder",
              target: "entry",
            },
          }),
      })
      .id(["tenantId", "code"])
      .map("g25_compression_crates");
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE g25_compression_crates(
        tenantId INTEGER NOT NULL,
        code TEXT NOT NULL,
        label TEXT NOT NULL,
        PRIMARY KEY(tenantId,code)
      );
      CREATE TABLE g25_compression_junction_notes(
        id INTEGER PRIMARY KEY,
        body TEXT NOT NULL
      );
      CREATE TABLE g25_compression_crate_notes(
        holder_1 INTEGER NOT NULL,
        holder_2 TEXT NOT NULL,
        entry INTEGER NOT NULL,
        PRIMARY KEY(holder_1,holder_2,entry),
        FOREIGN KEY(holder_1,holder_2)
          REFERENCES g25_compression_crates(tenantId,code),
        FOREIGN KEY(entry) REFERENCES g25_compression_junction_notes(id)
      );
      INSERT INTO g25_compression_crates VALUES
        (1000,'left','Exact'),
        (2000,'left','Coefficient decoy');
      INSERT INTO g25_compression_junction_notes VALUES
        (1,'Selected'),
        (2,'Decoy');
      INSERT INTO g25_compression_crate_notes VALUES
        (1000,'left',1),
        (2000,'left',2);
    `);
    const driver = new SQLite3Driver({ client: database });
    try {
      const value = await createCommandEngine({
        schema: { crate, note },
        driver,
      }).execute("crate", "update", {
        where: {
          tenantId_code: { tenantId: "10.00", code: "left" },
        },
        data: {
          items: {
            upsert: [
              {
                type: "note",
                where: { id: 1 },
                create: { id: 99, body: "Must not create" },
                update: { body: "Changed" },
              },
            ],
          },
        },
        select: { label: true, items: true },
      });

      assert.deepEqual(value, {
        label: "Exact",
        items: [{ type: "note", data: { id: 1, body: "Changed" } }],
      });
      assert.deepEqual(
        database
          .prepare(
            "SELECT id,body FROM g25_compression_junction_notes ORDER BY id"
          )
          .all(),
        [
          { id: 1, body: "Changed" },
          { id: 2, body: "Decoy" },
        ]
      );
    } finally {
      await driver.disconnect();
      database.close();
    }
  });
});

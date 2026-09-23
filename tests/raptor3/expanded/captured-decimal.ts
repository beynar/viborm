import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../harness/protocol";

export const capturedDecimalScenario: ScenarioDefinition = {
  id: "g1-captured-decimal-key-handoff",
  family: "C04",
  contracts: ["C02", "C04"],
  sources: [
    "tests/contracts/engine/write/captured-row-key-decode.core.test.ts",
  ],
  prepare() {
    const account = s
      .model({
        id: s.decimal({ precision: 12, scale: 2 }).id(),
        code: s.decimal({ precision: 12, scale: 2 }).unique(),
        label: s.string(),
        notes: s.toMany(() => note),
      })
      .map("g1_cd_accounts");
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
      .map("g1_cd_notes");
    const schema = { account, note };
    const args = {
      where: { id: "10" },
      data: { notes: { create: { id: 1, label: "New" } } },
      select: { label: true },
    } as const;
    const initial = {
      accounts: [
        { id: 1000, code: 250, label: "Exact" },
        { id: 100000, code: 25000, label: "Coefficient namesake" },
      ],
      notes: [{ id: 7, label: "Untouched", accountCode: 25000 }],
    };
    return {
      publicInput: { model: "account", operation: "update", args },
      requiredCuts: [],
      seed(database) {
        database.exec(`
          CREATE TABLE g1_cd_accounts(id INTEGER PRIMARY KEY,code INTEGER NOT NULL UNIQUE,label TEXT NOT NULL);
          CREATE TABLE g1_cd_notes(id INTEGER PRIMARY KEY,label TEXT NOT NULL,accountCode INTEGER NOT NULL REFERENCES g1_cd_accounts(code));
          INSERT INTO g1_cd_accounts VALUES(1000,250,'Exact'),(100000,25000,'Coefficient namesake');
          INSERT INTO g1_cd_notes VALUES(7,'Untouched',25000);
        `);
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return candidateFactory({ schema, driver }).execute(
            "account",
            "update",
            args
          );
        return createClient({ schema, driver }).account.update(args);
      },
      inspect(database) {
        return {
          accounts: database
            .prepare("SELECT * FROM g1_cd_accounts ORDER BY id")
            .all(),
          notes: database
            .prepare("SELECT * FROM g1_cd_notes ORDER BY id")
            .all(),
        };
      },
      assert(observation) {
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(observation.final, {
          accounts: initial.accounts,
          notes: [{ id: 1, label: "New", accountCode: 250 }, ...initial.notes],
        });
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(observation.reachedCuts, []);
        assert.deepEqual(observation.outcome, {
          kind: "success",
          value: { label: "Exact" },
        });
      },
    };
  },
};

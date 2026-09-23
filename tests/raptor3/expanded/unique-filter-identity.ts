import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../harness/protocol";

const cases = [
  "g1-compound-unique-filter-found",
  "g1-compound-unique-filter-missing",
  "g1-upsert-filter-created-identity",
  "g1-upsert-filter-unique-conflict",
  "g1-update-filter-missing-parent-source",
] as const;

export const uniqueFilterScenarios: ScenarioDefinition[] = cases.map((id) => ({
  id,
  family: "C01",
  contracts: ["C01", "C02"],
  sources: [
    "tests/contracts/engine/write/extended-where-unique-behavior.ts",
    "tests/fixtures/compound-key-behavior-schema.ts",
  ],
  prepare() {
    const account = s
      .model({
        id: s.int().id(),
        tenant: s.string(),
        code: s.string(),
        email: s.string().unique(),
        status: s.string(),
        score: s.int(),
        logins: s.toMany(() => login),
      })
      .unique(["tenant", "code"])
      .map("g1_uf_accounts");
    const login = s
      .model({
        id: s.int().id(),
        label: s.string(),
        accountId: s.int(),
        account: s
          .toOne(() => account)
          .fields("accountId")
          .references("id"),
      })
      .map("g1_uf_logins");
    const schema = { account, login };
    const read = id.startsWith("g1-compound-unique-");
    const found = id === "g1-compound-unique-filter-found";
    const conflict = id === "g1-upsert-filter-unique-conflict";
    const missingParent = id === "g1-update-filter-missing-parent-source";
    const creates = id === "g1-upsert-filter-created-identity";
    const select = {
      id: true,
      tenant: true,
      code: true,
      email: true,
      status: true,
      score: true,
    } as const;
    const created = {
      id: 9,
      tenant: "fresh",
      code: "fresh",
      email: "fresh",
      status: "new",
      score: 42,
    };
    const readArgs = {
      where: {
        tenant_code: { tenant: "north", code: "west" },
        status: found ? "active" : "archived",
      },
      select,
    };
    const upsertArgs = {
      where: { email: "match", status: "archived" },
      create: { ...created, email: conflict ? "match" : "fresh" },
      update: { score: { increment: 100 } },
      select,
    };
    const updateArgs = {
      where: { email: "match", status: "archived" },
      data: { logins: { create: { id: 100, label: "Must not publish" } } },
      select,
    };
    const initial = {
      accounts: [
        {
          id: 1,
          tenant: "north",
          code: "west",
          email: "match",
          status: "active",
          score: 10,
        },
        {
          id: 2,
          tenant: "north",
          code: "north",
          email: "decoy-a",
          status: "active",
          score: 20,
        },
        {
          id: 3,
          tenant: "west",
          code: "west",
          email: "decoy-b",
          status: "archived",
          score: 30,
        },
      ],
      logins: [{ id: 7, label: "Untouched", accountId: 2 }],
    };
    return {
      publicInput: {
        model: "account",
        operation: read ? "findUnique" : missingParent ? "update" : "upsert",
        args: read ? readArgs : missingParent ? updateArgs : upsertArgs,
      },
      requiredCuts: [],
      seed(database) {
        database.exec(`
          CREATE TABLE g1_uf_accounts(id INTEGER PRIMARY KEY,tenant TEXT NOT NULL,code TEXT NOT NULL,email TEXT NOT NULL UNIQUE,status TEXT NOT NULL,score INTEGER NOT NULL,UNIQUE(tenant,code));
          CREATE TABLE g1_uf_logins(id INTEGER PRIMARY KEY,label TEXT NOT NULL,accountId INTEGER NOT NULL REFERENCES g1_uf_accounts(id));
          INSERT INTO g1_uf_accounts VALUES(1,'north','west','match','active',10),(2,'north','north','decoy-a','active',20),(3,'west','west','decoy-b','archived',30);
          INSERT INTO g1_uf_logins VALUES(7,'Untouched',2);
        `);
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return candidateFactory({ schema, driver }).execute(
            "account",
            read ? "findUnique" : missingParent ? "update" : "upsert",
            read ? readArgs : missingParent ? updateArgs : upsertArgs
          );
        const client = createClient({ schema, driver });
        if (read) return client.account.findUnique(readArgs);
        if (missingParent) return client.account.update(updateArgs);
        return client.account.upsert(upsertArgs);
      },
      inspect(database) {
        return {
          accounts: database
            .prepare("SELECT * FROM g1_uf_accounts ORDER BY id")
            .all(),
          logins: database
            .prepare("SELECT * FROM g1_uf_logins ORDER BY id")
            .all(),
        };
      },
      assert(observation) {
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(
          observation.final,
          creates
            ? {
                accounts: [...initial.accounts, created],
                logins: initial.logins,
              }
            : initial
        );
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(observation.reachedCuts, []);
        if (conflict || missingParent) {
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          assert.equal(
            observation.outcome.failure.name,
            conflict ? "UniqueConstraintError" : "NotFoundError"
          );
          assert.equal(
            observation.outcome.failure.code,
            conflict ? "V3001" : "V6001"
          );
          return;
        }
        assert.deepEqual(observation.outcome, {
          kind: "success",
          value: creates ? created : found ? initial.accounts[0] : null,
        });
      },
    };
  },
}));

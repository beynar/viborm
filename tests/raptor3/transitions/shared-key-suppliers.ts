import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../harness/protocol";

const cases = [
  "g2-shared-key-supplier-modify",
  "g2-shared-key-supplier-occupied",
] as const;

/** The supplier changes the selected card's identity, not the outgoing account. */
export const sharedKeySupplierScenarios: ScenarioDefinition[] = cases.map(
  (id) => ({
    id,
    family: "C07",
    contracts: ["C05", "C07"],
    sources: [
      "tests/contracts/engine/write/shared-pk-supply-modify.test.ts",
      "tests/contracts/engine/write/shared-pk-update-root-behavior.ts",
    ],
    prepare() {
      const occupied = id === "g2-shared-key-supplier-occupied";
      const account = s
        .model({
          id: s.string().id(),
          email: s.string().unique(),
          name: s.string(),
          card: s.toOne(() => card),
        })
        .map("g2_shared_supplier_accounts");
      const card = s
        .model({
          accountId: s.string().id(),
          label: s.string(),
          account: s
            .toOne(() => account)
            .fields("accountId")
            .references("id")
            .onUpdate("cascade"),
          notes: s.toMany(() => note),
        })
        .map("g2_shared_supplier_cards");
      const note = s
        .model({
          id: s.string().id(),
          cardId: s.string(),
          body: s.string(),
          card: s
            .toOne(() => card)
            .fields("cardId")
            .references("accountId"),
        })
        .map("g2_shared_supplier_notes");
      const schema = { account, card, note };
      const args = {
        where: { accountId: "a1" },
        data: { account: { connect: { id: "a2" }, update: { name: "moved" } } },
        select: { accountId: true, label: true },
      } as const;
      const initial = {
        accounts: [
          { id: "a1", email: "a1@x", name: "one" },
          { id: "a2", email: "a2@x", name: "two" },
          { id: "a9", email: "a9@x", name: "untouched-account" },
        ],
        cards: [
          { accountId: "a1", label: "under test" },
          { accountId: "a9", label: "untouched-card" },
        ],
        notes: [
          ...(occupied
            ? [{ id: "n1", cardId: "a1", body: "follows the key" }]
            : []),
          { id: "n9", cardId: "a9", body: "untouched-note" },
        ],
      };
      const final = occupied
        ? initial
        : {
            accounts: [
              initial.accounts[0],
              { id: "a2", email: "a2@x", name: "moved" },
              initial.accounts[2],
            ],
            cards: [{ accountId: "a2", label: "under test" }, initial.cards[1]],
            notes: initial.notes,
          };
      return {
        publicInput: { model: "card", operation: "update", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
          CREATE TABLE g2_shared_supplier_accounts (
            id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL
          );
          CREATE TABLE g2_shared_supplier_cards (
            accountId TEXT PRIMARY KEY NOT NULL REFERENCES g2_shared_supplier_accounts(id) ON UPDATE CASCADE,
            label TEXT NOT NULL
          );
          CREATE TABLE g2_shared_supplier_notes (
            id TEXT PRIMARY KEY NOT NULL,
            cardId TEXT NOT NULL REFERENCES g2_shared_supplier_cards(accountId) ON UPDATE NO ACTION,
            body TEXT NOT NULL
          );
          INSERT INTO g2_shared_supplier_accounts VALUES
            ('a1','a1@x','one'), ('a2','a2@x','two'), ('a9','a9@x','untouched-account');
          INSERT INTO g2_shared_supplier_cards VALUES
            ('a1','under test'), ('a9','untouched-card');
          INSERT INTO g2_shared_supplier_notes VALUES ('n9','a9','untouched-note');
        `);
          if (occupied)
            database
              .prepare("INSERT INTO g2_shared_supplier_notes VALUES (?,?,?)")
              .run("n1", "a1", "follows the key");
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "card",
              "update",
              args
            );
          return createClient({ schema, driver }).card.update(args);
        },
        inspect(database) {
          return {
            accounts: database
              .prepare("SELECT * FROM g2_shared_supplier_accounts ORDER BY id")
              .all(),
            cards: database
              .prepare(
                "SELECT * FROM g2_shared_supplier_cards ORDER BY accountId"
              )
              .all(),
            notes: database
              .prepare("SELECT * FROM g2_shared_supplier_notes ORDER BY id")
              .all(),
          };
        },
        assert(observation) {
          if (occupied) {
            assert.equal(
              observation.outcome.kind,
              "failure",
              "Non-cascade note must block the shared-key move"
            );
            if (observation.outcome.kind === "failure") {
              assert.equal(observation.outcome.failure.name, "ForeignKeyError");
              assert.equal(observation.outcome.failure.code, "V3002");
              assert.equal(
                observation.outcome.failure.message,
                "Foreign key constraint violation"
              );
            }
          } else {
            assert.deepEqual(
              observation.outcome,
              {
                kind: "success",
                value: { accountId: "a2", label: "under test" },
              },
              "Terminal selection must use the supplied card key"
            );
          }
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(
            observation.final,
            final,
            occupied
              ? "Native FK failure must roll back both the key move and target modification"
              : "Only the supplied account is modified; outgoing and decoy graphs remain unchanged"
          );
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, []);
        },
      };
    },
  })
);

/**
 * G4-02 phase-2 review FOLLOW-UP — is decision R-D1's reachable shape real?
 *
 * Round 3 keeps ONE refusal in `Queries.updateValue`: an EXACT DECIMAL under
 * `multiply`/`divide` cannot be NAMED, only assigned. The note (§R2.1) says a
 * decimal PRIMARY key never reaches it (admission refuses first), so "the
 * reachable shape is a decimal RELATION key under multiply/divide on a
 * non-RETURNING provider, where the shipped engine computes the key in
 * JavaScript".
 *
 * This cell builds exactly that shape and records what each engine answers, so
 * the decision Arnaud is asked to make is stated in measured terms rather than
 * inferred.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

class NonReturningDriver extends SQLite3Driver {
  constructor(options: { client: Database.Database }) {
    super(options);
    this.adapter.capabilities.supportsReturning = false;
  }
}

const holder = s
  .model({
    id: s.int().id(),
    code: s.decimal({ precision: 8, scale: 2 }).unique(),
    label: s.string(),
    dependents: s.toMany(() => dependent),
  })
  .map("r3f_holders");
const dependent = s
  .model({
    id: s.int().id(),
    holderCode: s.decimal({ precision: 8, scale: 2 }).nullable(),
    holder: s
      .toOne(() => holder)
      .fields("holderCode")
      .references("code")
      .onUpdate("restrict"),
  })
  .map("r3f_dependents");
const schema = { holder, dependent };

async function run(engine: "shipped" | "candidate", seedDependent = true) {
  const database = new Database(":memory:");
  const driver = new NonReturningDriver({ client: database });
  const client = createClient({ schema, driver });
  assert.equal((await syncLiveSchema(client)).applied, true);
  database.exec("INSERT INTO r3f_holders (id,code,label) VALUES (1,'600','h');");
  if (seedDependent)
    database.exec("INSERT INTO r3f_dependents (id,holderCode) VALUES (9,'600');");
  const candidate = createCommandEngine({ schema, driver });
  const args = { where: { id: 1 }, data: { code: { multiply: "2" } } };
  let answer: string;
  try {
    const value =
      engine === "shipped"
        ? await client.holder.update(args as never)
        : await candidate.execute("holder", "update", args);
    answer = `ok:${JSON.stringify(value)}`;
  } catch (error) {
    answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  const rows = {
    holders: database.prepare("SELECT id,code FROM r3f_holders").all(),
    dependents: database.prepare("SELECT id,holderCode FROM r3f_dependents").all(),
  };
  await client.$disconnect();
  database.close();
  return { answer, rows };
}

async function updateDependentKey(engine: "shipped" | "candidate") {
  const database = new Database(":memory:");
  const driver = new NonReturningDriver({ client: database });
  const client = createClient({ schema, driver });
  assert.equal((await syncLiveSchema(client)).applied, true);
  database.exec(
    `INSERT INTO r3f_holders (id,code,label) VALUES (1,'600','h');
     INSERT INTO r3f_holders (id,code,label) VALUES (2,'1200','i');
     INSERT INTO r3f_dependents (id,holderCode) VALUES (9,'600');`
  );
  const candidate = createCommandEngine({ schema, driver });
  const args = { where: { id: 9 }, data: { holderCode: { multiply: "2" } } };
  let answer: string;
  try {
    const value =
      engine === "shipped"
        ? await client.dependent.update(args as never)
        : await candidate.execute("dependent", "update", args);
    answer = `ok:${JSON.stringify(value)}`;
  } catch (error) {
    answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  const rows = database
    .prepare("SELECT id,holderCode FROM r3f_dependents")
    .all();
  await client.$disconnect();
  database.close();
  return { answer, rows };
}

describe("G4-02 review follow-up — decision R-D1, measured", () => {
  it("records both engines' answers for a decimal FK column under multiply", async () => {
    const shipped = await updateDependentKey("shipped");
    const candidate = await updateDependentKey("candidate");
    console.log(
      `R-D1c shipped   ${JSON.stringify(shipped)}\nR-D1c candidate ${JSON.stringify(candidate)}`
    );
    assert.equal(typeof shipped.answer, "string");
    assert.equal(typeof candidate.answer, "string");
  });

  it("records both engines' answers for a decimal RELATION key under multiply", async () => {
    const shipped = await run("shipped");
    const candidate = await run("candidate");
    // Recorded, not asserted equal: this IS the divergence R-D1 declares.
    console.log(
      `R-D1 shipped   ${JSON.stringify(shipped)}\nR-D1 candidate ${JSON.stringify(candidate)}`
    );
    assert.equal(typeof shipped.answer, "string");
    assert.equal(typeof candidate.answer, "string");
  });

  it("records both answers when NO dependent row blocks the transition", async () => {
    const shipped = await run("shipped", false);
    const candidate = await run("candidate", false);
    console.log(
      `R-D1b shipped   ${JSON.stringify(shipped)}\nR-D1b candidate ${JSON.stringify(candidate)}`
    );
    assert.equal(typeof shipped.answer, "string");
    assert.equal(typeof candidate.answer, "string");
  });
});

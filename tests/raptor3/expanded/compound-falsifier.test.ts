import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { it } from "vitest";
import { compoundScenarios } from "./compound";

it("the compound agreement fixture rejects NULL then repair", () => {
  const scenario = compoundScenarios.find(
    (entry) => entry.id === "g1-compound-agree-partial"
  );
  assert.ok(scenario);
  const fixture = scenario.prepare({
    profile: "sqlite-interactive",
    seed: 0,
    clockEpochMs: 0,
    recordDefault() {
      assert.fail(
        "The compound agreement fixture declares no default callbacks"
      );
    },
  });
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    fixture.seed(database);
    const initial = fixture.inspect(database);
    assert.throws(
      () =>
        database.exec(`
        UPDATE g1_kids SET parent_a=NULL,parent_b=NULL WHERE id='target';
        UPDATE g1_kids SET parent_a='old',parent_b='pair' WHERE id='target';
      `),
      /C03 compound reference must not become transiently NULL/
    );
    assert.deepEqual(fixture.inspect(database), initial);
  } finally {
    database.close();
  }
});

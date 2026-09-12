import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { describe, it } from "vitest";
import type { CandidateEngineFactory } from "../harness/protocol";
import {
  liveProvider,
  runLiveWorld,
  type LiveFixture,
} from "../transitions/live-world";

const containerTable = "post_g3_clearability_containers";
const assetTable = "post_g3_clearability_assets";
const textType = liveProvider === "pg" ? "TEXT" : "VARCHAR(191)";

function clearabilitySchema() {
  const container = s
    .model({
      tenant: s.string().map("tenant_key"),
      code: s.string().map("container_code"),
      label: s.string(),
      assets: s.toMany(() => asset).name("containerAssets"),
    })
    .id(["tenant", "code"])
    .map(containerTable);
  const asset = s
    .model({
      tenant: s.string().map("tenant_key"),
      code: s.string().map("asset_code"),
      label: s.string(),
      containerCode: s.string().nullable().map("container_code_fk"),
      container: s
        .toOne(() => container)
        .fields("tenant", "containerCode")
        .references("tenant", "code")
        .name("containerAssets"),
    })
    .id(["tenant", "code"])
    .map(assetTable);
  return { container, asset };
}

const initial = {
  containers: [
    { tenant_key: "t1", container_code: "a", label: "Tenant one A" },
    { tenant_key: "t1", container_code: "b", label: "Tenant one B" },
    { tenant_key: "t1", container_code: "c", label: "Delete target" },
    { tenant_key: "t2", container_code: "a", label: "Other tenant" },
  ],
  assets: [
    {
      tenant_key: "t1",
      asset_code: "direct",
      label: "Direct disconnect",
      container_code_fk: "a",
    },
    {
      tenant_key: "t1",
      asset_code: "keep",
      label: "Retained by set",
      container_code_fk: "a",
    },
    {
      tenant_key: "t1",
      asset_code: "depart",
      label: "Departing from set",
      container_code_fk: "a",
    },
    {
      tenant_key: "t1",
      asset_code: "added",
      label: "Added by set",
      container_code_fk: null,
    },
    {
      tenant_key: "t1",
      asset_code: "empty-1",
      label: "First empty departure",
      container_code_fk: "b",
    },
    {
      tenant_key: "t1",
      asset_code: "empty-2",
      label: "Second empty departure",
      container_code_fk: "b",
    },
    {
      tenant_key: "t1",
      asset_code: "deleter",
      label: "Deletes its container",
      container_code_fk: "c",
    },
    {
      tenant_key: "t2",
      asset_code: "unrelated",
      label: "Other tenant control",
      container_code_fk: "a",
    },
  ],
};

const final = {
  containers: [
    initial.containers[0],
    initial.containers[1],
    initial.containers[3],
  ],
  assets: [
    { ...initial.assets[3], container_code_fk: "a" },
    { ...initial.assets[6], container_code_fk: null },
    { ...initial.assets[2], container_code_fk: null },
    { ...initial.assets[0], container_code_fk: null },
    { ...initial.assets[4], container_code_fk: null },
    { ...initial.assets[5], container_code_fk: null },
    initial.assets[1],
    initial.assets[7],
  ],
};

function compoundWhere(tenant: string, code: string) {
  return { tenant_code: { tenant, code } };
}

async function runClearabilityWorld(
  factory: CandidateEngineFactory,
  substrate: "interactive" | "atomic-batch"
) {
  const schema = clearabilitySchema();
  const fixture: LiveFixture = {
    expectedExecutions: 4,
    initial,
    tables: {
      containers: {
        name: containerTable,
        order: ["tenant_key", "container_code"],
      },
      assets: {
        name: assetTable,
        order: ["tenant_key", "asset_code"],
      },
    },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const candidate = candidateFactory({ schema, driver });
      const outcomes: unknown[] = [];
      outcomes.push(
        await candidate.execute("asset", "update", {
          where: compoundWhere("t1", "direct"),
          data: { container: { disconnect: true } },
          select: { tenant: true, code: true, containerCode: true },
        })
      );
      outcomes.push(
        await candidate.execute("container", "update", {
          where: compoundWhere("t1", "a"),
          data: {
            assets: {
              set: [compoundWhere("t1", "keep"), compoundWhere("t1", "added")],
            },
          },
          select: { tenant: true, code: true },
        })
      );
      outcomes.push(
        await candidate.execute("container", "update", {
          where: compoundWhere("t1", "b"),
          data: { assets: { set: [] } },
          select: { tenant: true, code: true },
        })
      );
      outcomes.push(
        await candidate.execute("asset", "update", {
          where: compoundWhere("t1", "deleter"),
          data: { container: { delete: true } },
          select: { tenant: true, code: true, containerCode: true },
        })
      );
      return outcomes;
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: [
          { tenant: "t1", code: "direct", containerCode: null },
          { tenant: "t1", code: "a" },
          { tenant: "t1", code: "b" },
          { tenant: "t1", code: "deleter", containerCode: null },
        ],
      });
      assert.deepEqual(observation.final, final);
    },
  };

  const world = await runLiveWorld(
    fixture,
    (names) => ({
      [containerTable]: `${names.quote("tenant_key")} ${textType} NOT NULL,${names.quote("container_code")} ${textType} NOT NULL,${names.quote("label")} ${textType} NOT NULL,PRIMARY KEY(${names.quote("tenant_key")},${names.quote("container_code")})`,
      [assetTable]: `${names.quote("tenant_key")} ${textType} NOT NULL,${names.quote("asset_code")} ${textType} NOT NULL,${names.quote("label")} ${textType} NOT NULL,${names.quote("container_code_fk")} ${textType} NULL,PRIMARY KEY(${names.quote("tenant_key")},${names.quote("asset_code")}),FOREIGN KEY(${names.quote("tenant_key")},${names.quote("container_code_fk")}) REFERENCES ${names.table(containerTable)}(${names.quote("tenant_key")},${names.quote("container_code")})`,
    }),
    factory,
    substrate
  );
  if (world.terminalFailure !== undefined) throw world.terminalFailure;
  fixture.assert(world.observation);
  world.assertHealthy();
}

describe(`post-G3-prep native ${liveProvider} clearability ownership`, () => {
  it(
    "mixed compound removals use the schema-owned nullable subset interactively",
    () => runClearabilityWorld(createCommandEngine, "interactive"),
    30_000
  );
  it(
    "mixed compound removals use the schema-owned nullable subset in a batch",
    () => runClearabilityWorld(createCommandEngine, "atomic-batch"),
    30_000
  );
});

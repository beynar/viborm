import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CandidateEngineFactory } from "../harness/protocol";
import type { KeyScenario } from "./keys";
import {
  liveProvider as provider,
  runLiveWorld,
  type LiveNames,
} from "./live-world";
import { encodeEvidenceValue } from "../../../benchmarks/operation-pipeline-evidence.mjs";
import { captureRaptor3Identity } from "../../../scripts/raptor3-manifest.mjs";

const liveEvidence: unknown[] = [];
export const keyLiveProvider = provider;
export async function saveLiveKeyEvidence() {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (!directory) return;
  await writeFile(
    join(directory, "g2-live-key-evidence.json"),
    JSON.stringify({
      identity: captureRaptor3Identity(),
      provider,
      records: encodeEvidenceValue(liveEvidence),
    })
  );
}

function tableDefinitions(observation: LiveNames): Record<string, string> {
  const q = observation.quote;
  const table = observation.table;
  const text = provider === "pg" ? "TEXT" : "VARCHAR(191)";
  const integer = provider === "pg" ? "INTEGER" : "INT";
  return {
    g2_orgs: `${q("id")} ${text} PRIMARY KEY NOT NULL,${q("slug")} ${text} NOT NULL UNIQUE`,
    g2_seats: `${q("id")} ${text} PRIMARY KEY NOT NULL,${q("name")} ${text} NOT NULL,${q("orgId")} ${text},FOREIGN KEY(${q("orgId")}) REFERENCES ${table("g2_orgs")}(${q("id")}) ON UPDATE SET NULL`,
    g2_zones: `${q("region")} ${text} NOT NULL,${q("code")} ${text} NOT NULL,${q("label")} ${text} NOT NULL,PRIMARY KEY(${q("region")},${q("code")})`,
    g2_spots: `${q("id")} ${text} PRIMARY KEY NOT NULL,${q("name")} ${text} NOT NULL,${q("zoneRegion")} ${text},${q("zoneCode")} ${text},FOREIGN KEY(${q("zoneRegion")},${q("zoneCode")}) REFERENCES ${table("g2_zones")}(${q("region")},${q("code")}) ON UPDATE SET NULL`,
    g2_counters: `${q("id")} ${integer} PRIMARY KEY NOT NULL,${q("tag")} ${text} NOT NULL UNIQUE`,
    g2_ticks: `${q("id")} ${text} PRIMARY KEY NOT NULL,${q("counterId")} ${integer},FOREIGN KEY(${q("counterId")}) REFERENCES ${table("g2_counters")}(${q("id")}) ON UPDATE SET NULL`,
    g2_bays: `${q("id")} ${text} PRIMARY KEY NOT NULL,${q("area")} ${text} NOT NULL,${q("slot")} ${text},UNIQUE(${q("area")},${q("slot")})`,
    g2_pads: `${q("id")} ${text} PRIMARY KEY NOT NULL,${q("bayArea")} ${text},${q("baySlot")} ${text},FOREIGN KEY(${q("bayArea")},${q("baySlot")}) REFERENCES ${table("g2_bays")}(${q("area")},${q("slot")}) ON UPDATE SET NULL`,
  };
}

/** Key recipes retain their original native evidence and assertion surface. */
export async function runLiveKeyScenario(
  scenario: KeyScenario,
  candidateFactory?: CandidateEngineFactory
) {
  const fixture = scenario.prepare();
  const world = await runLiveWorld(fixture, tableDefinitions, candidateFactory);
  liveEvidence.push({
    scenarioId: scenario.id,
    candidate: candidateFactory ? "commands" : "legacy",
    namespace: world.namespace,
    candidateEntries: world.candidateEntries,
    observation: world.observation,
    statements: world.statements,
  });
  world.assertHealthy();
  fixture.assert(world.observation);
  return {
    fixture,
    observation: world.observation,
    provider,
    namespace: world.namespace,
    statements: world.statements,
  };
}

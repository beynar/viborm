import assert from "node:assert/strict";
import { s } from "@schema";
import {
  createIdentifierQuoter,
  createQualifiedIdentifierRenderer,
} from "@src/sql/identifiers";
import type { PGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import type { G1_PROVIDER_CASE_IDS } from "../contracts";
import type {
  CandidateEngineFactory,
  RunObservation,
} from "../harness/protocol";

type ProducedCase = (typeof G1_PROVIDER_CASE_IDS)[number];

export const producedSchema = (() => {
  const depot = s
    .model({
      id: s.string().id(),
      serial: s.int().unique().increment(),
      crates: s.toMany(() => crate),
      bins: s.toMany(() => bin),
      holders: s.toMany(() => holder),
    })
    .map("g1_depots");
  const crate = s
    .model({
      id: s.string().id(),
      depotSerial: s.int(),
      depot: s
        .toOne(() => depot)
        .fields("depotSerial")
        .references("serial"),
    })
    .map("g1_crates");
  const bin = s
    .model({
      id: s.string().id(),
      depotSerial: s.int(),
      depot: s
        .toOne(() => depot)
        .fields("depotSerial")
        .references("serial"),
    })
    .map("g1_bins");
  const holder = s
    .model({
      id: s.string().id(),
      depotSerial: s.int(),
      depot: s
        .toOne(() => depot)
        .fields("depotSerial")
        .references("serial"),
    })
    .map("g1_holders");
  const hub = s
    .model({
      id: s.int().id().increment(),
      code: s.int().unique().increment(),
      spans: s.toMany(() => span),
      marks: s.toMany(() => mark),
    })
    .map("g1_hubs");
  const span = s
    .model({
      id: s.string().id(),
      hubId: s.int(),
      hub: s
        .toOne(() => hub)
        .fields("hubId")
        .references("id"),
    })
    .map("g1_spans");
  const mark = s
    .model({
      id: s.string().id(),
      hubCode: s.int(),
      hub: s
        .toOne(() => hub)
        .fields("hubCode")
        .references("code"),
    })
    .map("g1_marks");
  return { depot, crate, bin, holder, hub, span, mark };
})();

/** PostgreSQL-only C04 fixtures; the schema family owns setup, reset and teardown. */
export async function runProducedOutput(
  family: PGliteSchemaFamily<typeof producedSchema>,
  id: ProducedCase,
  requestedFactory?: CandidateEngineFactory
): Promise<RunObservation> {
  const fanoutArgs = {
    data: {
      id: "produced",
      crates: { create: { id: "new-crate" } },
      bins: { create: { id: "new-bin" } },
    },
    select: { id: true, serial: true },
  } as const;
  const beforeArgs = {
    data: { id: "new-holder", depot: { create: { id: "produced" } } },
    select: { id: true, depotSerial: true },
  } as const;
  const channelsArgs = {
    data: {
      spans: { create: { id: "new-span" } },
      marks: { create: { id: "new-mark" } },
    },
    select: { id: true, code: true },
  } as const;
  const { database, driver, client, namespace } = family;
  const table = createQualifiedIdentifierRenderer(
    createIdentifierQuoter('"'),
    namespace
  );
  await family.reset();
  const sequenceResponse = await database.query<{
    depot: string;
    hubId: string;
    hubCode: string;
  }>(
    `SELECT pg_get_serial_sequence($1,'serial') AS depot,
      pg_get_serial_sequence($2,'id') AS "hubId",
      pg_get_serial_sequence($2,'code') AS "hubCode"`,
    [table("g1_depots"), table("g1_hubs")]
  );
  const sequences = sequenceResponse.rows[0];
  assert.ok(sequences);
  await database.query(
    "SELECT setval($1::regclass,41,false),setval($2::regclass,41,false),setval($3::regclass,101,false)",
    [sequences.depot, sequences.hubId, sequences.hubCode]
  );
  let candidateExecutions = 0;
  const candidateFactory: CandidateEngineFactory | undefined = requestedFactory
    ? (config) => {
        const engine = requestedFactory(config);
        return {
          execute(...args) {
            candidateExecutions += 1;
            return engine.execute(...args);
          },
        };
      }
    : undefined;
  const distinct = id === "g1-produced-distinct-channels";
  const fanout = id === "g1-produced-nonprimary-fanout";
  const initial = {
    depots: [{ id: "decoy", serial: 7 }],
    crates: [{ id: "old-crate", depotSerial: 7 }],
    bins: [{ id: "old-bin", depotSerial: 7 }],
    holders: [{ id: "old-holder", depotSerial: 7 }],
    hubs: [{ id: 7, code: 17 }],
    spans: [{ id: "old-span", hubId: 7 }],
    marks: [{ id: "old-mark", hubCode: 17 }],
    sequences: [
      { name: "depot-serial", value: 41, called: false },
      { name: "hub-code", value: 101, called: false },
      { name: "hub-id", value: 41, called: false },
    ],
  };
  const final = {
    depots: distinct
      ? initial.depots
      : [...initial.depots, { id: "produced", serial: 41 }],
    crates: fanout
      ? [{ id: "new-crate", depotSerial: 41 }, ...initial.crates]
      : initial.crates,
    bins: fanout
      ? [{ id: "new-bin", depotSerial: 41 }, ...initial.bins]
      : initial.bins,
    holders:
      !distinct && !fanout
        ? [{ id: "new-holder", depotSerial: 41 }, ...initial.holders]
        : initial.holders,
    hubs: distinct ? [...initial.hubs, { id: 41, code: 101 }] : initial.hubs,
    spans: distinct
      ? [{ id: "new-span", hubId: 41 }, ...initial.spans]
      : initial.spans,
    marks: distinct
      ? [{ id: "new-mark", hubCode: 101 }, ...initial.marks]
      : initial.marks,
    sequences: [
      { name: "depot-serial", value: 41, called: !distinct },
      { name: "hub-code", value: 101, called: distinct },
      { name: "hub-id", value: 41, called: distinct },
    ],
  };
  const inspect = async () => ({
    depots: (
      await database.query(`SELECT * FROM ${table("g1_depots")} ORDER BY id`)
    ).rows,
    crates: (
      await database.query(`SELECT * FROM ${table("g1_crates")} ORDER BY id`)
    ).rows,
    bins: (
      await database.query(`SELECT * FROM ${table("g1_bins")} ORDER BY id`)
    ).rows,
    holders: (
      await database.query(`SELECT * FROM ${table("g1_holders")} ORDER BY id`)
    ).rows,
    hubs: (
      await database.query(`SELECT * FROM ${table("g1_hubs")} ORDER BY id`)
    ).rows,
    spans: (
      await database.query(`SELECT * FROM ${table("g1_spans")} ORDER BY id`)
    ).rows,
    marks: (
      await database.query(`SELECT * FROM ${table("g1_marks")} ORDER BY id`)
    ).rows,
    sequences: (
      await database.query(`
      SELECT 'depot-serial' AS name,last_value::int AS value,is_called AS called FROM ${sequences.depot}
      UNION ALL SELECT 'hub-code',last_value::int,is_called FROM ${sequences.hubCode}
      UNION ALL SELECT 'hub-id',last_value::int,is_called FROM ${sequences.hubId} ORDER BY name
    `)
    ).rows,
  });
  await database.exec(`
    INSERT INTO ${table("g1_depots")} (id,serial) VALUES ('decoy',7);
    INSERT INTO ${table("g1_crates")} (id,"depotSerial") VALUES ('old-crate',7);
    INSERT INTO ${table("g1_bins")} (id,"depotSerial") VALUES ('old-bin',7);
    INSERT INTO ${table("g1_holders")} (id,"depotSerial") VALUES ('old-holder',7);
    INSERT INTO ${table("g1_hubs")} (id,code) VALUES (7,17);
    INSERT INTO ${table("g1_spans")} (id,"hubId") VALUES ('old-span',7);
    INSERT INTO ${table("g1_marks")} (id,"hubCode") VALUES ('old-mark',17);
  `);
  const observedInitial = await inspect();
  assert.deepEqual(observedInitial, initial);
  let value: unknown;
  if (candidateFactory) {
    const engine = candidateFactory({ schema: producedSchema, driver });
    value = distinct
      ? await engine.execute("hub", "create", channelsArgs)
      : fanout
        ? await engine.execute("depot", "create", fanoutArgs)
        : await engine.execute("holder", "create", beforeArgs);
  } else {
    value = distinct
      ? await client.hub.create(channelsArgs)
      : fanout
        ? await client.depot.create(fanoutArgs)
        : await client.holder.create(beforeArgs);
  }
  if (requestedFactory)
    assert.equal(
      candidateExecutions,
      1,
      "Expected exactly one candidate execution"
    );
  const observation: RunObservation = {
    outcome: { kind: "success", value },
    initial: observedInitial,
    final: await inspect(),
    defaults: [],
    reachedCuts: [],
  };
  assert.deepEqual(observation.final, final);
  assert.deepEqual(
    value,
    distinct
      ? { id: 41, code: 101 }
      : fanout
        ? { id: "produced", serial: 41 }
        : { id: "new-holder", depotSerial: 41 }
  );
  return observation;
}

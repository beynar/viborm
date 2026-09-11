import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createClient } from "@client/client";
import { s } from "@schema";
import type Database from "better-sqlite3";
import type { ScenarioDefinition } from "../harness/protocol";

const cases = [
  "g2-own-membership-connect",
  "g2-own-membership-disconnect",
  "g2-own-membership-later-connect",
] as const;

const selfMembershipScenarios: ScenarioDefinition[] = cases.map((id) => ({
  id,
  family: "C07",
  contracts: ["C06", "C07"],
  sources: [
    "tests/contracts/engine/write/polymorphic-write-family.test.ts",
    "src/query-engine/OwnWriteLedger.ts",
    "src/query-engine/OwnWriteAnalyzer.ts",
    "src/query-engine/RelationMembership.ts",
  ],
  prepare() {
    const disconnect = id === "g2-own-membership-disconnect";
    const laterConnect = id === "g2-own-membership-later-connect";
    const selectedId = disconnect ? 910 : 900;
    const node = s
      .model({
        id: s.int().id(),
        label: s.string(),
        children: s.toMany(() => node).name("tree"),
        parent: s
          .toOne({ node: () => node }, { values: { node: "tree.node.v1" } })
          .name("tree")
          .optional(),
      })
      .map("g2_membership_nodes");
    const schema = { node };
    // The shipped disconnect case spells children first: public relation
    // execution phases, not caller property order, make disconnect earlier.
    const mutation = laterConnect
      ? {
          children: {
            upsert: {
              where: { id: selectedId },
              create: { id: selectedId + 1, label: "must not create" },
              update: { label: "changed" },
            },
          },
          parent: { connect: { type: "node", where: { id: selectedId } } },
        }
      : disconnect
        ? {
            children: {
              upsert: {
                where: { id: selectedId },
                create: { id: selectedId + 1, label: "must not create" },
                update: { label: "must not update" },
              },
            },
            parent: { disconnect: true },
          }
        : {
            children: { connect: { id: selectedId } },
            parent: {
              upsert: {
                type: "node",
                create: { id: selectedId + 1, label: "must not create" },
                update: { label: "must not update" },
              },
            },
          };
    const args = {
      where: { id: selectedId },
      data: mutation,
      select: { id: true, label: true },
    } as const;
    const initial = {
      nodes: [
        {
          id: selectedId,
          label: "root",
          parent_type: disconnect || laterConnect ? "tree.node.v1" : null,
          parent_id: disconnect || laterConnect ? selectedId : null,
        },
        { id: 990, label: "other root", parent_type: null, parent_id: null },
        {
          id: 991,
          label: "other member",
          parent_type: "tree.node.v1",
          parent_id: 990,
        },
      ],
    };
    const final = laterConnect
      ? {
          nodes: [
            { ...initial.nodes[0], label: "changed" },
            initial.nodes[1],
            initial.nodes[2],
          ],
        }
      : initial;
    const inspect = (database: Database.Database) => ({
      nodes: database
        .prepare("SELECT * FROM g2_membership_nodes ORDER BY id")
        .all(),
    });
    let ownEffectObserved = false;
    return {
      publicInput: { model: "node", operation: "update", args },
      requiredCuts: [],
      seed(database) {
        database.exec(`
            CREATE TABLE g2_membership_nodes(
              id INTEGER PRIMARY KEY,
              label TEXT NOT NULL,
              parent_type TEXT,
              parent_id INTEGER,
              CHECK ((parent_type IS NULL AND parent_id IS NULL) OR
                (parent_type IS NOT NULL AND parent_id IS NOT NULL AND parent_type='tree.node.v1'))
            );
          `);
        const insert = database.prepare(
          "INSERT INTO g2_membership_nodes(id,label,parent_type,parent_id) VALUES(?,?,?,?)"
        );
        for (const row of initial.nodes)
          insert.run(row.id, row.label, row.parent_type, row.parent_id);
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return candidateFactory({ schema, driver }).execute(
            "node",
            "update",
            args
          );
        const client = createClient({ schema, driver });
        // This fixture-owned union crosses only the public method boundary;
        // public operation admission still decides both nested payloads.
        const publicClient = client as unknown as {
          node: { update(input: typeof args): Promise<unknown> };
        };
        return publicClient.node.update(args);
      },
      inspect,
      afterStatement(database) {
        if (!laterConnect && !isDeepStrictEqual(inspect(database), initial))
          ownEffectObserved = true;
        return undefined;
      },
      assert(observation) {
        if (!laterConnect)
          assert.equal(
            ownEffectObserved,
            false,
            "membership-own-write-before-effects: refuse before changing either carrier column or any target row"
          );
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(observation.final, final);
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(observation.reachedCuts, []);
        if (laterConnect) {
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: { id: 900, label: "changed" },
          });
          return;
        }
        assert.equal(observation.outcome.kind, "failure");
        if (observation.outcome.kind !== "failure") return;
        const failure = observation.outcome.failure;
        const relation = disconnect ? "children" : "parent";
        const earlier = disconnect ? "disconnect" : "connect";
        assert.equal(failure.name, "NestedWriteError");
        assert.equal(failure.code, "V7001");
        assert.equal(
          failure.message,
          `Nested operation 'upsert' on relation '${relation}' depends on an earlier '${earlier}' membership write in the same nested write. Split these operations into separate queries.`
        );
        // dependency/overlap are not in the public diagnostic disclosure set.
        assert.deepEqual(Object.assign({}, failure.meta), {
          operation: "upsert",
          conflictsWith: earlier,
          relation,
        });
        assert.equal(failure.cause, undefined);
      },
    };
  },
}));

export const membershipOwnWriteScenarios: ScenarioDefinition[] = [
  ...selfMembershipScenarios,
  {
    id: "g2-own-membership-shared-column",
    family: "C07",
    contracts: ["C06", "C07"],
    sources: [
      "src/query-engine/RelationMembership.ts",
      "src/query-engine/OwnWriteLedger.ts",
      "src/query-engine/OwnWriteAnalyzer.ts",
    ],
    prepare() {
      const target = s
        .model({
          tenantId: s.int(),
          code: s.string(),
          label: s.string(),
          rightHolders: s.toMany(() => holder).name("right"),
          leftHolders: s.toMany(() => holder).name("left"),
        })
        .id(["tenantId", "code"])
        .map("g2_membership_targets");
      const holder = s
        .model({
          id: s.int().id(),
          tenantId: s.int(),
          leftCode: s.string(),
          rightCode: s.string(),
          right: s
            .toOne(() => target)
            .fields("tenantId", "rightCode")
            .references("tenantId", "code")
            .name("right"),
          left: s
            .toOne(() => target)
            .fields("tenantId", "leftCode")
            .references("tenantId", "code")
            .name("left"),
        })
        .map("g2_membership_holders");
      const schema = { target, holder };
      // Shipped relationMembershipScopesEqual compares the COMPLETE foreign-key
      // tuple. An unchanged shared tenant column does not merge these two edges.
      const args = {
        where: { id: 1 },
        data: {
          right: { connect: { tenantId_code: { tenantId: 1, code: "R2" } } },
          left: { update: { label: "changed" } },
        },
        select: { id: true, tenantId: true, leftCode: true, rightCode: true },
      } as const;
      const initial = {
        holders: [
          { id: 1, tenantId: 1, leftCode: "L", rightCode: "R1" },
          { id: 2, tenantId: 2, leftCode: "L", rightCode: "R1" },
        ],
        targets: [
          { tenantId: 1, code: "L", label: "selected left" },
          { tenantId: 1, code: "R1", label: "previous right" },
          { tenantId: 1, code: "R2", label: "supplied right" },
          { tenantId: 2, code: "L", label: "crossed left" },
          { tenantId: 2, code: "R1", label: "crossed previous right" },
          { tenantId: 2, code: "R2", label: "crossed supplied right" },
        ],
      };
      const publicValue = {
        id: 1,
        tenantId: 1,
        leftCode: "L",
        rightCode: "R2",
      };
      const final = {
        holders: [publicValue, initial.holders[1]],
        targets: [
          { tenantId: 1, code: "L", label: "changed" },
          ...initial.targets.slice(1),
        ],
      };
      return {
        publicInput: { model: "holder", operation: "update", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
            CREATE TABLE g2_membership_targets(
              tenantId INTEGER NOT NULL,code TEXT NOT NULL,label TEXT NOT NULL,
              PRIMARY KEY(tenantId,code)
            );
            CREATE TABLE g2_membership_holders(
              id INTEGER PRIMARY KEY,tenantId INTEGER NOT NULL,
              leftCode TEXT NOT NULL,rightCode TEXT NOT NULL,
              FOREIGN KEY(tenantId,rightCode) REFERENCES g2_membership_targets(tenantId,code),
              FOREIGN KEY(tenantId,leftCode) REFERENCES g2_membership_targets(tenantId,code)
            );
          `);
          const insertTarget = database.prepare(
            "INSERT INTO g2_membership_targets(tenantId,code,label) VALUES(?,?,?)"
          );
          for (const row of initial.targets)
            insertTarget.run(row.tenantId, row.code, row.label);
          const insertHolder = database.prepare(
            "INSERT INTO g2_membership_holders(id,tenantId,leftCode,rightCode) VALUES(?,?,?,?)"
          );
          for (const row of initial.holders)
            insertHolder.run(row.id, row.tenantId, row.leftCode, row.rightCode);
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "holder",
              "update",
              args
            );
          return createClient({ schema, driver }).holder.update(args);
        },
        inspect(database) {
          return {
            holders: database
              .prepare("SELECT * FROM g2_membership_holders ORDER BY id")
              .all(),
            targets: database
              .prepare(
                "SELECT * FROM g2_membership_targets ORDER BY tenantId,code"
              )
              .all(),
          };
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(observation.final, final);
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, []);
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: publicValue,
          });
        },
      };
    },
  },
];

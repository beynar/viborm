/** Missing G0 write families: public recipes and independent raw-state properties. */

import assert from "node:assert/strict";
import { observeBenchmarkContract } from "./operation-pipeline-harness.mjs";
import { assertSemanticDigest } from "./operation-pipeline-semantics.mjs";

const orderedChildren = (rows) =>
  rows.toSorted((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );

export async function buildContractWorkload(name, fixture, semanticFixture) {
  if (
    name === "nested-conditional-found" ||
    name === "nested-conditional-missing"
  ) {
    const found = name.endsWith("-found");
    const invocation = (world) => {
      let sequence = 0;
      return (cold) => {
        const current = sequence++;
        const client = cold ? world.createColdClient() : world.client;
        return client.generatedParent.create({
          data: {
            label: `conditional-${current}`,
            children: {
              connectOrCreate: {
                where: {
                  id: found
                    ? "conditional_found"
                    : `conditional_new_${current}`,
                },
                create: {
                  id: found
                    ? `unselected_${current}`
                    : `conditional_new_${current}`,
                  label: "created-child",
                },
              },
            },
          },
          select: {
            id: true,
            label: true,
            children: { select: { id: true, parentId: true, label: true } },
          },
        });
      };
    };
    return createContractHarness(
      fixture,
      semanticFixture,
      invocation,
      (value) => value.children.length,
      ({ outcome, initial, final, defaults, reachedCuts }) => {
        const child = {
          id: found ? "conditional_found" : "conditional_new_0",
          parentId: 10001,
          label: found ? "existing-child" : "created-child",
        };
        assert.deepEqual(outcome, {
          kind: "success",
          value: { id: 10001, label: "conditional-0", children: [child] },
        });
        assert.deepEqual(final, {
          ...initial,
          bench_generated_parents: [
            ...initial.bench_generated_parents,
            { id: 10001, label: "conditional-0" },
          ],
          bench_generated_children: found
            ? initial.bench_generated_children.map((row) =>
                row.id === "conditional_found" ? child : row
              )
            : orderedChildren([...initial.bench_generated_children, child]),
          sqlite_sequence: initial.sqlite_sequence.map((row) =>
            row.name === "bench_generated_parents"
              ? { ...row, seq: 10001 }
              : row
          ),
        });
        assert.deepEqual(defaults, []);
        assert.deepEqual(reachedCuts, [
          "generated-parent-visible",
          found ? "found-child-associated" : "missing-child-associated",
        ]);
      },
      (database) => {
        const cuts = [];
        const parent = database
          .prepare(
            "SELECT id,label FROM bench_generated_parents WHERE id=10001"
          )
          .get();
        if (parent) {
          assert.deepEqual(parent, { id: 10001, label: "conditional-0" });
          cuts.push("generated-parent-visible");
        }
        const child = database
          .prepare("SELECT parentId FROM bench_generated_children WHERE id=?")
          .get(found ? "conditional_found" : "conditional_new_0");
        if (child?.parentId === 10001) {
          assert(
            parent,
            "child association became visible without its generated parent"
          );
          cuts.push(
            found ? "found-child-associated" : "missing-child-associated"
          );
        }
        assert.equal(
          database
            .prepare(
              "SELECT count(*) FROM bench_generated_children WHERE id='unselected_0'"
            )
            .pluck()
            .get(),
          0
        );
        return cuts;
      }
    );
  }
  if (name === "key-transition-cascade") {
    const invocation = (world) => {
      let sequence = 0;
      return (cold) => {
        const current = sequence++;
        const client = cold ? world.createColdClient() : world.client;
        return client.generatedParent.update({
          where: { id: 10000 + current },
          data: { id: 10001 + current, label: "transitioned" },
          select: {
            id: true,
            label: true,
            children: { select: { id: true, parentId: true, label: true } },
          },
        });
      };
    };
    return createContractHarness(
      fixture,
      semanticFixture,
      invocation,
      (value) => value.children.length,
      ({ outcome, initial, final, defaults, reachedCuts }) => {
        assert.deepEqual(outcome, {
          kind: "success",
          value: {
            id: 10001,
            label: "transitioned",
            children: [
              {
                id: "transition_child",
                parentId: 10001,
                label: "cascade-child",
              },
            ],
          },
        });
        assert.deepEqual(final, {
          ...initial,
          bench_generated_parents: initial.bench_generated_parents.map((row) =>
            row.id === 10000 ? { id: 10001, label: "transitioned" } : row
          ),
          bench_generated_children: initial.bench_generated_children.map(
            (row) =>
              row.id === "transition_child" ? { ...row, parentId: 10001 } : row
          ),
        });
        assert.deepEqual(defaults, []);
        assert.deepEqual(reachedCuts, ["key-and-reference-transition-visible"]);
      },
      (database) => {
        const parent = database
          .prepare(
            "SELECT id,label FROM bench_generated_parents WHERE id=10001"
          )
          .get();
        if (!parent) return [];
        assert.deepEqual(parent, { id: 10001, label: "transitioned" });
        assert.equal(
          database
            .prepare(
              "SELECT count(*) FROM bench_generated_parents WHERE id=10000"
            )
            .pluck()
            .get(),
          0
        );
        assert.deepEqual(
          database
            .prepare(
              "SELECT parentId FROM bench_generated_children WHERE id='transition_child'"
            )
            .get(),
          { parentId: 10001 }
        );
        return ["key-and-reference-transition-visible"];
      }
    );
  }
  if (name === "relation-series-2") {
    const invocation = (world) => (cold) => {
      const client = cold ? world.createColdClient() : world.client;
      return client.generatedParent.updateMany({
        where: { id: { in: [5000, 6000] } },
        data: { children: { create: { label: "series-child" } } },
      });
    };
    return createContractHarness(
      fixture,
      semanticFixture,
      invocation,
      (value) => value.count,
      ({ outcome, initial, final, defaults, reachedCuts }) => {
        assert.deepEqual(outcome, { kind: "success", value: { count: 2 } });
        assert.deepEqual(
          defaults,
          Array.from({ length: 5 }, (_, index) => ({
            name: "generatedChild.id",
            value: `series_child_${index + 1}`,
          }))
        );
        assert.deepEqual(final, {
          ...initial,
          bench_generated_children: orderedChildren([
            ...initial.bench_generated_children,
            { id: "series_child_3", parentId: 5000, label: "series-child" },
            { id: "series_child_5", parentId: 6000, label: "series-child" },
          ]),
        });
        assert.deepEqual(reachedCuts, [
          "selected-roots-captured",
          "first-member-visible",
          "second-member-visible",
        ]);
      },
      (database, rows, defaults) => {
        const cuts = [];
        // Stock SQLite typed results retain INTEGER keys as bigint until parsing.
        if (
          rows.length === 2 &&
          rows.some((row) => row?.id === 5000n) &&
          rows.some((row) => row?.id === 6000n)
        ) {
          assert.equal(
            defaults.length,
            1,
            "selected members were admitted before capture completed"
          );
          cuts.push("selected-roots-captured");
        }
        const children = database
          .prepare(
            "SELECT id,parentId FROM bench_generated_children WHERE label='series-child' ORDER BY parentId"
          )
          .all();
        if (children.length > 0) {
          assert.equal(
            defaults.length,
            5,
            "series effects started before every member was admitted"
          );
          assert.deepEqual(children[0], {
            id: "series_child_3",
            parentId: 5000,
          });
          cuts.push("first-member-visible");
        }
        if (children.length > 1) {
          assert.deepEqual(children[1], {
            id: "series_child_5",
            parentId: 6000,
          });
          cuts.push("second-member-visible");
        }
        return cuts;
      }
    );
  }
  return undefined;
}

async function createContractHarness(
  fixture,
  semanticFixture,
  invocation,
  consume,
  verify,
  afterStatement
) {
  const measured = invocation(fixture);
  const semantic = invocation(semanticFixture);
  const contract = await observeBenchmarkContract(
    semanticFixture,
    () => semantic(false),
    verify,
    afterStatement
  );
  const measuredValue = await measured(false);
  const digest = assertSemanticDigest(
    "public write across fresh fixtures",
    contract.contractObservation.outcome.value,
    measuredValue
  );
  return {
    ...contract,
    semanticDigest: digest,
    full: async () => consume(await measured(false)),
    // Both modes include public admission, provider I/O, and decoding. Cold
    // additionally constructs fresh schema/client owners inside the timed call.
    "cold-full": async () => consume(await measured(true)),
  };
}

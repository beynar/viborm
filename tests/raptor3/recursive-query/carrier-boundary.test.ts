import assert from "node:assert/strict";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import type { NormalizedRecurrence } from "@validation/relations/recurrence";
import { describe, it } from "vitest";

const treeNode = (() => {
  const node = s.model({
    id: s.string().id(),
    mutable: s.json(),
    __rq_root: s.string(),
    __rq_nodes: s.string(),
    __rq_edges: s.string(),
    __rq_key: s.string(),
    __rq_row: s.string(),
    __rq_parent: s.string(),
    __rq_child: s.string(),
    __rq_depth: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id")
      .name("carrierTree"),
    children: s.toMany(() => node).name("carrierTree"),
  });
  return node;
})();

const graphNode = (() => {
  const node = s.model({
    id: s.string().id(),
    mutable: s.json(),
    links: s.toMany(() => node).name("carrierGraph"),
    linkedBy: s.toMany(() => node).name("carrierGraph"),
  });
  return node;
})();

/**
 * The admitted singular self-relation: an OWNING to-one whose foreign key is
 * nullable.
 *
 * A non-nullable self foreign key is not admissible, so no runtime carrier can
 * exercise a *required* singular recursive slot today: CM002
 * (`schema/validation/relation-resolution.ts`) reports "Circular required
 * relations" for a foreign key whose every local member is non-nullable,
 * because such a row can never be inserted, and its stated repair is to make
 * one key in the cycle nullable. That check runs before any projection is
 * prepared, so a required self-singular fixture proves nothing about decoding —
 * it only fails schema validation. The required-missing case therefore stays an
 * abstract oracle pin, explicitly labelled as such; this fixture does not fake
 * a schema to reach it.
 */
const singularNode = (() => {
  const node = s.model({
    id: s.string().id(),
    nextId: s.string().nullable().unique(),
    next: s
      .toOne(() => node)
      .fields("nextId")
      .references("id")
      .name("singularCarrier"),
    previous: s.toOne(() => node).name("singularCarrier"),
  });
  return node;
})();

interface CarrierNode {
  readonly __rq_key?: unknown;
  readonly __rq_row?: unknown;
}

interface CarrierEdge {
  readonly __rq_parent: unknown;
  readonly __rq_child: unknown;
  readonly __rq_depth?: unknown;
}

const carrier = (
  root: unknown,
  nodes: readonly CarrierNode[],
  edges: readonly CarrierEdge[]
) => ({ __rq_root: root, __rq_nodes: nodes, __rq_edges: edges });

const node = (id: string, mutable: unknown = {}) => ({
  __rq_key: [id],
  __rq_row: { id, mutable },
});

const edge = (parent: string, child: string, depth?: number) => ({
  __rq_parent: [parent],
  __rq_child: [child],
  ...(depth === undefined ? {} : { __rq_depth: depth }),
});

const MODELS = { treeNode, graphNode, singularNode };

/**
 * The decoder of one recursive slot of `model` (registered under its own
 * name), fed a carrier as the provider value.
 */
function decoderFor(
  model: keyof typeof MODELS,
  relation: string,
  recurrence: NormalizedRecurrence,
  select: Record<string, true>
) {
  const queries = new Queries(
    new EngineSchema({ [model]: MODELS[model] }),
    new SQLiteAdapter()
  );
  const projection = queries.prepareProjection(MODELS[model], {
    select: { [relation]: { recurse: recurrence, select } },
  });
  return (value: unknown): unknown => {
    const row = queries.decodeProjection(projection.shape, [
      { [relation]: value },
    ])[0];
    assert(row);
    return row[relation];
  };
}

const treeDecoder = (
  recurrence: NormalizedRecurrence,
  select: Record<string, true> = { id: true, mutable: true }
) => decoderFor("treeNode", "children", recurrence, select);

const graphDecoder = (recurrence: NormalizedRecurrence) =>
  decoderFor("graphNode", "links", recurrence, { id: true, mutable: true });

const singularDecoder = () =>
  decoderFor(
    "singularNode",
    "next",
    { depth: false, cycles: "reject" },
    { id: true }
  );

describe("recursive carrier boundary", () => {
  it("rejects wrong-width and sparse identity tuples", () => {
    const decode = treeDecoder({ depth: 2, cycles: "reject" });
    assert.throws(
      () => decode(carrier(["root", "extra"], [], [])),
      /Invalid provider recursive identity/
    );

    const sparse = Array(1);
    assert.throws(
      () => decode(carrier(sparse, [], [])),
      /Invalid provider string/
    );
  });

  it("rejects duplicate nodes and nodes without an identity", () => {
    const decode = treeDecoder({ depth: 2, cycles: "reject" });
    assert.throws(
      () =>
        decode(
          carrier(
            ["root"],
            [node("child"), node("child")],
            [edge("root", "child", 1)]
          )
        ),
      /Invalid provider duplicate recursive node/
    );
    assert.throws(
      () =>
        decode(
          carrier(
            ["root"],
            [{ __rq_row: { id: "child", mutable: {} } }],
            []
          )
        ),
      /Invalid provider recursive identity/
    );
  });

  it("rejects dangling, unreachable, and duplicate edge facts", () => {
    const decode = treeDecoder({ depth: 2, cycles: "reject" });
    assert.throws(
      () =>
        decode(
          carrier(
            ["root"],
            [node("child")],
            [edge("root", "missing", 1)]
          )
        ),
      /Invalid provider recursive edge endpoint/
    );
    assert.throws(
      () => decode(carrier(["root"], [node("orphan")], [])),
      /Invalid provider unreachable recursive node/
    );
    assert.throws(
      () =>
        decode(
          carrier(
            ["root"],
            [node("child")],
            [edge("root", "child", 1), edge("root", "child", 1)]
          )
        ),
      /Invalid provider duplicate recursive edge/
    );

    // An exhaustive carrier states no depth, so an edge nothing consumes can
    // only mean its parent was never reached: the answer is the unreachable
    // node, never a depth this carrier does not carry.
    assert.throws(
      () =>
        treeDecoder({ depth: false, cycles: "reject" })(
          carrier(
            ["root"],
            [node("reached"), node("stranded")],
            [edge("root", "reached"), edge("stranded", "reached")]
          )
        ),
      /Invalid provider unreachable recursive node/
    );
  });

  it("requires bounded depth facts and forbids them on exhaustive carriers", () => {
    const bounded = treeDecoder({ depth: 2, cycles: "reject" });
    assert.deepEqual(
      bounded(
        carrier(
          ["root"],
          [node("child")],
          [edge("root", "child", 1)]
        )
      ),
      [{ id: "child", mutable: {}, children: [] }]
    );
    assert.throws(
      () =>
        bounded(
          carrier(["root"], [node("child")], [edge("root", "child")])
        ),
      /Invalid provider recursive depth/
    );

    const exhaustive = treeDecoder({ depth: false, cycles: "reject" });
    assert.deepEqual(
      exhaustive(
        carrier(["root"], [node("child")], [edge("root", "child")])
      ),
      [{ id: "child", mutable: {}, children: [] }]
    );
    assert.throws(
      () =>
        exhaustive(
          carrier(
            ["root"],
            [node("child")],
            [edge("root", "child", 1)]
          )
        ),
      /Invalid provider exhaustive recursive depth/
    );
  });

  it("applies cycle policy to a direct root self-loop", () => {
    const selfLoop = carrier(
      ["root"],
      [node("root")],
      [edge("root", "root")]
    );
    const prevent = graphDecoder({ depth: false, cycles: "prevent" });
    assert.deepEqual(prevent(selfLoop), []);

    const reject = treeDecoder({ depth: false, cycles: "reject" });
    assert.throws(
      () => reject(selfLoop),
      /Recursive relation 'children' contains a cycle/
    );

    // The same admission, with prevention disabled: the root seeding prunes
    // nothing, the repeated identity unfolds to the numeric cutoff, and the
    // cut-off occurrence omits the repeated slot.
    const allow = graphDecoder({ depth: 2, cycles: "allow" });
    assert.deepEqual(
      allow(
        carrier(
          ["root"],
          [node("root")],
          [edge("root", "root", 1), edge("root", "root", 2)]
        )
      ),
      [{ id: "root", mutable: {}, links: [{ id: "root", mutable: {} }] }]
    );
  });

  it("rejects bounded edge facts attributed to the wrong traversal level", () => {
    const decode = treeDecoder({ depth: 2, cycles: "reject" });
    for (const invalidDepth of [0, 1.5, 3]) {
      assert.throws(
        () =>
          decode(
            carrier(
              ["root"],
              [node("child")],
              [edge("root", "child", invalidDepth)]
            )
          ),
        /Invalid provider recursive depth/
      );
    }
    assert.throws(
      () =>
        decode(
          carrier(
            ["root"],
            [node("child"), node("grandchild")],
            [
              edge("root", "child", 2),
              edge("child", "grandchild", 1),
            ]
          )
        ),
      /Invalid provider recursive depth/
    );
    // A fact attributed to a level its parent never occupies, beside the same
    // hop at the level it does: 'P' is reached only at level 1, so 'P' → 'C'
    // at 3 is consumed at no level. Every hop still carries its parent's one
    // answer, so the per-level hop check passes it and only the consumed-facts
    // guard refuses it.
    assert.throws(
      () =>
        graphDecoder({ depth: 3, cycles: "prevent" })(
          carrier(
            ["root"],
            [node("P"), node("C")],
            [edge("root", "P", 1), edge("P", "C", 2), edge("P", "C", 3)]
          )
        ),
      /Invalid provider recursive depth/
    );

    // The same rule must ACCEPT the legitimate shape it resembles: 'near' is
    // reached at level 1 from the root and at level 2 through 'far', so its
    // own edge is transported at both levels, and the deeper occurrence stops
    // at the cutoff.
    const accepted = graphDecoder({ depth: 3, cycles: "prevent" });
    assert.deepEqual(
      accepted(
        carrier(
          ["root"],
          [node("near"), node("far"), node("leaf")],
          [
            edge("root", "near", 1),
            edge("root", "far", 1),
            edge("near", "leaf", 2),
            edge("far", "near", 2),
            edge("near", "leaf", 3),
          ]
        )
      ),
      [
        {
          id: "near",
          mutable: {},
          links: [{ id: "leaf", mutable: {}, links: [] }],
        },
        {
          id: "far",
          mutable: {},
          links: [
            { id: "near", mutable: {}, links: [{ id: "leaf", mutable: {} }] },
          ],
        },
      ]
    );
  });

  it("refuses a bounded carrier that omits a hop's children at one level a parent is reached", () => {
    // The engine's SQL discovers a parent's children at EVERY level it reaches
    // that parent below the cutoff (a filter prunes every hop the same way;
    // prevention is the decoder's, not the statement's). A carrier that holds
    // 'near' → 'leaf' at level 2 but not at level 3, while 'near' is reached at
    // level 2 through 'far', is therefore malformed — and a decoder that reused
    // 'near''s one answer at level 3 would invent an occurrence the provider
    // never transported. The answer is the refusal, never the invented row.
    const decode = graphDecoder({ depth: 3, cycles: "prevent" });
    assert.throws(
      () =>
        decode(
          carrier(
            ["root"],
            [node("near"), node("far"), node("leaf")],
            [
              edge("root", "near", 1),
              edge("root", "far", 1),
              edge("near", "leaf", 2),
              edge("far", "near", 2),
            ]
          )
        ),
      /Invalid provider recursive depth/
    );
  });

  it("rejects sparse node and edge containers and a cyclic JavaScript carrier", () => {
    const decode = treeDecoder({ depth: 2, cycles: "reject" });
    const sparseNodes = Array<CarrierNode>(1);
    assert.throws(
      () => decode(carrier(["root"], sparseNodes, [])),
      /Invalid provider recursive node/
    );

    const sparseEdges = Array<CarrierEdge>(1);
    assert.throws(
      () => decode(carrier(["root"], [node("child")], sparseEdges)),
      /Invalid provider recursive edge/
    );

    assert.throws(
      () =>
        decode(
          carrier(
            ["root"],
            [{ __rq_key: ["child"], __rq_row: null }],
            [edge("root", "child", 1)]
          )
        ),
      /Invalid provider recursive row/
    );

    assert.throws(
      () => decode({ __rq_root: ["root"], __rq_nodes: [] }),
      /Invalid provider recursive carrier/
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(
      () =>
        decode(
          carrier(
            ["root"],
            [node("child", cyclic)],
            [edge("root", "child", 1)]
          )
        ),
      /Invalid provider json/
    );

    const cyclicList: unknown[] = [];
    cyclicList.push(cyclicList);
    assert.throws(
      () =>
        decode(
          carrier(
            ["root"],
            [node("child", cyclicList)],
            [edge("root", "child", 1)]
          )
        ),
      /Invalid provider json/
    );
  });

  it("answers an empty singular carrier with null and rejects multiple successors", () => {
    // An admitted singular self-relation is nullable (see `singularNode`), so a
    // natural end is the permitted null, not a failure. The required-missing
    // failure is unreachable at runtime and stays an abstract oracle pin.
    const decode = singularDecoder();
    assert.equal(decode(carrier(["root"], [], [])), null);
    assert.throws(
      () =>
        decode(
          carrier(
            ["root"],
            [
              { __rq_key: ["left"], __rq_row: { id: "left" } },
              { __rq_key: ["right"], __rq_row: { id: "right" } },
            ],
            [edge("root", "left"), edge("root", "right")]
          )
        ),
      /Invalid provider recursive singular relation/
    );
  });

  it("keeps public fields that collide with every private carrier name", () => {
    const fields: Record<string, true> = {
      id: true,
      mutable: true,
      __rq_root: true,
      __rq_nodes: true,
      __rq_edges: true,
      __rq_key: true,
      __rq_row: true,
      __rq_parent: true,
      __rq_child: true,
      __rq_depth: true,
    };
    const publicRow = {
      id: "child",
      mutable: { public: true },
      __rq_root: "public-root",
      __rq_nodes: "public-nodes",
      __rq_edges: "public-edges",
      __rq_key: "public-key",
      __rq_row: "public-row",
      __rq_parent: "public-parent",
      __rq_child: "public-child",
      __rq_depth: "public-depth",
    };
    const decode = treeDecoder({ depth: false, cycles: "reject" }, fields);
    assert.deepEqual(
      decode(
        carrier(
          ["root"],
          [{ __rq_key: ["child"], __rq_row: publicRow }],
          [edge("root", "child")]
        )
      ),
      [{ ...publicRow, children: [] }]
    );
  });

  it("materializes fresh diamond occurrences and mutable JSON leaves", () => {
    const decode = graphDecoder({ depth: false, cycles: "prevent" });
    const decoded = decode(
      carrier(
        ["root"],
        [
          node("left", { branch: "left" }),
          node("right", { branch: "right" }),
          node("shared", { nested: { value: 1 } }),
        ],
        [
          edge("root", "left"),
          edge("root", "right"),
          edge("left", "shared"),
          edge("right", "shared"),
        ]
      )
    );
    assert(Array.isArray(decoded));
    const left = decoded[0];
    const right = decoded[1];
    assert(left && typeof left === "object");
    assert(right && typeof right === "object");
    const leftLinks = Reflect.get(left, "links");
    const rightLinks = Reflect.get(right, "links");
    assert(Array.isArray(leftLinks));
    assert(Array.isArray(rightLinks));
    const leftShared = leftLinks[0];
    const rightShared = rightLinks[0];
    assert(leftShared && typeof leftShared === "object");
    assert(rightShared && typeof rightShared === "object");
    assert.notEqual(leftShared, rightShared);
    const leftMutable = Reflect.get(leftShared, "mutable");
    const rightMutable = Reflect.get(rightShared, "mutable");
    assert(leftMutable && typeof leftMutable === "object");
    assert(rightMutable && typeof rightMutable === "object");
    assert.notEqual(leftMutable, rightMutable);
    Reflect.set(leftMutable, "changed", true);
    assert.equal(Reflect.get(rightMutable, "changed"), undefined);

    const repeated = { value: 1 };
    const document = decode(
      carrier(
        ["root"],
        [node("twice", { first: repeated, second: repeated })],
        [edge("root", "twice")]
      )
    );
    assert.deepEqual(document, [
      {
        id: "twice",
        mutable: { first: { value: 1 }, second: { value: 1 } },
        links: [],
      },
    ]);
    assert(Array.isArray(document));
    const twice = document[0];
    assert(twice && typeof twice === "object");
    const members = Reflect.get(twice, "mutable");
    assert(members && typeof members === "object");
    assert.notEqual(Reflect.get(members, "first"), Reflect.get(members, "second"));
  });

  it("decodes a synthetic exhaustive chain beyond the public depth ceiling", () => {
    const decode = treeDecoder({ depth: false, cycles: "reject" });
    const nodes: CarrierNode[] = [];
    const edges: CarrierEdge[] = [];
    let parent = "root";
    for (let index = 0; index < 1_101; index += 1) {
      const child = `n${index}`;
      nodes.push(node(child, { index }));
      edges.push(edge(parent, child));
      parent = child;
    }
    let level = decode(carrier(["root"], nodes, edges));
    for (let index = 0; index < 1_101; index += 1) {
      assert(Array.isArray(level));
      assert.equal(level.length, 1);
      const occurrence = level[0];
      assert(occurrence && typeof occurrence === "object");
      assert.equal(Reflect.get(occurrence, "id"), `n${index}`);
      level = Reflect.get(occurrence, "children");
    }
    assert.deepEqual(level, []);
  });

  it("decodes a synthetic chain far beyond a copied ancestry", () => {
    // One active path, entered and left, costs a chain its own depth instead
    // of its depth squared. 12,000 levels decode inside this run's ordinary
    // heap/RSS ceilings; the 1,101-level cell above pins the public depth
    // ceiling, which is a different fact.
    const decode = treeDecoder({ depth: false, cycles: "reject" });
    const levels = 12_000;
    const nodes: CarrierNode[] = [];
    const edges: CarrierEdge[] = [];
    let parent = "root";
    for (let index = 0; index < levels; index += 1) {
      const child = `d${index}`;
      nodes.push(node(child));
      edges.push(edge(parent, child));
      parent = child;
    }
    let level = decode(carrier(["root"], nodes, edges));
    for (let index = 0; index < levels; index += 1) {
      assert(Array.isArray(level));
      assert.equal(level.length, 1);
      const occurrence = level[0];
      assert(occurrence && typeof occurrence === "object");
      assert.equal(Reflect.get(occurrence, "id"), `d${index}`);
      level = Reflect.get(occurrence, "children");
    }
    assert.deepEqual(level, []);
  });
});

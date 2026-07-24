import {
  type MembershipReadOrientation,
  OwnWriteLedger,
} from "@query-engine/OwnWriteLedger";
import type { RelationMembershipScope } from "@query-engine/RelationMembership";
import { normalizeTargetConstraint } from "@query-engine/TargetConstraint";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const target = s.model({
  id: s.int().id(),
  parentId: s.int(),
});

const membershipScope: RelationMembershipScope = {
  kind: "foreignKey",
  holder: target,
  referenced: target,
  fields: [{ foreignKey: "parentId", referencedKey: "id" }],
};

function constraint(id: number) {
  return normalizeTargetConstraint(target, ["id"], { id });
}

function endpoints(firstId: number, secondId = firstId) {
  return { first: constraint(firstId), second: constraint(secondId) };
}

describe("own-write ledger", () => {
  test("forks from a checkpoint and merges only branch deltas", () => {
    const ledger = new OwnWriteLedger();
    ledger.appendTarget("create", "targetExistence", constraint(1));
    const checkpoint = ledger.checkpoint();
    const membershipBranch = ledger.fork();
    const predicateBranch = ledger.fork();

    membershipBranch.appendMembership("connect", endpoints(2), membershipScope);
    predicateBranch.appendTarget(
      "update",
      "targetPredicate",
      constraint(3),
      new Set(["id"])
    );

    expect(ledger.deltaSince(checkpoint)).toEqual([]);
    ledger.mergeDeltas(
      membershipBranch.deltaSince(checkpoint),
      predicateBranch.deltaSince(checkpoint)
    );

    expect(
      ledger.deltaSince(checkpoint).map((footprint) => footprint.dimension)
    ).toEqual(["membership", "targetPredicate"]);
  });

  test("keeps a queued membership invisible until the insert barrier merges it", () => {
    const ledger = new OwnWriteLedger();
    const insertBarrier = ledger.emptyFork();
    insertBarrier.appendMembership(
      "create",
      endpoints(1, 2),
      membershipScope,
      "physical",
      "operation"
    );

    expect(() =>
      ledger.assertMembershipRead(
        "before-insert",
        "upsert",
        endpoints(1, 2),
        membershipScope,
        "direct"
      )
    ).not.toThrow();

    ledger.mergeDeltas(insertBarrier.deltaSince(0));

    expect(() =>
      ledger.assertMembershipRead(
        "after-insert",
        "upsert",
        endpoints(1, 2),
        membershipScope,
        "direct"
      )
    ).toThrow("depends on an earlier 'create' membership write");
  });

  test("exposes inverse-target membership writes only to inverse reads", () => {
    const ledger = new OwnWriteLedger();
    ledger.appendMembership(
      "update",
      endpoints(1),
      membershipScope,
      "inverseTarget"
    );

    expect(() =>
      ledger.assertMembershipRead(
        "parent",
        "update",
        endpoints(1),
        membershipScope,
        "direct"
      )
    ).not.toThrow();
    expect(() =>
      ledger.assertMembershipRead(
        "children",
        "update",
        endpoints(1),
        membershipScope,
        "inverse"
      )
    ).toThrow("depends on an earlier 'update' membership write");
  });

  test("exposes physical membership writes to either orientation", () => {
    const orientations: MembershipReadOrientation[] = ["direct", "inverse"];
    for (const orientation of orientations) {
      const ledger = new OwnWriteLedger();
      ledger.appendMembership(
        "connect",
        endpoints(1),
        membershipScope,
        "physical"
      );

      expect(() =>
        ledger.assertMembershipRead(
          "relation",
          "update",
          endpoints(1),
          membershipScope,
          orientation
        )
      ).toThrow("depends on an earlier 'connect' membership write");
    }
  });

  test("exports target writes but keeps node-local membership scoped", () => {
    const ledger = new OwnWriteLedger();
    ledger.withNestedScope(() => {
      ledger.appendTarget("create", "targetExistence", constraint(1));
      ledger.appendTarget(
        "update",
        "targetPredicate",
        constraint(2),
        new Set(["id"])
      );
      ledger.appendMembership("connect", endpoints(3), membershipScope);
    });

    expect(() =>
      ledger.assertTargetRead("target", "connectOrCreate", constraint(1))
    ).toThrow("depends on an earlier 'create' target write");
    expect(() =>
      ledger.assertTargetRead("predicate", "connectOrCreate", constraint(2))
    ).toThrow("depends on an earlier 'update' target write");
    expect(() =>
      ledger.assertMembershipRead(
        "membership",
        "update",
        endpoints(3),
        membershipScope,
        "direct"
      )
    ).not.toThrow();
  });

  test("nested reads inherit target writes but not node-local membership", () => {
    const ledger = new OwnWriteLedger();
    ledger.appendTarget("create", "targetExistence", constraint(1));
    ledger.appendTarget(
      "update",
      "targetPredicate",
      constraint(2),
      new Set(["id"])
    );
    ledger.appendMembership("connect", endpoints(3), membershipScope);

    ledger.withNestedScope(() => {
      expect(() =>
        ledger.assertTargetRead("target", "connectOrCreate", constraint(1))
      ).toThrow("depends on an earlier 'create' target write");
      expect(() =>
        ledger.assertTargetRead("predicate", "connectOrCreate", constraint(2))
      ).toThrow("depends on an earlier 'update' target write");
      expect(() =>
        ledger.assertMembershipRead(
          "membership",
          "update",
          endpoints(3),
          membershipScope,
          "direct"
        )
      ).not.toThrow();
    });
  });

  test("operation membership compares both canonical endpoints", () => {
    const ledger = new OwnWriteLedger();
    ledger.withNestedScope(() => {
      ledger.appendMembership(
        "connect",
        endpoints(1, 2),
        membershipScope,
        "physical",
        "operation"
      );
    });

    expect(() =>
      ledger.assertMembershipRead(
        "same-edge",
        "update",
        endpoints(1, 2),
        membershipScope,
        "direct"
      )
    ).toThrow("depends on an earlier 'connect' membership write");
    expect(() =>
      ledger.assertMembershipRead(
        "disjoint-source",
        "update",
        endpoints(3, 2),
        membershipScope,
        "direct"
      )
    ).not.toThrow();
    expect(() =>
      ledger.assertMembershipRead(
        "disjoint-target",
        "update",
        endpoints(1, 3),
        membershipScope,
        "direct"
      )
    ).not.toThrow();
  });
});

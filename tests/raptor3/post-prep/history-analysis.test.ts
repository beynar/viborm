import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import { NestedWriteError } from "@errors";
import {
  type Choose,
  type Command,
  Commands,
  type RecordCommand,
} from "@query-engine/raptor3/commands/commands";
import { OperationContext } from "@query-engine/raptor3/shared/operation-context";
import {
  type Arguments,
  EngineSchema,
  type Input,
} from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { describe, it } from "vitest";

const historyNode = s
  .model({
    id: s.string().id(),
    label: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => historyNode)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => historyNode).name("tree"),
  })
  .map("post_g3_history_nodes");

const engineSchema = new EngineSchema({ historyNode });
const driver = new SQLite3Driver();

function createCommands(rawData: Input): {
  readonly admitted: Arguments;
  readonly commands: Commands;
  readonly root: RecordCommand;
} {
  const raw: Arguments = { data: rawData };
  const admitted = engineSchema.admit(historyNode, "create", raw);
  const commands = new Commands(
    new OperationContext(engineSchema, driver, "historyNode", "create")
  );
  return {
    admitted,
    commands,
    root: commands.create(historyNode, admitted.data, raw.data),
  };
}

function rawSpine(depth: number): Input {
  let node: Input = { id: `node-${depth}`, label: `Node ${depth}` };
  for (let level = depth - 1; level >= 0; level--) {
    node = {
      id: `node-${level}`,
      label: `Node ${level}`,
      children: { create: node },
    };
  }
  return node;
}

function admittedSpine(depth: number): Input {
  let node: Input = {
    id: `node-${depth}`,
    label: `Node ${depth}`,
    parent: undefined,
    children: undefined,
  };
  for (let level = depth - 1; level >= 0; level--) {
    node = {
      id: `node-${level}`,
      label: `Node ${level}`,
      parent: undefined,
      children: { create: [node] },
    };
  }
  return { ...node, parentId: null };
}

function rawSiblings(width: number): Input {
  return {
    id: "root",
    label: "Root",
    children: {
      create: Array.from({ length: width }, (_, index) => ({
        id: `child-${index}`,
        label: `Child ${index}`,
      })),
    },
  };
}

function admittedSiblings(width: number): Input {
  return {
    id: "root",
    label: "Root",
    parentId: null,
    parent: undefined,
    children: {
      create: Array.from({ length: width }, (_, index) => ({
        id: `child-${index}`,
        label: `Child ${index}`,
        parent: undefined,
        children: undefined,
      })),
    },
  };
}

function recordSpine(root: RecordCommand): RecordCommand[] {
  const records: RecordCommand[] = [];
  let current: RecordCommand | undefined = root;
  while (current) {
    records.push(current);
    assert.equal(current.before.length, 0);
    const children = current.after.filter(
      (command): command is RecordCommand => command.kind === "record"
    );
    assert.equal(current.after.length, children.length);
    assert(children.length <= 1);
    current = children[0];
  }
  return records;
}

function literalId(command: RecordCommand): unknown {
  const id = command.fields.known("id");
  assert(id);
  assert.equal(id.kind, "literal");
  return id.value;
}

function requireRecord(command: Command | undefined): RecordCommand {
  if (!command || command.kind !== "record") {
    assert.fail("Expected a constructed record command");
  }
  return command;
}

function requireChoose(command: Command | undefined): Choose {
  if (!command || command.kind !== "choose") {
    assert.fail("Expected a constructed choice command");
  }
  return command;
}

function branchData(includeLaterSibling: boolean): Input {
  const upsert: Input[] = [
    {
      where: { id: "target" },
      create: {
        id: "created",
        label: "Created",
        children: { connect: { id: "target" } },
      },
      update: { label: "Found" },
    },
  ];
  if (includeLaterSibling) {
    upsert.push({
      where: { id: "created" },
      create: { id: "later", label: "Later" },
      update: { label: "Later found" },
    });
  }
  return {
    id: "root",
    label: "Root",
    children: { upsert },
  };
}

describe("post-G3 command history analysis", () => {
  it("keeps actual create spines linear at depths 1, 2, 8 and 32", () => {
    const metrics: {
      readonly depth: number;
      readonly records: number;
      readonly oldAncestorPrefixReferences: number;
    }[] = [];

    for (const depth of [1, 2, 8, 32]) {
      const { admitted, commands, root } = createCommands(rawSpine(depth));
      assert.deepEqual(admitted.data, admittedSpine(depth));

      const constructed = recordSpine(root);
      const history = commands.analyze(root);
      assert.equal(constructed.length, depth + 1);
      assert.equal(history.length, constructed.length);
      for (const [index, record] of constructed.entries()) {
        assert.equal(history[index], record);
        assert.equal(literalId(record), `node-${index}`);
      }

      const records = constructed.length;
      metrics.push({
        depth,
        records,
        // The retired `[...preceding]` copied prefixes of lengths 0 through depth.
        // This is a source-derived reference count, not an allocation measurement.
        oldAncestorPrefixReferences: ((records - 1) * records) / 2,
      });
    }

    assert.deepEqual(metrics, [
      { depth: 1, records: 2, oldAncestorPrefixReferences: 1 },
      { depth: 2, records: 3, oldAncestorPrefixReferences: 3 },
      { depth: 8, records: 9, oldAncestorPrefixReferences: 36 },
      { depth: 32, records: 33, oldAncestorPrefixReferences: 528 },
    ]);
  });

  it("keeps actual create siblings linear at widths 1, 2, 8 and 32", () => {
    const metrics: {
      readonly width: number;
      readonly records: number;
      readonly oldSiblingPrefixReferences: number;
    }[] = [];

    for (const width of [1, 2, 8, 32]) {
      const { admitted, commands, root } = createCommands(rawSiblings(width));
      assert.deepEqual(admitted.data, admittedSiblings(width));

      const siblings = root.after.map(requireRecord);
      assert.equal(root.before.length, 0);
      assert.equal(siblings.length, width);
      const history = commands.analyze(root);
      assert.equal(history.length, width + 1);
      assert.equal(history[0], root);
      for (const [index, sibling] of siblings.entries()) {
        assert.equal(sibling.before.length, 0);
        assert.equal(sibling.after.length, 0);
        assert.equal(history[index + 1], sibling);
        assert.equal(literalId(sibling), `child-${index}`);
      }

      metrics.push({
        width,
        records: history.length,
        // Unlike the deep case, each leaf used to copy the root plus every
        // earlier sibling: prefix lengths 1 through width. The equal triangular
        // totals are source-derived reference counts, not allocation measurements.
        oldSiblingPrefixReferences: (width * (width + 1)) / 2,
      });
    }

    assert.deepEqual(metrics, [
      { width: 1, records: 2, oldSiblingPrefixReferences: 1 },
      { width: 2, records: 3, oldSiblingPrefixReferences: 3 },
      { width: 8, records: 9, oldSiblingPrefixReferences: 36 },
      { width: 32, records: 33, oldSiblingPrefixReferences: 528 },
    ]);
  });

  it("retains repeated occurrences of the same record identity", () => {
    const { commands, root } = createCommands(rawSpine(1));
    const repeated = requireRecord(root.after[0]);
    root.after.push(repeated);

    const history = commands.analyze(root);
    assert.equal(history.length, 3);
    assert.equal(history[0], root);
    assert.equal(history[1], repeated);
    assert.equal(history[2], repeated);
    assert.equal(
      history.filter((occurrence) => occurrence === repeated).length,
      2
    );
  });

  it("isolates alternative suffixes while exposing them to a later sibling", () => {
    const isolated = createCommands(branchData(false));
    const isolatedChoice = requireChoose(isolated.root.after[0]);
    assert(isolatedChoice.foundRecord);
    assert(isolatedChoice.missing);
    const missingArmLookup = requireChoose(isolatedChoice.missing.after[0]);
    assert.equal(missingArmLookup.lookup.origin?.operation, "connect");

    const isolatedHistory = isolated.commands.analyze(isolated.root);
    assert.equal(isolated.root.refusal, undefined);
    assert.equal(isolatedChoice.foundRecord.refusal, undefined);
    assert.equal(isolatedChoice.missing.refusal, undefined);
    assert(isolatedHistory.includes(missingArmLookup));

    const visible = createCommands(branchData(true));
    const earlierChoice = requireChoose(visible.root.after[0]);
    const laterChoice = requireChoose(visible.root.after[1]);
    const visibleHistory = visible.commands.analyze(visible.root);
    assert(
      visibleHistory.indexOf(earlierChoice) <
        visibleHistory.indexOf(laterChoice)
    );
    assert(visible.root.refusal instanceof NestedWriteError);
    assert.equal(visible.root.refusal.meta.operation, "upsert");
    assert.equal(visible.root.refusal.meta.conflictsWith, "upsert");
    assert.equal(visible.root.refusal.meta.relation, "children");
  });
});

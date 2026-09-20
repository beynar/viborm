import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import {
  type Choose,
  type CommandOccurrence,
  Commands,
  isRecordOccurrence,
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
    const children = current.body
      .map((occurrence) => occurrence.command)
      .filter((command): command is RecordCommand => command.kind === "record");
    assert.equal(current.body.length, children.length);
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

function requireRecord(
  occurrence: CommandOccurrence | undefined
): RecordCommand {
  if (!occurrence || occurrence.command.kind !== "record") {
    assert.fail("Expected a constructed record command");
  }
  return occurrence.command;
}

function requireChoose(occurrence: CommandOccurrence | undefined): Choose {
  if (!occurrence || occurrence.command.kind !== "choose") {
    assert.fail("Expected a constructed choice command");
  }
  return occurrence.command;
}

function recordOccurrences(
  occurrence: CommandOccurrence
): CommandOccurrence<RecordCommand>[] {
  const records: CommandOccurrence<RecordCommand>[] = [];
  if (!isRecordOccurrence(occurrence)) return records;
  records.push(occurrence);
  for (const child of occurrence.children)
    records.push(...recordOccurrences(child));
  return records;
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
      const history = recordOccurrences(commands.analyze(root));
      assert.equal(constructed.length, depth + 1);
      assert.equal(history.length, constructed.length);
      for (const [index, record] of constructed.entries()) {
        assert.equal(history[index]?.command, record);
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

      const siblings = root.body.map(requireRecord);
      assert.equal(siblings.length, width);
      const history = recordOccurrences(commands.analyze(root));
      assert.equal(history.length, width + 1);
      assert.equal(history[0]?.command, root);
      for (const [index, sibling] of siblings.entries()) {
        assert.equal(sibling.body.length, 0);
        assert.equal(history[index + 1]?.command, sibling);
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
    const repeated = requireRecord(root.body[0]);
    commands.place(root, repeated, "after", repeated.origin);

    const history = recordOccurrences(commands.analyze(root));
    assert.equal(history.length, 3);
    assert.equal(history[0]?.command, root);
    assert.equal(history[1]?.command, repeated);
    assert.equal(history[2]?.command, repeated);
    assert.equal(
      history.filter((occurrence) => occurrence.command === repeated).length,
      2
    );
  });

  it("keeps nested occurrences distinct across repeated compound placements", () => {
    const { commands, root } = createCommands(rawSpine(2));
    const repeated = requireRecord(root.body[0]);
    commands.place(root, repeated, "after", repeated.origin);

    const history = recordOccurrences(commands.analyze(root));
    assert.equal(history.length, 5);
    assert.equal(history[1]?.command, repeated);
    assert.equal(history[3]?.command, repeated);
    assert.notEqual(history[1], history[3]);
    assert.equal(history[2]?.command, history[4]?.command);
    assert.notEqual(history[2], history[4]);
  });

  it("isolates alternative suffixes while exposing them to a later sibling", () => {
    const isolated = createCommands(branchData(false));
    const isolatedChoice = requireChoose(isolated.root.body[0]);
    assert(isolatedChoice.found);
    assert(isolatedChoice.missing);
    const missingArmLookup = requireChoose(
      isolatedChoice.missing.command.body[0]
    );
    assert.equal(missingArmLookup.lookup.origin?.operation, "connect");

    const isolatedAnalysis = isolated.commands.analyze(isolated.root);
    assert.equal(isolatedAnalysis.refusal, undefined);
    // Nothing earlier can change this choice's answer, so its lookup keeps the
    // place it always had: it is not an ordered observation (N1).
    assert.equal(isolatedChoice.lookup.dependent, undefined);
    const analyzedChoice = isolatedAnalysis.children[0];
    assert(analyzedChoice);
    assert.equal(
      isolated.commands.choiceArm(analyzedChoice, "found")?.refusal,
      undefined
    );
    assert.equal(
      isolated.commands.choiceArm(analyzedChoice, "missing")?.refusal,
      undefined
    );

    const visible = createCommands(branchData(true));
    const earlierChoice = requireChoose(visible.root.body[0]);
    const laterChoice = requireChoose(visible.root.body[1]);
    const visibleAnalysis = visible.commands.analyze(visible.root);
    assert.notEqual(earlierChoice, laterChoice);
    // N1 (D-51): pinned DESIGN §6.2's veto over the exposed suffix (a
    // NestedWriteError whose meta read operation 'upsert', conflictsWith
    // 'upsert', relation 'children'); now the pass spends that same overlap
    // fact on placement — the later sibling's lookup is an ORDERED
    // OBSERVATION, marked dependent and left behind the arm that can produce
    // the row it reads, while the sibling it reads across keeps its own place.
    assert.equal(visibleAnalysis.refusal, undefined);
    assert.equal(laterChoice.lookup.dependent, true);
    assert.equal(earlierChoice.lookup.dependent, undefined);
    assert.deepEqual(
      visibleAnalysis.children.map((child) => child.placement),
      ["after", "after"]
    );
    assert.equal(visibleAnalysis.children[0]?.command, earlierChoice);
    assert.equal(visibleAnalysis.children[1]?.command, laterChoice);
    assert.equal(visibleAnalysis.children[0]?.refusal, undefined);
    assert.equal(visibleAnalysis.children[1]?.refusal, undefined);
  });
});

import assert from "node:assert/strict";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { Assignments } from "@query-engine/raptor3/commands/assignments";
import {
  type Choose,
  type CommandOccurrence,
  Commands,
  isSeriesOccurrence,
  type RecordCommand,
  type Selection,
} from "@query-engine/raptor3/commands/commands";
import { OperationContext } from "@query-engine/raptor3/shared/operation-context";
import {
  type Arguments,
  EngineSchema,
} from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const rootModel = s
  .model({ id: s.string().id(), label: s.string() })
  .map("cs02_repeated_roots");
const targetModel = s
  .model({ id: s.string().id(), label: s.string() })
  .map("cs02_repeated_targets");
const containerModel = s
  .model({ id: s.string().id(), label: s.string() })
  .map("cs02_repeated_containers");

const membershipTargetModel = s
  .model({
    id: s.string().id(),
    roots: s.toMany(() => membershipRootModel).name("cs02RepeatedMembership"),
  })
  .map("cs02_repeated_membership_targets");
const membershipRootModel = s
  .model({
    id: s.string().id(),
    targetId: s.string().nullable(),
    target: s
      .toOne(() => membershipTargetModel)
      .fields("targetId")
      .references("id")
      .name("cs02RepeatedMembership"),
  })
  .map("cs02_repeated_membership_roots");

const engineSchema = new EngineSchema({
  rootModel,
  targetModel,
  containerModel,
});

class RecordingSQLiteDriver extends SQLite3Driver {
  readonly statements: string[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
}

function rootCommands(driver: SQLite3Driver): {
  readonly commands: Commands;
  readonly context: OperationContext;
  readonly root: RecordCommand;
} {
  const raw: Arguments = { data: { id: "root", label: "root" } };
  const admitted = engineSchema.admit(rootModel, "create", raw);
  const context = new OperationContext(
    engineSchema,
    driver,
    "rootModel",
    "create"
  );
  const commands = new Commands(context);
  return {
    commands,
    context,
    root: commands.create(rootModel, admitted.data, raw.data),
  };
}

function targetSelection(commands: Commands): Selection {
  return commands.lookup(targetModel, {
    kind: "query",
    where: { id: "target" },
  });
}

function choiceWithBothArms(commands: Commands, lookup: Selection): Choose {
  const found = commands.occurrence(
    commands.update(lookup, { label: "found" }, { label: "found" }, true)
  );
  const missing = commands.occurrence(
    commands.create(
      targetModel,
      { id: "missing", label: "missing" },
      { id: "missing", label: "missing" }
    )
  );
  return {
    kind: "choose",
    model: targetModel,
    lookup,
    fields: new Assignments(targetModel, "select"),
    found,
    missing,
  };
}

function choices(
  occurrence: CommandOccurrence<RecordCommand>
): CommandOccurrence<Choose>[] {
  return occurrence.children.filter(
    (child): child is CommandOccurrence<Choose> =>
      child.command.kind === "choose"
  );
}

function createDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE cs02_repeated_roots(
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL
    );
    CREATE TABLE cs02_repeated_targets(
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL
    );
    CREATE TABLE cs02_repeated_containers(
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL
    );
  `);
  return database;
}

describe("CS-02 repeated command occurrence ownership", () => {
  it("keeps finalized membership ownership with each repeated placement", () => {
    const schema = new EngineSchema({
      membershipRootModel,
      membershipTargetModel,
    });
    const raw: Arguments = {
      data: {
        id: "root",
        target: { connect: { id: "target" } },
      },
    };
    const admitted = schema.admit(membershipRootModel, "create", raw);
    const commands = new Commands(
      new OperationContext(
        schema,
        new SQLite3Driver(),
        "membershipRootModel",
        "create"
      )
    );
    const root = commands.create(membershipRootModel, admitted.data, raw.data);
    const [placed] = root.body;
    assert(placed);
    assert.equal(placed.command.kind, "choose");
    if (placed.placement === "root")
      throw new Error("Nested relation command lost its placement");
    commands.place(root, placed.command, placed.placement);

    const analyzed = commands.analyze(root);
    const [first, second] = choices(analyzed);
    assert(first);
    assert(second);
    const [firstMembership] = commands.membershipPublications(first);
    const [secondMembership] = commands.membershipPublications(second);
    assert(firstMembership);
    assert(secondMembership);
    assert.equal(
      firstMembership,
      secondMembership,
      "placements must share the finalized command-recipe publication"
    );
    assert.equal(
      Object.hasOwn(firstMembership.contribution, "owner"),
      false,
      "the symbolic contribution must not duplicate occurrence ownership"
    );
    assert.equal(
      firstMembership.contribution,
      secondMembership.contribution,
      "placements must share the reconciled symbolic contribution"
    );
  });

  it("gives each placement of one Choice its own complete arm ancestry", () => {
    const { commands, root } = rootCommands(new SQLite3Driver());
    const lookup = targetSelection(commands);
    const choice = choiceWithBothArms(commands, lookup);
    commands.place(root, choice, "after");
    commands.place(root, choice, "after");

    const analyzed = commands.analyze(root);
    const [first, second] = choices(analyzed);
    assert(first);
    assert(second);
    assert.notEqual(first, second);
    assert.equal(first.command, second.command);
    assert.equal(first.command.lookup, lookup);
    assert.equal(second.command.lookup, lookup);

    const firstFound = commands.choiceArm(first, "found");
    const firstMissing = commands.choiceArm(first, "missing");
    const secondFound = commands.choiceArm(second, "found");
    const secondMissing = commands.choiceArm(second, "missing");
    assert(firstFound);
    assert(firstMissing);
    assert(secondFound);
    assert(secondMissing);
    assert.notEqual(firstFound, secondFound);
    assert.notEqual(firstMissing, secondMissing);
    assert.equal(firstFound.command, secondFound.command);
    assert.equal(firstMissing.command, secondMissing.command);
    assert.equal(firstFound.parent, first);
    assert.equal(firstMissing.parent, first);
    assert.equal(secondFound.parent, second);
    assert.equal(secondMissing.parent, second);
    assert.deepEqual(commands.childrenOf(first), [firstFound, firstMissing]);
    assert.deepEqual(commands.childrenOf(second), [secondFound, secondMissing]);
  });

  it("reuses shared presence but reobserves shared absence per Choice placement", async () => {
    for (const present of [true, false]) {
      const database = createDatabase();
      if (present)
        database.exec(
          "INSERT INTO cs02_repeated_targets VALUES('target','existing')"
        );
      const driver = new RecordingSQLiteDriver({ client: database });
      try {
        const { commands, context, root } = rootCommands(driver);
        const lookup = targetSelection(commands);
        const choice: Choose = {
          kind: "choose",
          model: targetModel,
          lookup,
          fields: new Assignments(targetModel, "select"),
        };
        commands.place(root, choice, "before");
        commands.place(root, choice, "after");
        const analyzed = commands.analyze(root);
        const [first, second] = choices(analyzed);
        assert(first);
        assert(second);
        assert.notEqual(first, second);
        assert.equal(first.command.lookup, second.command.lookup);

        await context.run(() => commands.execution.run(analyzed));

        const targetReads = driver.statements.filter(
          (statement) =>
            /^SELECT\b/.test(statement) &&
            statement.includes("cs02_repeated_targets")
        );
        assert.equal(targetReads.length, present ? 1 : 2);
        assert.equal(commands.execution.attempt.rows.has(lookup), present);
      } finally {
        await driver.disconnect();
        database.close();
      }
    }
  });

  it("keeps repeated selected-series expansion and attempt state occurrence-owned", async () => {
    const database = createDatabase();
    database.exec(
      "INSERT INTO cs02_repeated_targets VALUES('target','existing')"
    );
    const driver = new RecordingSQLiteDriver({ client: database });
    try {
      const { commands, context, root } = rootCommands(driver);
      const selection = targetSelection(commands);
      const analysis = commands.update(
        selection,
        { label: "updated" },
        { label: "updated" },
        true
      );
      const series = commands.selectedSeries({
        selection,
        analysis,
        mutation: { kind: "update", raw: { label: "updated" } },
      });
      const firstSeries = commands.place(root, series, "after");
      commands.place(
        root,
        { kind: "captureSeries", target: firstSeries },
        "capture"
      );
      const secondSeries = commands.place(root, series, "after");
      commands.place(
        root,
        { kind: "captureSeries", target: secondSeries },
        "capture"
      );

      const analyzed = commands.analyze(root);
      const [firstRuntimeSeries, secondRuntimeSeries] =
        analyzed.children.filter(isSeriesOccurrence);
      const [firstRuntimeCapture, secondRuntimeCapture] =
        analyzed.children.filter(
          (occurrence) => occurrence.command.kind === "captureSeries"
        );
      assert(firstRuntimeSeries);
      assert(secondRuntimeSeries);
      assert(firstRuntimeCapture);
      assert(secondRuntimeCapture);
      assert.equal(firstSeries.command, secondSeries.command);
      assert.notEqual(firstRuntimeSeries, secondRuntimeSeries);
      assert.equal(firstRuntimeSeries.command.series.selection, selection);
      assert.equal(secondRuntimeSeries.command.series.selection, selection);
      assert.equal(
        commands.seriesCaptureTarget(firstRuntimeCapture),
        firstRuntimeSeries
      );
      assert.equal(
        commands.seriesCaptureTarget(secondRuntimeCapture),
        secondRuntimeSeries
      );

      const [firstTemplate] = commands.childrenOf(firstRuntimeSeries);
      const [secondTemplate] = commands.childrenOf(secondRuntimeSeries);
      assert(firstTemplate);
      assert(secondTemplate);
      assert.notEqual(firstTemplate, secondTemplate);
      assert.equal(firstTemplate.command, secondTemplate.command);
      assert.equal(firstTemplate.parent, firstRuntimeSeries);
      assert.equal(secondTemplate.parent, secondRuntimeSeries);

      await context.run(() => commands.execution.run(analyzed));

      const firstState =
        commands.execution.attempt.series.get(firstRuntimeSeries);
      const secondState =
        commands.execution.attempt.series.get(secondRuntimeSeries);
      assert(firstState);
      assert(secondState);
      assert.notEqual(firstState, secondState);
      assert.equal(commands.execution.attempt.series.size, 2);
      const [firstMember] = commands.seriesMembers(firstRuntimeSeries);
      const [secondMember] = commands.seriesMembers(secondRuntimeSeries);
      assert(firstMember);
      assert(secondMember);
      assert.notEqual(firstMember, secondMember);
      assert.equal(firstMember.parent, firstRuntimeSeries);
      assert.equal(secondMember.parent, secondRuntimeSeries);
      assert.deepEqual(firstState.members, [firstMember]);
      assert.deepEqual(secondState.members, [secondMember]);
      assert.deepEqual(
        database.prepare("SELECT id,label FROM cs02_repeated_targets").get(),
        { id: "target", label: "updated" }
      );

      firstRuntimeSeries.refusal = new Error("runtime-only refusal");
      const thirdSeries = commands.place(root, series, "after");
      commands.place(
        root,
        { kind: "captureSeries", target: thirdSeries },
        "capture"
      );
      const reanalyzed = commands.analyze(root);
      const reanalyzedSeries = reanalyzed.children.filter(isSeriesOccurrence);
      assert.equal(reanalyzedSeries.length, 3);
      for (const occurrence of reanalyzedSeries) {
        assert.equal(occurrence.refusal, undefined);
        const [template, extra] = commands.childrenOf(occurrence);
        assert(template);
        assert.equal(template.role, "template");
        assert.equal(extra, undefined);
        assert.equal(commands.seriesMembers(occurrence).length, 0);
      }
    } finally {
      await driver.disconnect();
      database.close();
    }
  });

  it("keeps a nested series capture local when one record recipe occupies both Choice arms", async () => {
    const database = createDatabase();
    database.exec(`
      INSERT INTO cs02_repeated_containers VALUES('container','initial');
      INSERT INTO cs02_repeated_targets VALUES('target','initial');
    `);
    const driver = new RecordingSQLiteDriver({ client: database });
    try {
      const { commands, context, root } = rootCommands(driver);
      const container = commands.lookup(containerModel, {
        kind: "query",
        where: { id: "container" },
      });
      const enclosing = commands.update(
        container,
        { label: "enclosing-updated" },
        { label: "enclosing-updated" },
        true
      );
      const selection = targetSelection(commands);
      const analysis = commands.update(
        selection,
        { label: "series-updated" },
        { label: "series-updated" },
        true
      );
      const series = commands.selectedSeries({
        selection,
        analysis,
        mutation: { kind: "update", raw: { label: "series-updated" } },
      });
      const sourceSeries = commands.place(enclosing, series, "after");
      commands.place(
        enclosing,
        { kind: "captureSeries", target: sourceSeries },
        "capture"
      );
      commands.place(
        root,
        {
          kind: "choose",
          model: containerModel,
          lookup: container,
          fields: new Assignments(containerModel, "select"),
          found: commands.occurrence(enclosing),
          missing: commands.occurrence(enclosing),
        },
        "after"
      );

      const analyzed = commands.analyze(root);
      const [choice] = choices(analyzed);
      assert(choice);
      const found = commands.choiceArm(choice, "found");
      const missing = commands.choiceArm(choice, "missing");
      assert(found);
      assert(missing);

      await context.run(() => commands.execution.run(analyzed));

      const [foundSeries] = found.children.filter(isSeriesOccurrence);
      const [missingSeries] = missing.children.filter(isSeriesOccurrence);
      const [foundCapture] = found.children.filter(
        (occurrence) => occurrence.command.kind === "captureSeries"
      );
      const [missingCapture] = missing.children.filter(
        (occurrence) => occurrence.command.kind === "captureSeries"
      );
      assert(foundSeries);
      assert(missingSeries);
      assert(foundCapture);
      assert(missingCapture);
      assert.notEqual(foundSeries, missingSeries);
      assert.equal(commands.seriesCaptureTarget(foundCapture), foundSeries);
      assert.equal(commands.seriesCaptureTarget(missingCapture), missingSeries);
      assert.deepEqual(
        database
          .prepare("SELECT id,label FROM cs02_repeated_containers")
          .get(),
        { id: "container", label: "enclosing-updated" }
      );
      assert.deepEqual(
        database.prepare("SELECT id,label FROM cs02_repeated_targets").get(),
        { id: "target", label: "series-updated" }
      );
    } finally {
      await driver.disconnect();
      database.close();
    }
  });
});

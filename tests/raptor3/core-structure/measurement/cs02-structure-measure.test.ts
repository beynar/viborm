import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { NestedWriteError, NotFoundError, VibORMErrorCode } from "@errors";
import {
  type CommandOccurrence,
  Commands,
  isRecordOccurrence,
  type Choose,
  type RecordCommand,
  type SelectedSeries,
} from "@query-engine/raptor3/commands/commands";
import { OperationContext } from "@query-engine/raptor3/shared/operation-context";
import {
  type Arguments,
  EngineSchema,
  entries,
  type Input,
  record,
} from "@query-engine/raptor3/shared/schema";
import { bindMembership } from "@query-engine/raptor3/shared/storage";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { createClient } from "@client/client";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import { encodeEvidenceValue } from "../../../../benchmarks/operation-pipeline-evidence.mjs";
import { captureRaptor3Identity } from "../../../../scripts/raptor3-manifest.mjs";
import Database from "better-sqlite3";
import { it } from "vitest";
import { Recorder } from "../../harness/recorder";
import type { ReplayTape, StatementCompletion } from "../../harness/protocol";
import {
  captureStructuralMeasurement,
  type CapturedMemberBinding,
  SemanticInventoryBindings,
} from "./hooks";
import {
  type MeasurementCase,
  measurementCaseSchema,
  measurementEventsFileSchema,
  measurementReceiptSchema,
  type SemanticInventory,
} from "./protocol";
import { reduceMeasurementEvents } from "./reducer";
import {
  type StructuralRecipe,
  structuralMeasurementRecipes,
} from "./structural-recipes";

const nodeModel = s
  .model({
    id: s.string().id(),
    label: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => nodeModel)
      .fields("parentId")
      .references("id")
      .name("cs02Tree"),
    children: s.toMany(() => nodeModel).name("cs02Tree"),
  })
  .map("cs02_measure_nodes");

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha256File = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const semanticId = (kind: string, caseId: string, path: string): string =>
  `${kind}:${caseId}:${path}`;

function counterContractSha256(): string {
  const hash = createHash("sha256");
  for (const file of [
    "tests/raptor3/core-structure/measurement/protocol.ts",
    "tests/raptor3/core-structure/measurement/reducer.ts",
  ]) {
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(resolve(file)))
      .update("\0");
  }
  return hash.digest("hex");
}

function canonicalInventory(inventory: SemanticInventory): SemanticInventory {
  return {
    commandIds: [...inventory.commandIds].sort(),
    occurrences: [...inventory.occurrences].sort((left, right) =>
      left.occurrenceId.localeCompare(right.occurrenceId)
    ),
    selectionIds: [...inventory.selectionIds].sort(),
    reads: [...inventory.reads].sort((left, right) =>
      left.readId.localeCompare(right.readId)
    ),
    writes: [...inventory.writes].sort((left, right) =>
      left.writeId.localeCompare(right.writeId)
    ),
    activationIds: [...inventory.activationIds].sort(),
  };
}

type SQLiteProfile = "sqlite-interactive" | "sqlite-atomic-batch";
interface MeasuredCase {
  readonly events: readonly import("./protocol").MeasurementEvent[];
  readonly measurementCase: MeasurementCase;
  readonly tape?: ReplayTape;
}

class MeasurementSQLiteDriver extends SQLite3Driver {
  readonly statements: Array<{
    readonly sql: string;
    readonly parameters: readonly unknown[];
  }> = [];
  afterStatement?: (rows: readonly unknown[]) => void;

  constructor(
    database: Database.Database,
    private readonly recorder: Recorder
  ) {
    super({ client: database });
  }

  resetObservations(): void {
    this.statements.length = 0;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.recorder.record({
      kind: "dispatch",
      sql: statement,
      parameters,
      transactionOpen: client.inTransaction,
    });
    this.statements.push({ sql: statement, parameters });
    const result = await super.execute<T>(client, statement, parameters);
    const completion: StatementCompletion = {
      sql: statement,
      parameters,
      rows: result.rows,
      transactionOpen: client.inTransaction,
    };
    await this.recorder.complete(completion);
    this.afterStatement?.(result.rows);
    return result;
  }
}

class MeasurementBatchSQLiteDriver extends MeasurementSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

function measurementDriver(
  profile: SQLiteProfile,
  database: Database.Database,
  recorder: Recorder
): MeasurementSQLiteDriver {
  return profile === "sqlite-interactive"
    ? new MeasurementSQLiteDriver(database, recorder)
    : new MeasurementBatchSQLiteDriver(database, recorder);
}

function bindOccurrence(
  bindings: SemanticInventoryBindings,
  caseId: string,
  path: string,
  occurrence: CommandOccurrence,
  selection?: { readonly value: object; readonly path: string },
  write = true
): void {
  bindings.bindCommand(occurrence.command, semanticId("command", caseId, path));
  if (selection)
    bindings.bindSelection(
      selection.value,
      semanticId("selection", caseId, selection.path)
    );
  bindings.bindOccurrence(
    occurrence,
    semanticId("occurrence", caseId, path),
    occurrence.command,
    selection?.value
  );
  if (write)
    bindings.bindWrite(
      occurrence,
      semanticId("write", caseId, path),
      occurrence
    );
}

function bindUnconditional(
  bindings: SemanticInventoryBindings,
  caseId: string,
  occurrence: CommandOccurrence
): void {
  bindings.bindActivationState(
    occurrence,
    "unconditional",
    semanticId("activation", caseId, "attempt/0/unconditional")
  );
}

async function migrate<S extends Record<string, AnyModel>>(
  schema: S,
  driver: MeasurementSQLiteDriver
) {
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  driver.resetObservations();
  return client;
}

function bindCreateTree(
  bindings: SemanticInventoryBindings,
  caseId: string,
  root: RecordCommand,
  kind: "depth-create" | "width-create"
): void {
  bindings.bindCommand(root, semanticId("command", caseId, "root"));
  const bindChildren = (record: RecordCommand, path: string): void => {
    const children = record.body.filter(isRecordOccurrence);
    for (const [index, child] of children.entries()) {
      const childPath = `${path}/children/${index}`;
      bindOccurrence(bindings, caseId, childPath, child);
      bindChildren(child.command, childPath);
    }
  };
  bindChildren(root, "root");
  const expectedChildren = kind === "depth-create" ? 1 : root.body.length;
  assert.equal(root.body.filter(isRecordOccurrence).length, expectedChildren);
}

function createCommands(data: Input): {
  readonly commands: Commands;
  readonly admitted: Arguments;
  readonly root: RecordCommand;
} {
  const schema = new EngineSchema({ nodeModel });
  const raw: Arguments = { data };
  const admitted = schema.admit(nodeModel, "create", raw);
  const commands = new Commands(
    new OperationContext(schema, new SQLite3Driver(), "nodeModel", "create")
  );
  return {
    commands,
    admitted,
    root: commands.create(nodeModel, admitted.data, raw.data),
  };
}

function overlapSchema() {
  const pair = s
    .model({
      a: s.string(),
      b: s.string(),
      label: s.string(),
      kids: s.toMany(() => kid),
    })
    .id(["a", "b"])
    .map("cs02_measure_pairs");
  const kid = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      label: s.string(),
      pa: s.string().nullable(),
      pb: s.string().nullable(),
      pair: s
        .toOne(() => pair)
        .fields("pa", "pb")
        .references("a", "b"),
    })
    .map("cs02_measure_kids");
  return { pair, kid };
}

function overlapCommands(
  schema: ReturnType<typeof overlapSchema>,
  recipe: Extract<StructuralRecipe, { kind: "width-overlap" }>,
  driver: MeasurementSQLiteDriver
): {
  readonly admitted: Arguments;
  readonly commands: Commands;
  readonly context: OperationContext;
  readonly root: RecordCommand;
  readonly writers: readonly CommandOccurrence<RecordCommand>[];
  readonly readers: readonly {
    readonly capture: CommandOccurrence;
    readonly target: CommandOccurrence;
  }[];
} {
  const engineSchema = new EngineSchema(schema);
  const raw: Arguments = {
    data: { a: "root-a", b: "root-b", label: "root" },
  };
  const admitted = engineSchema.admit(schema.pair, "create", raw);
  const context = new OperationContext(engineSchema, driver, "pair", "create");
  const commands = new Commands(context);
  const root = commands.create(schema.pair, admitted.data, raw.data);
  const edge = bindMembership(engineSchema, schema.pair, "kids");
  assert.equal(edge.kind, "reference");
  const writers = recipe.writers.map(({ selector }) => {
    const childRaw: Arguments = {
      where: selector,
      data: { pa: "root-a", pb: "root-b" },
    };
    const childAdmitted = engineSchema.admit(schema.kid, "update", childRaw);
    const located = commands.lookup(schema.kid, {
      kind: "query",
      where: childAdmitted.where,
    });
    const child = commands.update(
      located,
      childAdmitted.data,
      childRaw.data,
      true
    );
    const origin = commands.createOrigin("kids", "upsert");
    child.origin = origin;
    const occurrence = commands.place(root, child, "after", origin);
    const contribution = {
      origin,
      scope: edge.scope,
      identity: located.facts,
    };
    commands.assignMembership(edge, child.fields, root.fields);
    commands.publishMembership(occurrence, child.fields, contribution);
    return occurrence;
  });
  const readers = recipe.readers.map(({ selector }, index) => {
    const memberRaw: Arguments = {
      where: selector,
      data: { label: `reader-${index}` },
    };
    const member = engineSchema.admit(schema.kid, "update", memberRaw);
    const origin = commands.createOrigin("kids", "updateMany");
    const selection = commands.lookup(
      schema.kid,
      {
        kind: "query",
        where: selector,
        membership: { edge, parent: root.fields },
      },
      () =>
        new NestedWriteError(
          "Cannot update relation 'kids': target record was not found for this parent.",
          "kids"
        )
    );
    selection.membershipOnly = true;
    selection.origin = origin;
    const analysis = commands.update(
      selection,
      member.data,
      memberRaw.data,
      true
    );
    analysis.origin = origin;
    const target = commands.place(
      root,
      commands.selectedSeries({
        selection,
        analysis,
        mutation: { kind: "update", raw: memberRaw.data },
      }),
      "after",
      origin
    );
    const capture = commands.place(
      root,
      { kind: "captureSeries", target },
      "capture",
      origin
    );
    return { capture, target };
  });
  for (const field of engineSchema.keys(schema.pair)) root.fields.field(field);
  return { admitted, commands, context, root, writers, readers };
}

function bindOverlapTree(
  bindings: SemanticInventoryBindings,
  recipe: Extract<StructuralRecipe, { kind: "width-overlap" }>,
  built: ReturnType<typeof overlapCommands>
): void {
  bindings.bindCommand(
    built.root,
    semanticId("command", recipe.caseId, "root")
  );
  for (const [index, writer] of built.writers.entries()) {
    bindOccurrence(bindings, recipe.caseId, `root/writer/${index}`, writer);
    bindUnconditional(bindings, recipe.caseId, writer);
  }
  for (const [index, reader] of built.readers.entries()) {
    const path = `root/reader/${index}`;
    const selection = reader.target.command;
    assert.equal(selection.kind, "selectedSeries");
    bindOccurrence(
      bindings,
      recipe.caseId,
      path,
      reader.target,
      { value: selection.series.selection, path },
      false
    );
    bindOccurrence(
      bindings,
      recipe.caseId,
      `${path}/template`,
      selection.template,
      { value: selection.series.selection, path }
    );
    bindOccurrence(
      bindings,
      recipe.caseId,
      `${path}/capture`,
      reader.capture,
      undefined,
      false
    );
    bindUnconditional(bindings, recipe.caseId, reader.target);
    bindUnconditional(bindings, recipe.caseId, selection.template);
    bindUnconditional(bindings, recipe.caseId, reader.capture);
  }
}

async function measureOverlap(
  recipe: Extract<StructuralRecipe, { kind: "width-overlap" }>,
  replay?: ReplayTape
): Promise<MeasuredCase> {
  const recorder = new Recorder(recipe.size, replay);
  const bindings = new SemanticInventoryBindings();
  const captured = await recorder.control(() =>
    captureStructuralMeasurement(
      recipe.caseId,
      bindings,
      async () => {
        const database = new Database(":memory:");
        const driver = new MeasurementSQLiteDriver(database, recorder);
        const schema = overlapSchema();
        const client = await migrate(schema, driver);
        try {
          database.exec(
            recipe.writers
              .map(
                ({ selector }) =>
                  `INSERT INTO cs02_measure_kids (id,slug,label,pa,pb) VALUES('${selector.slug}','${selector.slug}','seed',NULL,NULL);`
              )
              .join("\n")
          );
          const built = overlapCommands(schema, recipe, driver);
          bindOverlapTree(bindings, recipe, built);
          const occurrence = built.commands.analyze(built.root);
          await built.context.run(() =>
            built.commands.execution.complete(occurrence, built.admitted)
          );
          // D-51: each reader's membership lookup is an ordered observation
          // taken at its own execution point, behind the writer that
          // publishes the key it reads, so every reader finds its target a
          // member and relabels it where the retired engine refused the tree.
          const kid = database.prepare(
            "SELECT id,label,pa,pb FROM cs02_measure_kids WHERE slug = ?"
          );
          assert.deepEqual(
            recipe.readers.map(({ selector }) => kid.get(selector.slug)),
            recipe.readers.map(({ selector }, index) => ({
              id: selector.slug,
              label: `reader-${index}`,
              pa: "root-a",
              pb: "root-b",
            }))
          );
          assert.deepEqual(
            database.prepare("SELECT a,b,label FROM cs02_measure_pairs").all(),
            [{ a: "root-a", b: "root-b", label: "root" }]
          );
          return { outcome: "accepted", dependency: "membership" };
        } finally {
          await client.$disconnect();
          database.close();
        }
      },
      (event, identities) =>
        bindCapturedMember(event, identities, recipe.caseId)
    )
  );
  assert.deepEqual(captured.semanticInventory, recipe.semanticInventory);
  return {
    events: captured.events,
    measurementCase: {
      caseId: recipe.caseId,
      slice: "structure",
      profile: recipe.profile,
      size: recipe.size,
      recipeSha256: sha256(recipe),
      scheduleSha256: sha256(recipe.schedule),
      semanticInventory: captured.semanticInventory,
      outcomeSha256: sha256(captured.value),
      counters: reduceMeasurementEvents(recipe.caseId, captured.events),
      eventCount: captured.events.length,
      eventsSha256: sha256(captured.events),
    },
    tape: recorder.finish(),
  };
}

function seriesSchema(nextTicketId: () => string) {
  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      bins: s.toMany(() => bin).name("cs02ShelfBins"),
      earlyHolders: s.toMany(() => earlyHolder).name("cs02EarlyShelf"),
      lateHolders: s.toMany(() => lateHolder).name("cs02LateShelf"),
    })
    .map("cs02_measure_shelves");
  const bin = s
    .model({
      id: s.string().id(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("cs02ShelfBins"),
      tickets: s.toMany(() => ticket).name("cs02BinTickets"),
    })
    .map("cs02_measure_bins");
  const ticket = s
    .model({
      id: s.string().id().default(nextTicketId),
      note: s.string(),
      binId: s.string(),
      bin: s
        .toOne(() => bin)
        .fields("binId")
        .references("id")
        .name("cs02BinTickets"),
      earlyHolders: s.toMany(() => earlyHolder).name("cs02EarlyTicket"),
      lateHolders: s.toMany(() => lateHolder).name("cs02LateTicket"),
    })
    .map("cs02_measure_tickets");
  const earlyHolder = s
    .model({
      id: s.string().id(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("cs02EarlyShelf"),
      ticketId: s.string().nullable(),
      earlyTicket: s
        .toOne(() => ticket)
        .fields("ticketId")
        .references("id")
        .name("cs02EarlyTicket"),
    })
    .map("cs02_measure_early_holders");
  const lateHolder = s
    .model({
      id: s.string().id(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("cs02LateShelf"),
      ticketId: s.string().nullable(),
      lateTicket: s
        .toOne(() => ticket)
        .fields("ticketId")
        .references("id")
        .name("cs02LateTicket"),
    })
    .map("cs02_measure_late_holders");
  return { shelf, bin, ticket, earlyHolder, lateHolder };
}

function seriesArguments(size: number, lateFound: boolean): Arguments {
  return {
    where: { id: "s1" },
    data: {
      label: "prefix",
      bins: {
        updateMany: {
          where: {},
          data: { tickets: { create: { note: "member" } } },
        },
      },
      earlyHolders: {
        update: {
          where: { id: "early" },
          data: {
            earlyTicket: { connect: { id: `member-${size - 1}` } },
          },
        },
      },
      lateHolders: {
        upsert: {
          where: { id: lateFound ? "late" : "missing" },
          create: { id: "missing", ticketId: null },
          update: { lateTicket: { connect: { id: "member-0" } } },
        },
      },
    },
  };
}

function requireChoice(root: RecordCommand, relation: string): Choose {
  const occurrence = root.body.find(
    (candidate) =>
      candidate.command.kind === "choose" &&
      candidate.command.lookup.origin?.relation === relation
  );
  assert(occurrence?.command.kind === "choose");
  return occurrence.command;
}

function requireOccurrence(
  parent: RecordCommand,
  predicate: (occurrence: CommandOccurrence) => boolean
): CommandOccurrence {
  const occurrence = parent.body.find(predicate);
  assert(occurrence);
  return occurrence;
}

function bindChoiceActivation(
  bindings: SemanticInventoryBindings,
  caseId: string,
  occurrence: CommandOccurrence,
  path: "root/choice/early" | "root/choice/late",
  observation: 0 | 1,
  selected: "found" | "missing"
): void {
  bindings.bindActivationState(
    occurrence,
    "unobserved",
    semanticId(
      "activation",
      caseId,
      `${path}/attempt/0/observation/${observation}/unobserved`
    )
  );
  bindings.bindActivationState(
    occurrence,
    selected,
    semanticId(
      "activation",
      caseId,
      `${path}/attempt/0/observation/${observation}/${selected}`
    )
  );
}

function bindSeriesTree(
  bindings: SemanticInventoryBindings,
  recipe: Extract<
    StructuralRecipe,
    { kind: "series-choice-found" | "series-choice-missing" }
  >,
  root: RecordCommand,
  earlyGuard: CommandOccurrence,
  lateGuard: CommandOccurrence
): void {
  const { caseId } = recipe;
  bindings.bindCommand(root, semanticId("command", caseId, "root"));
  const series = requireOccurrence(
    root,
    ({ command }) => command.kind === "selectedSeries"
  );
  assert.equal(series.command.kind, "selectedSeries");
  const capture = requireOccurrence(
    root,
    ({ command }) => command.kind === "captureSeries"
  );
  bindOccurrence(
    bindings,
    caseId,
    "root/series",
    series,
    { value: series.command.series.selection, path: "root/series" },
    false
  );
  bindOccurrence(
    bindings,
    caseId,
    "root/series/capture",
    capture,
    undefined,
    false
  );
  bindOccurrence(
    bindings,
    caseId,
    "root/series/template",
    series.command.template,
    { value: series.command.series.selection, path: "root/series" }
  );
  const template = series.command.template.command;
  assert.equal(template.kind, "record");
  const templateTicket = requireOccurrence(
    template,
    ({ command }) =>
      command.kind === "record" && command.origin?.relation === "tickets"
  );
  bindOccurrence(
    bindings,
    caseId,
    "root/series/template/ticket/create",
    templateTicket
  );

  const bindOuterChoice = (
    outerPath: "root/choice/early" | "root/choice/late",
    relation: "earlyHolders" | "lateHolders",
    guard: CommandOccurrence,
    selected: "found" | "missing",
    observation: 0 | 1
  ): void => {
    const outer = requireOccurrence(
      root,
      ({ command }) =>
        command.kind === "choose" &&
        command.lookup.origin?.relation === relation
    );
    assert.equal(outer.command.kind, "choose");
    const selection = outer.command.lookup;
    const guardPath =
      outerPath === "root/choice/early"
        ? "root/guard/early"
        : "root/guard/late";
    bindOccurrence(
      bindings,
      caseId,
      guardPath,
      guard,
      { value: selection, path: guardPath },
      false
    );
    bindOccurrence(
      bindings,
      caseId,
      outerPath,
      outer,
      { value: selection, path: guardPath },
      false
    );
    const found = outer.command.found;
    assert(found);
    bindOccurrence(bindings, caseId, `${outerPath}/found`, found, {
      value: selection,
      path: guardPath,
    });
    const foundRecord = found.command;
    const inner = requireOccurrence(
      foundRecord,
      ({ command }) => command.kind === "choose"
    );
    assert.equal(inner.command.kind, "choose");
    const innerPath =
      outerPath === "root/choice/early"
        ? `${outerPath}/found/earlyTicket/connect`
        : `${outerPath}/found/lateTicket/connect`;
    bindOccurrence(bindings, caseId, innerPath, inner, {
      value: inner.command.lookup,
      path: innerPath,
    });
    if (outer.command.missing)
      bindOccurrence(
        bindings,
        caseId,
        `${outerPath}/missing`,
        outer.command.missing
      );
    bindChoiceActivation(
      bindings,
      caseId,
      outer,
      outerPath,
      observation,
      selected
    );
  };
  bindOuterChoice("root/choice/early", "earlyHolders", earlyGuard, "found", 0);
  bindOuterChoice(
    "root/choice/late",
    "lateHolders",
    lateGuard,
    recipe.lateChoiceState,
    1
  );
}

/** An expanded member is `<its capture's path>/member/<ordinal>`. */
function bindCapturedMember(
  event: CapturedMemberBinding,
  bindings: SemanticInventoryBindings,
  caseId: string
): { readonly occurrence: CommandOccurrence; readonly path: string } {
  const parentPath = bindings
    .occurrenceId(event.parentOccurrence)
    .slice("occurrence:".length + caseId.length + 1);
  const path = `${parentPath}/member/${event.captureOrdinal}`;
  assert(isCommandOccurrence(event.occurrence));
  const occurrence = event.occurrence;
  assert.equal(event.command, occurrence.command);
  assert(event.selection);
  bindOccurrence(bindings, caseId, path, occurrence, {
    value: event.selection,
    path,
  });
  return { occurrence, path };
}

function bindCapturedSeriesMember(
  event: CapturedMemberBinding,
  bindings: SemanticInventoryBindings,
  caseId: string
): void {
  const { occurrence, path } = bindCapturedMember(event, bindings, caseId);
  assert.equal(path, `root/series/member/${event.captureOrdinal}`);
  const member = occurrence.command;
  assert.equal(member.kind, "record");
  const ticket = requireOccurrence(
    member,
    ({ command }) =>
      command.kind === "record" && command.origin?.relation === "tickets"
  );
  bindOccurrence(bindings, caseId, `${path}/ticket/create`, ticket);
}

function isCommandOccurrence(value: object): value is CommandOccurrence {
  return (
    "kind" in value &&
    value.kind === "occurrence" &&
    "command" in value &&
    typeof value.command === "object" &&
    value.command !== null &&
    "placement" in value &&
    "children" in value &&
    Array.isArray(value.children)
  );
}

function seriesCommands(
  schema: ReturnType<typeof seriesSchema>,
  driver: MeasurementSQLiteDriver,
  size: number,
  lateFound: boolean
): {
  readonly admitted: Arguments;
  readonly commands: Commands;
  readonly context: OperationContext;
  readonly root: RecordCommand;
} {
  const engineSchema = new EngineSchema(schema);
  const raw = seriesArguments(size, lateFound);
  const admitted = engineSchema.admit(schema.shelf, "update", raw);
  const context = new OperationContext(engineSchema, driver, "shelf", "update");
  const commands = new Commands(context);
  const located = commands.lookup(
    schema.shelf,
    { kind: "query", where: admitted.where! },
    () => new NotFoundError("shelf", "update")
  );
  const root = commands.update(located, admitted.data, raw.data);
  for (const field of engineSchema.keys(schema.shelf)) root.fields.field(field);
  return { admitted, commands, context, root };
}

async function measureSeriesChoice(
  recipe: StructuralRecipe,
  replay?: ReplayTape
): Promise<MeasuredCase> {
  assert(
    recipe.kind === "series-choice-found" ||
      recipe.kind === "series-choice-missing"
  );
  const recorder = new Recorder(
    recipe.size + (recipe.kind === "series-choice-found" ? 100 : 200),
    replay
  );
  const bindings = new SemanticInventoryBindings();
  const captured = await recorder.control(() =>
    captureStructuralMeasurement(
      recipe.caseId,
      bindings,
      async () => {
        const database = new Database(":memory:");
        database.pragma("foreign_keys = ON");
        const driver = measurementDriver(recipe.profile, database, recorder);
        let captureReached = false;
        const admissions: Array<{
          readonly scope: "template" | "member";
          readonly value: string;
        }> = [];
        let member = 0;
        const schema = seriesSchema(() => {
          const scope = captureReached ? "member" : "template";
          const value = scope === "template" ? "other" : `member-${member++}`;
          admissions.push({ scope, value });
          return value;
        });
        const client = await migrate(schema, driver);
        try {
          database.exec(`
          INSERT INTO cs02_measure_shelves VALUES('s1','initial');
          ${Array.from(
            { length: recipe.size },
            (_, index) =>
              `INSERT INTO cs02_measure_bins VALUES('bin-${index}','s1');`
          ).join("\n")}
          INSERT INTO cs02_measure_early_holders VALUES('early','s1',NULL);
          INSERT INTO cs02_measure_late_holders VALUES('late','s1',NULL);
        `);
          driver.afterStatement = (rows) => {
            if (
              rows.filter(
                (row) =>
                  isRecord(row) &&
                  typeof row.id === "string" &&
                  row.id.startsWith("bin-")
              ).length === recipe.size
            )
              captureReached = true;
          };
          driver.resetObservations();
          const built = seriesCommands(
            schema,
            driver,
            recipe.size,
            recipe.lateChoiceState === "found"
          );
          const earlyChoice = requireChoice(built.root, "earlyHolders");
          const lateChoice = requireChoice(built.root, "lateHolders");
          const earlyGuard = built.commands.place(
            built.root,
            earlyChoice.lookup,
            "before"
          );
          const lateGuard = built.commands.place(
            built.root,
            lateChoice.lookup,
            "before"
          );
          bindSeriesTree(bindings, recipe, built.root, earlyGuard, lateGuard);
          const occurrence = built.commands.analyze(built.root);
          await built.context.run(() =>
            built.commands.execution.complete(occurrence, built.admitted)
          );
          assert.deepEqual(admissions, [
            { scope: "template", value: "other" },
            ...recipe.members.map(
              (
                value
              ): { readonly scope: "member"; readonly value: string } => ({
                scope: "member",
                value,
              })
            ),
          ]);
          // D-51: each connect names a ticket this series writes, so it is an
          // ordered observation behind those writes rather than the retired
          // own-write dependency refusal — the whole guarded series commits,
          // on the interactive transport and on the batch one alike.
          assert.deepEqual(
            database
              .prepare("SELECT id,label FROM cs02_measure_shelves ORDER BY id")
              .all(),
            [{ id: "s1", label: "prefix" }]
          );
          const ticket = database.prepare(
            "SELECT id,note,binId FROM cs02_measure_tickets WHERE id = ?"
          );
          // Members are admitted in the captured selection's own order
          // (`ORDER BY id ASC`), so `member-N` is the N-th bin BY ID.
          const binsByAdmission = recipe.members
            .map((_, index) => `bin-${index}`)
            .sort();
          assert.deepEqual(
            recipe.members.map((member) => ticket.get(member)),
            recipe.members.map((member, index) => ({
              id: member,
              note: "member",
              binId: binsByAdmission[index],
            }))
          );
          assert.deepEqual(
            database
              .prepare("SELECT COUNT(*) AS written FROM cs02_measure_tickets")
              .get(),
            { written: recipe.oracle.ticketWrites }
          );
          assert.deepEqual(
            database
              .prepare(
                "SELECT id,shelfId,ticketId FROM cs02_measure_early_holders ORDER BY id"
              )
              .all(),
            [{ id: "early", shelfId: "s1", ticketId: recipe.oracle.earlyTicket }]
          );
          assert.deepEqual(
            database
              .prepare(
                "SELECT id,shelfId,ticketId FROM cs02_measure_late_holders ORDER BY id"
              )
              .all(),
            recipe.lateChoiceState === "found"
              ? [{ id: "late", shelfId: "s1", ticketId: recipe.oracle.lateTicket }]
              : [
                  { id: "late", shelfId: "s1", ticketId: null },
                  { id: "missing", shelfId: "s1", ticketId: null },
                ]
          );
          return {
            outcome: "accepted",
            earlyTicket: recipe.oracle.earlyTicket,
            lateTicket: recipe.oracle.lateTicket,
            admittedMembers: recipe.size,
          };
        } finally {
          await client.$disconnect();
          database.close();
        }
      },
      (event, identities) =>
        bindCapturedSeriesMember(event, identities, recipe.caseId)
    )
  );
  assert.deepEqual(captured.semanticInventory, recipe.semanticInventory);
  return {
    events: captured.events,
    measurementCase: {
      caseId: recipe.caseId,
      slice: "structure",
      profile: recipe.profile,
      size: recipe.size,
      recipeSha256: sha256(recipe),
      scheduleSha256: sha256(recipe.schedule),
      semanticInventory: captured.semanticInventory,
      outcomeSha256: sha256(captured.value),
      counters: reduceMeasurementEvents(recipe.caseId, captured.events),
      eventCount: captured.events.length,
      eventsSha256: sha256(captured.events),
    },
    tape: recorder.finish(),
  };
}

async function measureCreate(
  recipe: Extract<StructuralRecipe, { kind: "depth-create" | "width-create" }>
): Promise<MeasuredCase> {
  const bindings = new SemanticInventoryBindings();
  const captured = await captureStructuralMeasurement(
    recipe.caseId,
    bindings,
    () => {
      const { commands, root } = createCommands(record(recipe.data));
      bindCreateTree(bindings, recipe.caseId, root, recipe.kind);
      const occurrence = commands.analyze(root);
      assert.equal(occurrence.command, root);
      return { outcome: "accepted", logicalOrder: recipe.oracle.logicalOrder };
    }
  );
  assert.deepEqual(
    captured.semanticInventory,
    canonicalInventory(recipe.semanticInventory)
  );
  const counters = reduceMeasurementEvents(recipe.caseId, captured.events);
  return {
    events: captured.events,
    measurementCase: {
      caseId: recipe.caseId,
      slice: "structure",
      profile: recipe.profile,
      size: recipe.size,
      recipeSha256: sha256(recipe),
      scheduleSha256: sha256(recipe.schedule),
      semanticInventory: captured.semanticInventory,
      outcomeSha256: sha256(captured.value),
      counters,
      eventCount: captured.events.length,
      eventsSha256: sha256(captured.events),
    },
  };
}

async function measureRecipe(
  recipe: StructuralRecipe,
  replay?: ReplayTape
): Promise<MeasuredCase> {
  if (recipe.kind === "depth-create" || recipe.kind === "width-create") {
    assert.equal(replay, undefined);
    return measureCreate(recipe);
  }
  if (recipe.kind === "width-overlap") return measureOverlap(recipe, replay);
  if (
    recipe.kind === "series-choice-found" ||
    recipe.kind === "series-choice-missing"
  )
    return measureSeriesChoice(recipe, replay);
  return measureSeriesChoice(recipe, replay);
}

it("collects the frozen CS-02 structural work matrix", async () => {
  const cases: MeasurementCase[] = [];
  const events: Array<{
    readonly caseId: string;
    readonly events: readonly import("./protocol").MeasurementEvent[];
  }> = [];
  const replayTapes: Array<{
    readonly caseId: string;
    readonly tape: ReplayTape;
  }> = [];
  let replays = 0;
  for (const recipe of structuralMeasurementRecipes()) {
    const measured = await measureRecipe(recipe);
    cases.push(measured.measurementCase);
    events.push({ caseId: recipe.caseId, events: measured.events });
    if (!measured.tape) continue;
    replayTapes.push({ caseId: recipe.caseId, tape: measured.tape });
    for (let replay = 0; replay < 3; replay += 1) {
      const replayed = await measureRecipe(recipe, measured.tape);
      assert.deepEqual(replayed.measurementCase, measured.measurementCase);
      assert.deepEqual(replayed.events, measured.events);
      replays += 1;
    }
  }
  assert.equal(cases.length, 28);
  assert.equal(replays, 60);
  if (
    process.env.VIBORM_RAPTOR3_MEASUREMENT_ALTERNATIVE ===
    "shared-occurrence-candidate"
  ) {
    const navigationCase = events.find(
      ({ caseId }) =>
        caseId === "structure/series-choice-found/32/sqlite-interactive"
    );
    assert(navigationCase);
    const captureOccurrence =
      "occurrence:structure/series-choice-found/32/sqlite-interactive:root/series/capture";
    const choiceOccurrence =
      "occurrence:structure/series-choice-found/32/sqlite-interactive:root/choice/early";
    assert(
      navigationCase.events.some(
        (event) =>
          event.kind === "prefixRead" &&
          event.purpose === "comparison" &&
          event.prefixOccurrenceId === captureOccurrence
      ),
      "preceding traversal must count the read-only capture subtree"
    );
    assert.equal(
      navigationCase.events.some(
        (event) =>
          event.kind === "writeVisit" &&
          event.occurrenceId === captureOccurrence
      ),
      false,
      "the traversal witness must remain read-only"
    );
    assert(
      navigationCase.events.some(
        (event) =>
          event.kind === "prefixRead" &&
          event.purpose === "comparison" &&
          event.prefixOccurrenceId === choiceOccurrence
      ),
      "preceding traversal must count a compound Choice entry"
    );
    assert.equal(
      navigationCase.events.some(
        (event) =>
          event.kind === "writeVisit" && event.occurrenceId === choiceOccurrence
      ),
      false,
      "the compound Choice entry must not masquerade as a direct write"
    );
    assert(
      navigationCase.events.some(
        (event) => event.kind === "prefixRead" && event.purpose === "navigation"
      ),
      "preceding traversal must count ancestor navigation"
    );
  }
  const eventsFile = measurementEventsFileSchema.parse({
    formatVersion: 1,
    cases: events,
  });
  const parsedCases = cases.map((measurementCase) =>
    measurementCaseSchema.parse(measurementCase)
  );
  for (const measurementCase of parsedCases) {
    const eventCase = eventsFile.cases.find(
      ({ caseId }) => caseId === measurementCase.caseId
    );
    assert(eventCase, `Missing raw events for ${measurementCase.caseId}`);
    assert.deepEqual(
      reduceMeasurementEvents(measurementCase.caseId, eventCase.events),
      measurementCase.counters
    );
    assert.equal(sha256(eventCase.events), measurementCase.eventsSha256);
  }
  const evidenceDirectory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (evidenceDirectory) {
    mkdirSync(evidenceDirectory, { recursive: true });
    const eventsPath = join(evidenceDirectory, "events.json");
    writeFileSync(eventsPath, `${JSON.stringify(eventsFile, undefined, 2)}\n`);
    writeFileSync(
      join(evidenceDirectory, "measurement-cases.json"),
      `${JSON.stringify(cases, undefined, 2)}\n`
    );
    writeFileSync(
      join(evidenceDirectory, "replay-tapes.json"),
      `${JSON.stringify(
        encodeEvidenceValue({ formatVersion: 1, replays, cases: replayTapes }),
        undefined,
        2
      )}\n`
    );
    const baseIdentityFile =
      process.env.VIBORM_RAPTOR3_MEASUREMENT_BASE_IDENTITY;
    const instrumentationPatchFile =
      process.env.VIBORM_RAPTOR3_MEASUREMENT_PATCH;
    const alternative = process.env.VIBORM_RAPTOR3_MEASUREMENT_ALTERNATIVE;
    if (baseIdentityFile || instrumentationPatchFile || alternative) {
      assert(baseIdentityFile);
      assert(instrumentationPatchFile);
      assert(
        alternative === "flat-history-reference" ||
          alternative === "shared-occurrence-candidate"
      );
      const retainedPatch = join(evidenceDirectory, "instrumentation.patch");
      copyFileSync(resolve(instrumentationPatchFile), retainedPatch);
      const receipt = measurementReceiptSchema.parse({
        formatVersion: 1,
        qualifying: true,
        alternative,
        mode: "cs02-structure-measure",
        baseIdentity: JSON.parse(
          readFileSync(resolve(baseIdentityFile), "utf8")
        ),
        instrumentedIdentity: captureRaptor3Identity(),
        instrumentationPatchFile: "instrumentation.patch",
        instrumentationPatchSha256: sha256File(retainedPatch),
        counterContractSha256: counterContractSha256(),
        profiles: [
          "construction-only",
          "sqlite-interactive",
          "sqlite-atomic-batch",
        ],
        cases: parsedCases,
        eventsFileSha256: sha256File(eventsPath),
        replays,
        skipped: 0,
      });
      assert.deepEqual(
        receipt.baseIdentity.runtime,
        receipt.instrumentedIdentity.runtime
      );
      assert.notDeepEqual(receipt.baseIdentity, receipt.instrumentedIdentity);
      writeFileSync(
        join(evidenceDirectory, "verified.json"),
        `${JSON.stringify(receipt, undefined, 2)}\n`
      );
    }
  }
});

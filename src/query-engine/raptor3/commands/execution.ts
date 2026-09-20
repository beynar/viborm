import { getAdapterInternals } from "@adapters/adapter-internals";
import {
  NestedWriteError,
  NotFoundError,
  UniqueConstraintError,
  UnsupportedOperationError,
} from "@errors";
import { type AnyModel, getModelKeyCatalog } from "@schema/model";
import { assertInvariant } from "../shared/invariant";
import type {
  Member,
  MembershipParent,
  ObservationPremise,
} from "../shared/operation-context";
import type { Query } from "../shared/query";
import { type Arguments, entries, type Input, record } from "../shared/schema";
import { type Membership, storedFields } from "../shared/storage";
import type { TransportAttempt } from "../shared/transport-attempt";
import type { Assignments } from "./assignments";
import { CommandAttempt } from "./command-attempt";
import {
  isRecordOccurrence,
  isSeriesOccurrence,
  membershipRaceFailure,
} from "./commands";
import type {
  Choose,
  Command,
  CommandOccurrence,
  Commands,
  RecordCommand,
  SelectedSeriesMember,
  SeriesOccurrence,
} from "./commands";
import { membershipFields, type Selection } from "./selection";

/** What a captured series prepared, as its owner (`CommandAttempt`) states it. */
type PreparedSeries = NonNullable<ReturnType<CommandAttempt["series"]["get"]>>;

/** Interprets the prepared command tree through one replaceable execution attempt. */
export class CommandExecution {
  readonly context;
  private currentAttempt: CommandAttempt;
  constructor(readonly commands: Commands) {
    this.context = commands.context;
    this.currentAttempt = new CommandAttempt(this.context.transportAttempt);
    this.context.attachRecovery(() => this.replaceRegions());
  }
  /**
   * The ONE recovery method: both attempt regions replaced synchronously, with
   * no callback and no await between the installations. WHETHER it may run is
   * the operation's question, not this interpreter's — `OperationContext`
   * spends the single allowance ({@link OperationContext.spendRecovery}) and is
   * this method's only caller, so a re-planned operation's new interpreter
   * brings no second allowance with it (Arnaud's D-25).
   */
  private replaceRegions(): TransportAttempt {
    const replacement = new CommandAttempt();
    this.currentAttempt = replacement;
    return replacement.transport;
  }
  get attempt(): CommandAttempt {
    return this.currentAttempt;
  }
  identity(fields: Assignments): Input {
    return this.attempt.select(fields, this.context.schema.keys(fields.model));
  }
  private membershipValues(edge: Membership, parent: Assignments): Input {
    return this.attempt.select(parent, membershipFields(edge));
  }
  private linkValues(
    edge: Extract<Membership, { kind: "junction" }>,
    source?: Assignments,
    target?: Assignments
  ): Input {
    return Object.fromEntries([
      ...(source
        ? edge.sourceSide.members.map((pair) => [
            pair.junctionField,
            this.attempt.read(source, pair.referencedField),
          ])
        : []),
      ...(target
        ? edge.targetSide.members.map((pair) => [
            pair.junctionField,
            this.attempt.read(target, pair.referencedField),
          ])
        : []),
    ]);
  }
  private async requireTransitions(command: RecordCommand): Promise<void> {
    const ctx = this.context;
    const q = ctx.queries;
    const a = ctx.driver.adapter;
    for (const edge of command.transitions) {
      const before = this.membershipValues(edge, command.located!.fields);
      const after = this.membershipValues(edge, command.fields);
      for (const pair of edge.pairs) {
        if (after[pair.source] === null)
          throw new NestedWriteError(
            `Cannot update relation key field '${pair.source}' to null while mutating relation '${edge.name}'. A null reference names no row for that relation to point at.`,
            edge.name,
            {
              meta: {
                operation: "update",
                field: pair.source,
                relation: edge.name,
              },
            }
          );
      }
      if (
        !edge.reference ||
        edge.reference.onUpdate === "cascade" ||
        edge.pairs.some((pair) => before[pair.source] === null)
      )
        continue;
      const changed = a.operators.or(
        ...edge.pairs.map((pair) =>
          a.operators.not(
            a.operators.eq(
              q.fieldValue(command.model, pair.source, before[pair.source]),
              q.updateValue(
                command.model,
                pair.source,
                after[pair.source],
                q.fieldValue(command.model, pair.source, before[pair.source])
              )
            )
          )
        )
      );
      const failure = new NestedWriteError(
        `Cannot update relation '${edge.name}' with onUpdate('${edge.reference.onUpdate ?? "restrict"}') while the current relation is occupied.`,
        edge.name,
        {
          meta: ctx.usesBatch
            ? { relation: edge.name }
            : { operation: "update", relation: edge.name },
        }
      );
      if (ctx.usesBatch) failure.meta.raceable = true;
      await ctx.requireAbsent(
        q.select(
          edge.target,
          { take: 1 },
          { edge, parent: before },
          { condition: changed }
        ),
        failure
      );
    }
  }
  /**
   * What a parent-held `connect`'s LOCATED row supplies to the row that SPENDS
   * it — the ONE arm whose located value the parent's own SET writes.
   *
   * The probe answers EXISTENCE and the branch this arm takes. The value the
   * consumer's own statement writes is read inside that statement, over this
   * arm's own selector ({@link Queries.locatedValue}), so a probe row that
   * changed under us cannot move the written key and what lands in the column
   * is the target's own bytes. Reading the referenced column is also how the
   * arm SEES a located target holding NULL there: writing that NULL would
   * DISCONNECT the holder the payload asked to connect, so the arm refuses by
   * name — here, ahead of every write of the unit, the sibling scalars of the
   * same SET included.
   *
   * The gate asks TWO things because `membershipOnly` answers only one of
   * them: it says this arm's value is not a pure membership, and it is FALSE
   * for every verb but `connect` — so the verb is asked here as well. Every
   * other arm binds what the probe read, unchanged: a junction writes its
   * captured pair, and a `connectOrCreate` FOUND arm spends the bytes its own
   * probe returned — the retired engine folded the `connect` lookup and no
   * other, which is what the scripted transport replies still spell
   * (`tests/raptor3/transport/world.ts`, `coc-found`).
   */
  private folded(
    command: Choose,
    enclosing: Command | undefined,
    captured: Input
  ): Input {
    const origin = command.lookup.origin;
    if (
      !origin ||
      origin.operation !== "connect" ||
      command.lookup.membershipOnly !== false
    )
      return captured;
    const values: Input = { ...captured };
    for (const field of command.fields.demands) {
      if (captured[field] === null)
        throw new NestedWriteError(
          `Cannot ${origin.operation} relation '${origin.relation}': the located target's referenced field '${field}' is null.`,
          origin.relation
        );
      values[field] = this.context.queries.locatedValue(
        command.model,
        field,
        command.lookup.selector,
        enclosing?.kind === "record" ? enclosing.model : undefined
      );
    }
    return values;
  }
  /**
   * The PARENT row this created record is a member of, where it has one.
   *
   * A membership names its parent BY VALUE: this row's own column holds what
   * the parent's referenced field held when the plan read it. Where the INSERT
   * commits in a segment of its own, everything that follows trusts a parent
   * nothing re-read — and once another row holds that reference, the
   * correlation answers with IT. So the continuation re-pins the parent the
   * way {@link CommandExecution.captureSeries} pins a captured series': the
   * parent's IDENTITY and the value it holds for the edge, in one premise.
   *
   * The contributions that read the ENCLOSING record's own fields are that
   * membership — `Commands.create` assigns them from the incoming edge — and
   * the placement's origin names the relation and the verb that spelled it.
   */
  private membershipParent(
    command: RecordCommand,
    enclosing: Command | undefined
  ): MembershipParent | undefined {
    const origin = command.origin;
    if (!origin || enclosing?.kind !== "record") return undefined;
    const referenced: string[] = [];
    for (const value of command.fields.contributions().values())
      if (value.kind === "field" && value.producer === enclosing.fields)
        referenced.push(value.field);
    if (referenced.length === 0) return undefined;
    const parent = enclosing.fields;
    return {
      model: parent.model,
      where: () => ({
        ...this.identity(parent),
        ...this.attempt.select(parent, referenced),
      }),
      relation: origin.relation,
      verb: origin.operation,
    };
  }
  /**
   * Whether the arm that HOLDS a moved value is the arm that RAN.
   *
   * {@link Assignments.hold} is stated at plan time from a choice's FOUND
   * payload, because that write is the one the provider would carry this row
   * along with. A choice that took its MISSING arm created a row only this
   * row's own statement can point it at — nothing cascaded, and re-addressing
   * the observation by the key the new row holds would name no row at all
   * (a live `UPDATE ... RETURNING` that produces nothing, a batch route that
   * commits a fresh target and moves no holder). The attempt already records
   * which arm ran.
   */
  private carried(holder: Assignments): boolean {
    for (const choice of this.attempt.missingChoices.values())
      if (choice.found?.command.fields === holder) return false;
    return true;
  }
  private matchesSelectedConstraint(
    choice: Choose,
    error: UniqueConstraintError
  ): boolean {
    const key = choice.lookup.selector.uniqueKey;
    const selected = choice.lookup.selector.uniqueValues;
    if (!(key && selected)) return false;
    if (
      !key.fields.every((field) => {
        const missing = choice.missing;
        const proposed = missing?.command.fields.known(field);
        return (
          proposed?.kind === "literal" &&
          Object.is(proposed.value, selected.get(field))
        );
      })
    )
      return false;
    const table = choice.model["~"].names.sql!;
    const columns = key.fields.map((field) =>
      this.context.queries.columnName(choice.model, field)
    );
    const constraints = getAdapterInternals(
      this.context.driver.adapter
    ).constraints;
    const expected = (
      key.kind === "primary"
        ? constraints.primaryKey(table, columns)
        : constraints.unique(table, key.name ?? columns[0]!, columns)
    ).normalizedError;
    const meta = error.meta;
    if (meta.table !== expected.table) return false;
    if (meta.constraint !== expected.constraint) return false;
    const expectedColumns = expected.columns;
    if (meta.columns === undefined || expectedColumns === undefined) {
      return meta.columns === expectedColumns;
    }
    return (
      meta.columns.length === expectedColumns.length &&
      meta.columns.every((column, index) => column === expectedColumns[index])
    );
  }
  private async recover(error: unknown): Promise<boolean> {
    // In place, or not at all: where this operation opened a region, the
    // rejection aborted it and the recovery is the region owner's.
    if (!this.context.replaysInPlace) return false;
    const rejection = this.context.recoveryRejection(error);
    const choice =
      rejection?.kind === "insert"
        ? this.attempt.missingChoices.get(rejection.producer)
        : undefined;
    const conditional = this.attempt.conditionalSkips.get(error);
    if (conditional && rejection?.kind === "assertion") {
      const replacement = this.context.spendRecovery();
      if (!replacement) return false;
      this.context.restartRejectedInsert(replacement);
      return true;
    }
    if (
      !(
        choice &&
        error instanceof UniqueConstraintError &&
        this.matchesSelectedConstraint(choice, error)
      )
    )
      return false;
    const replacement = this.context.spendRecovery();
    if (!replacement) return false;
    this.context.restartRejectedInsert(replacement);
    // A lost winner is not permission to attempt the missing INSERT again.
    await this.runSelection(choice.lookup);
    return this.attempt.rows.has(choice.lookup);
  }
  async complete(
    root: CommandOccurrence<RecordCommand | Choose>,
    args: Arguments
  ): Promise<unknown> {
    while (true) {
      try {
        await this.run(root);
        return await this.context.finishOne(
          this.context.queries.select(
            root.command.model,
            {
              select: args.select,
              include: args.include,
              omit: args.omit,
            },
            undefined,
            { identity: this.identity(root.command.fields) }
          )
        );
      } catch (error) {
        if (!(await this.recover(error))) throw error;
      }
    }
  }
  private async runSelection(
    selection: Selection,
    member?: Member,
    premise?: ObservationPremise
  ): Promise<void> {
    const attempt = this.attempt;
    if (attempt.rows.has(selection)) return;
    const source = selection.source;
    if (
      source.kind === "producer" &&
      !this.context.usesBatch &&
      selection.facts.fields.size === 0
    ) {
      const row = attempt.select(source.producer, selection.fields.demands);
      attempt.rows.set(selection, row);
      attempt.bind(selection.fields, row);
      return;
    }
    // An ordered observation (N1) on the batch route reads through the barrier:
    // the queued unit goes with its premises and the read rides the same native
    // batch behind the writes it depends on; a required row is a premise of
    // that batch too, so an absent target aborts it before anything commits.
    const required = selection.required;
    const rows =
      selection.dependent && this.context.usesBatch
        ? await this.context.flush(
            selection.query(),
            member,
            premise ??
              (required && {
                query: selection.query(),
                present: true,
                failure: required,
              })
          )
        : await this.context.read(
            selection.query(),
            true,
            false,
            selection.model
          );
    const found = rows[0];
    if (!found) {
      if (selection.required) throw selection.required();
      return;
    }
    attempt.rows.set(selection, found);
    attempt.bind(selection.fields, found);
    if (this.context.usesBatch && selection.retained)
      this.context.requirePresent(selection.captured(), selection.retained());
  }
  async run(
    occurrence: CommandOccurrence,
    member: Member = occurrence.command
  ): Promise<void> {
    const ctx = this.context;
    const attempt = this.attempt;
    const command = occurrence.command;
    switch (command.kind) {
      case "record": {
        command.fields.activate();
        if (occurrence.refusal) throw occurrence.refusal;
        if (command.located && !attempt.rows.has(command.located))
          await this.runSelection(command.located, member);
        if (
          ctx.usesBatch &&
          command.located &&
          !command.located.retained &&
          !attempt.retained.has(command.located)
        ) {
          const missingRow =
            command.requirement?.failure ?? command.located.required;
          ctx.requirePresent(
            command.located.captured(
              undefined,
              command.requirement?.membership ?? command.located.membership(),
              1
            ),
            missingRow
              ? missingRow()
              : new NotFoundError(command.model["~"].names.ts!, "update")
          );
        }
        await this.requireTransitions(command);
        for (const child of occurrence.children)
          if (child.placement === "before") await this.run(child, member);
        // Every `before` child has run, and one of them may already have moved
        // this row: a correlated arm's target is the row this one points at, so
        // the provider rewrote this row's foreign key when the arm rewrote the
        // key it references ({@link Assignments.hold}). The observation this
        // operation holds of the row is re-addressed from the value the arm
        // published, so the record's own statement, its later children and the
        // terminal read all name the row where the cascade left it — the
        // located key names nothing at all. One of them may equally have run
        // its OTHER arm, and then nothing cascaded ({@link carried}).
        const moved =
          command.located &&
          command.fields.moved((holder) => this.carried(holder));
        if (moved)
          attempt.materialize(command.located!.fields, attempt.resolve(moved));
        attempt.bind(
          command.fields,
          command.located
            ? await ctx.update(
                command.model,
                this.identity(command.located.fields),
                attempt.values(command.fields),
                member,
                command.operation,
                command.fields.demands,
                attempt.rows.get(command.located)
              )
            : await ctx.insert(
                command.model,
                attempt.values(command.fields),
                command.fields.demands,
                member,
                command.operation,
                command.fields,
                this.membershipParent(command, occurrence.parent?.command)
              )
        );
        // Every capture still runs before every effect, and the reason is
        // MEASURED, not stylistic: a capture flushes
        // (`OperationContext.captureSeries` → `flush`), and on the batch route a
        // flush COMMITS everything queued before it — so a capture placed after
        // a sibling effect commits that effect, and a planning refusal the
        // capture then raises can no longer undo it.
        // `tests/raptor3/post-prep/g29-dependency-boundaries.test.ts` measures
        // exactly that: with the two passes merged into the body's declared
        // order, the earlier sibling `create` is durable (`committedSegments: 1`)
        // before the member lookup refuses. Sibling ORDER is restored where it
        // was actually inverted — by compiling a set mutation as one statement
        // instead of a capture (`SetMutation`) — not by moving the captures that
        // remain. See `docs/architecture/raptor3-evidence/g4/parity/lane-x-note.md`
        // (U6.2, "the phase pass stays").
        for (const child of occurrence.children)
          if (child.placement === "capture") await this.run(child, member);
        for (const child of occurrence.children)
          if (child.placement === "after") await this.run(child, member);
        return;
      }
      case "lookup": {
        await this.runSelection(command, member);
        return;
      }
      case "junction": {
        if (attempt.junctions.has(command)) return;
        if (command.address && !attempt.rows.has(command.address)) return;
        const captured = await ctx.captureMembership(
          command.edge,
          attempt.resolve(command.values)
        );
        if (captured) attempt.junctions.set(command, captured);
        return;
      }
      case "absent": {
        const exclude = command.excluding.map((fields) =>
          ctx.queries.lowerIdentity(command.model, this.identity(fields))
        );
        await ctx.requireAbsent(
          ctx.queries.select(
            command.model,
            {
              take: 1,
              select: Object.fromEntries(
                storedFields(ctx.schema, command.model).map((field) => [
                  field,
                  true,
                ])
              ),
            },
            {
              edge: command.membership.edge,
              parent: this.membershipValues(
                command.membership.edge,
                command.membership.parent
              ),
            },
            {
              forUpdate: !ctx.usesBatch,
              condition: exclude.length
                ? ctx.driver.adapter.operators.not(
                    ctx.driver.adapter.operators.or(...exclude)
                  )
                : undefined,
            }
          ),
          command.failure()
        );
        return;
      }
      case "choose": {
        const supplied = command.lookup.source.kind === "producer";
        // A lookup whose selector names a value this operation PRODUCED is
        // answered outside the queue, so the unit that produces it is
        // dispatched first — and the boundary itself carries the value across
        // as a literal (D-58, `OperationContext.submit`), which is what lets
        // the selector name it at all.
        if (ctx.usesBatch && supplied) {
          try {
            await ctx.flush(undefined, member);
          } catch (error) {
            throw ctx.failure(error, "prefix", member);
          }
        }
        // A found requirement rides the observation's batch as its premise:
        // no row the selector names may stand outside the membership (N1).
        const requirement = command.foundRequirement;
        const premised =
          requirement !== undefined &&
          ctx.usesBatch &&
          command.lookup.dependent === true;
        try {
          await this.runSelection(
            command.lookup,
            member,
            premised
              ? {
                  query: requirement.selection.outsideMembership(
                    requirement.membership
                  ),
                  present: false,
                  failure: requirement.failure,
                }
              : undefined
          );
          for (const condition of command.conditions?.probes ?? [])
            await this.runSelection(condition.lookup, member);
        } catch (error) {
          throw supplied ? ctx.failure(error, "capture", member) : error;
        }
        const captured = attempt.rows.get(command.lookup);
        const found = this.commands.choiceArm(occurrence, "found");
        const missing = this.commands.choiceArm(occurrence, "missing");
        if (captured) {
          if (command.conditions?.probes.length && found) {
            found.command.fields.activate();
            if (found.refusal) throw found.refusal;
            const unmatched = command.conditions.probes.find(
              (condition) => !attempt.rows.has(condition.lookup)
            );
            if (unmatched) {
              if (ctx.usesBatch) {
                attempt.conditionalSkips.set(unmatched.skip, command);
                ctx.requirePresent(
                  command.lookup.captured(undefined, undefined, 1),
                  command.conditions.missingRow
                );
                await ctx.requireAbsent(
                  command.lookup.captured(unmatched.lookup, undefined, 1),
                  unmatched.skip
                );
              }
              attempt.bind(command.fields, captured);
              return;
            }
            if (ctx.usesBatch) {
              for (const condition of command.conditions.probes)
                ctx.requirePresent(
                  command.lookup.captured(condition.lookup, undefined, 1),
                  condition.match
                );
              attempt.retained.add(command.lookup);
            }
          }
          if (requirement && !premised) {
            const rows = await ctx.read(
              requirement.selection.inspectMembership(requirement.membership),
              true,
              false,
              requirement.selection.model
            );
            if (!rows[0]) throw requirement.failure();
          }
          if (found) {
            if (ctx.usesBatch && supplied) {
              ctx.prepareMembers(() => [found.command], member);
              await ctx.executeMember(() => this.run(found), found.command);
            } else await this.run(found, member);
            attempt.bind(command.fields, {
              ...captured,
              ...attempt.select(found.command.fields, command.fields.demands),
            });
          } else
            attempt.bind(
              command.fields,
              this.folded(command, occurrence.parent?.command, captured)
            );
        } else if (missing) {
          attempt.missingChoices.set(missing.command.fields, command);
          await this.run(missing, member);
          attempt.bind(
            command.fields,
            attempt.select(missing.command.fields, command.fields.demands)
          );
        }
        return;
      }
      case "link": {
        const original =
          command.captured && attempt.junctions.get(command.captured);
        const address = command.captured;
        const carriedSide =
          address?.edge.uniqueSide === "source"
            ? address.edge.sourceSide
            : address?.edge.targetSide;
        const captured =
          original && address && carriedSide
            ? {
                ...original,
                ...Object.fromEntries(
                  carriedSide.members.map((pair) => [
                    pair.junctionField,
                    attempt.read(address.final, pair.referencedField),
                  ])
                ),
              }
            : original;
        const matches = (fields: Input) =>
          Object.entries(fields).every(
            ([field, value]) => captured && Object.is(captured[field], value)
          );
        const removed =
          captured &&
          command.removals?.some(
            (removal) =>
              matches(
                this.linkValues(removal.edge, removal.source, removal.target)
              ) &&
              !removal.keep.some((retained) =>
                matches(this.linkValues(removal.edge, undefined, retained))
              )
          );
        await ctx.link(
          command.edge,
          attempt.resolve(command.values),
          member,
          removed ? undefined : captured
        );
        return;
      }
      case "remove": {
        await ctx.remove(
          command.edge,
          command.source
            ? this.membershipValues(command.edge, command.source)
            : undefined,
          command.target ? this.identity(command.target) : undefined,
          command.keep.map((target) => this.identity(target)),
          member
        );
        return;
      }
      case "delete": {
        await this.runSelection(command.located, member);
        // A selection that is not required and bound no row is an empty
        // slot: a lax `delete: true` deletes nothing (DESIGN §5.3). A
        // required selection threw in `runSelection` before reaching here.
        const row = attempt.rows.get(command.located);
        if (!row) return;
        await ctx.delete(command.located.model, row, member);
        return;
      }
      case "set": {
        await ctx.mutateMembers(
          command.edge,
          this.membershipValues(command.edge, command.parent),
          command.selector,
          command.values,
          member
        );
        return;
      }
      case "captureSeries": {
        await this.captureSeries(
          this.commands.seriesCaptureTarget(occurrence),
          member
        );
        return;
      }
      case "series": {
        await this.executeRecords(
          occurrence.children.filter(isRecordOccurrence),
          member,
          command.select
        );
        return;
      }
      case "selectedSeries": {
        if (isSeriesOccurrence(occurrence))
          await this.executeSeries(occurrence);
        return;
      }
      case "membership":
        return;
    }
  }
  async records(
    records: CommandOccurrence<RecordCommand>[],
    select: Input | undefined,
    member: Member
  ): Promise<unknown> {
    const { count, identities } = await this.executeRecords(
      records,
      member,
      select
    );
    if (!select) return this.context.finishValue({ count });
    if (identities.length === 0) return this.context.finishMany([]);
    return this.context.finishMany(
      this.context.seriesQueries(
        this.context.queries.prepareProjection(records[0]!.command.model, {
          select,
        }),
        identities
      )
    );
  }
  private async executeRecords(
    records: CommandOccurrence<RecordCommand>[],
    member: Member,
    select: Input | undefined
  ): Promise<{ readonly count: number; readonly identities: Input[] }> {
    const ctx = this.context;
    const members = ctx.prepareMembers(() => records, member);
    const identities: Input[] = [];
    let count = 0;
    for (const record of members) {
      const command = record.command;
      const completed = command.suppression
        ? await ctx.executeSkippableMember(
            () => this.run(record),
            command.fields,
            command
          )
        : (await ctx.executeMember(() => this.run(record), command), true);
      if (!completed) {
        await ctx.executeMember(() => this.adoptSuppressed(record), command);
        continue;
      }
      count++;
      if (select) identities.push(this.identity(command.fields));
    }
    return { count, identities };
  }
  /**
   * A skipped INSERT is not a skipped MEMBERSHIP.
   *
   * `skipDuplicates` suppressed this member's target ROW, so the membership it
   * declared is written against the row the member NAMES rather than rolled
   * back with the insert — the shipped `joinWhenTargetExists` route
   * (`write-engine/junction-create-many-routing.ts:95-113`,
   * `JunctionStatements.ts:134-155`). "Own key spelled" is not that question:
   * a spelled key that names NO row (the insert was refused by a different
   * unique) must write no membership, and a row key the provider generates
   * names the existing row through the one declared unique the payload spells
   * — the shipped `adopt` disposition, which E6.8 calls the `connectOrCreate`
   * adopt (`junction-create-many-routing.ts:117-131`). So the row is LOCATED
   * by what the payload spells, generated keys included, and a member that
   * locates nothing writes nothing.
   *
   * The MEMBERSHIP, and only it: every other effect this member declared
   * belongs to the row that was never created, so a member that declares one
   * strands whole, join included — the shipped router reads `relationBearing`
   * BEFORE the join route (`junction-create-many-routing.ts:76-84`), and in
   * the series it takes instead a skipped root returned before the member's
   * remaining steps ran (`OperationExecutor.ts:894`,
   * `if (execution.skippedRoot) return true`). The separate invariant "a
   * skipped root must strand nothing" (`:2389`) is about an effect placed
   * BEFORE that root, and refuses the member outright.
   */
  private async adoptSuppressed(
    record: CommandOccurrence<RecordCommand>
  ): Promise<void> {
    const command = record.command;
    for (const child of record.children)
      if (
        child.command.kind !== "link" &&
        child.command.kind !== "remove" &&
        child.command.kind !== "junction"
      )
        return;
    const row = await this.locateSuppressed(command);
    if (!row) return;
    this.attempt.bind(command.fields, row);
    for (const child of record.children)
      if (child.placement !== "before") await this.run(child, command);
  }
  /**
   * The existing row a suppressed member NAMES, read at this member's own
   * position: its complete row key when the payload spells it, else the one
   * declared unique it spells whole. Two spelled uniques name two rows and so
   * name none — the shipped disposition's `spelled.length !== 1` suppression
   * (`junction-create-many-routing.ts:121-124`).
   */
  private async locateSuppressed(
    command: RecordCommand
  ): Promise<Input | undefined> {
    const ctx = this.context;
    // A NULL is not a spelling: it equals no row, so a key holding one names
    // none (the shipped disposition's own `value !== undefined && value !==
    // null`, `junction-create-many-routing.ts:118-120`).
    const spelled = (fields: readonly string[]): Input | undefined => {
      const values: Input = {};
      for (const field of fields) {
        const known = command.fields.known(field);
        if (known?.kind !== "literal" || known.value === null) return undefined;
        values[field] = known.value;
      }
      return values;
    };
    let address = spelled(ctx.schema.keys(command.model));
    if (!address) {
      const named = getModelKeyCatalog(command.model)
        .addressableKeys.filter((key) => key.kind !== "primary")
        .map((key) => spelled(key.fields))
        .filter((values) => values !== undefined);
      if (named.length !== 1) return undefined;
      address = named[0]!;
    }
    const located = this.commands.lookup(command.model, {
      kind: "query",
      selector: ctx.queries.identitySelector(command.model, address),
    });
    await this.runSelection(located, command);
    return this.attempt.rows.get(located);
  }
  async series(
    occurrence: CommandOccurrence<SeriesOccurrence>,
    member?: Member
  ): Promise<number>;
  async series(
    occurrence: CommandOccurrence<SeriesOccurrence>,
    member: Member,
    select: Input
  ): Promise<Input[]>;
  async series(
    occurrence: CommandOccurrence<SeriesOccurrence>,
    member: Member = occurrence.command.series.selection,
    select?: Input
  ): Promise<number | Input[]> {
    const prepared = await this.captureSeries(occurrence, member);
    // Only the admitted updateMany boundary supplies select, so captureSeries
    // has constructed record members for this terminal readback.
    const updatedMembers =
      prepared.members as CommandOccurrence<RecordCommand>[];
    const identityFields = select
      ? updatedMembers.map(({ command }) => command.fields)
      : [];
    const count = await this.executeSeries(occurrence);
    const identities = identityFields.map((fields) => this.identity(fields));
    if (!select) {
      await this.context.finish();
      return count;
    }
    if (identities.length === 0) return this.context.finishMany([]);
    return this.context.finishMany(
      this.context.seriesQueries(
        this.context.queries.prepareProjection(
          occurrence.command.series.selection.model,
          { select }
        ),
        identities,
        "updateMany"
      )
    );
  }
  /**
   * A captured member set is an assertion about the rows it does NOT contain.
   *
   * Rule 5 forbids caching observed absence, and a plan-time membership read is
   * exactly that: it names the members that were connected and matched the
   * filter when it ran. So the set rides its own batch with the complement it
   * claims — "connected ∧ filter ∧ key ∉ captured is EMPTY" — as one raceable
   * `requireAbsent`. A member committed between the read and the batch aborts
   * the atomic unit instead of being silently missed, and the one recovery
   * re-plans from the admitted values against the larger set (Arnaud's D-25).
   *
   * Only on the batch route: an interactive transaction took `FOR UPDATE` on
   * the same read, so its member set cannot grow underneath it.
   */
  private async requireNoAddedMember(
    series: SeriesOccurrence["series"],
    membership: NonNullable<ReturnType<Selection["membership"]>>,
    rows: readonly Input[],
    keys: readonly string[]
  ): Promise<void> {
    const ctx = this.context;
    const selection = series.selection;
    const captured = ctx.queries.andSelectors(selection.model, [
      ...(selection.selector ? [selection.selector] : []),
      ...(rows.length === 0
        ? []
        : [
            ctx.queries.prepareSelector(selection.model, {
              NOT: {
                OR: rows.map((row) =>
                  Object.fromEntries(keys.map((field) => [field, row[field]]))
                ),
              },
            }),
          ]),
    ]);
    const failure = membershipRaceFailure(
      series.mutation.kind,
      membership.edge.name,
      "added"
    );
    await ctx.requireAbsent(
      ctx.queries.select(
        selection.model,
        { take: 1 },
        {
          edge: membership.edge,
          parent: this.membershipValues(membership.edge, membership.parent),
        },
        { selector: captured }
      ),
      failure
    );
  }
  private async captureSeries(
    occurrence: CommandOccurrence<SeriesOccurrence>,
    member: Member
  ): Promise<PreparedSeries> {
    const ctx = this.context;
    const attempt = this.attempt;
    const captured = attempt.series.get(occurrence);
    if (captured) return captured;
    const series = occurrence.command.series;
    const selection = series.selection;
    const membership = selection.membership();
    let parentRequirement: { query: Query; failure: Error } | undefined;
    if (membership) {
      const { edge, parent } = membership;
      const failure = new NestedWriteError(
        `Cannot ${series.mutation.kind} relation '${edge.name}': parent record changed across a committed segment.`,
        edge.name
      );
      const parentWhere = () => ({
        ...this.identity(parent),
        ...this.membershipValues(edge, parent),
      });
      const published = await ctx.flush(
        ctx.queries.select(parent.model, {
          where: parentWhere(),
          select: Object.fromEntries(
            [...parent.demands].map((field) => [field, true])
          ),
        }),
        member
      );
      if (!published[0]) throw ctx.failure(failure, "result", member);
      attempt.bind(parent, published[0]);
      parentRequirement = {
        failure,
        query: ctx.queries.select(parent.model, {
          where: parentWhere(),
          select: Object.fromEntries(
            ctx.schema.keys(parent.model).map((field) => [field, true])
          ),
        }),
      };
    }
    const keys = ctx.schema.keys(selection.model);
    const rows = await ctx.read(
      ctx.queries.select(
        selection.model,
        {
          orderBy: Object.fromEntries(keys.map((field) => [field, "asc"])),
          take: series.limit,
        },
        membership && {
          edge: membership.edge,
          parent: this.membershipValues(membership.edge, membership.parent),
        },
        { forUpdate: !ctx.usesBatch, selector: selection.selector }
      ),
      true,
      false,
      selection.model
    );
    if (series.mutation.kind === "update") {
      const exclusive = this.exclusiveMemberMove(
        selection.model,
        series.mutation.raw,
        rows.length
      );
      if (exclusive) throw ctx.failure(exclusive, "planning", member);
    }
    if (membership && parentRequirement && ctx.usesBatch) {
      // The complement's own premise, in front of the complement.
      //
      // Membership correlates by VALUE, so once another row takes the captured
      // reference its members answer the same correlation and the complement
      // reads them as additions to a set they were never in. What says "this
      // parent" is the premise `executeSeries` already asserts for every
      // member — the same query and the same sentence, asserted here at the
      // position where the captured set is FIXED, because a series that
      // captured no member queues none of the member copies and the complement
      // would otherwise be the only statement of this series that can abort
      // the unit. It is the batch's first statement, so a parent reference
      // reused between the capture and the batch refuses with the sentence the
      // shipped engine raised (`transitions/series-staleness.ts`
      // `g2-series-parent-reference-reused`) instead of the complement's
      // raceable one, which would retry against another parent's members.
      ctx.requirePresent(parentRequirement.query, parentRequirement.failure);
      await this.requireNoAddedMember(series, membership, rows, keys);
    }
    const members: SelectedSeriesMember[] = ctx.prepareMembers(
      () =>
        rows.map((row): SelectedSeriesMember => {
          const located = this.commands.capture(selection, row);
          attempt.rows.set(located, row);
          attempt.bind(located.fields, row);
          if (series.mutation.kind === "delete") {
            // The member's presence, asserted where the set is captured —
            // before any write of the unit — so its loss after the plan-time
            // read rejects at a premise and the operation re-plans once (D-32).
            if (ctx.usesBatch && membership) {
              ctx.requirePresent(
                located.captured(undefined, membership, 1),
                membershipRaceFailure(
                  series.mutation.kind,
                  membership.edge.name,
                  "removed"
                )
              );
              attempt.retained.add(located);
            }
            return {
              kind: "delete",
              located,
              origin: series.mutation.origin,
            };
          }
          const child = this.commands.update(
            located,
            membership &&
              membership.edge.scope.edge.kind !== "variantRowCarrier" &&
              membership.edge.scope.edge.kind !== "variantJunctionCarrier"
              ? ctx.schema.member(
                  membership.edge.source,
                  membership.edge.name,
                  series.mutation.raw
                )
              : ctx.schema.update(selection.model, series.mutation.raw, true),
            series.mutation.raw
          );
          if (membership)
            child.requirement = {
              selection: located,
              membership,
              failure: selection.required!,
            };
          return child;
        }),
      member
    );
    const refusal = this.commands.expandSeries(occurrence, members);
    if (refusal) throw ctx.failure(refusal.error, "planning", refusal.member);
    const prepared: PreparedSeries = {
      members: this.commands.seriesMembers(occurrence),
      parentRequirement,
    };
    attempt.series.set(occurrence, prepared);
    return prepared;
  }
  /**
   * One named EXCLUSIVE target membership, applied to many captured rows.
   *
   * A target whose membership is stored once — a junction row unique on the
   * target side, or a reference the TARGET row holds — belongs to exactly one
   * of the rows this series captured, so `connect` / `set` / `connectOrCreate`
   * across more than one of them is not executable by any owner: applied in
   * sequence the last row takes the target from the others, which is the
   * damage measured before this refusal returned ({count: 2}, both rows
   * written, the membership on whichever ran last). These are the retired
   * engine's two registered sentences
   * (`query-engine/relation-key-legality.ts:145`/`:149` at `e8114ed9d^`), kept
   * because D-52 keeps a refusal that names an execution fact — here
   * cardinality — that no owner can execute around.
   *
   * It is stated where the observed COUNT is first known, which is this site:
   * the one place that holds both the captured rows and the mutation they all
   * apply. That is NOT ahead of every write of the unit. A capture flushes,
   * and on the batch route a flush commits everything queued before it, so an
   * enclosing parent's own segment is already durable when this refusal fires
   * — the two routes answer with the same sentence and differ only in what
   * stands committed behind it (D-51's succession of segments, pinned by
   * `tests/raptor3/g4/parity/exclusive-member-cardinality.test.ts`). It reads
   * the payload the caller wrote, which the
   * plan-time analysis (`SelectedSeries.analysis`) already admitted — the
   * per-member admission is NOT re-run here, because a member's admission runs
   * this payload's client-side defaults and every member owns its own
   * (`tests/raptor3/core-structure/member-scope.contract.test.ts`
   * `cs03-peer-scope-root` pins the sequence).
   */
  private exclusiveMemberMove(
    model: AnyModel,
    data: Input,
    count: number
  ): Error | undefined {
    if (count < 2) return undefined;
    for (const name of model["~"].relationNames) {
      const payload = data[name];
      if (payload === undefined) continue;
      const arm =
        model["~"].state.relations[name]!["~"].state.target.kind === "variants";
      for (const verb of ["connect", "connectOrCreate", "set"] as const) {
        const targets = record(payload)[verb];
        if (targets === undefined) continue;
        for (const target of entries(targets)) {
          const edge = this.context.schema.membership(
            model,
            name,
            arm ? (target.type as string) : undefined
          );
          const stored =
            edge.kind === "junction"
              ? edge.uniqueSide === "target" &&
                "that target's member-junction slot can belong to only one of them"
              : edge.owner === "target" &&
                "that membership is stored on the target row, which can belong to only one of them";
          if (!stored) continue;
          return new UnsupportedOperationError(
            `updateMany matched ${count} rows, so it cannot apply '${verb}' to relation '${name}': ${stored} — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call.`
          );
        }
      }
    }
    return undefined;
  }
  private async executeSeries(
    occurrence: CommandOccurrence<SeriesOccurrence>
  ): Promise<number> {
    const ctx = this.context;
    const prepared = this.attempt.series.get(occurrence);
    // The `captureSeries` command `requireSeriesCapture` placed ahead of this
    // series ran in this same attempt (`run`'s `case "captureSeries"`), and a
    // recovery replaces the attempt AND the command tree together.
    assertInvariant(prepared, "this series was captured in this attempt");
    const { members, parentRequirement } = prepared;
    for (const child of members) {
      const command = child.command;
      const located = command.located;
      // Every member `captureSeries` built names the row it captured: a
      // `Deletion` carries its `located` by type, and an update member is
      // `Commands.update(located, …)` on that same captured selection.
      assertInvariant(located, "a series member names its captured row");
      if (ctx.usesBatch) {
        this.attempt.rows.delete(located);
        try {
          await this.runSelection(located);
        } catch (error) {
          throw ctx.failure(error, "planning", command);
        }
      }
      await ctx.executeMember(async () => {
        if (ctx.usesBatch && parentRequirement)
          ctx.requirePresent(
            parentRequirement.query,
            parentRequirement.failure
          );
        await this.run(child);
      }, command);
    }
    return members.length;
  }
}

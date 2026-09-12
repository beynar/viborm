import { getAdapterInternals } from "@adapters/adapter-internals";
import {
  NestedWriteError,
  NotFoundError,
  UniqueConstraintError,
} from "@errors";
import type { Member } from "../shared/operation-context";
import type { Query } from "../shared/query";
import { record, type Arguments, type Input } from "../shared/schema";
import { storedFields, type Membership } from "../shared/storage";
import type { Assignments } from "./assignments";
import { CommandAttempt } from "./command-attempt";
import type {
  Choose,
  Command,
  Commands,
  RecordCommand,
  SelectedSeries,
  SelectedSeriesMember,
} from "./commands";
import { membershipFields, type Selection } from "./selection";

/** Interprets the prepared command tree through one replaceable execution attempt. */
export class CommandExecution {
  readonly context;
  private currentAttempt: CommandAttempt;
  private recovered = false;
  constructor(readonly commands: Commands) {
    this.context = commands.context;
    this.currentAttempt = new CommandAttempt(this.context.transportAttempt);
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
  private matchesSelectedConstraint(
    choice: Choose,
    error: UniqueConstraintError
  ): boolean {
    const key = choice.lookup.selector.uniqueKey;
    const selected = choice.lookup.selector.uniqueValues;
    if (!key || !selected) return false;
    if (
      !key.fields.every((field) => {
        const proposed = choice.missing!.fields.known(field);
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
    const rejection = this.context.recoveryRejection(error);
    const choice =
      rejection?.kind === "insert"
        ? this.attempt.missingChoices.get(rejection.producer)
        : undefined;
    const conditional = this.attempt.conditionalSkips.get(error);
    if (!this.recovered && conditional && rejection?.kind === "assertion") {
      const replacement = new CommandAttempt();
      this.recovered = true;
      this.currentAttempt = replacement;
      this.context.restartRejectedInsert(replacement.transport);
      return true;
    }
    if (
      this.recovered ||
      !choice ||
      !(error instanceof UniqueConstraintError) ||
      !this.matchesSelectedConstraint(choice, error)
    )
      return false;
    const replacement = new CommandAttempt();
    this.recovered = true;
    this.currentAttempt = replacement;
    this.context.restartRejectedInsert(replacement.transport);
    // A lost winner is not permission to attempt the missing INSERT again.
    await this.run(choice.lookup);
    return this.attempt.rows.has(choice.lookup);
  }
  async complete(
    root: RecordCommand | Choose,
    args: Arguments
  ): Promise<unknown> {
    while (true) {
      try {
        await this.run(root);
        return (
          await this.context.finish(
            this.context.queries.select(
              root.model,
              {
                select: args.select,
                include: args.include,
                omit: args.omit,
              },
              undefined,
              { identity: this.identity(root.fields) },
            )
          )
        )[0];
      } catch (error) {
        if (!(await this.recover(error))) throw error;
      }
    }
  }
  async run(command: Command, member: Member = command): Promise<void> {
    const ctx = this.context;
    const attempt = this.attempt;
    switch (command.kind) {
      case "record": {
        command.fields.activate();
        if (command.refusal) throw command.refusal;
        if (command.located && !attempt.rows.has(command.located))
          await this.run(command.located, member);
        if (
          ctx.usesBatch &&
          command.located &&
          !command.located.retained &&
          !attempt.retained.has(command.located)
        ) {
          ctx.requirePresent(
            command.located.captured(
              undefined,
              command.requirement?.membership ?? command.located.membership(),
              1
            ),
            command.requirement?.failure ??
              command.located.required ??
              new NotFoundError(command.model["~"].names.ts!, "update")
          );
        }
        await this.requireTransitions(command);
        for (const child of command.before) await this.run(child, member);
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
                command.fields
              )
        );
        for (const child of command.after) await this.run(child, member);
        return;
      }
      case "lookup": {
        if (attempt.rows.has(command)) return;
        const source = command.source;
        if (
          source.kind === "producer" &&
          !ctx.usesBatch &&
          command.facts.fields.size === 0
        ) {
          const row = attempt.select(source.producer, command.fields.demands);
          attempt.rows.set(command, row);
          attempt.bind(command.fields, row);
          return;
        }
        const rows = await ctx.read(command.query(), true);
        const found = rows[0];
        if (!found) {
          if (command.required) throw command.required;
          return;
        }
        attempt.rows.set(command, found);
        attempt.bind(command.fields, found);
        if (ctx.usesBatch && command.retained)
          ctx.requirePresent(command.captured(), command.retained);
        return;
      }
      case "junction": {
        if (attempt.junctions.has(command)) return;
        if (attempt.rows.has(command.address)) {
          const captured = await ctx.captureMembership(
            command.edge,
            attempt.resolve(command.values)
          );
          if (captured) attempt.junctions.set(command, captured);
        }
        return;
      }
      case "absent": {
        const exclude = command.excluding.map(
          (fields) =>
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
          command.failure
        );
        return;
      }
      case "choose": {
        const supplied = command.lookup.source.kind === "producer";
        if (ctx.usesBatch && supplied) {
          ctx.beginSeries();
          try {
            const outputs = attempt.references();
            const rows = await ctx.flush(
              outputs.map(({ fields, values }) =>
                ctx.referenceProjection(fields.model, values)
              ),
              member
            );
            for (const [index, { fields }] of outputs.entries())
              attempt.materialize(fields, rows[index]![0]!);
          } catch (error) {
            throw ctx.failure(error, "prefix", member);
          }
        }
        try {
          await this.run(command.lookup, member);
          for (const condition of command.conditions?.probes ?? [])
            await this.run(condition.lookup, member);
        } catch (error) {
          throw supplied ? ctx.failure(error, "capture", member) : error;
        }
        const captured = attempt.rows.get(command.lookup);
        if (captured) {
          if (command.conditions?.probes.length) {
            command.foundRecord!.fields.activate();
            if (command.foundRecord!.refusal)
              throw command.foundRecord!.refusal;
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
          if (command.foundRequirement) {
            const requirement = command.foundRequirement;
            const rows = await ctx.read(
              requirement.selection.inspectMembership(requirement.membership),
              true
            );
            if (!rows[0]) throw requirement.failure;
          }
          if (command.foundRecord) {
            const found = command.foundRecord;
            if (ctx.usesBatch && supplied) {
              ctx.prepareMembers(() => [found], member);
              await ctx.executeMember(() => this.run(found), found);
            } else await this.run(found, member);
            attempt.bind(command.fields, {
              ...captured,
              ...attempt.select(found.fields, command.fields.demands),
            });
          } else attempt.bind(command.fields, captured);
        } else if (command.missing) {
          attempt.missingChoices.set(command.missing.fields, command);
          await this.run(command.missing, member);
          attempt.bind(
            command.fields,
            attempt.select(command.missing.fields, command.fields.demands)
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
        await this.run(command.located, member);
        await ctx.delete(
          command.located.model,
          attempt.rows.get(command.located)!,
          member
        );
        return;
      }
      case "captureSeries": {
        await this.captureSeries(command.series, member);
        return;
      }
      case "series": {
        if ("records" in command) {
          await this.records(command.records, command.select, member);
          return;
        }
        await this.executeSeries(command.series, member);
        return;
      }
    }
  }
  async records(
    records: RecordCommand[],
    select: Input | undefined,
    member: Member
  ): Promise<unknown> {
    const ctx = this.context;
    const members = ctx.prepareMembers(() => records, member);
    const identities: Input[] = [];
    let count = 0;
    for (const record of members) {
      const completed = record.suppression
        ? await ctx.executeSkippableMember(
            () => this.run(record),
            record.fields,
            record
          )
        : (await ctx.executeMember(() => this.run(record), record), true);
      if (!completed) continue;
      count++;
      if (select) identities.push(this.identity(record.fields));
    }
    if (!select) {
      await ctx.finish();
      return { count };
    }
    if (identities.length === 0) {
      await ctx.finish();
      return [];
    }
    return ctx.finish(
      ctx.queries.selectSeries(records[0]!.model, select, identities)
    );
  }
  async series(
    series: SelectedSeries,
    member: Member = series.selection
  ): Promise<number> {
    await this.captureSeries(series, member);
    return this.executeSeries(series, member);
  }
  private async captureSeries(
    series: SelectedSeries,
    member: Member
  ): Promise<void> {
    const ctx = this.context;
    const attempt = this.attempt;
    if (attempt.series.has(series)) return;
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
      ctx.beginSeries();
    }
    const keys = ctx.schema.keys(selection.model);
    const rows = await ctx.read(
      ctx.queries.select(
        selection.model,
        {
          orderBy: Object.fromEntries(keys.map((field) => [field, "asc"])),
        },
        membership && {
          edge: membership.edge,
          parent: this.membershipValues(membership.edge, membership.parent),
        },
        { forUpdate: !ctx.usesBatch, selector: selection.selector }
      ),
      true
    );
    const members: SelectedSeriesMember[] = ctx.prepareMembers(
      () =>
        rows.map((row): SelectedSeriesMember => {
          const located = this.commands.capture(selection, row);
          attempt.rows.set(located, row);
          attempt.bind(located.fields, row);
          if (series.mutation.kind === "delete") {
            if (!selection.origin)
              throw new Error("Selected delete series has no mutation origin");
            return {
              kind: "delete",
              located,
              origin: selection.origin,
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
          this.commands.analyze(child);
          if (child.refusal) throw child.refusal;
          return child;
        }),
      member
    );
    attempt.series.set(series, { members, parentRequirement });
  }
  private async executeSeries(
    series: SelectedSeries,
    member: Member
  ): Promise<number> {
    const ctx = this.context;
    const prepared = this.attempt.series.get(series);
    if (!prepared) throw new Error("Selected series was not captured");
    const { members, parentRequirement } = prepared;
    for (const child of members) {
      const located = child.located;
      if (!located) throw new Error("Selected update series has no location");
      if (ctx.usesBatch) {
        this.attempt.rows.delete(located);
        try {
          await this.run(located, child);
        } catch (error) {
          throw ctx.failure(error, "planning", child);
        }
      }
      await ctx.executeMember(async () => {
        if (ctx.usesBatch && parentRequirement)
          ctx.requirePresent(
            parentRequirement.query,
            parentRequirement.failure
          );
        await this.run(child);
      }, child);
    }
    return members.length;
  }
}

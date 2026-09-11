import { NestedWriteError } from "@errors";
import type { AnyModel } from "@schema/model";
import { OperationContext } from "../shared/operation-context";
import { type Arguments, entries, type Input, record } from "../shared/schema";
import { bindMembership, type Membership } from "../shared/storage";

const mutationOrder: readonly string[] = [
  "create",
  "connectOrCreate",
  "set",
  "updateMany",
];

type Expression =
  | { kind: "literal"; value: unknown }
  | { kind: "field"; producer: number; field: string };
type Projection = Record<string, Expression>;
interface Block {
  nodes: Node[];
  output: number;
}
type Node = { id: number } & (
  | { kind: "bind"; row: Input }
  | {
      kind: "insert";
      model: AnyModel;
      values: Projection;
      origin?: { relation: string; operation: "connectOrCreate" };
    }
  | { kind: "update"; model: AnyModel; where: Input; values: Input }
  | {
      kind: "scan";
      model: AnyModel;
      where?: Input;
      intent?: { relation: string; operation: "set" };
    }
  | { kind: "choice"; read: number; missing: Block; found?: Block }
  | { kind: "link"; edge: Membership; source: number; target: number }
  | { kind: "clear"; edge: Membership; source: number }
  | {
      kind: "series";
      edge: Membership;
      source: number;
      after: number;
      where?: Input;
      raw: Input;
    }
);
interface Analysis {
  order: Map<Block, Node[]>;
  demands: Map<number, Set<string>>;
}

/** A scoped dataflow program: references stay symbolic until a separate analysis. */
export class Program {
  private nextId = 0;
  constructor(readonly context: OperationContext) {}
  private id(): number {
    return this.nextId++;
  }
  private literal(value: unknown): Expression {
    return { kind: "literal", value };
  }
  private field(producer: number, field: string): Expression {
    return { kind: "field", producer, field };
  }
  create(
    model: AnyModel,
    admitted: Input,
    injected: Projection = {},
    origin?: { relation: string; operation: "connectOrCreate" }
  ): Block {
    const block: Block = { nodes: [], output: this.id() };
    const values: Projection = {
      ...Object.fromEntries(
        Object.entries(this.context.schema.scalars(model, admitted)).map(
          ([field, value]) => [field, this.literal(value)]
        )
      ),
      ...injected,
    };
    block.nodes.push({
      id: block.output,
      kind: "insert",
      model,
      values,
      origin,
    });
    this.expandRelations(
      block,
      block.output,
      model,
      admitted,
      admitted,
      block.output,
      values
    );
    return block;
  }
  update(model: AnyModel, where: Input, admitted: Input, raw: Input): Block {
    const values = this.context.schema.scalars(model, admitted);
    const source = this.id();
    const effect = this.id();
    const block: Block = {
      nodes: [
        { id: source, kind: "bind", row: { ...where, ...values } },
        { id: effect, kind: "update", model, where, values },
      ],
      output: source,
    };
    this.expandRelations(block, source, model, admitted, raw, effect);
    return block;
  }
  private expandRelations(
    block: Block,
    source: number,
    model: AnyModel,
    admitted: Input,
    raw: Input,
    preceding: number,
    sourceValues?: Projection
  ): void {
    for (const name of model["~"].relationNames) {
      if (admitted[name] === undefined) continue;
      const edge = bindMembership(this.context.schema, model, name);
      const mutation = record(admitted[name]);
      for (const [verb, payload] of Object.entries(mutation).sort(
        ([left], [right]) =>
          mutationOrder.indexOf(left) - mutationOrder.indexOf(right)
      )) {
        if (payload === undefined) continue;
        switch (verb) {
          case "create":
            for (const created of entries(payload))
              this.expandSupply(
                block,
                edge,
                source,
                created,
                undefined,
                sourceValues
              );
            break;
          case "connectOrCreate":
            for (const conditional of entries(payload))
              this.expandSupply(
                block,
                edge,
                source,
                record(conditional.create),
                record(conditional.where),
                sourceValues
              );
            break;
          case "set":
            block.nodes.push({ id: this.id(), kind: "clear", edge, source });
            for (const where of entries(payload)) {
              const read = this.id();
              block.nodes.push(
                {
                  id: read,
                  kind: "scan",
                  model: edge.target,
                  where,
                  intent: { relation: name, operation: "set" },
                },
                { id: this.id(), kind: "link", edge, source, target: read }
              );
            }
            break;
          case "updateMany": {
            const rawMembers = entries(record(raw[name]).updateMany);
            for (const [index, entry] of entries(payload).entries())
              block.nodes.push({
                id: this.id(),
                kind: "series",
                edge,
                source,
                after: preceding,
                where: entry.where as Input | undefined,
                raw: record(rawMembers[index]!.data),
              });
            break;
          }
          default:
            throw new Error(
              `Raptor 3 G1 relation operation is not implemented: ${verb}`
            );
        }
      }
    }
  }
  private expandSupply(
    block: Block,
    edge: Membership,
    source: number,
    admitted: Input,
    where: Input | undefined,
    sourceValues: Projection | undefined
  ): void {
    const injected: Projection = {};
    if (edge.kind === "reference" && edge.owner === "target") {
      for (const pair of edge.pairs)
        injected[pair.target] = this.field(source, pair.source);
    }
    const child = this.create(
      edge.target,
      admitted,
      injected,
      where ? { relation: edge.name, operation: "connectOrCreate" } : undefined
    );
    let target = child.output;
    if (where) {
      const read = this.id();
      target = this.id();
      const found =
        edge.kind === "reference" && edge.owner === "target"
          ? {
              nodes: [
                {
                  id: this.id(),
                  kind: "link",
                  edge,
                  source,
                  target: read,
                } satisfies Node,
              ],
              output: read,
            }
          : undefined;
      block.nodes.push(
        { id: read, kind: "scan", model: edge.target, where },
        { id: target, kind: "choice", read, missing: child, found }
      );
    } else block.nodes.push(...child.nodes);
    if (edge.kind === "reference" && edge.owner === "source") {
      if (!sourceValues)
        throw new Error(
          "Raptor 3 G1 source-held update supply is not implemented"
        );
      for (const pair of edge.pairs)
        sourceValues[pair.source] = this.field(target, pair.target);
    }
    if (edge.kind === "junction")
      block.nodes.push({ id: this.id(), kind: "link", edge, source, target });
  }
  analyze(root: Block, outputFields: readonly string[] = []): Analysis {
    const demands = new Map<number, Set<string>>();
    const dependencies = new Map<number, Set<number>>();
    const nodes = new Map<number, Node>();
    const demand = (producer: number, field: string) => {
      let fields = demands.get(producer);
      if (!fields) demands.set(producer, (fields = new Set()));
      fields.add(field);
    };
    const reference = (consumer: number, expression: Expression) => {
      if (expression.kind !== "field") return;
      dependencies.get(consumer)!.add(expression.producer);
      demand(expression.producer, expression.field);
    };
    const row = (
      consumer: number,
      producer: number,
      fields: readonly string[]
    ) => {
      dependencies.get(consumer)!.add(producer);
      for (const field of fields) demand(producer, field);
    };
    const collect = (block: Block): void => {
      for (const node of block.nodes) {
        nodes.set(node.id, node);
        dependencies.set(node.id, new Set());
        switch (node.kind) {
          case "insert":
            for (const value of Object.values(node.values))
              reference(node.id, value);
            break;
          case "choice":
            dependencies.get(node.id)!.add(node.read);
            collect(node.missing);
            if (node.found) collect(node.found);
            break;
          case "link": {
            const edge = node.edge;
            const sourceFields =
              edge.kind === "junction"
                ? edge.sourceSide.members.map((pair) => pair.referencedField)
                : [
                    ...this.context.schema.keys(edge.source),
                    ...edge.pairs.map((pair) => pair.source),
                  ];
            const targetFields =
              edge.kind === "junction"
                ? edge.targetSide.members.map((pair) => pair.referencedField)
                : [
                    ...this.context.schema.keys(edge.target),
                    ...edge.pairs.map((pair) => pair.target),
                  ];
            row(node.id, node.source, sourceFields);
            row(node.id, node.target, targetFields);
            break;
          }
          case "clear":
          case "series": {
            const edge = node.edge;
            row(
              node.id,
              node.source,
              edge.kind === "junction"
                ? edge.sourceSide.members.map((pair) => pair.referencedField)
                : edge.pairs.map((pair) => pair.source)
            );
            if (node.kind === "series")
              dependencies.get(node.id)!.add(node.after);
            break;
          }
        }
      }
    };
    collect(root);
    for (const field of outputFields) demand(root.output, field);
    // A choice's output is a scoped phi: demand each exact missing-arm output, not its selector.
    const propagate = (id: number, fields: ReadonlySet<string>): void => {
      const node = nodes.get(id);
      if (node?.kind !== "choice") return;
      for (const field of fields) demand(node.missing.output, field);
      propagate(node.missing.output, fields);
    };
    for (const [id, fields] of demands) propagate(id, fields);
    const order = new Map<Block, Node[]>();
    const schedule = (block: Block): Set<number> => {
      const local = new Set(block.nodes.map((node) => node.id));
      const external = new Set<number>();
      for (const node of block.nodes) {
        if (node.kind === "choice") {
          for (const id of schedule(node.missing))
            dependencies.get(node.id)!.add(id);
          if (node.found)
            for (const id of schedule(node.found))
              dependencies.get(node.id)!.add(id);
        }
        for (const id of dependencies.get(node.id)!)
          if (!local.has(id)) external.add(id);
      }
      const remaining = [...block.nodes];
      const complete = new Set<number>();
      const sorted: Node[] = [];
      while (remaining.length) {
        const index = remaining.findIndex((node) =>
          [...dependencies.get(node.id)!].every(
            (id) => !local.has(id) || complete.has(id)
          )
        );
        if (index < 0)
          throw new Error(
            "Raptor 3 program has a cyclic produced-field dependency"
          );
        const [node] = remaining.splice(index, 1);
        sorted.push(node!);
        complete.add(node!.id);
      }
      order.set(block, sorted);
      return external;
    };
    this.analyzeDecisions(root);
    schedule(root);
    return { order, demands };
  }
  private analyzeDecisions(block: Block): void {
    const writes: Extract<Node, { kind: "insert" }>[] = [];
    const collectWrites = (nested: Block): void => {
      for (const node of nested.nodes) {
        if (node.kind === "insert" && node.origin) writes.push(node);
        if (node.kind === "choice") collectWrites(node.missing);
      }
    };
    for (const node of block.nodes) {
      if (node.kind === "choice") {
        this.analyzeDecisions(node.missing);
        collectWrites(node.missing);
      }
      if (node.kind !== "scan" || !node.intent) continue;
      for (const write of writes) {
        if (write.model !== node.model) continue;
        const selector = node.where!;
        const fields = Object.keys(selector);
        const known = fields.filter(
          (field) =>
            write.values[field]?.kind === "literal" &&
            typeof selector[field] !== "object"
        );
        const literal = (field: string) =>
          (write.values[field] as Extract<Expression, { kind: "literal" }>)
            .value;
        if (known.some((field) => literal(field) !== selector[field])) continue;
        const overlap = known.length === fields.length ? "equal" : "unknown";
        throw new NestedWriteError(
          `Nested operation '${node.intent.operation}' on relation '${node.intent.relation}' depends on an earlier '${write.origin!.operation}' target write in the same nested write. Split these operations into separate queries.`,
          node.intent.relation,
          {
            meta: {
              operation: node.intent.operation,
              conflictsWith: write.origin!.operation,
              dependency: "targetExistence",
              overlap,
            },
          }
        );
      }
    }
  }
  async run(
    block: Block,
    analysis: Analysis,
    outputs = new Map<number, Input[]>(),
    member: object = block
  ): Promise<Input> {
    const ctx = this.context;
    const row = (id: number): Input => outputs.get(id)![0]!;
    const value = (expression: Expression): unknown =>
      expression.kind === "literal"
        ? expression.value
        : row(expression.producer)[expression.field];
    for (const node of analysis.order.get(block)!) {
      switch (node.kind) {
        case "bind":
          outputs.set(node.id, [node.row]);
          break;
        case "insert":
          outputs.set(node.id, [
            await ctx.insert(
              node.model,
              Object.fromEntries(
                Object.entries(node.values).map(([field, expression]) => [
                  field,
                  value(expression),
                ])
              ),
              analysis.demands.get(node.id) ?? new Set(),
              member
            ),
          ]);
          break;
        case "update":
          await ctx.update(node.model, node.where, node.values, member);
          break;
        case "scan":
          outputs.set(
            node.id,
            await ctx.read(
              ctx.queries.select(node.model, {
                where: node.where,
                select: Object.fromEntries(
                  node.model["~"].scalarFieldNames.map((field) => [field, true])
                ),
                take: 1,
              })
            )
          );
          break;
        case "choice": {
          const found = outputs.get(node.read)![0];
          if (found) {
            if (node.found)
              await this.run(node.found, analysis, outputs, member);
            outputs.set(node.id, [found]);
          } else
            outputs.set(node.id, [
              await this.run(node.missing, analysis, outputs, member),
            ]);
          break;
        }
        case "link":
          await ctx.associate(
            node.edge,
            row(node.source),
            row(node.target),
            member
          );
          break;
        case "clear":
          await ctx.clear(node.edge, row(node.source), member);
          break;
        case "series": {
          await ctx.flush();
          const keys = ctx.schema.keys(node.edge.target);
          const captured = await ctx.read(
            ctx.queries.select(
              node.edge.target,
              {
                where: node.where,
                select: Object.fromEntries(keys.map((field) => [field, true])),
                orderBy: Object.fromEntries(
                  keys.map((field) => [field, "asc"])
                ),
              },
              { edge: node.edge, parent: row(node.source) }
            )
          );
          const members = ctx.prepareMembers(() =>
            captured.map((capturedRow) => {
              const admitted = ctx.schema.member(
                node.edge.source,
                node.edge.name,
                node.raw
              );
              const member = this.update(
                node.edge.target,
                ctx.schema.identity(node.edge.target, capturedRow),
                admitted,
                node.raw
              );
              return { block: member, analysis: this.analyze(member) };
            })
          );
          for (const member of members)
            await ctx.executeMember(() =>
              this.run(member.block, member.analysis)
            );
        }
      }
    }
    return row(block.output);
  }
  async execute(
    model: AnyModel,
    args: Arguments,
    raw: Arguments
  ): Promise<unknown> {
    const ctx = this.context;
    if (ctx.operation === "create") {
      const block = this.create(model, args.data);
      const output = await this.run(
        block,
        this.analyze(block, ctx.schema.keys(model))
      );
      return (
        await ctx.finish(
          ctx.queries.select(model, {
            ...args,
            where: ctx.schema.identity(model, output),
          })
        )
      )[0];
    }
    if (ctx.operation === "update") {
      const block = this.update(model, args.where!, args.data, raw.data);
      await this.run(block, this.analyze(block));
      return (
        await ctx.finish(
          ctx.queries.select(model, { ...args, where: args.where })
        )
      )[0];
    }
    const keys = ctx.schema.keys(model);
    const captured = await ctx.read(
      ctx.queries.select(model, {
        where: args.where,
        select: Object.fromEntries(keys.map((field) => [field, true])),
        orderBy: Object.fromEntries(keys.map((field) => [field, "asc"])),
      })
    );
    const members = ctx.prepareMembers(() =>
      captured.map((capturedRow) => {
        const block = this.update(
          model,
          ctx.schema.identity(model, capturedRow),
          ctx.schema.update(model, raw.data, true),
          raw.data
        );
        return { block, analysis: this.analyze(block) };
      })
    );
    for (const member of members)
      await ctx.executeMember(() => this.run(member.block, member.analysis));
    await ctx.finish();
    return { count: captured.length };
  }
}

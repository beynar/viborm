import { Sql } from "@sql";
import type { Query } from "../shared/query";
import type { Input } from "../shared/schema";
import { TransportAttempt } from "../shared/transport-attempt";
import type { Assignments, FieldValue } from "./assignments";
import type {
  Choose,
  CommandOccurrence,
  Deletion,
  JunctionCapture,
  RecordCommand,
  Selection,
  SeriesOccurrence,
} from "./commands";

/** Database observations and field transports belonging to one command attempt. */
export class CommandAttempt {
  constructor(readonly transport = new TransportAttempt()) {}
  readonly rows = new Map<Selection, Input>();
  readonly retained = new Set<Selection>();
  readonly junctions = new Map<JunctionCapture, Input>();
  readonly missingChoices = new Map<object, Choose>();
  readonly conditionalSkips = new Map<unknown, Choose>();
  readonly series = new Map<
    CommandOccurrence<SeriesOccurrence>,
    {
      readonly members: CommandOccurrence<RecordCommand | Deletion>[];
      readonly parentRequirement?: {
        readonly query: Query;
        readonly failure: Error;
      };
    }
  >();
  private readonly bindings = new Map<Assignments, Input>();

  bind(fields: Assignments, values: Input): void {
    this.bindings.set(fields, values);
  }
  read(fields: Assignments, field: string): unknown {
    const bound = this.bindings.get(fields);
    if (bound && Object.hasOwn(bound, field)) return bound[field];
    const value = fields.contributions().get(field);
    return value
      ? this.resolveValue(value)
      : fields.captured && this.read(fields.captured, field);
  }
  private resolveValue(value: FieldValue): unknown {
    return value.kind === "literal"
      ? value.value
      : this.read(value.producer, value.field);
  }
  resolve(fields: Record<string, FieldValue>): Input {
    return Object.fromEntries(
      Object.entries(fields).map(([field, value]) => [
        field,
        this.resolveValue(value),
      ])
    );
  }
  values(fields: Assignments): Input {
    return Object.fromEntries(
      [...fields.contributions()].map(([field, value]) => [
        field,
        this.resolveValue(value),
      ])
    );
  }
  select(fields: Assignments, names: Iterable<string>): Input {
    return Object.fromEntries(
      [...names].map((field) => [field, this.read(fields, field)])
    );
  }
  references(): { fields: Assignments; values: Input }[] {
    const outputs: { fields: Assignments; values: Input }[] = [];
    for (const fields of this.bindings.keys()) {
      const values = Object.fromEntries(
        [...fields.demands]
          .map((field) => [field, this.read(fields, field)] as const)
          .filter(([, value]) => value instanceof Sql)
      );
      if (Object.keys(values).length) outputs.push({ fields, values });
    }
    return outputs;
  }
  materialize(fields: Assignments, values: Input): void {
    this.bind(fields, { ...this.bindings.get(fields), ...values });
  }
}

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
  /**
   * The runtime VALUE of one field: a bound row value, else what the payload
   * states. `stated` is the key-reconciliation reader — it resolves the update
   * envelope — while {@link values} submits the admitted payload verbatim, so
   * a referenced key crosses as `'u1'` and the row's own write still carries
   * `{ set: 'u1' }` to its one interpreter.
   */
  read(fields: Assignments, field: string): unknown {
    const bound = this.bindings.get(fields);
    // A value this operation PRODUCED is an expression inside the unit that
    // stored it and the literal that unit read back in every unit after it
    // (D-58, `TransportAttempt.carried`); one reader, so every statement,
    // premise and guard names the same value.
    if (bound && Object.hasOwn(bound, field))
      return this.transport.carried(bound[field]);
    const value = fields.stated(field);
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
  materialize(fields: Assignments, values: Input): void {
    this.bind(fields, { ...this.bindings.get(fields), ...values });
  }
}

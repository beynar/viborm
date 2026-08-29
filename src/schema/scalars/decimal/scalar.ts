import type { StandardSchemaOf } from "@standard-schema/spec";
import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";
import v from "@validation/primitives/v";
import type Decimal from "decimal.js";
import {
  createDefaultState,
  type DefaultValueInput,
  type ScalarState,
  updateState,
} from "../common";
import {
  normalizeDecimalDefault,
  readDecimalDescriptor,
  refuseDecimalListKey,
} from "./descriptor";

/**
 * The shared L1 descriptor supplies the two required keys. This intersection
 * makes that surface exact for held objects too, without declaring a second L2
 * precision/scale bag.
 */
type KeysOfUnion<Given> = Given extends unknown ? keyof Given : never;

type ExactDomain<Given> = Given &
  Record<Exclude<KeysOfUnion<Given>, keyof DecimalDescriptor>, never>;

/**
 * The type-level half of plan 2.1's list exclusion.
 *
 * A key position is refused by making the RECEIVER unassignable, which is what
 * lets the diagnostic carry the reason: TypeScript reports the missing property
 * by name, so `s.decimal({...}).array().id()` reads as "a fixed-decimal list
 * cannot be a key" rather than as an arity or an argument error. The scalar's
 * own type is intersected in, so inside the method body `this` is the scalar it
 * has always been and no assertion is needed to reach its state.
 *
 * `unknown` on the legal side is inert: intersecting it changes nothing, so a
 * non-list decimal keeps exactly the chain it had, and a scalar whose arity is
 * still the unresolved `boolean` is admitted — only a declared list is refused.
 */
interface DecimalListKeyRefusal {
  readonly "a fixed-decimal list cannot be a key": never;
}

type NotAList<State extends ScalarState<"decimal">> =
  State["array"] extends true ? DecimalListKeyRefusal : unknown;

type NotAKey<State extends ScalarState<"decimal">> = State["isId"] extends true
  ? DecimalListKeyRefusal
  : State["isUnique"] extends true
    ? DecimalListKeyRefusal
    : unknown;

type DecimalScalarState<State extends ScalarState<"decimal">> = State & {
  readonly decimal: DecimalDescriptor;
};

export class DecimalScalar<State extends ScalarState<"decimal">> {
  private readonly state: DecimalScalarState<State>;

  constructor(state: DecimalScalarState<State>) {
    this.state = state;
  }

  /** The frozen domain, carried by reference so identity survives a chain. */
  private get descriptor(): DecimalDescriptor {
    return this.state.decimal;
  }

  nullable() {
    return new DecimalScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        // The custom schema travels with the rebuilt base. `create` reads
        // `state.schema` directly, but `set`, `equals` and the field's own
        // value schema all read `state.base` — dropping it here would make one
        // field refine on create and not on update.
        base: v.decimal<{
          nullable: true;
          array: State["array"];
          decimal: DecimalDescriptor;
          schema: State["schema"];
        }>({
          nullable: true,
          array: this.state.array,
          decimal: this.descriptor,
          schema: this.state.schema,
        }),
      })
    );
  }

  array(this: DecimalScalar<State> & NotAKey<State>) {
    if (this.state.isId || this.state.isUnique) refuseDecimalListKey("array");
    const base = v.decimal<{
      nullable: State["nullable"];
      array: true;
      decimal: DecimalDescriptor;
      schema: State["schema"];
    }>({
      nullable: this.state.nullable,
      array: true,
      decimal: this.descriptor,
      schema: this.state.schema,
    });
    const state = updateState(this, { array: true, base });
    if (this.state.hasDefault && typeof this.state.default !== "function") {
      Object.defineProperty(state, "default", {
        value: normalizeDecimalDefault(this.state.default, base, true),
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    return new DecimalScalar(state);
  }

  id(this: DecimalScalar<State> & NotAList<State>) {
    if (this.state.array) refuseDecimalListKey("id");
    return new DecimalScalar(updateState(this, { isId: true, isUnique: true }));
  }

  unique(this: DecimalScalar<State> & NotAList<State>) {
    if (this.state.array) refuseDecimalListKey("unique");
    return new DecimalScalar(updateState(this, { isUnique: true }));
  }

  /**
   * A literal default is normalized through the field codec HERE, at
   * definition time, so model metadata retains the canonical logical value and
   * a schema document round-trips to the same declaration. A value outside the
   * declared domain fails at the call that wrote it, not at the first write.
   */
  default<V extends DefaultValueInput<State>>(value: V) {
    return withValidatedDecimalDefault(
      this,
      normalizeDecimalDefault(value, this.state.base, this.state.array)
    );
  }

  /**
   * Refine or brand the exact value. The schema observes a `Decimal` — the
   * public value type — and the declared domain validates whatever it returns
   * LAST, so a custom schema can narrow the domain but never escape it, and it
   * cannot change the value family the field reads back as.
   */
  schema<S extends StandardSchemaOf<Decimal>>(schema: S) {
    const base = v.decimal<{
      nullable: State["nullable"];
      array: State["array"];
      decimal: DecimalDescriptor;
      schema: S;
    }>({
      nullable: this.state.nullable,
      array: this.state.array,
      decimal: this.descriptor,
      schema,
    });
    const state = updateState(this, { schema, base });
    if (this.state.hasDefault && typeof this.state.default !== "function") {
      Object.defineProperty(state, "default", {
        value: normalizeDecimalDefault(
          this.state.default,
          base,
          this.state.array
        ),
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    return new DecimalScalar(state);
  }

  map(columnName: string) {
    return new DecimalScalar(updateState(this, { columnName }));
  }

  get ["~"](): {
    state: DecimalScalarState<State>;
    nativeType?: undefined;
  } {
    // A fixed decimal has no native-type override: PostgreSQL's `NUMERIC(p,s)`,
    // MySQL's `DECIMAL(p,s)` and SQLite's checked scaled `INTEGER` are all
    // DERIVED from the declared domain, and a second spelling beside it would
    // be a second answer to what the column is. The absence is DECLARED so the
    // scalar union keeps one internal shape for every reader.
    return { state: this.state };
  }
}

/**
 * Store the canonical verdict of the field's current base schema.
 *
 * This is an internal schema-document seam, deliberately absent from the
 * public decimal barrel. The document interpreter already has to validate a
 * decoded default to own its J008 diagnostic; feeding that verdict back
 * through `.default()` would run the same field codec a second time.
 */
export function withValidatedDecimalDefault<
  State extends ScalarState<"decimal">,
>(scalar: DecimalScalar<State>, value: unknown) {
  return new DecimalScalar(
    updateState(scalar, {
      hasDefault: true,
      default: value,
      optional: true,
    })
  );
}

/**
 * The one public decimal factory.
 *
 * `precision` is the maximum total digit count and `scale` the maximum
 * fractional digit count; values are multiples of `10^-scale`, and an input
 * that does not fit is refused rather than silently rounded. There is no
 * zero-argument form, no native-type override, and no second "fixed decimal"
 * factory: portable exact decimal arithmetic needs these two numbers, and
 * SQLite cannot supply them from storage, so they are declared once here.
 */
export const buildDecimalScalar = (descriptor: unknown) => {
  const domain = readDecimalDescriptor(descriptor);
  return new DecimalScalar({
    ...createDefaultState(
      "decimal",
      v.decimal<{ decimal: DecimalDescriptor }>({ decimal: domain })
    ),
    decimal: domain,
  });
};

/** The exact public argument surface over the hostile construction boundary. */
export const decimal = <const D>(
  descriptor: D & NoInfer<DecimalDescriptor & ExactDomain<D>>
) => buildDecimalScalar(descriptor);

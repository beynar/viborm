import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";
import type { Decimal } from "@validation/primitives/decimal-value";
import v from "@validation/primitives/v";
import type { VibSchema } from "@validation/types";
import {
  createDefaultState,
  type DefaultValueInput,
  type ScalarState,
  type UpdateState,
  untypedKeyedScalarChain,
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

export class DecimalScalar<
  out State extends ScalarState<"decimal">,
> extends untypedKeyedScalarChain<DecimalScalarState<State>> {
  private declare readonly state: DecimalScalarState<State>;

  protected rebase(state: DecimalScalarState<State>): VibSchema {
    return v.decimal({
      nullable: state.nullable,
      array: state.array,
      decimal: state.decimal,
      schema: state.schema,
    });
  }

  /**
   * A literal default follows the base it was normalized through: a modifier
   * that rebuilds the base normalizes the default again, through the new one.
   */
  private again<Next extends { "~": { state: ScalarState } }>(next: Next) {
    if (this.state.hasDefault && typeof this.state.default !== "function") {
      next["~"].state.default = normalizeDecimalDefault(
        this.state.default,
        next["~"].state.base
      );
    }
    return next;
  }

  override nullable() {
    return super.nullable() as DecimalScalar<
      UpdateState<
        this["~"]["state"],
        {
          readonly nullable: true;
          readonly hasDefault: true;
          readonly default: State["hasDefault"] extends false
            ? null
            : State["default"];
          readonly optional: true;
          readonly base: ReturnType<
            typeof v.decimal<{
              nullable: true;
              array: State["array"];
              decimal: DecimalDescriptor;
              schema: State["schema"];
            }>
          >;
        }
      >
    >;
  }

  override array(this: DecimalScalar<State> & NotAKey<State>) {
    if (this.state.isId || this.state.isUnique) refuseDecimalListKey("array");
    return this.again(
      super.array() as DecimalScalar<
        UpdateState<
          DecimalScalarState<State>,
          {
            readonly array: true;
            readonly base: ReturnType<
              typeof v.decimal<{
                nullable: State["nullable"];
                array: true;
                decimal: DecimalDescriptor;
                schema: State["schema"];
              }>
            >;
          }
        >
      >
    );
  }

  override id(this: DecimalScalar<State> & NotAList<State>) {
    if (this.state.array) refuseDecimalListKey("id");
    return super.id() as DecimalScalar<
      UpdateState<
        DecimalScalarState<State>,
        { readonly isId: true; readonly isUnique: true }
      >
    >;
  }

  override unique(this: DecimalScalar<State> & NotAList<State>) {
    if (this.state.array) refuseDecimalListKey("unique");
    return super.unique() as DecimalScalar<
      UpdateState<DecimalScalarState<State>, { readonly isUnique: true }>
    >;
  }

  /**
   * A literal default is normalized through the field codec HERE, at
   * definition time, so model metadata retains the canonical logical value and
   * a schema document round-trips to the same declaration. A value outside the
   * declared domain fails at the call that wrote it, not at the first write.
   */
  override default<V extends DefaultValueInput<State>>(value: V) {
    return withValidatedDecimalDefault(
      this,
      normalizeDecimalDefault(value, this.state.base)
    );
  }

  /**
   * Refine or brand the exact value. The schema observes a `Decimal` — the
   * public value type — and the declared domain validates whatever it returns
   * LAST, so a custom schema can narrow the domain but never escape it, and it
   * cannot change the value family the field reads back as.
   */
  override schema<S extends StandardSchemaV1<Decimal>>(schema: S) {
    return this.again(
      super.schema(schema) as DecimalScalar<
        UpdateState<
          this["~"]["state"],
          {
            readonly schema: S;
            readonly base: ReturnType<
              typeof v.decimal<{
                nullable: State["nullable"];
                array: State["array"];
                decimal: DecimalDescriptor;
                schema: S;
              }>
            >;
          }
        >
      >
    );
  }

  override map(columnName: string) {
    return super.map(columnName) as DecimalScalar<
      UpdateState<this["~"]["state"], { readonly columnName: string }>
    >;
  }

  get ["~"](): {
    state: DecimalScalarState<State>;
    nativeType?: undefined;
  } {
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

/** The exact public argument surface over the untyped construction seam. */
export const decimal = <const D>(
  descriptor: D & NoInfer<DecimalDescriptor & ExactDomain<D>>
) => buildDecimalScalar(descriptor);

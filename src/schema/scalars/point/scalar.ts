import { ValidationError } from "@errors";
import type { GeoPoint } from "@validation/primitives/geo-point-codec";
import { validateSchema } from "@validation/primitives/helpers";
import type { PointSchema } from "@validation/primitives/point";
import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  type ScalarState,
  scalarChain,
  type UpdateState,
  updateState,
} from "../common";

const pointBase = v.point();

export class PointScalar<
  State extends ScalarState<"point">,
> extends scalarChain<State> {
  private declare readonly state: State;
  declare readonly nullable: () => PointScalar<
    UpdateState<
      State,
      {
        readonly nullable: true;
        readonly hasDefault: true;
        readonly default: State["hasDefault"] extends true
          ? State["default"]
          : null;
        readonly optional: true;
        readonly base: PointSchema<GeoPoint | null, GeoPoint | null>;
      }
    >
  >;
  declare readonly map: (columnName: string) => PointScalar<
    UpdateState<
      State,
      {
        readonly columnName: string;
      }
    >
  >;

  protected rebase(state: State) {
    return v.point({
      nullable: state.nullable,
    });
  }

  // biome-ignore lint/complexity/noUselessConstructor: a point has no native type, so its constructor takes none
  constructor(state: State) {
    super(state);
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new PointScalar(
      updateState(this, {
        hasDefault: true,
        default: normalizePointDefault(value, this.state.base),
        optional: true,
      })
    );
  }

  get ["~"](): { state: State; nativeType?: undefined } {
    return { state: this.state };
  }
}

function normalizePointDefault(value: unknown, schema: StateSchema): unknown {
  if (typeof value === "function") return value;
  const result = validateSchema(schema, value);
  if (!result.issues) return result.value;
  throw new ValidationError(
    { kind: "schema-builder", builder: "s.point", path: "default" },
    result.issues.map((issue) => ({
      path: issue.path?.join(".") ?? "default",
      message: issue.message,
    }))
  );
}

type StateSchema = ScalarState<"point">["base"];

/** The one public GeoPoint scalar factory; EPSG:4326 is not configurable. */
export function point(...args: []) {
  if (args.length !== 0) {
    throw new ValidationError(
      { kind: "schema-builder", builder: "s.point", path: "arguments" },
      [
        {
          path: "arguments",
          message: "s.point() takes no native type or options",
        },
      ]
    );
  }
  return new PointScalar(createDefaultState("point", pointBase));
}

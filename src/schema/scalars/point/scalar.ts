import { ValidationError } from "@errors";
import { validateSchema } from "@validation/primitives/helpers";
import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  type ScalarState,
  updateState,
} from "../common";

const pointBase = v.point();

export class PointScalar<State extends ScalarState<"point">> {
  private readonly state: State;
  constructor(state: State) {
    this.state = state;
  }

  nullable() {
    return new PointScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.point<{
          nullable: true;
        }>({
          nullable: true,
        }),
      })
    );
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

  map(columnName: string) {
    return new PointScalar(updateState(this, { columnName }));
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

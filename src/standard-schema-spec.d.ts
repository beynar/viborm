import type { StandardSchemaV1 } from "@standard-schema/spec";

declare module "@standard-schema/spec" {
  export type StandardSchemaOf<
    Input = unknown,
    Output = Input,
  > = StandardSchemaV1<Input, Output>;
}

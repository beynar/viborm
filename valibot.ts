import {
  lazy,
  object,
  string,
  number,
  InferInput,
  AnySchema,
  LazySchema,
  StringSchema,
  ObjectSchema,
  NumberSchema,
} from "valibot";
import { type } from "arktype";
const model1 = object({
  name: string(),
  age: number(),
  friend: lazy(() => model2),
});

const model2 = lazy(() => {
  return object({
    name: string(),
    age: number(),
    friend: lazy(() => model1),
  });
});

const model1Type = type({
  name: "string",
  age: "number",
  friend: () => model2Type,
});

const model2Type = type({
  name: "string",
  age: "number",
  friend: () => model1Type,
});

type Model1SchemaInput = InferInput<typeof model1>;

type Model1Schema = ObjectSchema<
  {
    name: StringSchema<undefined>;
    age: NumberSchema<undefined>;
    friend: LazySchema<Model2Schema>;
  },
  undefined
>;

type Model2Schema = ObjectSchema<
  {
    name: StringSchema<undefined>;
    age: NumberSchema<undefined>;
    // friend: LazySchema<Model1Schema>;
  },
  undefined
>;
type M1 = {
  name: string;
  age: number;
  friend: M2;
};

type M2 = {
  name: string;
  age: number;
  friend: M1;
};

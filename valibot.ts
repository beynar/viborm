import { lazy, object, string, number } from "valibot";
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
    friend: model1,
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

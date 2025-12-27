import { StandardSchemaV1 } from "@standard-schema/spec";
import { v, safeParse, Prettify, object, string } from "./src/validation";

const user = v.object(
  {
    name: () => v.string(),
    age: v.number(),
    friends: v.string({ array: true }),
    nested: v.object({
      name: v.string(),
      age: () => v.number(),
      nested: v.object({
        name: v.string(),
        friends: () => user,
        age: () => {
          console.log("computed");
          return v.number();
        },
      }),
    }),
  }
  // { partial: true, strict: false }
);

type Output = Prettify<StandardSchemaV1.InferOutput<typeof user>>;
type Input = Prettify<StandardSchemaV1.InferInput<typeof user>>;

const x: Input = {
  age: 20,
  nested: {
    age: 23,
    nested: {
      age: 24,
    },
  },
};
type Result = StandardSchemaV1.Result<Output>;
// const result = safeParse(user, {
//   name: "John",
//   age: 30,
//   friends: ["Jane", "Doe"],
// });

// if(result.issues){
//   console.log("Issues:", result.issues);
// } else {
//   console.log("Success:", result.value);
// }

const result = await user.parse({
  name: "John",
  age: 30,
  nested: {
    name: "Jane",
    age: 20,
    // nested: {
    //   age: 24,
    // },
  },
});

if (result.issues) {
  console.log("Issues:", result.issues);
} else {
  type Result = Prettify<typeof result>;
  console.log("Success:", result.value);
}

const selfReference = object(
  {
    self: () => selfReference,
    string: string(),
  },
  {
    partial: false,
  }
);

type I = Prettify<StandardSchemaV1.InferInput<typeof selfReference>>["self"];

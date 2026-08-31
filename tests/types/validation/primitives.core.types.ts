import { type InferInput, type InferOutput, v } from "@src/validation";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const personSchema = v.object({
  name: v.string(),
  age: v.number({ optional: true }),
});

type PersonInput = InferInput<typeof personSchema>;

const acceptedPerson: PersonInput = { name: "Ada" };

// @ts-expect-error - an unknown key beside a real key must be refused
const refusedPerson: PersonInput = { name: "Ada", nmae: "typo" };

void acceptedPerson;
void refusedPerson;

const withoutName = v.omit(personSchema, ["name"] as const);
type PersonWithoutName = InferOutput<typeof withoutName>;
type _omittedOutputDropsTheKey = Expect<
  Equal<Extract<"name", keyof PersonWithoutName>, never>
>;
type _omittedOutputKeepsOtherKeys = Expect<
  Equal<Extract<"age", keyof PersonWithoutName>, "age">
>;

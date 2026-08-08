import { type InferInput, v } from "@src/validation";

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

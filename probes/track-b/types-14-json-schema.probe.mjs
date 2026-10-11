// types-14: the exported JSON Schema agrees with the validator. Bigint is an
// integer-pattern string, a decimal carries its scale, and string id formats
// carry patterns; a payload the JSON Schema accepts is one the validator
// accepts, and the other way round.
//
// No JSON Schema library is installed in the probe consumer, so a minimal
// draft 2020-12 evaluator below covers the keywords the export emits (type,
// pattern, enum, const, anyOf/oneOf/allOf, min/max, properties, required,
// additionalProperties, items, $ref). Like Ajv without ajv-formats, it ignores
// `format`: the plan asks for patterns.
//
// Pinned in 1.2.0 (owner decision 2026-10-10): the bigint VALIDATOR admits
// integer strings, so bigint parity is a gate; the all-issues mode is
// `parse(schema, value, { allIssues: true })`, also a gate.
import { getSchemas, s } from "viborm";
import { parse, toJsonSchema } from "viborm/validation";

export const meta = {
  id: "types-14",
  title:
    "JSON Schema export: bigint integer-pattern string, decimal scale, id-format patterns",
  plan: "track-b/types-14",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/evidence/types/probes/p07-jsonschema-parity.ts, p07b-multi-issue.ts; src/validation/json-schema/converters.ts:255-280,332-335",
};

const account = s.model({
  id: s.string().id().ulid(),
  externalId: s.string().uuid(),
  traceId: s.string().uuidv7(),
  publicId: s.string().nanoid(),
  slug: s.string().cuid(),
  eventId: s.string().ksuid(),
  ownerRef: s.string().ulid("user"),
  email: s.string().unique(),
  name: s.string().nullable(),
  balance: s.decimal({ precision: 10, scale: 2 }),
  ledgerTotal: s.bigInt().default(0n),
  tier: s.enum(["free", "pro", "enterprise"]).default("free"),
  settings: s.json().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});

const base = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  externalId: "550e8400-e29b-41d4-a716-446655440000",
  traceId: "0199c4e2-79b0-7f3a-8c21-9f2d6b4a1e08",
  publicId: "V1StGXR8_Z5jdHi6B-myT",
  slug: "ajenr87qeqg87w8vjc7xiaie",
  eventId: "0ujtsYcgvSTl8PAuAdqWYSMnLOv",
  ownerRef: "user-01ARZ3NDEKTSV4RRFFQ69G5FAV",
  email: "a@example.com",
  balance: "12.50",
};

// [field, value]; `ledgerTotal` is checked separately.
const SAMPLES = [
  ["balance", "1.555"],
  ["balance", "1.5"],
  ["balance", "1.500"],
  ["balance", "-0.01"],
  ["balance", "12345678.9"],
  ["id", "nope"],
  ["id", "01ARZ3NDEKTSV4RRFFQ69G5FA"],
  ["externalId", "nope"],
  ["externalId", "550e8400e29b41d4a716446655440000"],
  ["traceId", "550e8400-e29b-41d4-a716-446655440000"],
  ["traceId", "nope"],
  ["publicId", "V1StGXR8_Z5jdHi6B-my"],
  ["publicId", "nope nope nope nope n"],
  ["slug", "Not-A-Cuid!"],
  ["eventId", "nope"],
  ["ownerRef", "01ARZ3NDEKTSV4RRFFQ69G5FAV"],
  ["ownerRef", "user-nope"],
];
const BIGINT_SAMPLES = ["12345678901234567890", "-42", "1.5", "x", 1];
const INTEGER_STRINGS = ["0", "-42", "12345678901234567890"];
const NON_INTEGER_STRINGS = ["1.5", "x", "", "1e3"];
// ------------------------------------------------- minimal evaluator

const LOCAL_REF = /^#\//;

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function accepts(schema, value, root) {
  if (schema === true || schema === undefined) return true;
  if (schema === false) return false;
  if (schema.$ref) {
    const path = schema.$ref.replace(LOCAL_REF, "").split("/");
    return accepts(
      path.reduce((node, key) => node?.[key], root),
      value,
      root
    );
  }
  if (schema.type !== undefined) {
    const types = [schema.type].flat();
    const actual = typeOf(value);
    const ok = types.some(
      (type) => type === actual || (type === "number" && actual === "integer")
    );
    if (!ok) return false;
  }
  if (
    schema.const !== undefined &&
    JSON.stringify(schema.const) !== JSON.stringify(value)
  )
    return false;
  if (
    schema.enum &&
    !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
  )
    return false;
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value))
      return false;
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength)
      return false;
    if (schema.maxLength !== undefined && length > schema.maxLength)
      return false;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (schema.anyOf && !schema.anyOf.some((arm) => accepts(arm, value, root)))
    return false;
  if (
    schema.oneOf &&
    schema.oneOf.filter((arm) => accepts(arm, value, root)).length !== 1
  )
    return false;
  if (schema.allOf && !schema.allOf.every((arm) => accepts(arm, value, root)))
    return false;
  if (
    Array.isArray(value) &&
    schema.items !== undefined &&
    !value.every((item) => accepts(schema.items, item, root))
  )
    return false;
  if (typeOf(value) === "object") {
    const properties = schema.properties ?? {};
    if ((schema.required ?? []).some((key) => !(key in value))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) {
        if (!accepts(properties[key], item, root)) return false;
      } else if (
        schema.additionalProperties !== undefined &&
        !accepts(schema.additionalProperties, item, root)
      ) {
        return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------- probe

export default async function probe() {
  const create = getSchemas({ account }).account.core.create;
  const json = toJsonSchema(create, "draft-2020-12");
  const validator = (payload) => !create["~standard"].validate(payload).issues;
  const schemaAccepts = (payload) => accepts(json, payload, json);
  const problems = [];
  const facts = [];

  if (!(validator(base) && schemaAccepts(base))) {
    throw new Error(
      `base payload: validator=${validator(base)} jsonschema=${schemaAccepts(base)}`
    );
  }

  // Bigint: an integer-pattern string.
  const bigint = json.properties?.ledgerTotal ?? {};
  const bigintAcceptsInts = INTEGER_STRINGS.every((value) =>
    accepts(bigint, value, json)
  );
  const bigintRejectsOthers = NON_INTEGER_STRINGS.every(
    (value) => !accepts(bigint, value, json)
  );
  if (!(bigintAcceptsInts && bigintRejectsOthers)) {
    problems.push(
      `bigint exported as ${JSON.stringify(bigint)}: integer strings ${bigintAcceptsInts ? "accepted" : "refused"}, non-integer strings ${bigintRejectsOthers ? "refused" : "accepted"}`
    );
  }
  // The validator takes exactly what the export allows.
  const bigintParity = BIGINT_SAMPLES.map((value) => {
    const payload = { ...base, ledgerTotal: value };
    const v = validator(payload);
    const j = schemaAccepts(payload);
    if (v !== j)
      problems.push(
        `bigint ${JSON.stringify(value)} ${v ? "v+" : "v-"}${j ? "s+" : "s-"}`
      );
    return `${JSON.stringify(value)}:${v ? "v+" : "v-"}${j ? "s+" : "s-"}`;
  });
  facts.push(`bigint validator/schema: ${bigintParity.join(" ")}`);

  // Decimal scale and id formats: iff-parity with the validator.
  const disagreements = [];
  for (const [field, value] of SAMPLES) {
    const payload = { ...base, [field]: value };
    const v = validator(payload);
    const j = schemaAccepts(payload);
    if (v !== j)
      disagreements.push(
        `${field}=${JSON.stringify(value)} ${v ? "v+" : "v-"}${j ? "s+" : "s-"}`
      );
  }
  if (disagreements.length > 0) {
    problems.push(
      `${disagreements.length}/${SAMPLES.length} samples disagree (v=validator, s=schema): ${disagreements.join(" ")}`
    );
  }

  // All-issues mode: one call reports every issue of a payload with four.
  const broken = { ...base, id: "nope", balance: 3, tier: "root", nmae: 1 };
  const first = create["~standard"].validate(broken).issues ?? [];
  const all = parse(create, broken, { allIssues: true }).issues ?? [];
  if (all.length !== 4)
    problems.push(`all-issues mode reports ${all.length} of 4 issues`);
  facts.push(
    `default validate reports ${first.length} issue(s); parse(..., { allIssues: true }) reports ${all.length}: ${all.map((issue) => issue.path?.join(".")).join(", ")}`
  );

  return {
    status: problems.length === 0 ? "pass" : "fail",
    evidence: [...problems, ...facts].join(" | "),
  };
}

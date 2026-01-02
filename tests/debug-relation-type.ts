import { s } from "@schema";

// Simple model - no circular refs
const SimpleModel = s.model({
  id: s.string().id(),
  name: s.string(),
});

// Test 1: Via s.relation builder - no chaining (getter-last pattern)
const direct1 = s.relation.oneToOne(() => SimpleModel);

// Test 2: Via s.relation builder - with config then getter
const direct2 = s.relation.fields("test").oneToOne(() => SimpleModel);

// Test 3: Via s.relation builder - optional relation
const optionalRel = s.relation.optional().oneToOne(() => SimpleModel);

// Test 4: Via s.relation builder - full config chain
const fullConfigRel = s.relation
  .fields("authorId")
  .references("id")
  .onDelete("cascade")
  .manyToOne(() => SimpleModel);

// Force TypeScript to show us the types by creating type aliases
type Direct1G = typeof direct1 extends { "~": { getter: infer G } } ? G : never;
type Direct2G = typeof direct2 extends { "~": { getter: infer G } } ? G : never;
type OptionalRelG = typeof optionalRel extends { "~": { getter: infer G } }
  ? G
  : never;
type OptionalRelIsOptional = typeof optionalRel extends {
  "~": { isOptional: infer O };
}
  ? O
  : never;
type FullConfigRelG = typeof fullConfigRel extends { "~": { getter: infer G } }
  ? G
  : never;

// This will show type errors that reveal the actual types
const _d1: Direct1G = null as any;
const _d2: Direct2G = null as any;
const _o1: OptionalRelG = null as any;
const _o2: OptionalRelIsOptional = null as any;
const _f1: FullConfigRelG = null as any;

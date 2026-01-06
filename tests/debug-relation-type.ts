import { s } from "@schema";

// Simple model - no circular refs
const SimpleModel = s.model({
  id: s.string().id(),
  name: s.string(),
});

// Test 1: Direct factory - no chaining
const direct1 = s.oneToOne(() => SimpleModel);

// Test 2: With fields config
const direct2 = s.oneToOne(() => SimpleModel).fields("test");

// Test 3: Optional relation (new chainable API)
const optionalRel = s.oneToOne(() => SimpleModel).optional();

// Test 4: Full config chain (new chainable API)
const fullConfigRel = s
  .manyToOne(() => SimpleModel)
  .fields("authorId")
  .references("id")
  .onDelete("cascade");

// Force TypeScript to show us the types by creating type aliases
type Direct1State = (typeof direct1)["~"]["state"];
type Direct2State = (typeof direct2)["~"]["state"];
type OptionalRelState = (typeof optionalRel)["~"]["state"];
type FullConfigRelState = (typeof fullConfigRel)["~"]["state"];

// This will show type errors that reveal the actual types
const _d1: Direct1State = null as any;
const _d2: Direct2State = null as any;
const _o1: OptionalRelState = null as any;
const _f1: FullConfigRelState = null as any;

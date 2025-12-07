import { s } from "../src/schema";
import { oneToOne } from "../src/schema/relation";

// Simple model - no circular refs
const SimpleModel = s.model({
  id: s.string().id(),
  name: s.string(),
});

// Test 1: Direct import - no chaining
const direct1 = oneToOne(() => SimpleModel);

// Test 2: Direct import - with chaining
const direct2 = oneToOne(() => SimpleModel).fields("test");

// Test 3: Via s object - no chaining
const viaS1 = s.oneToOne(() => SimpleModel);

// Test 4: Via s object - with chaining
const viaS2 = s.oneToOne(() => SimpleModel).fields("test");

// Force TypeScript to show us the types by creating type aliases
type Direct1G = typeof direct1 extends { "~": { getter: infer G } } ? G : never;
type Direct2G = typeof direct2 extends { "~": { getter: infer G } } ? G : never;
type ViaS1G = typeof viaS1 extends { "~": { getter: infer G } } ? G : never;
type ViaS2G = typeof viaS2 extends { "~": { getter: infer G } } ? G : never;

// This will show type errors that reveal the actual types
const _d1: Direct1G = null as any;
const _d2: Direct2G = null as any;
const _v1: ViaS1G = null as any;
const _v2: ViaS2G = null as any;

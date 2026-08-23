import { s } from "@src/schema";
// @ts-expect-error -- the registry implementation is not constructible publicly
import { createSchemaRegistry, type SchemaRegistry } from "@src/validation";

const schema = { user: s.model({ id: s.string().id() }) };
const registry = createSchemaRegistry(schema);

// @ts-expect-error -- the public boundary always resolves its own schema
createSchemaRegistry(schema, new Map());

type Expect<Value extends true> = Value;
type _registryKeepsItsSchemaKey = Expect<
  "user" extends keyof typeof registry.proxy ? true : false
>;
type _privateConstructorProbe = typeof SchemaRegistry;

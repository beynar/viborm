/**
 * `ExtendedClient<typeof client, typeof tuple>` names, in another module,
 * the client an ordered tuple of extension values produces.
 */

import type { ExtendedClient } from "@src/index";
import { expectTypeOf } from "vitest";
import type { base } from "./extension-vocabulary.fixture";
import type {
  application,
  applicationExtensions,
  hidden,
  ping,
  tenancy,
} from "./extension-vocabulary-cross-module.fixture";

type Application = ExtendedClient<typeof base, typeof applicationExtensions>;

type _sameClient = Expect<Equal<Application, typeof application>>;
type _emptyTupleKeepsTheBase = Expect<
  Equal<ExtendedClient<typeof base, readonly []>, typeof base>
>;
type _wideTupleIsRefused = Expect<
  Equal<ExtendedClient<typeof base, readonly (typeof ping)[]>, never>
>;

const _surface = async (client: Application) => {
  expectTypeOf(client.$ping()).toEqualTypeOf<"pong">();
  const [row] = await client.post.findMany({
    tenant: "t",
    include: { author: true },
  });
  expectTypeOf(row!.author).toEqualTypeOf<{
    id: string;
    tenantId: string;
    firstName: string;
    lastName: string;
  } | null>();
  client.post.create({
    data: { title: "t", author: { connect: { id: "u" } } },
  });
  // @ts-expect-error - "tenat" is refused beside the real "tenant"
  client.post.findMany({ tenant: "t", tenat: "t" });
};

// The same tuple applied in another order names another client.
type Reordered = ExtendedClient<
  typeof base,
  readonly [typeof ping, typeof hidden, typeof tenancy]
>;
const _reordered = (client: Reordered) => {
  expectTypeOf(client.$ping()).toEqualTypeOf<"pong">();
};

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

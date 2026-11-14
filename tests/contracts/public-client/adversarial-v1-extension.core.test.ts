import type { AnyTarget, EmptyFacts, Part } from "@extensions/contract";
import {
  arg,
  args,
  createClient,
  defaults,
  extension,
  keep,
  oneOf,
  parts,
  rule,
  s,
} from "@src/index";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { appendResolvedExtension } from "@tests/fixtures/host-definition";
import { describe, expect, it } from "vitest";

const UNKNOWN_PATTERN = /unknown/i;
const UNDECLARED_CONTROL_TENNAT_PATTERN = /undeclared argument "tennat"/;

const post = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  title: s.string(),
});
const schema = { post };
/** A part built from entries the types would refuse, as a caller without them writes. */
const written = (
  build: (entries: never) => unknown,
  entries: object
): Part<AnyTarget, EmptyFacts> => Reflect.apply(build, undefined, [entries]);

/** An extension applied to a chain over `receiving`, as `$extends` applies it. */
const applied = (
  definition: unknown,
  receiving: Parameters<typeof appendResolvedExtension>[2]
) => appendResolvedExtension(undefined, definition, receiving);
describe("named extension policy admission", () => {
  // The members a builder writes are no longer read from a hand-made
  // definition (`rows`, `data`, `deletion` and the modes are gone): what is
  // refused is what an author writes with the public parts.
  it("refuses config-sourced unknown models and fields before binding", () => {
    const tenantld = { tenantId: "acme", tenantld: "globex" };
    const components = [
      written(rule, { posts: { root: { tenantId: "acme" } } }),
      written(defaults, { post: { create: tenantld } }),
      written(rule, {
        post: { delete: { instead: keep({ deletedAT: "now" }) } },
      }),
      written(rule, { post: { related: { AND: [tenantld] } } }),
    ];
    for (const component of components)
      expect(() =>
        applied(
          Reflect.apply(extension, undefined, ["policy", component]),
          schema
        )
      ).toThrow(UNKNOWN_PATTERN);
  });
  it("admits a scalar named AND as a field", () => {
    const named = s.model({ id: s.string().id(), AND: s.string() });
    expect(() =>
      applied(
        extension(
          "logical-field",
          rule({ named: { root: { AND: "field value" } } })
        ),
        { named }
      )
    ).not.toThrow();
  });
  it("refuses dangling argument references without rejecting declared optional absence", () => {
    // Held apart from the rule, a name is checked at $extends (D7).
    const tennat = arg("tennat");
    const tenant = arg("tenant");
    // An argument is the chain's to judge: order owns it (K7(c)).
    expect(() =>
      applied(
        extension(
          "references",
          args({ tenant: oneOf("acme") }),
          // A test the types would refuse: the arguments' own refusal is read.
          written(rule, {
            post: {
              root: { tenantId: tenant, AND: [{ tenantId: { in: tennat } }] },
            },
          })
        ),
        schema
      )
    ).toThrow(UNDECLARED_CONTROL_TENNAT_PATTERN);
    expect(() =>
      applied(
        extension(
          "optional",
          args({ tenant: oneOf("acme") }),
          rule({ post: { root: { tenantId: tenant } } })
        ),
        schema
      )
    ).not.toThrow();
    const controlled = s.model({ id: s.string().id(), control: s.string() });
    expect(() =>
      applied(
        extension(
          "control-field",
          rule({ controlled: { root: { control: "literal field" } } })
        ),
        { controlled }
      )
    ).not.toThrow();
  });
  it("refuses typed model typos beside real models through public surfaces", () => {
    const client = createClient({
      schema,
      driver: new PlanningDriver("postgresql"),
    });
    const probe = () => {
      // Written apart from the client, against its schema.
      parts<typeof schema>().rule({
        post: {},
        // @ts-expect-error model typo beside the real model
        posts: {},
      });
      // Written where it is applied.
      client.$extends(
        extension(
          "deletion",
          rule({
            post: { delete: { instead: keep({ title: "deleted" }) } },
            // @ts-expect-error model typo beside the real model
            posts: { delete: { instead: keep({ title: "deleted" }) } },
          })
        )
      );
    };
    expect(probe).toBeTypeOf("function");
  });
});

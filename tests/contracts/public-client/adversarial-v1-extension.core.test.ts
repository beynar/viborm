import { createClient, extension, keep, parts, rule, s } from "@src/index";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import {
  appendResolvedExtension,
  type HostDefinition,
} from "@tests/fixtures/host-definition";
import { describe, expect, it } from "vitest";

const UNKNOWN_PATTERN = /unknown/i;
const SHARE_MODE_NAMES_PATTERN = /share mode names/;
const UNDECLARED_CONTROL_TENNAT_PATTERN = /undeclared control "tennat"/;

const post = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  title: s.string(),
});
const schema = { post };
/** A definition's members applied to a chain by the host parts that read them. */
const applied = (
  definition: HostDefinition,
  receiving: Parameters<typeof appendResolvedExtension>[2]
) => appendResolvedExtension(undefined, definition, receiving);
describe("named extension policy admission", () => {
  it("rejects malformed policy containers and scalar assignments", () => {
    const cases: readonly (readonly [Record<string, unknown>, string])[] = [
      [{ rows: 42 }, "rows must be an object"],
      [{ data: { models: 42 } }, "data.models must be an object"],
      [{ data: { models: { post: 42 } } }, "data.post must be an object"],
      [
        { data: { models: { post: { create: 42 } } } },
        "fields must be an object",
      ],
      [{ deletion: { models: { post: { at: 42 } } } }, "names unknown scalar"],
      [
        { rows: { default: "tenant", models: { post: { tenant: 42 } } } },
        "row mode must be an object",
      ],
    ];
    for (const [component, message] of cases)
      expect(() =>
        Reflect.apply(appendResolvedExtension, undefined, [
          undefined,
          { name: "hostile-policy", ...component },
          schema,
        ])
      ).toThrow(message);
  });

  it("admits a predicate past a caller's nesting bound and refuses different mode counts before binding", () => {
    // A domain predicate is the application's own data: its lowering, not a
    // depth number, bounds it (plan K1(a)).
    let predicate: Record<string, unknown> = { tenantId: "acme" };
    for (let depth = 0; depth < 17; depth++) predicate = { AND: [predicate] };
    expect(() =>
      applied(
        {
          name: "deep-policy",
          rows: {
            control: "scope",
            default: "tenant",
            models: {
              post: { tenant: { root: predicate } },
            },
          },
        },
        schema
      )
    ).not.toThrow();
    expect(() =>
      applied(
        {
          name: "different-mode-counts",
          rows: {
            control: "scope",
            default: "tenant",
            models: {
              post: { tenant: {} },
              other: { tenant: {}, all: {} },
            },
          },
        },
        { post, other: post }
      )
    ).toThrow(SHARE_MODE_NAMES_PATTERN);
  });

  it("refuses config-sourced unknown models and fields before binding", () => {
    const components: Omit<HostDefinition, "name">[] = [
      {
        rows: {
          control: "scope",
          default: "tenant",
          models: { posts: { tenant: { root: { tenantId: "acme" } } } },
        },
      },
      {
        data: {
          models: {
            post: { create: { tenantId: "acme", tenantld: "globex" } },
          },
        },
      },
      { deletion: { models: { post: { at: "deletedAT" } } } },
      {
        rows: {
          control: "scope",
          default: "tenant",
          models: {
            post: {
              tenant: {
                related: { AND: [{ tenantId: "acme", tenantld: "globex" }] },
              },
            },
          },
        },
      },
    ];
    for (const component of components)
      expect(() => applied({ name: "policy", ...component }, schema)).toThrow(
        UNKNOWN_PATTERN
      );
  });
  it("refuses missing policy modes and preserves a scalar named AND", () => {
    const other = s.model({ id: s.string().id(), tenantId: s.string() });
    expect(() =>
      applied(
        {
          name: "modes",
          rows: {
            control: "scope",
            default: "tenant",
            models: {
              post: { tenant: { root: { tenantId: "acme" } } },
              other: { all: {} },
            },
          },
        },
        { post, other }
      )
    ).toThrow(SHARE_MODE_NAMES_PATTERN);
    const named = s.model({ id: s.string().id(), AND: s.string() });
    expect(() =>
      applied(
        {
          name: "logical-field",
          rows: {
            control: "scope",
            default: "tenant",
            models: { named: { tenant: { root: { AND: "field value" } } } },
          },
        },
        { named }
      )
    ).not.toThrow();
  });
  it("refuses dangling control references without rejecting declared optional absence", () => {
    const definition = {
      name: "references",
      controls: { tenant: { oneOf: ["acme"] } },
      rows: {
        control: "scope",
        default: "tenant",
        models: {
          post: {
            tenant: {
              root: {
                tenantId: { control: "tenant" },
                AND: [{ tenantId: { in: { control: "tennat" } } }],
              },
            },
          },
        },
      },
    };
    // A reference is the chain's to judge: order owns it (K7(c)).
    expect(() =>
      appendResolvedExtension(undefined, definition, schema)
    ).toThrow(UNDECLARED_CONTROL_TENNAT_PATTERN);
    expect(() =>
      applied(
        {
          name: "optional",
          controls: { tenant: { oneOf: ["acme"] } },
          rows: {
            control: "scope",
            default: "tenant",
            models: {
              post: { tenant: { root: { tenantId: { control: "tenant" } } } },
            },
          },
        },
        schema
      )
    ).not.toThrow();
    const controlled = s.model({ id: s.string().id(), control: s.string() });
    expect(() =>
      applied(
        {
          name: "control-field",
          rows: {
            control: "scope",
            default: "tenant",
            models: {
              controlled: { tenant: { root: { control: "literal field" } } },
            },
          },
        },
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

import {
  type ExtensionDefinitionInput,
  normalizeExtensionDefinition,
} from "@extensions/definition";
import { createClient, defineExtension, s } from "@src/index";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, expect, it } from "vitest";

const UNKNOWN_PATTERN = /unknown/;
const SHARE_MODE_NAMES_PATTERN = /share mode names/;
const UNDECLARED_CONTROL_TENNAT_PATTERN = /undeclared control "tennat"/;

const post = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  title: s.string(),
});
const schema = { post };
describe("named extension policy admission", () => {
  it("refuses config-sourced unknown models and fields before binding", () => {
    const components: ExtensionDefinitionInput[] = [
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
      expect(() =>
        normalizeExtensionDefinition({ name: "policy", ...component }, schema)
      ).toThrow(UNKNOWN_PATTERN);
  });
  it("refuses missing policy modes and preserves a scalar named AND", () => {
    const other = s.model({ id: s.string().id(), tenantId: s.string() });
    expect(() =>
      normalizeExtensionDefinition(
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
      normalizeExtensionDefinition(
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
    expect(() => normalizeExtensionDefinition(definition, schema)).toThrow(
      UNDECLARED_CONTROL_TENNAT_PATTERN
    );
    expect(() =>
      normalizeExtensionDefinition(
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
      normalizeExtensionDefinition(
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
      defineExtension<typeof schema>()({
        name: "rows",
        rows: {
          control: "scope",
          default: "tenant",
          models: {
            // @ts-expect-error the whole model map is refused when any key is unknown
            post: { tenant: {} },
            // @ts-expect-error model typo beside the real model
            posts: { tenant: {} },
          },
        },
      });
      const dynamic = {
        name: "deletion",
        deletion: { models: { post: {}, posts: {} } },
      };
      // @ts-expect-error non-fresh policy model typo is structurally refused
      client.$extends(dynamic);
    };
    expect(probe).toBeTypeOf("function");
  });
});

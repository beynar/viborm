/**
 * Views for migration tests while the definition compiler is not wired: a
 * view model built the way `s.view` holds one (its source's scalars, no
 * relation, no index), and the body, hash and reads `viewDefinition` answers
 * for it, spelled for the dialect of the migration driver that asks. A test
 * file mocks `@migrations/view-definition` with {@link testViewDefinition}.
 * Imports nothing of the migration layer at run time, so the mock can load it.
 */

import type {
  ViewDefinition,
  ViewDefinitionContext,
} from "@migrations/view-definition";
import { type AnyModel, Model } from "@schema/model";
import type { ViewFacts } from "@schema/view/facts";

/** How a body names a table (qualified where the dialect qualifies) and a column. */
export interface ViewSpelling {
  readonly table: (name: string) => string;
  readonly column: (name: string) => string;
}

export interface TestViewDefinition {
  readonly hash: string;
  readonly dependsOn: readonly string[];
  readonly body: (spelling: ViewSpelling) => string;
}

const DEFINITIONS = new WeakMap<AnyModel, TestViewDefinition>();

/** A view of `source` named `name` in the database, with its definition. */
export function testView(
  source: AnyModel,
  name: string,
  definition: TestViewDefinition
): AnyModel {
  const facts: ViewFacts = { source, query: {}, documents: [] };
  const state = {
    ...source["~"].state,
    relations: {},
    indexes: [],
    tableName: name,
    view: facts,
  };
  const view = new Model(state);
  DEFINITIONS.set(view, definition);
  return view;
}

/** The mock of `viewDefinition`. */
export function testViewDefinition(
  view: AnyModel,
  context: ViewDefinitionContext
): ViewDefinition {
  const definition = DEFINITIONS.get(view);
  if (definition === undefined)
    throw new Error(`No test definition for view "${view["~"].names.sql}"`);
  const driver = context.migrationDriver;
  const quote = (name: string) =>
    driver.dialect === "mysql" ? `\`${name}\`` : `"${name}"`;
  // PostgreSQL resolves no unqualified name (VibORM sets no search_path);
  // MySQL resolves it in the database the migration session selected.
  const namespace =
    driver.dialect === "postgresql"
      ? (driver.namespace ??
        (driver.target?.dialect === "postgresql"
          ? driver.target.namespace
          : undefined))
      : undefined;
  return {
    hash: definition.hash,
    dependsOn: [...definition.dependsOn],
    sql: definition.body({
      table: (name) =>
        namespace === undefined
          ? quote(name)
          : `${quote(namespace)}.${quote(name)}`,
      column: quote,
    }),
  };
}

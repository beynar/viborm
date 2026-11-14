/**
 * `rule({ [model]: entry })`: what binds every caller of a model, per model.
 * The leaves are the ORM's own `where`, checked once where the extension is
 * applied by the model's `where` schema, with the words of `rule-words.ts`
 * and `judge-words.ts` where a value or a judgement goes. What applies it
 * is `rows-translation.ts`.
 */
import type { Schema } from "@client/types";
import type {
  AnyTarget,
  EmptyFacts,
  Exact,
  Part,
  RuleFacts,
  RuleInput,
  SchemaOf,
} from "./contract";
import type { RowsContribution } from "./controls";
import { builtPart, type DefinitionDraft } from "./extension";
import { rowsPart, verbsPart } from "./rows-part";
import { buildRule, judges, ruleAdmission } from "./rows-translation";
import { verbsTranslation } from "./verbs-translation";

/**
 * What binds every caller of the models named: filters, checks, gated
 * fields, projections and kept rows. Given a function of the schema, it is
 * read where the extension is applied (an extension that depends on the
 * schema is written apart from any client).
 */
export function rule<T extends AnyTarget, const R = RuleInput<T>>(
  rules: R & RuleInput<T> & NoInfer<Exact<R, RuleInput<T>>>
): Part<T, RuleFacts<R>>;
export function rule<T extends AnyTarget>(
  build: (schema: SchemaOf<T>) => Readonly<Record<string, object>>
): Part<T, EmptyFacts>;
export function rule(
  rules:
    | Readonly<Record<string, unknown>>
    | ((schema: Schema) => Readonly<Record<string, unknown>>)
): unknown {
  // What judges rows comes with an entry that judges: one of a function is
  // not known before it is read.
  return buildRule(
    rules,
    typeof rules === "function" || Object.values(rules).some(judges)
      ? { part: verbsPart, translate: verbsTranslation }
      : undefined
  );
}

/**
 * A rows member already in the form the rows host reads, computed from the
 * schema where the extension is applied: how `permissions` hands its
 * compiled policy to the host until its compiler writes rules (temporary).
 */
export function compiledRows(
  build: (schema: Schema) => {
    readonly rows: RowsContribution;
    readonly controls?: DefinitionDraft["controls"];
  }
): unknown {
  return builtPart([ruleAdmission, rowsPart, verbsPart], (draft, schema) => {
    const { rows, controls } = build(schema);
    draft.rows = rows;
    if (controls !== undefined)
      draft.controls = { ...draft.controls, ...controls };
  });
}

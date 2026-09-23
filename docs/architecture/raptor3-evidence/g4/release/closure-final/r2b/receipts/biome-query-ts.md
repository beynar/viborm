# Biome, base copy vs repaired copy — src/query-engine/raptor3/shared/query.ts

The base copy of this file carries a `format` diagnostic, so the formatter is
never run on it. The diagnostic SET is unchanged by this unit's three lines:

## base copy (/private/tmp/viborm-r2ab-tmp/base/query.ts)
   1 query.ts assist/source/organizeImports  FIXABLE  ━━━━━━━━━━━━
   1 query.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   4 query.ts lint/complexity/useSimplifiedLogicExpression  FIXABLE  ━━━━━━━━━
   3 query.ts lint/correctness/noUnusedFunctionParameters  FIXABLE  ━━━━━━━━━
   1 query.ts lint/correctness/noUnusedVariables  FIXABLE  ━━━━━━━━━
   4 query.ts lint/style/noParameterProperties ━━━━━━━━━━━━━━━━━
   2 query.ts lint/style/useDefaultSwitchClause ━━━━━━━━━━━━━━━

## repaired copy (src/query-engine/raptor3/shared/query.ts)
   1 query.ts assist/source/organizeImports  FIXABLE  ━━━━━━━━━━━━━━
   1 query.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   4 query.ts lint/complexity/useSimplifiedLogicExpression  FIXABLE  ━━━━━━━━━
   3 query.ts lint/correctness/noUnusedFunctionParameters  FIXABLE  ━━━━━━━━━
   1 query.ts lint/correctness/noUnusedVariables  FIXABLE  ━━━━━━━━━
   4 query.ts lint/style/noParameterProperties ━━━━━━━━━━━━━━━━━━━
   2 query.ts lint/style/useDefaultSwitchClause ━━━━━━━━━━━━━━━━━

Both: 15 errors + 1 info. Every other changed file: 0 diagnostics.

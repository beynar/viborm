import ts from "typescript";
import { QUERY_OPERATIONS, type QueryOperation } from "./query";

export interface ParsedQuery {
  model: string;
  operation: QueryOperation;
  args: Record<string, unknown>;
}

const MAX_SOURCE = 65_536;
const MAX_DEPTH = 64;

/** Read data from syntax, never execute JavaScript or expose the client's other capabilities. */
export function parseQueryCode(source: unknown): ParsedQuery {
  if (
    typeof source !== "string" ||
    !source.trim() ||
    source.length > MAX_SOURCE
  )
    throw new Error("Enter one VibORM read query (at most 65,536 characters).");
  const checked = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });
  const error = checked.diagnostics?.find(
    (entry) => entry.category === ts.DiagnosticCategory.Error
  );
  if (error)
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  const file = ts.createSourceFile(
    "query.ts",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS
  );
  const statement = file.statements[0];
  if (
    file.statements.length !== 1 ||
    !statement ||
    !ts.isExpressionStatement(statement)
  )
    throw new Error("Enter one call: await client.model.findMany({ ... }).");
  const expression = unwrap(statement.expression);
  const call = ts.isAwaitExpression(expression)
    ? unwrap(expression.expression)
    : expression;
  if (
    !ts.isCallExpression(call) ||
    call.questionDotToken ||
    call.typeArguments?.length
  )
    throw new Error("Enter one call: await client.model.findMany({ ... }).");
  const method = member(call.expression);
  const model = method && member(method.target);
  if (
    !(method && model && ts.isIdentifier(model.target)) ||
    model.target.text !== "client"
  )
    throw new Error(
      "Start the query with client.model, for example client.user.findMany()."
    );
  const operation = QUERY_OPERATIONS.find((entry) => entry === method.name);
  if (!operation)
    throw new Error(`The query editor reads: ${QUERY_OPERATIONS.join(", ")}.`);
  if (call.arguments.length > 1)
    throw new Error("Pass one arguments object, or no arguments.");
  const args = call.arguments[0] ? literal(call.arguments[0], 0) : {};
  if (
    typeof args !== "object" ||
    args === null ||
    Array.isArray(args) ||
    args instanceof Date
  )
    throw new Error("Query arguments must be an object.");
  // Rebuild the object with a naturally inferred record type after its boundary check.
  return {
    model: model.name,
    operation,
    args: Object.fromEntries(Object.entries(args)),
  };
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function member(
  expression: ts.Expression
): { target: ts.Expression; name: string } | undefined {
  const node = unwrap(expression);
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken)
    return { target: unwrap(node.expression), name: node.name.text };
  if (
    ts.isElementAccessExpression(node) &&
    !node.questionDotToken &&
    ts.isStringLiteral(node.argumentExpression)
  )
    return {
      target: unwrap(node.expression),
      name: node.argumentExpression.text,
    };
  return undefined;
}

function literal(expression: ts.Expression, depth: number): unknown {
  if (depth > MAX_DEPTH)
    throw new Error("Query arguments are nested too deeply.");
  const node = unwrap(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text);
    if (!Number.isFinite(value)) throw new Error("Numbers must be finite.");
    return value;
  }
  if (ts.isBigIntLiteral(node))
    return BigInt(node.text.slice(0, -1).replaceAll("_", ""));
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node) && node.text === "undefined") return undefined;
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken ||
      node.operator === ts.SyntaxKind.PlusToken)
  ) {
    const value = literal(node.operand, depth + 1);
    if (typeof value === "number")
      return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
    if (typeof value === "bigint" && node.operator === ts.SyntaxKind.MinusToken)
      return -value;
  }
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((entry) => literal(entry, depth + 1));
  if (ts.isObjectLiteralExpression(node)) {
    const entries: [string, unknown][] = [];
    for (const property of node.properties) {
      if (
        !(
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) ||
            ts.isStringLiteral(property.name) ||
            ts.isNumericLiteral(property.name))
        )
      )
        throw new Error(
          "Use literal object properties; spreads, methods and computed keys are not supported."
        );
      entries.push([
        property.name.text,
        literal(property.initializer, depth + 1),
      ]);
    }
    return Object.fromEntries(entries);
  }
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Date" &&
    !node.typeArguments?.length &&
    node.arguments?.length === 1
  ) {
    const value = literal(node.arguments[0]!, depth + 1);
    if (typeof value === "string" || typeof value === "number") {
      const date = new Date(value);
      if (Number.isFinite(date.getTime())) return date;
      throw new Error("The Date value is invalid.");
    }
  }
  throw new Error(
    "Use literal values, arrays, objects, bigint literals or new Date(...). Variables, functions and other JavaScript expressions are not supported."
  );
}

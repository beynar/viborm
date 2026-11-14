/**
 * How the extension codemod (`scripts/extension-codemod.mjs`) spells the new
 * extension contract. Every piece of output text the codemod writes for the
 * new vocabulary comes from a function of this module, so a change of
 * spelling decided by the type spike (step 1 of the extension rewrite plan)
 * is made here and nowhere else:
 *
 * - `x.extension(…)` with schema-bound parts: change `printExtension` (it
 *   receives the schema type the old `defineExtension<S>()` named) and the
 *   printers of the parts, which all name their word through `w`.
 * - the extension is always one value passed to `$extends` (owner rule D11),
 *   so `printExtension` returns the expression that replaces the old
 *   definition where it stood; there is no form of a function given to
 *   `$extends`.
 * - `call.around` named otherwise, or one `call` for both moments: change
 *   `AROUND`, or make `printCallAround` print `printCall`.
 * - `via`/`again` as members of `run`: change `printVia`/`printAgain`.
 *
 * Each printer takes source snippets that are already printed (strings) and
 * returns one. `w(name)` is the local name under which the file imports the
 * word `name` (the codemod aliases a word whose name the file already uses,
 * and imports every word a printer asked for). Nothing here reads the AST.
 * The output is not formatted: the codemod hands each file to Biome.
 */

/** Every word a printer may ask for, in the order an import lists them. */
export const WORDS = [
  "extension",
  "call",
  "unit",
  "rule",
  "defaults",
  "args",
  "methods",
  "fields",
  "target",
  "reads",
  "writes",
  "deletes",
  "around",
  "nothing",
  "oneOf",
  "accepts",
  "bound",
  "arg",
  "now",
  "row",
  "exists",
  "when",
  "unless",
  "provided",
  "check",
  "gate",
  "facts",
  "keep",
  "watch",
  "settled",
  "again",
  "via",
  "statement",
  "run",
];

/**
 * The parameter names the codemod gives the handlers it writes, before it
 * makes them unique in the handler they land in.
 */
export const PARAMETERS = { call: "c", run: "run", unit: "u", next: "next" };

/** The construction of a part that has a second moment (spec §13: its own export). */
const AROUND = "around";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** A property key as an object literal writes it. */
export function printKey(name) {
  // A computed key arrives printed: `[expression]`.
  if (name.startsWith("[")) return name;
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** An object literal from `[key, value]` pairs whose values are printed. */
export function printObject(entries) {
  if (entries.length === 0) return "{}";
  return `{ ${entries.map(([key, value]) => `${printKey(key)}: ${value}`).join(", ")} }`;
}

/** A string literal. */
export function printString(value) {
  return JSON.stringify(value);
}

export function printers(w) {
  return {
    /** `extension(name, ...parts)`; `schemaType` is `S` of `defineExtension<S>()`, unused today. */
    printExtension(name, parts, _schemaType) {
      return `${w("extension")}(${[name, ...parts].join(", ")})`;
    },

    /** A part with a first moment only. */
    printCall(handler, on) {
      return `${w("call")}(${handler}${on ? `, ${on}` : ""})`;
    },

    /** A part whose handler returns a second moment. */
    printCallAround(handler, on) {
      const [head, ...rest] = AROUND.split(".");
      return `${[w(head), ...rest].join(".")}(${handler}${on ? `, ${on}` : ""})`;
    },

    /** `target("post", "findMany")` for one model operation. */
    printOnOperation(model, operation) {
      return `${w("target")}(${printString(model)}, ${printString(operation)})`;
    },

    /** `target(writes)`, `target(reads)`, `target(deletes)`. */
    printOnFamily(family) {
      return `${w("target")}(${w(family)})`;
    },

    /** The first-moment handler: `(c) => body`, `() => body` when it reads no `c`. */
    printHandler(c, body, readsCall) {
      return `(${readsCall ? c : ""}) => ${body}`;
    },

    /** The second-moment function `(run) => body`. */
    printAround(isAsync, run, body) {
      return `${isAsync ? "async " : ""}(${run}) => ${body}`;
    },

    // The facts of a call, first moment.
    printCallArgs: (c) => `${c}.args`,
    printCallValues: (c) => `${c}.values`,
    printCallModel: (c) => `${c}.model`,
    printCallOperation: (c) => `${c}.operation`,
    printCallKind: (c) => `${c}.kind`,
    printSet: (c, patch) => `${c}.set(${patch})`,

    // The facts of a run, second moment.
    printRunInput: (run) => `${run}.input`,
    printRunMode: (run) => `${run}.mode`,

    printSettled: (c, listener) => `${w("settled")}(${c}, ${listener})`,
    printWatch: (c, watcher) => `${w("watch")}(${c}, ${watcher})`,
    printAgain: (run) => `${w("again")}(${run})`,
    printVia: (run, driver) => `${w("via")}(${run}, ${driver})`,

    /** `unit(handler, kinds?, options?)`. */
    printUnit(handler, kinds, options) {
      const rest = [];
      if (kinds) rest.push(`[${kinds.map(printString).join(", ")}]`);
      if (options) rest.push(printObject(Object.entries(options)));
      return `${w("unit")}(${[handler, ...rest].join(", ")})`;
    },
    printUnitHandler(isAsync, u, next, body) {
      return `${isAsync ? "async " : ""}(${u}, ${next}) => ${body}`;
    },
    printUnitModel: (u) => `${u}.model`,
    printUnitOperation: (u) => `${u}.operation`,
    /** The statement a `statement` unit sends, before any rewrite (spec §11). */
    printStatement: (u) => `${w("statement")}(${u})`,
    printNext: (next, statement) => `${next}(${statement ?? ""})`,
    printRunInUnit: (u, statement) => `${w("run")}(${u}, ${statement})`,

    /** `args({ name: declaration, … })`. */
    printArgs(entries) {
      return `${w("args")}(${printObject(entries)})`;
    },

    /**
     * One argument: a closed list or a schema, then its modifiers. `base` is
     * `{ oneOf: [printed values] }`, `{ oneOfSpread: printed }` or
     * `{ schema: printed }`; a schema alone stays itself.
     */
    printArgDeclaration({
      base,
      on,
      models,
      required,
      fallback,
      bound,
      volatile,
    }) {
      let text;
      if (base.oneOf) text = `${w("oneOf")}(${base.oneOf.join(", ")})`;
      else if (base.oneOfSpread) text = `${w("oneOf")}(...${base.oneOfSpread})`;
      else text = base.schema;
      if (bound) text = `${w("bound")}(${text})`;
      const modifiers = [];
      if (on) modifiers.push(`.on(${on})`);
      if (models) modifiers.push(`.models(${models})`);
      if (required)
        modifiers.push(`.required(${required === true ? "" : required})`);
      if (fallback !== undefined) modifiers.push(`.default(${fallback})`);
      if (volatile) modifiers.push(".volatile()");
      if (modifiers.length === 0) return text;
      if (base.schema && !bound) text = `${w("accepts")}(${text})`;
      return text + modifiers.join("");
    },

    /** Where an argument is accepted: `reads`, `writes`, `deletes` or a printed list. */
    printPlacement(family) {
      return family === "reads" || family === "writes" || family === "deletes"
        ? w(family)
        : family;
    },

    /** A list of models: printed names, and printed lists spread into it. */
    printModelList(names, lists) {
      if (names.length === 0 && lists.length === 1) return lists[0];
      return `[${[...lists.map((list) => `...${list}`), ...names.map(printString)].join(", ")}]`;
    },

    /** `rule(models)`, `models` a printed object or expression. */
    /** `defaults(models)`: orderBy, create, update, fields (D13). */
    printDefaults(models) {
      return `${w("defaults")}(${models})`;
    },

    printRule(models) {
      return `${w("rule")}(${models})`;
    },

    /** A lazy rule entry: `() => { prelude; return entry; }`. */
    printLazyEntry(parameters, prelude, entry) {
      return prelude.length === 0
        ? `(${parameters}) => (${entry})`
        : `(${parameters}) => { ${prelude.join(" ")} return ${entry}; }`;
    },

    /** Several conditions where a rule takes one filter. */
    printConditions(conditions) {
      return conditions.length === 1
        ? conditions[0]
        : `[${conditions.join(", ")}]`;
    },

    /** Filters that must all hold. */
    printAll(filters) {
      return filters.length === 1
        ? filters[0]
        : `{ AND: [${filters.join(", ")}] }`;
    },

    // The words of a rule.
    printArg: (name, path) => `${w("arg")}(${name}${path ? `, ${path}` : ""})`,
    printNow: () => w("now"),
    /** The filter no row holds: a verb a 1.14 entry left out. */
    printNothing: () => w("nothing"),
    printRow: (column, up) => `${w("row")}(${column}, ${up})`,
    printExists: (spec) => `${w("exists")}(${spec})`,
    printWhen: (value, test, then) =>
      `${w("when")}(${value}, ${test}, ${then})`,
    printProvided: (value, test, then) =>
      `${w("provided")}(${value}, ${test}${then === "{}" ? "" : `, ${then}`})`,
    printUnless: (value, test, then) =>
      `${w("unless")}(${value}, ${test}, ${then})`,
    printCheck: (where) => `${w("check")}(${where})`,
    printGate: (where) => `${w("gate")}(${where})`,
    /** `facts({ name: where })`; `ordered` keeps the last that holds (no spelling in spec v0). */
    printFacts(entries, ordered) {
      return `${w("facts")}(${printObject(entries)}${ordered ? ", { ordered: true }" : ""})`;
    },
    printInstead: (data) => `${w("keep")}(${data})`,
    /** `deletion`'s tombstone: kept unless the call's argument says to remove. */
    printDeleteInstead(data, removeWhen) {
      const kept = removeWhen
        ? `${w("unless")}(${removeWhen.value}, ${removeWhen.test}, ${data})`
        : data;
      return `${w("keep")}(${kept})`;
    },
    /** A condition test of `$if`: `equals` is the value itself. */
    printTest(test, operand) {
      return test === "equals" ? operand : `{ ${test}: ${operand} }`;
    },

    /**
     * `methods((scope) => …)`: the old `client` factory's methods, and each
     * old model factory as a model's entry given as a function of its
     * delegate and the scope.
     */
    printMethods(members) {
      const client = members.some((member) => member.startsWith("client"));
      const models = members.some((member) => member.startsWith("models"));
      const spread = [
        ...(client ? ["...own.client(scope)"] : []),
        ...(models ? ["...own.models"] : []),
      ];
      return `${w("methods")}((${client ? "scope" : ""}) => { const own = { ${members.join(", ")} }; return { ${spread.join(", ")} }; })`;
    },
    printFields: (definition) => `${w("fields")}(${definition})`,

    /** A shared predicate declared above the definition. */
    printConst: (name, value) => `const ${name} = ${value};`,

    /** The marker of a conversion a person must read again. */
    printFlag: (reason) =>
      `// FIXME(extension-codemod): ${reason.replace(/\s+/g, " ")}\n`,
  };
}

/** Check every source root, but serialize only the public producer. */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const [compiler, project, ...producers] = process.argv.slice(2);
if (!(compiler && project) || producers.length === 0)
  throw new Error("Expected compiler, project and producer paths");
const ts = createRequire(import.meta.url)(
  join(dirname(compiler), "../lib/typescript.js")
);
const report = (diagnostics) => {
  if (diagnostics.length === 0) return;
  process.stderr.write(
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => ts.sys.newLine,
    })
  );
  process.exit(2);
};
const config = ts.readConfigFile(project, ts.sys.readFile);
if (config.error) report([config.error]);
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  dirname(project),
  undefined,
  project
);
report(parsed.errors);
const program = ts.createProgram({
  rootNames: parsed.fileNames,
  options: parsed.options,
  projectReferences: parsed.projectReferences,
});
// getPreEmitDiagnostics also serializes every probe's declaration; the source
// contract needs all ordinary checks, and declaration checks for producers only.
report(program.getConfigFileParsingDiagnostics());
report(program.getOptionsDiagnostics());
report(program.getSyntacticDiagnostics());
report(program.getGlobalDiagnostics());
report(program.getSemanticDiagnostics());
for (const producer of producers) {
  const source = program.getSourceFile(resolve(dirname(project), producer));
  if (!source)
    throw new Error(`Producer is not in the checked program: ${producer}`);
  report(program.getDeclarationDiagnostics(source));
  const emitted = program.emit(source, undefined, undefined, true);
  report(emitted.diagnostics);
  if (emitted.emitSkipped)
    throw new Error(`Producer emission skipped: ${producer}`);
}

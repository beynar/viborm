/**
 * A definition handed to the host parts as their members, without a
 * builder: for the tests of a host part itself (the rows binding, the
 * controls placement), which reads those members until each part carries
 * its own state. An application writes `extension(name, ...parts)`.
 */
import type { Schema } from "@client/types";
import { partSet } from "@extensions/chain";
import type { ResolvedExtensionChain } from "@extensions/chain-state";
import { controlsPart } from "@extensions/controls";
import type { RuntimeExtensionDefinition } from "@extensions/definition";
import { builtPart, extension } from "@extensions/extension";
import { methodsPart } from "@extensions/methods";
import { queryPart } from "@extensions/query";
import { resultPart } from "@extensions/result";
import { rowsPart, verbsPart } from "@extensions/rows-part";
import { ruleAdmission } from "@extensions/rows-translation";

const hosts = partSet([
  controlsPart,
  ruleAdmission,
  rowsPart,
  verbsPart,
  resultPart,
  methodsPart,
]);
for (const part of hosts.parts) part.bring?.();

/** A definition's members as the host parts read them. */
export type HostDefinition = { readonly name: string } & Readonly<
  Record<string, unknown>
>;

/** `chain` with `definition` applied by the host parts that read it. */
export function appendResolvedExtension(
  chain: ResolvedExtensionChain | undefined,
  definition: HostDefinition,
  schema: Schema
): ResolvedExtensionChain {
  return hosts.append(chain, definition as RuntimeExtensionDefinition, schema);
}

/**
 * An extension value made of raw members, applied by the host parts that
 * read them (`query` by the query host, `rows` by the rows host): for the
 * tests of a host part through `$extends`.
 */
export function hostExtension(definition: HostDefinition): unknown {
  const { name, ...members } = definition;
  return extension(
    name,
    builtPart([...hosts.parts, queryPart], (draft) => {
      Object.assign(draft, members);
    })
  );
}

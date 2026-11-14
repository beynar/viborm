/**
 * `rows`, `deletion`, `data` and `order`: the rows each call reads and
 * writes, what a delete writes instead, the fields a write stamps and the
 * order a read takes. One part for the four, read by what `rows-slot.ts`
 * brings, until each becomes its own.
 */
import type { ModelStamps } from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
import type { ExtensionPart } from "./chain";
import type { ResolvedDeletion } from "./chain-state";
import {
  controlsPart,
  type DataContribution,
  type DeletionContribution,
} from "./controls";
import { extensionError } from "./definition";
import { withRows, withVerbs } from "./rows-runtime";
import { rowsRuntime } from "./rows-slot";

const NO_ASSIGN: Readonly<Record<string, unknown>> = Object.freeze({});

/** One entry per managed model on the chain: a later entry replaces one. */
function appendDeletion(
  previous: Readonly<Record<string, ResolvedDeletion>> | undefined,
  extension: string,
  deletion: DeletionContribution
): Readonly<Record<string, ResolvedDeletion>> {
  const entries: Record<string, ResolvedDeletion> = Object.create(null);
  Object.assign(entries, previous);
  for (const [model, entry] of Object.entries(deletion.models)) {
    entries[model] = Object.freeze({
      extension,
      ...entry,
      assign: entry.assign ?? NO_ASSIGN,
      ...(deletion.removeWhen === undefined
        ? {}
        : { removeWhen: deletion.removeWhen }),
    });
  }
  return Object.freeze(entries);
}

/** One kind's fields with an extension's own merged in: it wins a field. */
function withStamp(
  previous: Input | undefined,
  fields: Readonly<Record<string, unknown>> | undefined
): Input | undefined {
  return fields === undefined
    ? previous
    : Object.freeze({ ...previous, ...fields });
}

function appendData(
  previous: Readonly<Record<string, ModelStamps>> | undefined,
  data: DataContribution
): Readonly<Record<string, ModelStamps>> {
  const entries: Record<string, ModelStamps> = Object.create(null);
  Object.assign(entries, previous);
  for (const [model, entry] of Object.entries(data.models)) {
    const known = entries[model];
    entries[model] = Object.freeze({
      create: withStamp(known?.create, entry.create),
      update: withStamp(known?.update, entry.update),
    });
  }
  return Object.freeze(entries);
}

export const rowsPart: ExtensionPart = {
  members: ["rows", "deletion", "data", "order"],
  // A `rows` member declares the control that picks its mode.
  uses: [controlsPart],
  bring: withRows,
  join({ next, chain, definition }) {
    const { name } = definition;
    // A definition may name its own controls and those an earlier extension
    // declares: order owns a reference, so one value serves every extension.
    // Only a declaration of rows, data or deletion names a control it does
    // not declare.
    const declares = definition.rows ?? definition.data ?? definition.deletion;
    for (const control of declares
      ? rowsRuntime().undeclaredControlReferencesOf(definition)
      : []) {
      if (chain?.controls?.names.has(control) !== true) {
        extensionError(
          `Extension "${name}" references undeclared control "${control}".`,
          name
        );
      }
    }
    // A lazy `verbs` entry's references are checked when it is resolved, by
    // the binding, against what the chain declared where it was applied.
    const rows =
      definition.rows === undefined
        ? chain?.rows
        : Object.freeze([...(chain?.rows ?? []), definition.rows]);
    const deletion =
      definition.deletion === undefined
        ? chain?.deletion
        : appendDeletion(chain?.deletion, name, definition.deletion);
    const data =
      definition.data === undefined
        ? chain?.data
        : appendData(chain?.data, definition.data);
    const order =
      definition.order === undefined
        ? chain?.order
        : Object.freeze({
            ...chain?.order,
            // Admission left each entry a frozen array of terms.
            ...(definition.order.models as Readonly<
              Record<string, readonly Input[]>
            >),
          });
    if (
      rows === chain?.rows &&
      deletion === chain?.deletion &&
      data === chain?.data &&
      order === chain?.order
    )
      return;
    // The binding reads `required` from the controls, already appended: a
    // filter names only controls its own or an earlier extension declares,
    // so a later definition that declares only controls changes nothing it
    // binds.
    if (rows !== undefined) next.rows = rows;
    if (deletion !== undefined) next.deletion = deletion;
    if (data !== undefined) next.data = data;
    if (order !== undefined) next.order = order;
    next.callRows = rowsRuntime().bindRows(
      rows,
      deletion,
      data,
      next.controls,
      order
    );
  },
};

/**
 * What reads a `rows` member's `verbs` and `confine`: what judges the rows a
 * write produces and what a read carries beside them or hides. Apart from
 * `rows`, so an extension whose rows only filter does not carry it.
 */
export const verbsPart: ExtensionPart = {
  uses: [rowsPart],
  bring: withVerbs,
};

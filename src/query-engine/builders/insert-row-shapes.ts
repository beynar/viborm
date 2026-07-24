export interface InsertRowShape<Row> {
  readonly fields: readonly string[];
  readonly inputIndexes: readonly number[];
  readonly rows: readonly Row[];
}

/**
 * Compute effective fields per row and group maximal contiguous runs of the
 * same shape. Field order is canonical, input order is never changed, and
 * every row retains its original input index.
 */
export function planInsertRowShapes<
  Row extends Readonly<Record<string, unknown>>,
>(
  fieldOrder: readonly string[],
  rows: readonly Row[],
  shouldOmit: (field: string, value: unknown) => boolean
): InsertRowShape<Row>[] {
  const groups: {
    fields: string[];
    inputIndexes: number[];
    rows: Row[];
  }[] = [];
  let activeShapeKey: string | undefined;

  for (let inputIndex = 0; inputIndex < rows.length; inputIndex++) {
    const row = rows[inputIndex]!;
    const fields = fieldOrder.filter((field) => !shouldOmit(field, row[field]));
    const shapeKey = JSON.stringify(fields);
    let group = groups.at(-1);
    if (!group || activeShapeKey !== shapeKey) {
      group = { fields, inputIndexes: [], rows: [] };
      groups.push(group);
      activeShapeKey = shapeKey;
    }
    group.inputIndexes.push(inputIndex);
    group.rows.push(row);
  }

  return groups;
}

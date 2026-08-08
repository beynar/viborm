import { type DiffOperation, sortOperations } from "@src/migrations";

declare const operation: DiffOperation;

const orderedOperations: DiffOperation[] = sortOperations([operation]);

void orderedOperations;

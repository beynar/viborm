import {
  type DiffOperation,
  type GenerateOptions,
  type PolymorphicMemberHistoryChange,
  type PolymorphicMemberResolver,
  type PolymorphicSnapshotStorage,
  sortOperations,
} from "@src/migrations";

declare const operation: DiffOperation;

const orderedOperations: DiffOperation[] = sortOperations([operation]);

void orderedOperations;

const polymorphicStorage = {
  ownerTable: "comments",
  relation: "subject",
  typeColumn: "subject_type",
  idColumn: "subject_id",
  members: [
    {
      publicType: "post",
      storedType: "content.post.v1",
      targetTable: "posts",
      referencedColumn: "id",
    },
  ],
} satisfies PolymorphicSnapshotStorage;

const polymorphicMemberResolver: PolymorphicMemberResolver = (change) => {
  const historyChange: PolymorphicMemberHistoryChange = change;
  void historyChange.from.storedType;
  return change.acknowledgeMigrated();
};

const generateOptions: GenerateOptions = { polymorphicMemberResolver };

void polymorphicStorage;
void generateOptions;

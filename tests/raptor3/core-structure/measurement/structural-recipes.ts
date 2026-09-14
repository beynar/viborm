import {
  type SemanticInventory,
  semanticInventorySchema,
  structuralSizes,
} from "./protocol";

type StructuralSize = (typeof structuralSizes)[number];
type SQLiteProfile = "sqlite-interactive" | "sqlite-atomic-batch";

interface StructuralNode {
  id: string;
  label: string;
  children?: { create: StructuralNode[] };
}

interface RecipeBase {
  formatVersion: 1;
  caseId: string;
  size: StructuralSize;
  profile: "construction-only" | SQLiteProfile;
  schedule: string[];
  semanticInventory: SemanticInventory;
}

interface CreateRecipe extends RecipeBase {
  kind: "depth-create" | "width-create";
  profile: "construction-only";
  route: "public-create";
  data: StructuralNode;
  oracle: { outcome: "accepted"; logicalOrder: string[] };
}

interface OverlapRecipe extends RecipeBase {
  kind: "width-overlap";
  profile: "sqlite-interactive";
  route: "private-bound-selection-after-writers";
  edge: "kids";
  publication: "whole-body-finalized";
  keyFields: ["pa", "pb"];
  writers: Array<{ writerId: string; selector: { slug: string } }>;
  readers: Array<{ readerId: string; selector: { slug: string } }>;
  oracle: {
    outcome: "NestedWriteError";
    dependency: "membership";
    positivePairs: Array<{ readId: string; writeId: string }>;
  };
}

interface SeriesChoiceRecipe extends RecipeBase {
  kind: "series-choice-found" | "series-choice-missing";
  profile: SQLiteProfile;
  route: "private-guarded-bound-selection";
  members: string[];
  lateChoiceState: "found" | "missing";
  oracle: {
    outcome: "NestedWriteError";
    relation: "lateTicket" | "earlyTicket";
    memberPath: [number];
    admittedMembers: number;
    preparation: "all-before-execute";
    ticketWrites: 0;
    batch: {
      atomicity: "segment";
      phase: "planning";
      committedSegments: 1;
      committedWriteMembers: 1;
      completedMembers: 0;
    };
  };
}

export type StructuralRecipe =
  | CreateRecipe
  | OverlapRecipe
  | SeriesChoiceRecipe;

const id = (kind: string, caseId: string, path: string) =>
  `${kind}:${caseId}:${path}`;

function inventory(
  caseId: string,
  paths: readonly string[],
  options: {
    selectionByPath?: ReadonlyMap<string, string>;
    readPaths?: readonly string[];
    writePaths?: readonly string[];
    activations?: readonly string[];
  } = {}
): SemanticInventory {
  const readPaths = options.readPaths ?? [];
  const writePaths = options.writePaths ?? paths;
  const commandIds = paths.map((path) => id("command", caseId, path)).sort();
  const occurrences = paths
    .map((path) => ({
      commandId: id("command", caseId, path),
      occurrenceId: id("occurrence", caseId, path),
      ...(options.selectionByPath?.get(path) && {
        selectionId: options.selectionByPath.get(path),
      }),
    }))
    .sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId));
  const reads = readPaths
    .map((path) => ({
      readId: id("read", caseId, path),
      occurrenceId: id("occurrence", caseId, path),
    }))
    .sort((left, right) => left.readId.localeCompare(right.readId));
  const writes = writePaths
    .map((path) => ({
      writeId: id("write", caseId, path),
      occurrenceId: id("occurrence", caseId, path),
    }))
    .sort((left, right) => left.writeId.localeCompare(right.writeId));
  const activationIds = [
    ...(options.activations ?? [
      id("activation", caseId, "attempt/0/unconditional"),
    ]),
  ].sort();
  return semanticInventorySchema.parse({
    commandIds,
    occurrences,
    selectionIds: [...new Set(options.selectionByPath?.values() ?? [])].sort(),
    reads,
    writes,
    activationIds,
  });
}

function depthInput(size: StructuralSize): StructuralNode {
  let node: StructuralNode = { id: `node-${size}`, label: `Node ${size}` };
  for (let level = size - 1; level >= 0; level--)
    node = {
      id: `node-${level}`,
      label: `Node ${level}`,
      children: { create: [node] },
    };
  return node;
}

function depthPaths(size: StructuralSize): string[] {
  const paths = ["root"];
  for (let level = 0; level < size; level++)
    paths.push(`${paths[paths.length - 1]}/children/0`);
  return paths;
}

function createRecipe(
  kind: CreateRecipe["kind"],
  size: StructuralSize
): CreateRecipe {
  const caseId = `structure/${kind}/${size}`;
  const paths =
    kind === "depth-create"
      ? depthPaths(size)
      : [
          "root",
          ...Array.from(
            { length: size },
            (_, index) => `root/children/${index}`
          ),
        ];
  const data =
    kind === "depth-create"
      ? depthInput(size)
      : {
          id: "root",
          label: "Root",
          children: {
            create: Array.from({ length: size }, (_, index) => ({
              id: `child-${index}`,
              label: `Child ${index}`,
            })),
          },
        };
  return {
    formatVersion: 1,
    caseId,
    kind,
    size,
    profile: "construction-only",
    route: "public-create",
    data,
    schedule: paths.map((path) => `construct:${path}`),
    semanticInventory: inventory(caseId, paths),
    oracle: {
      outcome: "accepted",
      logicalOrder: paths.map((path) => id("occurrence", caseId, path)),
    },
  };
}

function overlapRecipe(size: StructuralSize): OverlapRecipe {
  const caseId = `structure/width-overlap/${size}`;
  const writerPaths = Array.from(
    { length: size },
    (_, index) => `root/writer/${index}`
  );
  const readerPaths = Array.from(
    { length: size },
    (_, index) => `root/reader/${index}`
  );
  const readerCapturePaths = readerPaths.map((path) => `${path}/capture`);
  const readerTemplatePaths = readerPaths.map((path) => `${path}/template`);
  const writers = writerPaths.map((path, index) => ({
    writerId: id("write", caseId, path),
    selector: { slug: `kid-${index}` },
  }));
  const readers = readerPaths.map((path, index) => ({
    readerId: id("read", caseId, path),
    selector: { slug: `kid-${index}` },
  }));
  const readerSelections = new Map<string, string>();
  for (const path of readerPaths) {
    const selectionId = id("selection", caseId, path);
    readerSelections.set(path, selectionId);
    readerSelections.set(`${path}/template`, selectionId);
  }
  return {
    formatVersion: 1,
    caseId,
    kind: "width-overlap",
    size,
    profile: "sqlite-interactive",
    route: "private-bound-selection-after-writers",
    edge: "kids",
    publication: "whole-body-finalized",
    keyFields: ["pa", "pb"],
    writers,
    readers,
    schedule: [
      ...writerPaths.map((path) => `publish:${path}`),
      ...readerPaths.map((path) => `observe:${path}`),
    ],
    semanticInventory: inventory(
      caseId,
      [
        "root",
        ...writerPaths,
        ...readerPaths,
        ...readerCapturePaths,
        ...readerTemplatePaths,
      ],
      {
        selectionByPath: readerSelections,
        readPaths: readerPaths,
        writePaths: ["root", ...writerPaths, ...readerTemplatePaths],
      }
    ),
    oracle: {
      outcome: "NestedWriteError",
      dependency: "membership",
      positivePairs: writers.map((writer, index) => {
        const reader = readers[index];
        if (!reader)
          throw new Error("Overlap reader/writer cardinality changed");
        return { writeId: writer.writerId, readId: reader.readerId };
      }),
    },
  };
}

function seriesChoiceRecipe(
  size: StructuralSize,
  profile: SQLiteProfile,
  lateChoiceState: "found" | "missing"
): SeriesChoiceRecipe {
  const kind =
    lateChoiceState === "found"
      ? "series-choice-found"
      : "series-choice-missing";
  const caseId = `structure/${kind}/${size}/${profile}`;
  const members = Array.from({ length: size }, (_, index) => `member-${index}`);
  const memberPaths = members.map((_, index) => `root/series/member/${index}`);
  const ticketPaths = memberPaths.map((path) => `${path}/ticket/create`);
  const choiceArmPaths = [
    "root/choice/early/found",
    "root/choice/late/found",
    "root/choice/late/missing",
  ];
  const innerChoicePaths = [
    "root/choice/early/found/earlyTicket/connect",
    "root/choice/late/found/lateTicket/connect",
  ];
  const paths = [
    "root",
    "root/series",
    "root/series/capture",
    "root/series/template",
    "root/series/template/ticket/create",
    "root/guard/early",
    "root/guard/late",
    "root/choice/early",
    "root/choice/late",
    ...choiceArmPaths,
    ...innerChoicePaths,
    ...memberPaths,
    ...ticketPaths,
  ];
  const early = id("selection", caseId, "root/guard/early");
  const late = id("selection", caseId, "root/guard/late");
  const selections = new Map([
    ["root/series", id("selection", caseId, "root/series")],
    ["root/series/template", id("selection", caseId, "root/series")],
    ["root/guard/early", early],
    ["root/choice/early", early],
    ["root/choice/early/found", early],
    ["root/guard/late", late],
    ["root/choice/late", late],
    ["root/choice/late/found", late],
    [
      "root/choice/early/found/earlyTicket/connect",
      id("selection", caseId, "root/choice/early/found/earlyTicket/connect"),
    ],
    [
      "root/choice/late/found/lateTicket/connect",
      id("selection", caseId, "root/choice/late/found/lateTicket/connect"),
    ],
  ]);
  for (const memberPath of memberPaths)
    selections.set(memberPath, id("selection", caseId, memberPath));
  const conflictMember = lateChoiceState === "found" ? 0 : size - 1;
  return {
    formatVersion: 1,
    caseId,
    kind,
    size,
    profile,
    route: "private-guarded-bound-selection",
    members,
    lateChoiceState,
    schedule: [
      "capture:root/series",
      "observe:root/guard/early",
      "observe:root/guard/late",
      ...memberPaths.map((path) => `admit:${path}`),
      `activate:choice/late/${lateChoiceState}`,
      `fail:member/${conflictMember}`,
    ],
    semanticInventory: inventory(caseId, paths, {
      selectionByPath: selections,
      readPaths: [
        "root/series",
        "root/choice/early",
        "root/choice/late",
        ...innerChoicePaths,
      ],
      writePaths: [
        "root",
        "root/series/template",
        "root/series/template/ticket/create",
        ...choiceArmPaths,
        ...innerChoicePaths,
        ...memberPaths,
        ...ticketPaths,
      ],
      activations: [
        id("activation", caseId, "attempt/0/unconditional"),
        id(
          "activation",
          caseId,
          "root/choice/early/attempt/0/observation/0/unobserved"
        ),
        id(
          "activation",
          caseId,
          "root/choice/early/attempt/0/observation/0/found"
        ),
        id(
          "activation",
          caseId,
          "root/choice/late/attempt/0/observation/1/unobserved"
        ),
        id(
          "activation",
          caseId,
          `root/choice/late/attempt/0/observation/1/${lateChoiceState}`
        ),
      ],
    }),
    oracle: {
      outcome: "NestedWriteError",
      relation:
        lateChoiceState === "found" && size > 1 ? "lateTicket" : "earlyTicket",
      memberPath: [conflictMember],
      admittedMembers: size,
      preparation: "all-before-execute",
      ticketWrites: 0,
      batch: {
        atomicity: "segment",
        phase: "planning",
        committedSegments: 1,
        committedWriteMembers: 1,
        completedMembers: 0,
      },
    },
  };
}

export function structuralMeasurementRecipes(): readonly StructuralRecipe[] {
  const recipes: StructuralRecipe[] = [];
  const profiles: readonly SQLiteProfile[] = [
    "sqlite-interactive",
    "sqlite-atomic-batch",
  ];
  for (const size of structuralSizes) {
    recipes.push(createRecipe("depth-create", size));
    recipes.push(createRecipe("width-create", size));
    recipes.push(overlapRecipe(size));
    for (const profile of profiles) {
      recipes.push(seriesChoiceRecipe(size, profile, "found"));
      recipes.push(seriesChoiceRecipe(size, profile, "missing"));
    }
  }
  return recipes;
}

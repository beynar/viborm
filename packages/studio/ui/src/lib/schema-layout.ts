// Where each card of the schema diagram stands. Models that join each other
// stand together as a group, with more room between groups than inside one;
// inside a group the models pointed to stand left of the ones pointing to
// them (a crowd of them on both sides), and the groups are packed so that the ones joined most sit side by
// side, on a sheet about as wide as a screen. No randomness and no reading of
// the schema's order: one schema has one layout.
import type { StudioSchema } from "./api";
import {
  CARD_HEADER,
  CARD_ROW,
  CARD_WIDTH,
  cardHeight,
  columnAnchor,
  linksOf,
  relationAnchor,
} from "./diagram";

const COLUMN_GAP = 120;
const ROW_GAP = 48;
const GROUP_GAP = 320;
/** Width over height: of a group, of the sheet. */
const GROUP_SHAPE = 1.3;
const SHEET_SHAPE = 1.6;
/** So few models read as one group, whatever their lines. */
const ONE_GROUP = 8;
const SWEEPS = 8;
/** The most room lines may open between two cards of a column. */
const WIDEST_GAP = ROW_GAP * 2;
/** How much a card with no line to pull it wants to stay where it is. */
const REST = 0.01;

type Point = { x: number; y: number };

interface Line {
  readonly from: string;
  readonly fromRow: number;
  readonly to: string;
  readonly toRow: number;
}

interface Graph {
  readonly names: readonly string[];
  readonly height: ReadonlyMap<string, number>;
  readonly lines: readonly Line[];
}

function graphOf(schema: StudioSchema): Graph {
  const rows = new Map(
    schema.models.map((model) => {
      const at = new Map<string, number>();
      model.fields.forEach((field, index) => {
        at.set(
          columnAnchor(field.name),
          CARD_HEADER + (index + 0.5) * CARD_ROW
        );
      });
      model.relations.forEach((relation, index) => {
        at.set(
          relationAnchor(relation.name),
          CARD_HEADER + 9 + (model.fields.length + index + 0.5) * CARD_ROW
        );
      });
      return [model.name, at] as const;
    })
  );
  const known = (name: string) => rows.has(name);
  const row = (model: string, anchor: string) =>
    rows.get(model)?.get(anchor) ?? CARD_HEADER;
  return {
    names: schema.models.map((model) => model.name).sort(compareNames),
    height: new Map(
      schema.models.map((model) => [model.name, cardHeight(model)])
    ),
    lines: linksOf(schema)
      .filter(
        (link) => link.from !== link.to && known(link.from) && known(link.to)
      )
      .map((link) => ({
        from: link.from,
        fromRow: row(link.from, link.fromAnchor),
        to: link.to,
        toRow: row(link.to, link.toAnchor),
      }))
      .sort(
        (a, b) =>
          compareNames(a.from, b.from) ||
          compareNames(a.to, b.to) ||
          a.fromRow - b.fromRow ||
          a.toRow - b.toRow
      ),
  };
}

const compareNames = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The groups: a greedy modularity partition (Louvain). A line counts for less
 * the more lines its two models hold, so a model everything points to (a
 * user, an organization) does not pull the whole schema into its group.
 */
function groupsOf(graph: Graph): string[][] {
  const degree = new Map<string, number>();
  for (const line of graph.lines) {
    degree.set(line.from, (degree.get(line.from) ?? 0) + 1);
    degree.set(line.to, (degree.get(line.to) ?? 0) + 1);
  }
  const joined = graph.names.filter((name) => degree.has(name));
  const alone = graph.names.filter((name) => !degree.has(name));
  if (joined.length <= ONE_GROUP) {
    return alone.length > 0 && joined.length > 0
      ? [joined, alone]
      : [joined.length > 0 ? joined : alone];
  }
  // Every step works on the groups of the step before, starting with models.
  let weights = new Map<string, Map<string, number>>(
    joined.map((name) => [name, new Map()])
  );
  const add = (
    into: Map<string, Map<string, number>>,
    a: string,
    b: string,
    weight: number
  ) => {
    const row = into.get(a) ?? new Map<string, number>();
    row.set(b, (row.get(b) ?? 0) + weight);
    into.set(a, row);
  };
  for (const line of graph.lines) {
    const weight =
      1 / Math.sqrt((degree.get(line.from) ?? 1) * (degree.get(line.to) ?? 1));
    add(weights, line.from, line.to, weight);
    add(weights, line.to, line.from, weight);
  }
  let members = new Map(joined.map((name) => [name, [name]]));
  for (;;) {
    const merged = localMoves(weights);
    const groups = new Set(merged.values());
    if (groups.size === weights.size) break;
    const nextMembers = new Map<string, string[]>();
    const nextWeights = new Map<string, Map<string, number>>();
    for (const group of groups) nextWeights.set(group, new Map());
    for (const [node, group] of merged) {
      nextMembers.set(group, [
        ...(nextMembers.get(group) ?? []),
        ...(members.get(node) ?? []),
      ]);
      for (const [other, weight] of weights.get(node) ?? []) {
        add(nextWeights, group, merged.get(other) ?? other, weight);
      }
    }
    members = nextMembers;
    weights = nextWeights;
  }
  const groups = [...members.values()].map((group) => group.sort(compareNames));
  return alone.length > 0 ? [...groups, alone] : groups;
}

/** One Louvain pass: each node moves to the neighbouring group that gains most. */
function localMoves(
  weights: ReadonlyMap<string, ReadonlyMap<string, number>>
): Map<string, string> {
  const nodes = [...weights.keys()].sort(compareNames);
  const strength = new Map(
    nodes.map((node) => [
      node,
      [...(weights.get(node)?.values() ?? [])].reduce((a, b) => a + b, 0),
    ])
  );
  const total = [...strength.values()].reduce((a, b) => a + b, 0);
  const groupOf = new Map(nodes.map((node) => [node, node]));
  const groupStrength = new Map(strength);
  for (let moved = true; moved; ) {
    moved = false;
    for (const node of nodes) {
      const own = strength.get(node) ?? 0;
      const current = groupOf.get(node) ?? node;
      groupStrength.set(current, (groupStrength.get(current) ?? 0) - own);
      const toward = new Map<string, number>();
      for (const [other, weight] of weights.get(node) ?? []) {
        if (other === node) continue;
        const group = groupOf.get(other) ?? other;
        toward.set(group, (toward.get(group) ?? 0) + weight);
      }
      const gain = (group: string) =>
        (toward.get(group) ?? 0) -
        ((groupStrength.get(group) ?? 0) * own) / total;
      let best = current;
      let bestGain = gain(current);
      for (const group of [...toward.keys()].sort(compareNames)) {
        const value = gain(group);
        if (value > bestGain + 1e-9) {
          best = group;
          bestGain = value;
        }
      }
      groupStrength.set(best, (groupStrength.get(best) ?? 0) + own);
      if (best !== current) {
        groupOf.set(node, best);
        moved = true;
      }
    }
  }
  return groupOf;
}

interface Block {
  readonly at: ReadonlyMap<string, Point>;
  readonly width: number;
  readonly height: number;
}

/**
 * How far right of the models it points to a model stands, counted in columns.
 * A loop of relations stops where it would come back. A model only pointed to
 * then moves up beside the nearest model pointing to it.
 */
function levelsOf(
  names: readonly string[],
  lines: readonly Line[]
): Map<string, number> {
  const targets = new Map<string, string[]>();
  const pointers = new Map<string, string[]>();
  for (const line of lines) {
    targets.set(line.from, [...(targets.get(line.from) ?? []), line.to]);
    pointers.set(line.to, [...(pointers.get(line.to) ?? []), line.from]);
  }
  const levels = new Map<string, number>();
  const levelOf = (name: string, path: ReadonlySet<string>): number => {
    const known = levels.get(name);
    if (known !== undefined) return known;
    const through = new Set([...path, name]);
    let level = 0;
    for (const target of targets.get(name) ?? []) {
      if (!path.has(target) && target !== name) {
        level = Math.max(level, 1 + levelOf(target, through));
      }
    }
    levels.set(name, level);
    return level;
  };
  for (const name of names) levelOf(name, new Set());
  for (const name of names) {
    if ((targets.get(name) ?? []).length > 0) continue;
    const nearest = Math.min(
      ...(pointers.get(name) ?? []).map((p) => levels.get(p) ?? 0)
    );
    if (Number.isFinite(nearest) && nearest > 0) {
      levels.set(name, nearest - 1);
    }
  }
  return levels;
}

/**
 * The places that keep a column in its order, as near as they can to the ones
 * its cards want (weighted least squares, by pooling adjacent violators).
 */
function settle(
  cards: readonly { want: number; pull: number; height: number }[]
): number[] {
  const pools: { sum: number; pull: number; size: number }[] = [];
  let offset = 0;
  const offsets: number[] = [];
  for (const card of cards) {
    offsets.push(offset);
    offset += card.height + ROW_GAP;
    pools.push({
      sum: (card.want - (offsets.at(-1) ?? 0)) * card.pull,
      pull: card.pull,
      size: 1,
    });
    while (pools.length > 1) {
      const last = pools.at(-1);
      const previous = pools.at(-2);
      if (
        !(last && previous) ||
        previous.sum / previous.pull <= last.sum / last.pull
      ) {
        break;
      }
      previous.sum += last.sum;
      previous.pull += last.pull;
      previous.size += last.size;
      pools.pop();
    }
  }
  const wanted: number[] = [];
  for (const pool of pools) {
    for (let index = 0; index < pool.size; index += 1) {
      wanted.push(pool.sum / pool.pull + (offsets[wanted.length] ?? 0));
    }
  }
  // Lines may pull a column apart: it closes up, around where they want it.
  let closed = 0;
  let drift = 0;
  let pull = 0;
  const places = cards.map((card, index) => {
    const above = cards[index - 1];
    if (above) {
      const gap =
        (wanted[index] ?? 0) - (wanted[index - 1] ?? 0) - above.height;
      closed += Math.max(0, gap - WIDEST_GAP);
    }
    const place = (wanted[index] ?? 0) - closed;
    drift += (card.want - place) * card.pull;
    pull += card.pull;
    return place;
  });
  return places.map((place) => place + drift / pull);
}

/** One group, laid out alone: its columns, each wrapped at the group's height. */
function blockOf(names: readonly string[], graph: Graph): Block {
  const inside = new Set(names);
  const lines = graph.lines.filter(
    (line) => inside.has(line.from) && inside.has(line.to)
  );
  const height = (name: string) => graph.height.get(name) ?? 0;
  const levels = levelsOf(names, lines);
  const area = names.reduce(
    (sum, name) => sum + (height(name) + ROW_GAP) * (CARD_WIDTH + COLUMN_GAP),
    0
  );
  const limit = Math.max(...names.map(height), Math.sqrt(area / GROUP_SHAPE));
  const byLevel = new Map<number, string[]>();
  for (const name of names) {
    const level = levels.get(name) ?? 0;
    byLevel.set(level, [...(byLevel.get(level) ?? []), name]);
  }
  // A level taller than the limit wraps into columns side by side, each about
  // as tall, keeping cards joined to the same neighbours next to each other.
  const neighbours = (name: string) =>
    lines.flatMap((line) =>
      line.from === name ? [line.to] : line.to === name ? [line.from] : []
    );
  const pointedTo = new Set(lines.map((line) => line.to));
  const columns: string[][] = [];
  const levelNumbers = [...byLevel.keys()].sort((a, b) => a - b);
  const rank = new Map(names.map((name, index) => [name, index]));
  for (const level of levelNumbers) {
    const cards = [...(byLevel.get(level) ?? [])].sort((a, b) => {
      const mean = (name: string) => {
        const around = neighbours(name).map((n) => rank.get(n) ?? 0);
        return around.length === 0
          ? (rank.get(name) ?? 0)
          : around.reduce((x, y) => x + y, 0) / around.length;
      };
      return mean(a) - mean(b) || compareNames(a, b);
    });
    cards.forEach((name, index) => {
      rank.set(name, index);
    });
    const total = cards.reduce((sum, n) => sum + height(n) + ROW_GAP, 0);
    const wraps = Math.max(1, Math.ceil(total / limit));
    const share = total / wraps;
    const wrapped: string[][] = [[]];
    let filled = 0;
    for (const name of cards) {
      const size = height(name) + ROW_GAP;
      if ((wrapped.at(-1)?.length ?? 0) > 0 && filled + size / 2 > share) {
        wrapped.push([]);
        filled = 0;
      }
      wrapped.at(-1)?.push(name);
      filled += size;
    }
    // Many models pointing to the first column, and pointed to by none: every
    // other column of them stands left of it, so their lines stay short.
    wrapped.forEach((column, index) => {
      const onLeft =
        level === levelNumbers[1] &&
        index % 2 === 1 &&
        column.every((name) => !pointedTo.has(name));
      if (onLeft) columns.unshift(column);
      else columns.push(column);
    });
  }

  const columnOf = new Map<string, number>();
  columns.forEach((column, index) => {
    for (const name of column) columnOf.set(name, index);
  });
  const y = new Map<string, number>();
  for (const column of columns) {
    let top = 0;
    for (const name of column) {
      y.set(name, top);
      top += height(name) + ROW_GAP;
    }
  }
  // Sweeps across the columns: each card wants its lines level, the lines of
  // the nearest columns first; a column reorders and settles around that.
  const sweep = (index: number) => {
    const column = columns[index] ?? [];
    const wants = new Map(
      column.map((name) => {
        let sum = 0;
        let pull = 0;
        for (const line of lines) {
          const mine = line.from === name;
          if (!(mine || line.to === name)) continue;
          const other = mine ? line.to : line.from;
          const span = Math.abs((columnOf.get(other) ?? 0) - index);
          if (span === 0) continue;
          const weight = 1 / span;
          const otherRow =
            (y.get(other) ?? 0) + (mine ? line.toRow : line.fromRow);
          sum += (otherRow - (mine ? line.fromRow : line.toRow)) * weight;
          pull += weight;
        }
        return [
          name,
          pull === 0
            ? { want: y.get(name) ?? 0, pull: REST }
            : { want: sum / pull, pull },
        ] as const;
      })
    );
    const center = (name: string) =>
      (wants.get(name)?.want ?? 0) + height(name) / 2;
    column.sort((a, b) => center(a) - center(b) || compareNames(a, b));
    const places = settle(
      column.map((name) => ({
        want: wants.get(name)?.want ?? 0,
        pull: wants.get(name)?.pull ?? REST,
        height: height(name),
      }))
    );
    column.forEach((name, row) => {
      y.set(name, places[row] ?? 0);
    });
  };
  for (let pass = 0; pass < SWEEPS; pass += 1) {
    if (pass % 2 === 0) {
      for (let index = 0; index < columns.length; index += 1) sweep(index);
    } else {
      for (let index = columns.length - 1; index >= 0; index -= 1) sweep(index);
    }
  }
  const top = Math.min(...names.map((name) => y.get(name) ?? 0));
  const bottom = Math.max(
    ...names.map((name) => (y.get(name) ?? 0) + height(name))
  );
  return {
    at: new Map(
      names.map((name) => [
        name,
        {
          x: (columnOf.get(name) ?? 0) * (CARD_WIDTH + COLUMN_GAP),
          y: (y.get(name) ?? 0) - top,
        },
      ])
    ),
    width: columns.length * (CARD_WIDTH + COLUMN_GAP) - COLUMN_GAP,
    height: bottom - top,
  };
}

/** Models with no line at all, in rows, by name. */
function shelfOf(names: readonly string[], graph: Graph): Block {
  const tall = names.reduce(
    (sum, name) => sum + (graph.height.get(name) ?? 0) + ROW_GAP,
    0
  );
  const across = Math.max(
    1,
    Math.round(Math.sqrt((SHEET_SHAPE * tall) / (CARD_WIDTH + COLUMN_GAP)))
  );
  const at = new Map<string, Point>();
  let top = 0;
  let width = 0;
  for (let row = 0; row * across < names.length; row += 1) {
    const cards = names.slice(row * across, (row + 1) * across);
    cards.forEach((name, column) => {
      at.set(name, { x: column * (CARD_WIDTH + COLUMN_GAP), y: top });
    });
    width = Math.max(
      width,
      cards.length * (CARD_WIDTH + COLUMN_GAP) - COLUMN_GAP
    );
    top +=
      Math.max(...cards.map((name) => graph.height.get(name) ?? 0)) + ROW_GAP;
  }
  return { at, width, height: top - ROW_GAP };
}

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
) =>
  a.x < b.x + b.width + GROUP_GAP &&
  b.x < a.x + a.width + GROUP_GAP &&
  a.y < b.y + b.height + GROUP_GAP &&
  b.y < a.y + a.height + GROUP_GAP;

/**
 * The sheet: the most joined group first, then each next group where its lines
 * to the groups already placed are shortest and the sheet stays screen-shaped,
 * mirrored when that brings it nearer. Lines to a group yet to come count when
 * that group is placed.
 */
function packed(blocks: readonly Block[], graph: Graph): Map<string, Point> {
  const owner = new Map<string, number>();
  blocks.forEach((block, index) => {
    for (const name of block.at.keys()) owner.set(name, index);
  });
  const across = graph.lines.filter(
    (line) => owner.get(line.from) !== owner.get(line.to)
  );
  const between = (index: number, placed: ReadonlySet<number>) =>
    across.filter((line) => {
      const a = owner.get(line.from);
      const b = owner.get(line.to);
      return (
        (a === index && placed.has(b ?? -1)) ||
        (b === index && placed.has(a ?? -1))
      );
    });
  const lineCount = blocks.map(
    (_, index) =>
      across.filter(
        (line) => owner.get(line.from) === index || owner.get(line.to) === index
      ).length
  );
  const area = (block: Block) => block.width * block.height;
  const remaining = new Set(blocks.map((_, index) => index));
  const placed = new Set<number>();
  const rects: { x: number; y: number; width: number; height: number }[] = [];
  const at = new Map<string, Point>();
  const centerOf = (name: string, point: Point): Point => ({
    x: point.x + CARD_WIDTH / 2,
    y: point.y + (graph.height.get(name) ?? 0) / 2,
  });

  while (remaining.size > 0) {
    const order = [...remaining].sort((a, b) => {
      const links = (index: number) => between(index, placed).length;
      const blockA = blocks[a];
      const blockB = blocks[b];
      return (
        links(b) - links(a) ||
        (lineCount[b] ?? 0) - (lineCount[a] ?? 0) ||
        (blockB ? area(blockB) : 0) - (blockA ? area(blockA) : 0) ||
        a - b
      );
    });
    const index = order[0] ?? 0;
    const block = blocks[index];
    remaining.delete(index);
    if (!block) continue;
    const size = { width: block.width, height: block.height };
    const candidates: Point[] = [];
    for (const rect of rects) {
      const xs = [
        rect.x,
        rect.x + rect.width - size.width,
        rect.x + (rect.width - size.width) / 2,
      ];
      const ys = [
        rect.y,
        rect.y + rect.height - size.height,
        rect.y + (rect.height - size.height) / 2,
      ];
      for (const y of ys) {
        candidates.push({ x: rect.x + rect.width + GROUP_GAP, y });
        candidates.push({ x: rect.x - size.width - GROUP_GAP, y });
      }
      for (const x of xs) {
        candidates.push({ x, y: rect.y + rect.height + GROUP_GAP });
        candidates.push({ x, y: rect.y - size.height - GROUP_GAP });
      }
    }
    if (rects.length === 0) candidates.push({ x: 0, y: 0 });
    const lines = between(index, placed);
    let best: { score: number; point: Point; mirror: boolean } | undefined;
    for (const point of candidates) {
      if (rects.some((rect) => overlaps({ ...point, ...size }, rect))) continue;
      const left = Math.min(point.x, ...rects.map((rect) => rect.x));
      const right = Math.max(
        point.x + size.width,
        ...rects.map((rect) => rect.x + rect.width)
      );
      const top = Math.min(point.y, ...rects.map((rect) => rect.y));
      const bottom = Math.max(
        point.y + size.height,
        ...rects.map((rect) => rect.y + rect.height)
      );
      const sheet = Math.max((right - left) / SHEET_SHAPE, bottom - top);
      for (const mirror of [false, true]) {
        const place = (name: string): Point => {
          const local = block.at.get(name) ?? { x: 0, y: 0 };
          return {
            x: point.x + (mirror ? size.width - CARD_WIDTH - local.x : local.x),
            y: point.y + local.y,
          };
        };
        let length = 0;
        for (const line of lines) {
          const mine = owner.get(line.from) === index;
          const own = mine ? line.from : line.to;
          const other = mine ? line.to : line.from;
          const a = centerOf(own, place(own));
          const b = centerOf(other, at.get(other) ?? { x: 0, y: 0 });
          length += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        }
        const score = length + (lines.length + 2) * sheet;
        if (!best || score < best.score - 1e-6) {
          best = { score, point, mirror };
        }
      }
    }
    const { point, mirror } = best ?? {
      point: { x: 0, y: 0 },
      mirror: false,
    };
    for (const [name, local] of block.at) {
      at.set(name, {
        x: point.x + (mirror ? size.width - CARD_WIDTH - local.x : local.x),
        y: point.y + local.y,
      });
    }
    rects.push({ ...point, ...size });
    placed.add(index);
  }
  const left = Math.min(...[...at.values()].map((point) => point.x));
  const top = Math.min(...[...at.values()].map((point) => point.y));
  return new Map(
    [...at].map(([name, point]) => [
      name,
      { x: Math.round(point.x - left), y: Math.round(point.y - top) },
    ])
  );
}

/** Where each card stands: see the top of this file. */
export function schemaLayout(schema: StudioSchema): Map<string, Point> {
  if (schema.models.length === 0) return new Map();
  const graph = graphOf(schema);
  const joined = new Set(graph.lines.flatMap((line) => [line.from, line.to]));
  const blocks = groupsOf(graph).map((names) =>
    names.some((name) => joined.has(name))
      ? blockOf(names, graph)
      : shelfOf(names, graph)
  );
  return packed(blocks, graph);
}

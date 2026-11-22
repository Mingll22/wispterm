import type { WorkspaceNode } from "../workspace_protocol";

type Axis = "x" | "y";
export type DropEdge = "left" | "right" | "top" | "bottom" | "center";
export type WorkspaceTree =
  | { surfaceId: string }
  | { axis: Axis; ratio: number; first: WorkspaceTree; last: WorkspaceTree };

export type PaneRect = { x: number; y: number; width: number; height: number };
type WorkspacePane = PaneRect & { surfaceId: string };
type Divider = { path: string; axis: Axis; at: number; start: number; end: number };
export type SplitTrack = Omit<Divider, "path"> & { paths: string[] };
export type WorkspaceGeometry = { panes: WorkspacePane[]; dividers: Divider[] };

export const WEB_PANE_LIMIT = 4;
const EPSILON = 0.00001;
const WORKSPACE_RECT: PaneRect = { x: 0, y: 0, width: 1, height: 1 };

function equal(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

// The wire parser has already checked that the preorder contains one complete tree.
export function workspaceTree(nodes: WorkspaceNode[]): WorkspaceTree {
  let index = 0;
  function readNode(): WorkspaceTree {
    const node = nodes[index++];
    if ("surfaceId" in node) return node;
    return { ...node, first: readNode(), last: readNode() };
  }
  return readNode();
}

export function workspaceNodes(tree: WorkspaceTree): WorkspaceNode[] {
  const nodes: WorkspaceNode[] = [];
  function append(node: WorkspaceTree): void {
    if ("surfaceId" in node) {
      nodes.push(node);
    } else {
      nodes.push({ axis: node.axis, ratio: node.ratio });
      append(node.first);
      append(node.last);
    }
  }
  append(tree);
  return nodes;
}

function partition(rect: PaneRect, axis: Axis, at: number): [PaneRect, PaneRect] {
  if (axis === "x") return [
    { ...rect, width: at - rect.x },
    { ...rect, x: at, width: rect.x + rect.width - at },
  ];
  return [
    { ...rect, height: at - rect.y },
    { ...rect, y: at, height: rect.y + rect.height - at },
  ];
}

export function workspaceGeometry(tree: WorkspaceTree): WorkspaceGeometry {
  const panes: WorkspacePane[] = [];
  const dividers: Divider[] = [];

  function place(node: WorkspaceTree, rect: PaneRect, path: string): void {
    if ("surfaceId" in node) {
      panes.push({ surfaceId: node.surfaceId, ...rect });
      return;
    }
    const { x, y, width, height } = rect;
    const inX = node.axis === "x";
    const at = inX ? x + width * node.ratio : y + height * node.ratio;
    dividers.push({ path, axis: node.axis, at, start: inX ? y : x, end: inX ? y + height : x + width });
    const [first, last] = partition(rect, node.axis, at);
    place(node.first, first, path + "0");
    place(node.last, last, path + "1");
  }

  place(tree, WORKSPACE_RECT, "root");
  panes.sort((a, b) => equal(a.y, b.y) ? a.x - b.x : a.y - b.y);
  return { panes, dividers };
}

export function resetSplitRatios(tree: WorkspaceTree): WorkspaceTree {
  if ("surfaceId" in tree) return tree;
  const first = resetSplitRatios(tree.first);
  const last = resetSplitRatios(tree.last);
  if (first === tree.first && last === tree.last && tree.ratio === 0.5) return tree;
  return { axis: tree.axis, ratio: 0.5, first, last };
}

function mapLeaves(tree: WorkspaceTree, transform: (surfaceId: string) => WorkspaceTree): WorkspaceTree {
  if ("surfaceId" in tree) return transform(tree.surfaceId);
  return { ...tree, first: mapLeaves(tree.first, transform), last: mapLeaves(tree.last, transform) };
}

function removeLeaf(tree: WorkspaceTree, surfaceId: string): WorkspaceTree | null {
  if ("surfaceId" in tree) return tree.surfaceId === surfaceId ? null : tree;
  const first = removeLeaf(tree.first, surfaceId);
  const last = removeLeaf(tree.last, surfaceId);
  return first && last ? { ...tree, first, last } : first ?? last;
}

export function rearrangePanes(tree: WorkspaceTree, source: string, target: string, edge: DropEdge): WorkspaceTree {
  if (source === target) return tree;
  if (edge === "center") {
    return resetSplitRatios(mapLeaves(tree, (surfaceId) => ({
      surfaceId: surfaceId === source ? target : surfaceId === target ? source : surfaceId,
    })));
  }

  const remaining = removeLeaf(tree, source);
  if (!remaining) return tree;
  const inX = edge === "left" || edge === "right";
  const sourceFirst = edge === "left" || edge === "top";
  const destination: WorkspaceTree = {
    axis: inX ? "x" : "y", ratio: 0.5,
    first: { surfaceId: sourceFirst ? source : target },
    last: { surfaceId: sourceFirst ? target : source },
  };
  return resetSplitRatios(mapLeaves(remaining, (surfaceId) => surfaceId === target ? destination : { surfaceId }));
}

export function sharedSplitTracks(dividers: Divider[]): SplitTrack[] {
  const tracks: SplitTrack[] = [];
  for (const divider of [...dividers].sort((a, b) => a.start - b.start)) {
    const track = tracks.find((item) => item.axis === divider.axis && equal(item.at, divider.at) && equal(item.end, divider.start));
    if (track) {
      track.end = divider.end;
      track.paths.push(divider.path);
    } else {
      const { path, ...geometry } = divider;
      tracks.push({ ...geometry, paths: [path] });
    }
  }
  return tracks;
}

export function resizeSplitTrack(
  tree: WorkspaceTree,
  geometry: WorkspaceGeometry,
  tracks: SplitTrack[],
  track: SplitTrack,
  requested: number,
  viewportLength: number,
): WorkspaceTree {
  if (viewportLength <= 0) return tree;
  const inX = track.axis === "x";
  const minimum = Math.min((inX ? 132 : 96) / viewportLength, 0.2);
  let min = 0;
  let max = 1;
  for (const pane of geometry.panes) {
    const acrossStart = inX ? pane.y : pane.x;
    const acrossEnd = acrossStart + (inX ? pane.height : pane.width);
    if (acrossEnd <= track.start + EPSILON || acrossStart >= track.end - EPSILON) continue;
    const from = inX ? pane.x : pane.y;
    const span = inX ? pane.width : pane.height;
    const gap = Math.min(span, minimum);
    if (equal(from + span, track.at)) min = Math.max(min, from + gap);
    if (equal(from, track.at)) max = Math.min(max, from + span - gap);
  }
  const snap = tracks.find((other) => other !== track && other.axis === track.axis &&
    (equal(other.end, track.start) || equal(other.start, track.end)) &&
    other.at >= min && other.at <= max && Math.abs(other.at - requested) * viewportLength <= 10);
  const at = Math.min(max, Math.max(min, snap?.at ?? requested));
  if (equal(at, track.at)) return tree;

  // Translate the selected edge and keep unrelated edges at their absolute positions.
  const positions = new Map(geometry.dividers.map((divider) => [divider.path, divider.at]));
  for (const path of track.paths) positions.set(path, at);

  function move(node: WorkspaceTree, rect: PaneRect, path: string): WorkspaceTree {
    if ("surfaceId" in node) return node;
    const coordinate = positions.get(path)!;
    const ratio = node.axis === "x" ? (coordinate - rect.x) / rect.width : (coordinate - rect.y) / rect.height;
    const [first, last] = partition(rect, node.axis, coordinate);
    return { ...node, ratio, first: move(node.first, first, path + "0"), last: move(node.last, last, path + "1") };
  }

  return move(tree, WORKSPACE_RECT, "root");
}

export function paneDropEdge(rect: DOMRect, clientX: number, clientY: number): DropEdge {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const distances = [[x, "left"], [1 - x, "right"], [y, "top"], [1 - y, "bottom"]] as const;
  const [distance, edge] = distances.reduce((nearest, entry) => entry[0] < nearest[0] ? entry : nearest);
  return distance < 0.24 ? edge : "center";
}

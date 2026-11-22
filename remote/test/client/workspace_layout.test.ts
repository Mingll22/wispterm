import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLayout, resolveLayoutSelection } from "../../src/client/layout";
import {
  rearrangePanes, resetSplitRatios, resizeSplitTrack, sharedSplitTracks,
  workspaceGeometry, workspaceNodes, workspaceTree,
} from "../../src/client/workspace_layout";

const a = { surfaceId: "0000000000000001" };
const b = { surfaceId: "0000000000000002" };
const c = { surfaceId: "0000000000000003" };
const d = { surfaceId: "0000000000000004" };
const rootX = { axis: "x", ratio: 0.5 } as const;
const rootY = { axis: "y", ratio: 0.5 } as const;

test("creates in screen order and joins contiguous collinear dividers", () => {
  const tree = workspaceTree([rootX, rootY, a, c, rootY, b, d]);
  const geometry = workspaceGeometry(tree);
  assert.deepEqual(geometry.panes.map((pane) => pane.surfaceId), [a, b, c, d].map((pane) => pane.surfaceId));
  const tracks = sharedSplitTracks(geometry.dividers);
  const shared = tracks.find((track) => track.axis === "y")!;
  assert.deepEqual(shared, { axis: "y", at: 0.5, start: 0, end: 1, paths: ["root0", "root1"] });
  const moved = resizeSplitTrack(tree, geometry, tracks, shared, 0.65, 800);
  assert.deepEqual(workspaceNodes(moved), [rootX, { ...rootY, ratio: 0.65 }, a, c, { ...rootY, ratio: 0.65 }, b, d]);
  assert.deepEqual(workspaceNodes(resetSplitRatios(moved)), workspaceNodes(tree));
});

test("center swaps identities and an edge rebuilds topology with half-size splits", () => {
  const tree = workspaceTree([{ ...rootX, ratio: 0.7 }, a, { ...rootY, ratio: 0.4 }, b, c]);
  const swapped = rearrangePanes(tree, a.surfaceId, c.surfaceId, "center");
  assert.deepEqual(workspaceNodes(swapped), [rootX, c, rootY, b, a]);
  const moved = rearrangePanes(tree, a.surfaceId, c.surfaceId, "bottom");
  assert.deepEqual(workspaceNodes(moved), [rootY, b, rootY, c, a]);
});

test("resizing one nested cut keeps the other cut in place with positive panes", () => {
  const tree = workspaceTree([rootX, rootX, a, b, c]);
  const geometry = workspaceGeometry(tree);
  const tracks = sharedSplitTracks(geometry.dividers);
  const root = tracks.find((track) => track.paths[0] === "root")!;
  const moved = resizeSplitTrack(tree, geometry, tracks, root, 0.05, 1000);
  const resized = workspaceGeometry(moved);
  assert.equal(resized.dividers.find((entry) => entry.path === "root0")?.at, 0.25);
  assert.ok(resized.panes.every((pane) => pane.width >= 0.132 - 1e-12));
});

test("authored tabs follow stable identity through index changes and reject inconsistent trees", () => {
  const tab = {
    index: 1, tabId: "1111111111111111", layoutRevision: "2222222222222222",
    splitTree: [rootX, a, b], surfaces: [{ id: b.surfaceId }, { id: a.surfaceId }],
  };
  const initial = normalizeLayout({ type: "layout", activeTab: 1, workspaceActions: true, tabs: [tab] });
  assert.deepEqual(initial.tabs[0].surfaces.map(({ id }) => id), [a.surfaceId, b.surfaceId]);
  const shifted = normalizeLayout({ type: "layout", activeTab: 1, workspaceActions: true, tabs: [
    { ...tab, index: 0 },
    { ...tab, tabId: "3333333333333333", surfaces: [{ id: c.surfaceId }, { id: c.surfaceId }] },
  ] });
  assert.deepEqual(resolveLayoutSelection(shifted, initial.tabs[0], b.surfaceId), { tabIndex: 0, surfaceId: b.surfaceId });
  assert.equal(shifted.tabs[1].workspace, undefined);
});

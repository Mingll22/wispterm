//! Desktop workspace commands. The window thread owns the live tab tree.

const std = @import("std");
const config = @import("../config.zig");
const remote_workspace = @import("../remote_workspace.zig");
const Surface = @import("../Surface.zig");
const remote_control = @import("../remote_terminal_control.zig");
const remote_hub = @import("../remote_hub.zig");
const SplitTree = @import("../split_tree.zig");
const tab = @import("tab.zig");

const Handle = SplitTree.Node.Handle;
const GridSize = @import("../core/geometry.zig").GridSize;

const max_web_panes = 4;

pub const Host = struct {
    allocator: std.mem.Allocator,
    grid: GridSize,
    can_mutate: bool = true,
    cell_width: f32,
    cell_height: f32,
    cursor_style: config.CursorStyle,
    cursor_blink: bool,
    surfaceProtected: *const fn (*Surface) bool,
    closeTab: *const fn (usize) void,
    tabSpawned: *const fn () void,
    layoutChanged: *const fn (*tab.TabState, ?remote_workspace.Id) void,
};

fn revision(tree: *const SplitTree) remote_workspace.Id {
    var hash = std.hash.Wyhash.init(0);
    hashNode(tree, .root, &hash);
    return remote_workspace.formatId(hash.final());
}

fn hashNode(tree: *const SplitTree, handle: Handle, hash: *std.hash.Wyhash) void {
    switch (tree.nodes[handle.idx()]) {
        .leaf => |leaf| {
            hash.update("s");
            hash.update(&leaf.terminal.remote_id);
        },
        .split => |split| {
            hash.update(switch (split.layout) {
                .horizontal => "x",
                .vertical => "y",
            });
            var ratio_bytes: [2]u8 = undefined;
            std.mem.writeInt(u16, &ratio_bytes, @bitCast(split.ratio), .little);
            hash.update(&ratio_bytes);
            hashNode(tree, split.left, hash);
            hashNode(tree, split.right, hash);
        },
    }
}

pub fn appendLayoutFields(allocator: std.mem.Allocator, out: *std.ArrayListUnmanaged(u8), state: *tab.TabState) !void {
    const id = state.publishRemoteWorkspace() orelse return;
    const layout_revision = revision(&state.tree);
    try out.print(allocator, ",\"tabId\":\"{s}\",\"layoutRevision\":\"{s}\",\"splitTree\":[", .{ &id, &layout_revision });
    try appendNode(allocator, out, &state.tree, .root);
    try out.append(allocator, ']');
}

fn appendNode(allocator: std.mem.Allocator, out: *std.ArrayListUnmanaged(u8), tree: *const SplitTree, handle: Handle) std.mem.Allocator.Error!void {
    switch (tree.nodes[handle.idx()]) {
        .leaf => |leaf| try out.print(allocator, "{{\"surfaceId\":\"{s}\"}}", .{&leaf.terminal.remote_id}),
        .split => |split| {
            const axis: u8 = if (split.layout == .horizontal) 'x' else 'y';
            try out.print(allocator, "{{\"axis\":\"{c}\",\"ratio\":{d}}},", .{ axis, @as(f64, split.ratio) });
            try appendNode(allocator, out, tree, split.left);
            try out.append(allocator, ',');
            try appendNode(allocator, out, tree, split.right);
        },
    }
}

pub fn apply(host: Host, request: remote_workspace.Request) remote_workspace.Result {
    if (request.action == .@"create-tab") {
        if (!host.can_mutate) return .{ .status = .stale };
        if (tab.g_tab_count >= tab.MAX_TABS) return .{ .status = .limit };
        if (!tab.spawnTabWithCwd(host.allocator, host.grid.cols, host.grid.rows, host.cursor_style, host.cursor_blink, null)) return .{ .status = .failed };
        const state = tab.activeTab().?;
        const surface = state.focusedSurface().?;
        host.tabSpawned();
        return .{ .status = .ok, .tab_id = state.publishRemoteWorkspace(), .surface_id = surface.remote_id };
    }

    const id = request.tabId orelse return .{ .status = .failed };
    const target = findTab(id) orelse return .{ .status = .stale };
    return applyToTab(host, request, target.index, target.state);
}

pub fn findTab(id: remote_workspace.Id) ?struct { index: usize, state: *tab.TabState } {
    for (tab.g_tabs[0..tab.g_tab_count], 0..) |candidate, index| {
        const state = candidate orelse continue;
        const current_id = state.workspace_id orelse continue;
        if (std.mem.eql(u8, &current_id, &id)) return .{ .index = index, .state = state };
    }
    return null;
}

fn applyToTab(host: Host, request: remote_workspace.Request, index: usize, state: *tab.TabState) remote_workspace.Result {
    if (!state.supportsRemoteWorkspace()) return .{ .status = .unsupported };
    const identity: remote_control.Identity = .{ .client_id = request.clientId, .lease_id = request.leaseId };
    if (!state.remote_tab_control.lease.authorizes(identity)) return .{ .status = .denied };
    if (!host.can_mutate) return .{ .status = .stale };
    const requested_revision = request.layoutRevision orelse return .{ .status = .failed };
    const current_revision = revision(&state.tree);
    if (!std.mem.eql(u8, &current_revision, &requested_revision)) return .{ .status = .stale };

    switch (request.action) {
        .@"create-tab" => unreachable,
        .@"add-pane" => {
            if (state.tree.nodes.len >= 2 * max_web_panes - 1) return .{ .status = .limit };
            const target = findSurface(&state.tree, request.surfaceId.?) orelse return .{ .status = .stale };
            // The browser selected the last pane in the published geometry. Its
            // identity remains valid here after checking the exact tree revision.
            var spatial = state.tree.spatial(host.allocator) catch return .{ .status = .failed };
            defer spatial.deinit(host.allocator);
            const area = spatial.slots[target.handle.idx()];
            const direction: SplitTree.Split.Direction = if (area.width >= area.height) .right else .down;
            const surface = tab.splitWithDefaultShell(host.allocator, state, target, direction, host.cell_width, host.cell_height, host.cursor_style, host.cursor_blink) orelse return .{ .status = .failed };
            host.layoutChanged(state, null);
            return .{ .status = .ok, .tab_id = state.workspace_id, .surface_id = surface.remote_id };
        },
        .@"close-pane" => {
            const id = request.surfaceId.?;
            const target = findSurface(&state.tree, id) orelse return .{ .status = .stale };
            if (host.surfaceProtected(target.surface)) return .{ .status = .protected };
            if (!state.tree.isSplit()) {
                host.closeTab(index);
            } else {
                tab.removeSplitPane(host.allocator, state, target.handle, .remote) catch return .{ .status = .failed };
                host.layoutChanged(state, id);
            }
        },
        .@"close-tab" => {
            var surfaces = state.tree.surfaces();
            while (surfaces.next()) |entry| {
                if (host.surfaceProtected(entry.surface)) return .{ .status = .protected };
            }
            host.closeTab(index);
        },
        .@"set-layout" => {
            replaceLayout(host.allocator, state, request.splitTree.?) catch return .{ .status = .failed };
            host.layoutChanged(state, null);
        },
    }
    return .{ .status = .ok };
}

fn findSurface(tree: *const SplitTree, id: remote_workspace.Id) ?SplitTree.SurfaceEntry {
    var surfaces = tree.surfaces();
    while (surfaces.next()) |entry| {
        if (std.mem.eql(u8, &entry.surface.remote_id, &id)) return entry;
    }
    return null;
}

fn replaceLayout(allocator: std.mem.Allocator, state: *tab.TabState, requested_nodes: []const remote_workspace.Node) !void {
    if (requested_nodes.len != state.tree.nodes.len or !remote_workspace.validTree(requested_nodes)) return error.InvalidLayout;
    var nodes: [remote_workspace.max_tree_nodes]SplitTree.Node = undefined;
    var builder: LayoutBuilder = .{
        .old = state,
        .requested = requested_nodes,
        .nodes = nodes[0..requested_nodes.len],
    };
    _ = try builder.write();

    // A complete tree with the same node count has the same number of leaves.
    // The builder has matched every leaf to a different live surface.
    const new_tree = try SplitTree.cloneNodes(allocator, builder.nodes, builder.zoomed);
    var old_tree = state.tree;
    state.tree = new_tree;
    state.focused = builder.focused orelse state.tree.deepest(.left, .root);
    old_tree.deinit();
}

const LayoutBuilder = struct {
    old: *const tab.TabState,
    requested: []const remote_workspace.Node,
    nodes: []SplitTree.Node,
    cursor: usize = 0,
    used: std.StaticBitSet(remote_workspace.max_tree_nodes) = .initEmpty(),
    focused: ?Handle = null,
    zoomed: ?Handle = null,

    fn write(self: *LayoutBuilder) error{InvalidLayout}!Handle {
        const index = self.cursor;
        const handle: Handle = @enumFromInt(index);
        const node = self.requested[index];
        self.cursor += 1;
        if (node.surfaceId) |id| {
            const old_entry = findSurface(&self.old.tree, id) orelse return error.InvalidLayout;
            const old_index = old_entry.handle.idx();
            if (self.used.isSet(old_index)) return error.InvalidLayout;
            self.used.set(old_index);
            self.nodes[index] = .{ .leaf = .{ .terminal = old_entry.surface } };
            if (old_entry.handle == self.old.focused) self.focused = handle;
            if (old_entry.handle == self.old.tree.zoomed) self.zoomed = handle;
        } else {
            const ratio: f16 = @floatCast(node.ratio.?);
            if (ratio <= 0 or ratio >= 1) return error.InvalidLayout;
            const left = try self.write();
            const right = try self.write();
            self.nodes[index] = .{ .split = .{
                .layout = switch (node.axis.?) {
                    .x => .horizontal,
                    .y => .vertical,
                },
                .ratio = ratio,
                .left = left,
                .right = right,
            } };
        }
        return handle;
    }
};

test "workspace applies only a current revision and an exact surface permutation" {
    const allocator = std.testing.allocator;
    const saved_tabs = tab.g_tabs;
    const saved_count = tab.g_tab_count;
    defer {
        tab.g_tabs = saved_tabs;
        tab.g_tab_count = saved_count;
    }

    var a: Surface = undefined;
    a.remote_id = "0000000000000001".*;
    a.ref_count = 1;
    a.remote_terminal = .{ .enabled = true };
    a.confirmed_grid = .init(80 << 16 | 24);
    var b: Surface = undefined;
    b.remote_id = "0000000000000002".*;
    b.ref_count = 1;
    b.remote_terminal = .{ .enabled = true };
    b.confirmed_grid = .init(80 << 16 | 24);
    const nodes = [_]SplitTree.Node{
        .{ .split = .{ .layout = .horizontal, .ratio = 0.5, .left = @enumFromInt(1), .right = @enumFromInt(2) } },
        .{ .leaf = .{ .terminal = &a } },
        .{ .leaf = .{ .terminal = &b } },
    };
    var state: tab.TabState = .{
        .focused = @enumFromInt(1),
        .tree = try SplitTree.cloneNodes(allocator, &nodes, @enumFromInt(1)),
    };
    defer state.tree.deinit();
    tab.g_tabs = .{null} ** tab.MAX_TABS;
    tab.g_tabs[0] = &state;
    tab.g_tab_count = 1;

    const Hooks = struct {
        fn protected(surface: *Surface) bool {
            return surface.remote_id[15] == '2';
        }
        fn close(_: usize) void {
            @panic("test request must leave the live tab open");
        }
        fn spawn() void {
            @panic("test request must not create a tab");
        }
        fn changed(_: *tab.TabState, _: ?remote_workspace.Id) void {}
    };
    const host: Host = .{
        .allocator = allocator,
        .grid = .{},
        .cell_width = 8,
        .cell_height = 16,
        .cursor_style = .block,
        .cursor_blink = true,
        .surfaceProtected = Hooks.protected,
        .closeTab = Hooks.close,
        .tabSpawned = Hooks.spawn,
        .layoutChanged = Hooks.changed,
    };
    const initial_revision = revision(&state.tree);
    const id = state.publishRemoteWorkspace().?;
    var hub = remote_hub.Hub.init(allocator);
    defer hub.deinit();
    state.remote_tab_control.request(&state.tree, &hub, .{
        .type = "tab-control",
        .tabId = id,
        .clientId = "client",
        .action = .acquire,
    });
    const lease_id = state.remote_tab_control.lease.grant.?.id;
    var layout = [_]remote_workspace.Node{
        .{ .axis = .y, .ratio = 0.625 },
        .{ .surfaceId = b.remote_id },
        .{ .surfaceId = b.remote_id },
    };
    var request: remote_workspace.Request = .{
        .type = "workspace-action",
        .requestId = "request",
        .clientId = "client",
        .action = .@"set-layout",
        .tabId = id,
        .layoutRevision = initial_revision,
        .splitTree = &layout,
    };
    try std.testing.expectEqual(remote_workspace.Status.denied, apply(host, request).status);
    request.leaseId = lease_id + 1;
    try std.testing.expectEqual(remote_workspace.Status.denied, apply(host, request).status);
    request.leaseId = lease_id;
    request.clientId = "other";
    try std.testing.expectEqual(remote_workspace.Status.denied, apply(host, request).status);
    request.clientId = "client";
    try std.testing.expectEqual(remote_workspace.Status.failed, apply(host, request).status);
    try std.testing.expectEqual(initial_revision, revision(&state.tree));
    layout[2].surfaceId = "0000000000000003".*;
    try std.testing.expectEqual(remote_workspace.Status.failed, apply(host, request).status);
    try std.testing.expectEqual(initial_revision, revision(&state.tree));

    layout[2].surfaceId = a.remote_id;
    try std.testing.expectEqual(remote_workspace.Status.ok, apply(host, request).status);
    try std.testing.expectEqual(@as(f16, 0.625), state.tree.nodes[0].split.ratio);
    try std.testing.expectEqual(&b, state.tree.nodes[1].leaf.terminal);
    try std.testing.expectEqual(&a, state.tree.nodes[2].leaf.terminal);
    try std.testing.expectEqual(&a, state.focusedSurface().?);
    try std.testing.expectEqual(state.focused, state.tree.zoomed.?);
    try std.testing.expectEqual(id, state.publishRemoteWorkspace().?);
    try std.testing.expectEqual(@as(usize, 2), a.ref_count);
    try std.testing.expectEqual(@as(usize, 2), b.ref_count);
    try std.testing.expectEqual(remote_workspace.Status.stale, apply(host, request).status);

    request.action = .@"close-pane";
    request.splitTree = null;
    request.surfaceId = b.remote_id;
    request.layoutRevision = revision(&state.tree);
    try std.testing.expectEqual(remote_workspace.Status.protected, apply(host, request).status);
    request.action = .@"close-tab";
    request.surfaceId = null;
    try std.testing.expectEqual(remote_workspace.Status.protected, apply(host, request).status);

    var wire: std.ArrayListUnmanaged(u8) = .empty;
    defer wire.deinit(allocator);
    try appendLayoutFields(allocator, &wire, &state);
    try std.testing.expect(std.mem.endsWith(u8, wire.items,
        \\[{"axis":"y","ratio":0.625},{"surfaceId":"0000000000000002"},{"surfaceId":"0000000000000001"}]
    ));
}

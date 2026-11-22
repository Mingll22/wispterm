//! WispTerm Remote layout publishing and remote AI control callbacks.

const std = @import("std");
const ghostty_vt = @import("ghostty-vt");
const Surface = @import("../Surface.zig");
const SplitTree = @import("../split_tree.zig");
const ai_chat = @import("../assistant/conversation/session.zig");
const ai_history_session = @import("../terminal_agents/sessions/session.zig");
const appwindow_state = @import("state.zig");
const active_tab_state = @import("active_tab.zig");
const remote = @import("../remote_hub.zig");
const remote_snapshot = @import("../remote_snapshot.zig");
const remote_control = @import("../remote_terminal_control.zig");
const remote_workspace = @import("../remote_workspace.zig");
const renderer = @import("../renderer.zig");
const surface_snapshots = @import("surface_snapshots.zig");
const live_transcript = @import("../terminal_agents/live_transcript.zig");
const tab = @import("tab.zig");
const thread_message = @import("thread_message.zig");
const window_backend = @import("../platform/window_backend.zig");
const workspace_actions = @import("workspace_actions.zig");

pub const AiAgentOpenStatus = remote.AiAgentOpenStatus;
pub const workspace_supported = @import("../platform/remote_transport.zig").supported;

pub const Host = struct {
    hub: ?*remote.Hub,
    window: ?*window_backend.Window,
    state: *appwindow_state.State,
    allocator: ?std.mem.Allocator = null,
    workspace_window: ?usize = null,
    markUiDirty: *const fn () void,
    openDefaultAiAgentForRemote: *const fn () remote.AiAgentOpenStatus,
};

pub const RemoteAiInputRequest = struct {
    tab_index: usize,
    data: []u8,
};

pub const RemoteAiAgentOpenRequest = struct {
    request_id: []const u8,
};

pub fn syncLayout(host: Host, allocator: std.mem.Allocator) void {
    const hub = host.hub orelse return;

    const now = std.time.milliTimestamp();
    if (!host.state.remote.shouldSendLayout(now, 250)) return;

    const grid_epoch = hub.currentGridEpoch();
    const layout = buildLayoutJson(host, allocator) catch return;
    defer allocator.free(layout);
    if (hub.sendLayoutIfCurrent(layout, grid_epoch, host.workspace_window)) {
        host.state.remote.layout_pending = false;
    } else {
        host.state.remote.forceNextLayout();
    }
}

/// Background or minimized tabs can change their grid or workspace without a frame.
pub fn syncPendingLayout(host: Host, allocator: std.mem.Allocator) void {
    const hub = host.hub orelse return;
    if (host.state.remote.layout_pending or hub.layoutNeedsGridRefresh()) syncLayout(host, allocator);
}

pub fn expireTabControls(host: Host) ?i64 {
    const hub = host.hub orelse return null;
    const now = std.time.Instant.now() catch return null;
    var next_deadline: ?i64 = null;
    for (tab.g_tabs[0..tab.g_tab_count]) |maybe_tab| {
        const state = maybe_tab orelse continue;
        const id = state.workspace_id orelse continue;
        const remaining_ns = state.remote_tab_control.expire(&state.tree, hub, id, now) orelse continue;
        const remaining_ms: i64 = @intCast((remaining_ns + std.time.ns_per_ms - 1) / std.time.ns_per_ms);
        next_deadline = @min(next_deadline orelse remaining_ms, remaining_ms);
    }
    return next_deadline;
}

pub fn handleWorkspaceRequests(
    host: Host,
    can_mutate: bool,
    apply: *const fn (remote_workspace.Request) remote_workspace.Result,
) void {
    const hub = host.hub orelse return;
    const window = host.workspace_window orelse return;
    for (0..remote.max_workspace_requests) |_| {
        const request = hub.takeWorkspaceRequest(window) orelse return;
        defer request.deinit();
        switch (request) {
            .action => |parsed| {
                const result = apply(parsed.value);
                hub.sendWorkspaceActionResult(parsed.value, result);
                if (result.status == .ok or result.status == .stale) host.state.remote.forceNextLayout();
            },
            .control => |parsed| handleTabControl(hub, parsed.value, can_mutate),
        }
    }
    // A producer can fill the bounded queue again while this window drains it.
    window_backend.postWakeup();
}

fn handleTabControl(hub: *remote.Hub, request: remote_control.TabRequest, can_mutate: bool) void {
    const target = workspace_actions.findTab(request.tabId) orelse {
        hub.sendTabControlState(request.tabId, null, .unsupported);
        return;
    };
    const state = target.state;
    if (!state.supportsRemoteWorkspace()) {
        hub.sendTabControlState(request.tabId, null, .unsupported);
        return;
    }
    if (!can_mutate and (request.action == .acquire or request.action == .takeover)) {
        hub.sendTabControlState(request.tabId, if (state.remote_tab_control.lease.grant) |*grant| grant else null, .denied);
        return;
    }
    state.remote_tab_control.request(&state.tree, hub, request);
}

pub fn buildLayoutJson(host: Host, allocator: std.mem.Allocator) ![]u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);
    try appendLayoutJson(host, allocator, &out);
    return out.toOwnedSlice(allocator);
}

fn appendLayoutJson(host: Host, allocator: std.mem.Allocator, out: *std.ArrayListUnmanaged(u8)) !void {
    try out.appendSlice(allocator, "{\"type\":\"layout\",\"activeTab\":");
    try out.print(allocator, "{d}", .{active_tab_state.g_active_tab});
    if (host.workspace_window != null) try out.appendSlice(allocator, ",\"workspaceActions\":true,\"tabControl\":true");
    try out.appendSlice(allocator, ",\"tabs\":[");

    var wrote_tab = false;
    for (0..tab.g_tab_count) |tab_index| {
        const tab_state = tab.g_tabs[tab_index] orelse continue;
        if (wrote_tab) try out.append(allocator, ',');
        wrote_tab = true;

        if (tab_state.kind == .ai_chat) {
            try appendRemoteAiChatTabJson(host, allocator, out, tab_state, tab_index);
            continue;
        }
        if (tab_state.kind == .ai_history) {
            try appendRemoteAiHistoryTabJson(allocator, out, tab_state, tab_index);
            continue;
        }

        try out.appendSlice(allocator, "{\"index\":");
        try out.print(allocator, "{d}", .{tab_index});
        try out.appendSlice(allocator, ",\"title\":\"");
        try remote.appendJsonString(out, allocator, tab_state.getTitle());
        try out.appendSlice(allocator, "\",\"focusedSurfaceId\":\"");
        var focused_surface: ?*Surface = null;
        if (tab_state.focusedSurface()) |focused| {
            focused_surface = focused;
            try remote.appendJsonString(out, allocator, focused.remote_id[0..]);
        }
        try out.append(allocator, '"');
        try surface_snapshots.appendAgentDetectionJson(allocator, out, focused_surface);
        if (host.workspace_window != null) try workspace_actions.appendLayoutFields(allocator, out, tab_state);
        try out.appendSlice(allocator, ",\"surfaces\":[");

        var spatial = tab_state.tree.spatial(allocator) catch null;
        defer if (spatial) |*sp| sp.deinit(allocator);

        var wrote_surface = false;
        var it = tab_state.tree.surfaces();
        while (it.next()) |entry| {
            if (wrote_surface) try out.append(allocator, ',');
            wrote_surface = true;

            try out.appendSlice(allocator, "{\"id\":\"");
            try remote.appendJsonString(out, allocator, entry.surface.remote_id[0..]);
            try out.appendSlice(allocator, "\",\"title\":\"");
            try remote.appendJsonString(out, allocator, entry.surface.getTitle());
            try out.appendSlice(allocator, "\",\"focused\":");
            try out.appendSlice(allocator, if (entry.handle == tab_state.focused) "true" else "false");
            try surface_snapshots.appendAgentDetectionJson(allocator, out, entry.surface);
            try appendAgentTranscriptJson(allocator, out, entry.surface);
            if (entry.surface.supportsRemoteControl()) try out.appendSlice(allocator, ",\"terminalControl\":true");
            var cols: u16 = 0;
            var rows: u16 = 0;
            var cursor_x: usize = 0;
            var cursor_y: usize = 0;
            {
                entry.surface.render_state.mutex.lock();
                defer entry.surface.render_state.mutex.unlock();
                cols = entry.surface.terminal.cols;
                rows = entry.surface.terminal.rows;
                cursor_x = entry.surface.terminal.screens.active.cursor.x;
                cursor_y = entry.surface.terminal.screens.active.cursor.y;
            }
            try out.print(allocator, ",\"cols\":{d},\"rows\":{d}", .{ cols, rows });
            try out.appendSlice(allocator, ",\"cursorX\":");
            try out.print(allocator, "{d}", .{cursor_x});
            try out.appendSlice(allocator, ",\"cursorY\":");
            try out.print(allocator, "{d}", .{cursor_y});
            try out.appendSlice(allocator, ",\"snapshot\":\"");
            const snapshot = surface_snapshots.buildRemoteSurfaceSnapshotWithModes(allocator, entry.surface, remote_snapshot.default_max_history_rows) catch null;
            defer if (snapshot) |text| allocator.free(text);
            if (snapshot) |text| try remote.appendJsonString(out, allocator, text);
            try out.append(allocator, '"');

            if (spatial) |sp| {
                const slot = sp.slots[entry.handle.idx()];
                try out.appendSlice(allocator, ",\"x\":");
                try out.print(allocator, "{d:.5}", .{@as(f64, @floatCast(slot.x))});
                try out.appendSlice(allocator, ",\"y\":");
                try out.print(allocator, "{d:.5}", .{@as(f64, @floatCast(slot.y))});
                try out.appendSlice(allocator, ",\"w\":");
                try out.print(allocator, "{d:.5}", .{@as(f64, @floatCast(slot.width))});
                try out.appendSlice(allocator, ",\"h\":");
                try out.print(allocator, "{d:.5}", .{@as(f64, @floatCast(slot.height))});
            } else {
                try out.appendSlice(allocator, ",\"x\":0,\"y\":0,\"w\":1,\"h\":1");
            }

            try out.append(allocator, '}');
        }

        try out.appendSlice(allocator, "]}");
    }

    try out.appendSlice(allocator, "]}");
}

/// Claude Code / Codex panes additionally carry their session-log tail
/// (`agentTranscript`) and, while waiting on the user, the approval menu parsed
/// from the screen (`agentPrompt`), so phones can render them as a conversation.
fn appendAgentTranscriptJson(allocator: std.mem.Allocator, out: *std.ArrayListUnmanaged(u8), surface: *Surface) !void {
    const det = surface.agent_detection;
    if (det.app != .claude_code and det.app != .codex) return;
    const cwd = surface.getCwd() orelse surface.getInitialCwd();
    if (surface.agent_transcript.refresh(allocator, det.app, cwd)) |json| {
        try out.appendSlice(allocator, ",\"agentTranscript\":");
        try out.appendSlice(allocator, json);
    }
    if (det.state != .waiting_approval and det.state != .needs_input) return;
    const screen = surface_snapshots.buildRemoteSurfaceSnapshot(allocator, surface, remote_snapshot.agent_max_history_rows) catch return;
    defer allocator.free(screen);
    const prompt = live_transcript.allocPromptJson(allocator, screen) catch null;
    defer if (prompt) |p| allocator.free(p);
    if (prompt) |p| {
        try out.appendSlice(allocator, ",\"agentPrompt\":");
        try out.appendSlice(allocator, p);
    }
}

pub fn remoteAiSurfaceId(tab_index: usize) [16]u8 {
    var id: [16]u8 = undefined;
    _ = std.fmt.bufPrint(&id, "aichat{d:0>10}", .{tab_index}) catch unreachable;
    return id;
}

pub fn remoteAiHistorySurfaceId(tab_index: usize) [16]u8 {
    var id: [16]u8 = undefined;
    _ = std.fmt.bufPrint(&id, "aihist{d:0>10}", .{tab_index}) catch unreachable;
    return id;
}

fn registerRemoteAiInputSink(host: Host, tab_index: usize) void {
    const hub = host.hub orelse return;
    const window = host.window orelse return;

    const sink = host.state.remote.recordAiSink(tab_index, window_backend.nativeHandleBits(window)) orelse return;
    hub.registerSurface(remoteAiSurfaceId(tab_index), sink, writeAiInput);
}

pub fn writeAiInput(ctx: *anyopaque, data: []const u8) void {
    const sink: *appwindow_state.RemoteAiInputSink = @ptrCast(@alignCast(ctx));
    const native_handle = window_backend.nativeHandleFromBits(sink.native_handle_bits) orelse return;
    const request = std.heap.page_allocator.create(RemoteAiInputRequest) catch return;
    request.* = .{
        .tab_index = sink.tab_index,
        .data = std.heap.page_allocator.dupe(u8, data) catch {
            std.heap.page_allocator.destroy(request);
            return;
        },
    };

    const ok = thread_message.postPointer(native_handle, .remote_ai_input, @intFromPtr(request));
    if (!ok) {
        std.heap.page_allocator.free(request.data);
        std.heap.page_allocator.destroy(request);
    }
}

fn appendRemoteAiChatTabJson(
    host: Host,
    allocator: std.mem.Allocator,
    out: *std.ArrayListUnmanaged(u8),
    tab_state: *tab.TabState,
    tab_index: usize,
) !void {
    registerRemoteAiInputSink(host, tab_index);
    const surface_id = remoteAiSurfaceId(tab_index);
    const title_text = tab_state.getTitle();

    try out.appendSlice(allocator, "{\"index\":");
    try out.print(allocator, "{d}", .{tab_index});
    try out.appendSlice(allocator, ",\"title\":\"");
    try remote.appendJsonString(out, allocator, title_text);
    try out.appendSlice(allocator, "\",\"focusedSurfaceId\":\"");
    try remote.appendJsonString(out, allocator, surface_id[0..]);
    try out.append(allocator, '"');
    try surface_snapshots.appendAgentDetectionJson(allocator, out, null);
    try out.appendSlice(allocator, ",\"surfaces\":[{\"id\":\"");
    try remote.appendJsonString(out, allocator, surface_id[0..]);
    try out.appendSlice(allocator, "\",\"title\":\"");
    try remote.appendJsonString(out, allocator, title_text);
    try out.appendSlice(allocator, "\",\"focused\":true");
    try surface_snapshots.appendAgentDetectionJson(allocator, out, null);
    try out.appendSlice(allocator, ",\"kind\":\"ai_chat\",\"readOnly\":false,\"cols\":120,\"rows\":30,\"cursorX\":0,\"cursorY\":0,\"snapshot\":\"");
    var request_state: ai_chat.Session.RequestState = .{ .inflight = false, .stopping = false };
    if (tab_state.ai_chat_session) |session| {
        request_state = session.requestState();
        const snapshot = session.allocRemoteSnapshot(allocator) catch null;
        defer if (snapshot) |text| allocator.free(text);
        if (snapshot) |text| try remote.appendJsonString(out, allocator, text);
    }
    try out.appendSlice(allocator, "\",\"requestInflight\":");
    try out.appendSlice(allocator, if (request_state.inflight) "true" else "false");
    try out.appendSlice(allocator, ",\"requestStopping\":");
    try out.appendSlice(allocator, if (request_state.stopping) "true" else "false");
    try out.appendSlice(allocator, ",\"x\":0,\"y\":0,\"w\":1,\"h\":1}]}");
}

fn appendRemoteAiHistoryTabJson(
    allocator: std.mem.Allocator,
    out: *std.ArrayListUnmanaged(u8),
    tab_state: *tab.TabState,
    tab_index: usize,
) !void {
    const surface_id = remoteAiHistorySurfaceId(tab_index);
    const title_text = tab_state.getTitle();

    try out.appendSlice(allocator, "{\"index\":");
    try out.print(allocator, "{d}", .{tab_index});
    try out.appendSlice(allocator, ",\"title\":\"");
    try remote.appendJsonString(out, allocator, title_text);
    try out.appendSlice(allocator, "\",\"focusedSurfaceId\":\"");
    try remote.appendJsonString(out, allocator, surface_id[0..]);
    try out.append(allocator, '"');
    try surface_snapshots.appendAgentDetectionJson(allocator, out, null);
    try out.appendSlice(allocator, ",\"surfaces\":[{\"id\":\"");
    try remote.appendJsonString(out, allocator, surface_id[0..]);
    try out.appendSlice(allocator, "\",\"title\":\"");
    try remote.appendJsonString(out, allocator, title_text);
    try out.appendSlice(allocator, "\",\"focused\":true");
    try surface_snapshots.appendAgentDetectionJson(allocator, out, null);
    // AI History is read-only in remote layouts. Keep it terminal-style so the
    // remote client does not show AI Chat composer/input affordances.
    try out.appendSlice(allocator, ",\"kind\":\"terminal\",\"readOnly\":true,\"cols\":120,\"rows\":30,\"cursorX\":0,\"cursorY\":0,\"snapshot\":\"Sessions\\n");
    try remote.appendJsonString(out, allocator, title_text);
    try out.appendSlice(allocator, "\",\"x\":0,\"y\":0,\"w\":1,\"h\":1}]}");
}

pub fn handleAiInputRequest(request: *RemoteAiInputRequest, host: Host) void {
    defer {
        std.heap.page_allocator.free(request.data);
        std.heap.page_allocator.destroy(request);
    }
    if (request.tab_index >= tab.g_tab_count) return;
    const tab_state = tab.g_tabs[request.tab_index] orelse return;
    if (tab_state.kind != .ai_chat) return;
    const session = tab_state.ai_chat_session orelse return;
    session.applyRemoteInput(request.data);
    host.markUiDirty();
}

pub fn handleAiAgentOpenRequest(request: *RemoteAiAgentOpenRequest, host: Host) void {
    const hub = host.hub orelse return;

    const status = host.openDefaultAiAgentForRemote();
    hub.sendAiAgentOpenResult(request.request_id, status);

    if (status == .opened) {
        host.state.remote.forceNextLayout();
        if (host.allocator) |alloc| syncLayout(host, alloc);
    }
}

fn noopMarkUiDirty() void {}

fn failOpenDefaultAiAgentForRemote() remote.AiAgentOpenStatus {
    return .failed;
}

fn testHost(state: *appwindow_state.State, allocator: std.mem.Allocator) Host {
    return .{
        .hub = null,
        .window = null,
        .state = state,
        .allocator = allocator,
        .markUiDirty = noopMarkUiDirty,
        .openDefaultAiAgentForRemote = failOpenDefaultAiAgentForRemote,
    };
}

fn resetTestTabs() void {
    for (0..tab.MAX_TABS) |idx| tab.g_tabs[idx] = null;
    tab.g_tab_count = 0;
    active_tab_state.g_active_tab = 0;
}

test "remote sync: layout serializes ai_history as non-terminal surface" {
    const allocator = std.testing.allocator;
    resetTestTabs();
    defer resetTestTabs();
    var state = appwindow_state.State{};

    var session = ai_history_session.Session.init(allocator, .{
        .id = "local-history",
        .name = "Local History",
        .target = .local,
    });
    defer session.deinit();
    var tab_state = tab.TabState{
        .kind = .ai_history,
        .tree = .empty,
        .focused = .root,
        .ai_chat_session = null,
        .ai_history_session = &session,
        .copilot_session = null,
    };
    tab.g_tabs[0] = &tab_state;
    tab.g_tab_count = 1;

    const json = try buildLayoutJson(testHost(&state, allocator), allocator);
    defer allocator.free(json);

    try std.testing.expect(std.mem.indexOf(u8, json, "\"kind\":\"terminal\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"kind\":\"ai_chat\"") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"readOnly\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"surfaces\":[]") == null);
}

test "remote sync: build layout json includes agent metadata from terminal snapshots" {
    const allocator = std.testing.allocator;
    resetTestTabs();
    defer resetTestTabs();
    var state = appwindow_state.State{};

    var surface: Surface = undefined;
    surface.terminal = try ghostty_vt.Terminal.init(allocator, .{
        .cols = 12,
        .rows = 4,
        .max_scrollback = 16,
        .default_modes = .{ .grapheme_cluster = true },
    });
    defer surface.terminal.deinit(allocator);
    surface.render_state = renderer.State.init(&surface.terminal);
    surface.remote_terminal = .{};
    surface.size = .{};
    surface.size.grid.cols = 12;
    surface.size.grid.rows = 4;
    surface.ref_count = 1;
    surface.title_override_len = 0;
    surface.osc7_title_len = 0;
    surface.window_title_len = 0;
    surface.cwd_path_len = 0;
    surface.initial_cwd_path_len = 0;
    surface.agent_transcript = .{};
    surface.agent_detection = .{
        .app = .codex,
        .state = .waiting_approval,
        .confidence = 88,
    };
    @memcpy(surface.remote_id[0..], "term000000000001");

    var tab_state = tab.TabState{
        .kind = .terminal,
        .tree = try SplitTree.init(allocator, &surface),
        .focused = .root,
        .ai_chat_session = null,
        .ai_history_session = null,
        .copilot_session = null,
    };
    defer tab_state.tree.deinit();
    tab.g_tabs[0] = &tab_state;
    tab.g_tab_count = 1;

    const json = try buildLayoutJson(testHost(&state, allocator), allocator);
    defer allocator.free(json);

    try std.testing.expect(std.mem.indexOf(u8, json, "\"agentApp\":\"codex\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"agentState\":\"waiting_approval\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"agentBadge\":\"ask\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"agentConfidence\":88") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"id\":\"term000000000001\"") != null);
}

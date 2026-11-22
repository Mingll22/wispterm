//! WispTerm Remote message hub: the single producer of relay-format messages
//! (layout, terminal grid/state/bytes, action results) and the single
//! consumer of relay-format terminal, workspace and AI commands, independent of
//! how the bytes travel.
//!
//! Surfaces register as sinks here and publish PTY output with their stable
//! surface id. Transports (the public relay client in `remote_client.zig`, the
//! LAN message channel in `lan_stream.zig`) attach with `addTransport` and get
//! every outbound message; they hand inbound messages to
//! `handleIncomingMessage`. The hub never blocks on the network: a transport's
//! `send_fn` must only enqueue (or drop) and must not call back into the hub.
//!
//! Message formats match `remote/README.md` "Relay Messages" byte-for-byte.

const std = @import("std");
const terminal_control = @import("remote_terminal_control.zig");
const image_paste = @import("remote_image_paste.zig");
const workspace = @import("remote_workspace.zig");
const GridSize = @import("core/geometry.zig").GridSize;

var next_surface_counter = std.atomic.Value(u64).init(1);

pub const SurfaceWriteFn = *const fn (ctx: *anyopaque, data: []const u8) void;
pub const TerminalWriteFn = *const fn (ctx: *anyopaque, data: []const u8, identity: terminal_control.Identity) void;
pub const TerminalControlFn = *const fn (ctx: *anyopaque, request: terminal_control.Request) void;
pub const AiAgentOpenStatus = enum {
    opened,
    no_profile,
    failed,
};
pub const AiAgentOpenFn = *const fn (ctx: *anyopaque, request_id: []const u8) void;
pub const TransportSendFn = *const fn (ctx: *anyopaque, message: []const u8) void;

pub const ImagePasteSink = struct {
    authorize: *const fn (ctx: *anyopaque, identity: terminal_control.Identity) image_paste.Authorization,
    enqueue: *const fn (ctx: *anyopaque, identity: terminal_control.Identity, target: image_paste.Target, text: []const u8) image_paste.Status,
};

const SurfaceSink = struct {
    id: [16]u8,
    ctx: *anyopaque,
    handler: union(enum) {
        legacy: SurfaceWriteFn,
        terminal: struct {
            write: TerminalWriteFn,
            control: ?TerminalControlFn,
            paste_image: ?ImagePasteSink,
        },
    },
};

pub const WorkspaceRequest = union(enum) {
    action: std.json.Parsed(workspace.Request),
    control: std.json.Parsed(terminal_control.TabRequest),

    pub fn deinit(self: WorkspaceRequest) void {
        switch (self) {
            inline else => |request| request.deinit(),
        }
    }

    fn reject(self: WorkspaceRequest, hub: *Hub, status: workspace.Status) void {
        switch (self) {
            .action => |request| hub.sendWorkspaceActionResult(request.value, .{ .status = status }),
            .control => |request| hub.sendTabControlState(request.value.tabId, null, if (status == .unsupported) .unsupported else .denied),
        }
    }
};

const PendingWorkspaceRequest = struct {
    window: usize,
    request: WorkspaceRequest,
};

pub const max_workspace_requests = 16;

pub const Transport = struct {
    ctx: *anyopaque,
    send_fn: TransportSendFn,
};

pub const Hub = struct {
    allocator: std.mem.Allocator,
    // Inbound callbacks may publish receipts. Keep the sink lifetime lock
    // separate from the outbound lock so a receipt can be sent inline.
    sinks_mutex: std.Thread.Mutex = .{},
    mutex: std.Thread.Mutex = .{},
    surface_sinks: std.ArrayListUnmanaged(SurfaceSink) = .empty,
    transports: std.ArrayListUnmanaged(Transport) = .empty,
    ai_agent_open_ctx: ?*anyopaque = null,
    ai_agent_open_fn: ?AiAgentOpenFn = null,
    workspace_window: ?usize = null,
    workspace_wakeup: ?*const fn () void = null,
    workspace_requests: std.ArrayListUnmanaged(PendingWorkspaceRequest) = .empty,
    last_layout: ?[]u8 = null,
    grid_epoch: u64 = 0,
    layout_epoch: u64 = 0,

    pub fn create(allocator: std.mem.Allocator) !*Hub {
        const hub = try allocator.create(Hub);
        hub.* = .{ .allocator = allocator };
        return hub;
    }

    pub fn init(allocator: std.mem.Allocator) Hub {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *Hub) void {
        self.sinks_mutex.lock();
        self.surface_sinks.deinit(self.allocator);
        self.sinks_mutex.unlock();
        self.mutex.lock();
        self.transports.deinit(self.allocator);
        for (self.workspace_requests.items) |action| action.request.deinit();
        self.workspace_requests.deinit(self.allocator);
        if (self.last_layout) |layout| self.allocator.free(layout);
        self.last_layout = null;
        self.mutex.unlock();
    }

    pub fn destroy(self: *Hub) void {
        const allocator = self.allocator;
        self.deinit();
        allocator.destroy(self);
    }

    // ---- transports -------------------------------------------------------

    pub fn addTransport(self: *Hub, ctx: *anyopaque, send_fn: TransportSendFn) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.transports.items) |*t| {
            if (t.ctx == ctx) {
                t.send_fn = send_fn;
                return;
            }
        }
        self.transports.append(self.allocator, .{ .ctx = ctx, .send_fn = send_fn }) catch {};
    }

    /// After this returns the hub never calls `ctx` again, so the transport
    /// may free itself.
    pub fn removeTransport(self: *Hub, ctx: *anyopaque) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.transports.items, 0..) |t, i| {
            if (t.ctx == ctx) {
                _ = self.transports.swapRemove(i);
                return;
            }
        }
    }

    pub fn transportCount(self: *Hub) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.transports.items.len;
    }

    /// Replay under the same lock as live publication so an older layout
    /// cannot be inserted into a reconnecting transport after a newer grid.
    pub fn replayLastLayout(self: *Hub, ctx: *anyopaque) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.layout_epoch != self.grid_epoch) return false;
        const last = self.last_layout orelse return false;
        for (self.transports.items) |transport| {
            if (transport.ctx != ctx) continue;
            transport.send_fn(ctx, last);
            return true;
        }
        return false;
    }

    // ---- outbound ---------------------------------------------------------

    pub fn sendOutput(self: *Hub, surface_id: []const u8, data: []const u8) void {
        if (data.len == 0) return;
        if (!self.hasTransports()) return;
        const message = buildOutputMessage(self.allocator, surface_id, data) catch return;
        defer self.allocator.free(message);
        self.broadcast(message);
    }

    pub fn sendAiAgentOpenResult(self: *Hub, request_id: []const u8, status: AiAgentOpenStatus) void {
        if (request_id.len == 0) return;
        const message = buildAiAgentOpenResultMessage(self.allocator, request_id, status) catch return;
        defer self.allocator.free(message);
        self.broadcast(message);
    }

    pub fn sendWorkspaceActionResult(self: *Hub, request: workspace.Request, result: workspace.Result) void {
        const message = std.json.Stringify.valueAlloc(self.allocator, .{
            .type = "workspace-action-result",
            .requestId = request.requestId,
            .clientId = request.clientId,
            .status = @tagName(result.status),
            .tabId = if (result.tab_id) |*id| @as([]const u8, id) else null,
            .surfaceId = if (result.surface_id) |*id| @as([]const u8, id) else null,
        }, .{ .emit_null_optional_fields = false }) catch return;
        defer self.allocator.free(message);
        self.broadcast(message);
    }

    pub fn sendTerminalControlState(
        self: *Hub,
        surface_id: []const u8,
        holder: ?*const terminal_control.Holder,
        reason: terminal_control.Reason,
    ) void {
        const message = std.json.Stringify.valueAlloc(self.allocator, .{
            .type = "terminal-control-state",
            .surfaceId = surface_id,
            .clientId = if (holder) |h| h.clientId() else null,
            .leaseId = if (holder) |h| h.id else null,
            .reason = @tagName(reason),
        }, .{}) catch return;
        defer self.allocator.free(message);
        self.broadcast(message);
    }

    pub fn sendTabControlState(self: *Hub, tab_id: workspace.Id, grant: ?*const terminal_control.TabGrant, reason: terminal_control.Reason) void {
        const message = std.json.Stringify.valueAlloc(self.allocator, .{
            .type = "tab-control-state",
            .tabId = @as([]const u8, &tab_id),
            .clientId = if (grant) |value| value.clientId() else null,
            .leaseId = if (grant) |value| value.id else null,
            .reason = @tagName(reason),
        }, .{}) catch return;
        defer self.allocator.free(message);
        self.broadcast(message);
    }

    /// Called at the termio resize commit, while output publication is fenced.
    pub fn sendTerminalGrid(self: *Hub, surface_id: []const u8, grid: GridSize) void {
        var buffer: [128]u8 = undefined;
        const message = std.fmt.bufPrint(&buffer, "{{\"type\":\"terminal-grid\",\"surfaceId\":\"{s}\",\"cols\":{d},\"rows\":{d}}}", .{ surface_id, grid.cols, grid.rows }) catch unreachable;
        self.mutex.lock();
        defer self.mutex.unlock();
        self.grid_epoch +%= 1;
        self.broadcastLocked(message);
    }

    pub fn currentGridEpoch(self: *Hub) u64 {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.grid_epoch;
    }

    pub fn layoutNeedsGridRefresh(self: *Hub) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.layout_epoch != self.grid_epoch;
    }

    /// Remembers the layout for late joiners and broadcasts it when it changed.
    pub fn sendLayout(self: *Hub, layout_json: []const u8) void {
        _ = self.sendLayoutIfCurrent(layout_json, null, null);
    }

    /// A resize may commit while the UI builds the snapshot across surfaces.
    /// Do not publish that older layout after the ordered grid event.
    pub fn sendLayoutIfCurrent(self: *Hub, layout_json: []const u8, expected_grid_epoch: ?u64, workspace_window: ?usize) bool {
        if (layout_json.len == 0) return false;
        self.mutex.lock();
        defer self.mutex.unlock();
        if (expected_grid_epoch) |epoch| if (epoch != self.grid_epoch) return false;
        if (self.last_layout) |last| {
            if (std.mem.eql(u8, last, layout_json)) {
                self.layout_epoch = self.grid_epoch;
                self.workspace_window = workspace_window;
                return true;
            }
        }
        const next_layout = self.allocator.dupe(u8, layout_json) catch return false;
        if (self.last_layout) |last| self.allocator.free(last);
        self.last_layout = next_layout;
        self.layout_epoch = self.grid_epoch;
        self.workspace_window = workspace_window;
        self.broadcastLocked(next_layout);
        return true;
    }

    fn hasTransports(self: *Hub) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.transports.items.len > 0;
    }

    fn broadcast(self: *Hub, message: []const u8) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.broadcastLocked(message);
    }

    fn broadcastLocked(self: *Hub, message: []const u8) void {
        for (self.transports.items) |t| t.send_fn(t.ctx, message);
    }

    // ---- sinks ------------------------------------------------------------

    pub fn registerSurface(self: *Hub, surface_id: [16]u8, ctx: *anyopaque, write_fn: SurfaceWriteFn) void {
        self.registerSink(.{ .id = surface_id, .ctx = ctx, .handler = .{ .legacy = write_fn } });
    }

    pub fn registerTerminalSurface(
        self: *Hub,
        surface_id: [16]u8,
        ctx: *anyopaque,
        write: TerminalWriteFn,
        control: ?TerminalControlFn,
        paste_image: ?ImagePasteSink,
    ) void {
        self.registerSink(.{
            .id = surface_id,
            .ctx = ctx,
            .handler = .{ .terminal = .{ .write = write, .control = control, .paste_image = paste_image } },
        });
    }

    fn registerSink(self: *Hub, next: SurfaceSink) void {
        self.sinks_mutex.lock();
        defer self.sinks_mutex.unlock();
        for (self.surface_sinks.items) |*registered| {
            if (std.mem.eql(u8, &registered.id, &next.id)) {
                registered.* = next;
                return;
            }
        }
        self.surface_sinks.append(self.allocator, next) catch {};
    }

    pub fn unregisterSurface(self: *Hub, surface_id: [16]u8) void {
        self.sinks_mutex.lock();
        defer self.sinks_mutex.unlock();
        for (self.surface_sinks.items, 0..) |sink, i| {
            if (std.mem.eql(u8, sink.id[0..], surface_id[0..])) {
                _ = self.surface_sinks.swapRemove(i);
                return;
            }
        }
    }

    pub fn registerAiAgentOpener(self: *Hub, ctx: *anyopaque, open_fn: AiAgentOpenFn) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.ai_agent_open_ctx = ctx;
        self.ai_agent_open_fn = open_fn;
    }

    pub fn registerWorkspaceWakeup(self: *Hub, wakeup: *const fn () void) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.workspace_wakeup = wakeup;
    }

    /// A window owns the requests queued against its published workspace.
    /// Only its UI thread takes these requests and touches the live tabs.
    pub fn takeWorkspaceRequest(self: *Hub, window: usize) ?WorkspaceRequest {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.workspace_requests.items, 0..) |action, i| {
            if (action.window == window) return self.workspace_requests.orderedRemove(i).request;
        }
        return null;
    }

    pub fn detachWorkspaceWindow(self: *Hub, window: usize) void {
        {
            self.mutex.lock();
            defer self.mutex.unlock();
            if (self.workspace_window == window) {
                self.workspace_window = null;
                if (self.last_layout) |layout| self.allocator.free(layout);
                self.last_layout = null;
            }
        }
        while (self.takeWorkspaceRequest(window)) |request| {
            defer request.deinit();
            request.reject(self, .failed);
        }
    }

    // ---- inbound ----------------------------------------------------------

    /// LAN and legacy inputs carry no trusted browser identity.
    pub fn handleIncomingMessage(self: *Hub, message: []const u8) void {
        self.handleMessage(message, false);
    }

    /// The relay stamps the client id from its authenticated WebSocket session.
    pub fn handleRelayMessage(self: *Hub, message: []const u8) void {
        self.handleMessage(message, true);
    }

    fn handleMessage(self: *Hub, message: []const u8, from_relay: bool) void {
        if (isJsonMessageType(message, image_paste.wire_type)) {
            if (from_relay) self.handleRelayImagePaste(message);
            return;
        }
        if (isJsonMessageType(message, "workspace-action")) {
            if (from_relay) {
                const request = workspace.parse(self.allocator, message) orelse return;
                self.handleWorkspaceRequest(.{ .action = request });
            }
            return;
        }
        if (isJsonMessageType(message, "tab-control")) {
            if (from_relay) {
                const request = terminal_control.TabRequest.parse(self.allocator, message) orelse return;
                self.handleWorkspaceRequest(.{ .control = request });
            }
            return;
        }
        if (from_relay and (isJsonMessageType(message, "input-bytes") or isJsonMessageType(message, "terminal-control"))) {
            self.handleRelayTerminalMessage(message);
            return;
        }
        if (isJsonMessageType(message, "input-bytes")) {
            const surface_id = extractJsonString(message, "surfaceId") orelse return;
            const hex_data = extractJsonString(message, "data") orelse return;
            const decoded = decodeHexAlloc(self.allocator, hex_data) catch return;
            defer self.allocator.free(decoded);
            self.dispatchInput(surface_id, decoded, .{ .origin = .lan });
            return;
        }
        if (isJsonMessageType(message, "open-ai-agent")) {
            const request_id = extractJsonString(message, "requestId") orelse return;
            self.dispatchAiAgentOpen(request_id);
        }
    }

    fn handleRelayImagePaste(self: *Hub, message: []const u8) void {
        if (message.len > image_paste.max_message_bytes) return;
        const parsed = std.json.parseFromSlice(image_paste.Wire, self.allocator, message, .{}) catch return;
        defer parsed.deinit();
        const wire = parsed.value;
        if (!std.mem.eql(u8, wire.type, image_paste.wire_type) or
            !image_paste.validRequestId(wire.requestId) or !image_paste.validClientId(wire.clientId)) return;

        const status = self.pasteRelayImage(wire);
        const result = std.json.Stringify.valueAlloc(self.allocator, .{
            .type = "terminal-image-paste-result",
            .requestId = wire.requestId,
            .clientId = wire.clientId,
            .status = @tagName(status),
        }, .{}) catch return;
        defer self.allocator.free(result);
        self.broadcast(result);
    }

    fn pasteRelayImage(self: *Hub, wire: image_paste.Wire) image_paste.Status {
        if (!wire.validSurface()) return .invalid;
        const identity = wire.identity() orelse return .denied;
        const image = image_paste.decode(self.allocator, wire) catch |err| return switch (err) {
            error.InvalidImage => .invalid,
            error.OutOfMemory => .failed,
        };
        defer self.allocator.free(image.bytes);

        const target = switch (self.authorizeImagePaste(wire.surfaceId, identity)) {
            .accepted => |target| target,
            .denied => return .denied,
            .unsupported => return .unsupported,
        };
        // File I/O happens outside the sink and terminal locks. The surface
        // may be removed or its lease changed while the file is being staged.
        const attachment = image_paste.stage(self.allocator, image, target.kind) catch return .failed;
        const status = self.enqueueImagePaste(wire.surfaceId, identity, target, attachment.paste_text);
        attachment.deinit(self.allocator, status == .queued);
        return status;
    }

    fn authorizeImagePaste(
        self: *Hub,
        surface_id: []const u8,
        identity: terminal_control.Identity,
    ) image_paste.Authorization {
        self.sinks_mutex.lock();
        defer self.sinks_mutex.unlock();
        const sink = self.findImageSinkLocked(surface_id) orelse return .unsupported;
        return sink.handler.terminal.paste_image.?.authorize(sink.ctx, identity);
    }

    fn enqueueImagePaste(
        self: *Hub,
        surface_id: []const u8,
        identity: terminal_control.Identity,
        target: image_paste.Target,
        text: []const u8,
    ) image_paste.Status {
        self.sinks_mutex.lock();
        defer self.sinks_mutex.unlock();
        const sink = self.findImageSinkLocked(surface_id) orelse return .unsupported;
        return sink.handler.terminal.paste_image.?.enqueue(sink.ctx, identity, target, text);
    }

    fn findImageSinkLocked(self: *Hub, surface_id: []const u8) ?SurfaceSink {
        for (self.surface_sinks.items) |sink| {
            if (!std.mem.eql(u8, &sink.id, surface_id)) continue;
            if (sink.handler == .terminal and sink.handler.terminal.paste_image != null) return sink;
            break;
        }
        return null;
    }

    fn handleWorkspaceRequest(self: *Hub, request: WorkspaceRequest) void {
        const submission = self.queueWorkspaceRequest(request);
        switch (submission) {
            .queued => |wakeup| wakeup(),
            .rejected => |status| {
                defer request.deinit();
                request.reject(self, status);
            },
        }
    }

    const WorkspaceSubmission = union(enum) {
        queued: *const fn () void,
        rejected: workspace.Status,
    };

    fn queueWorkspaceRequest(self: *Hub, request: WorkspaceRequest) WorkspaceSubmission {
        self.mutex.lock();
        defer self.mutex.unlock();
        const window = self.workspace_window orelse return .{ .rejected = .unsupported };
        const wakeup = self.workspace_wakeup orelse return .{ .rejected = .unsupported };
        if (self.workspace_requests.items.len >= max_workspace_requests) return .{ .rejected = .limit };
        self.workspace_requests.append(self.allocator, .{ .window = window, .request = request }) catch return .{ .rejected = .failed };
        return .{ .queued = wakeup };
    }

    const RelayTerminalMessage = struct {
        type: []const u8,
        surfaceId: []const u8,
        clientId: ?[]const u8 = null,
        leaseId: ?u32 = null,
        action: ?terminal_control.Action = null,
        cols: ?u16 = null,
        rows: ?u16 = null,
        data: ?[]const u8 = null,
    };

    fn handleRelayTerminalMessage(self: *Hub, message: []const u8) void {
        const parsed = std.json.parseFromSlice(RelayTerminalMessage, self.allocator, message, .{ .ignore_unknown_fields = true }) catch return;
        defer parsed.deinit();
        const wire = parsed.value;
        if (wire.surfaceId.len != 16) return;
        if (std.mem.eql(u8, wire.type, "input-bytes")) {
            const decoded = decodeHexAlloc(self.allocator, wire.data orelse return) catch return;
            defer self.allocator.free(decoded);
            self.dispatchInput(wire.surfaceId, decoded, .{ .client_id = wire.clientId, .lease_id = wire.leaseId });
        } else if (std.mem.eql(u8, wire.type, "terminal-control")) {
            const cols = wire.cols orelse 0;
            const rows = wire.rows orelse 0;
            self.dispatchTerminalControl(wire.surfaceId, .{
                .client_id = wire.clientId orelse return,
                .action = wire.action orelse return,
                .lease_id = wire.leaseId,
                .grid = if (cols >= 2 and cols <= 512 and rows >= 1 and rows <= 256) .{ .cols = cols, .rows = rows } else null,
            });
        }
    }

    fn dispatchInput(self: *Hub, surface_id: []const u8, data: []const u8, identity: terminal_control.Identity) void {
        if (data.len == 0) return;
        self.sinks_mutex.lock();
        defer self.sinks_mutex.unlock();
        for (self.surface_sinks.items) |sink| {
            if (std.mem.eql(u8, sink.id[0..], surface_id)) {
                switch (sink.handler) {
                    .legacy => |write| if (identity.lease_id == null) write(sink.ctx, data),
                    .terminal => |terminal| terminal.write(sink.ctx, data, identity),
                }
                return;
            }
        }
    }

    fn dispatchTerminalControl(self: *Hub, surface_id: []const u8, request: terminal_control.Request) void {
        self.sinks_mutex.lock();
        defer self.sinks_mutex.unlock();
        for (self.surface_sinks.items) |sink| {
            if (!std.mem.eql(u8, &sink.id, surface_id)) continue;
            if (sink.handler == .terminal) {
                if (sink.handler.terminal.control) |control| {
                    control(sink.ctx, request);
                    return;
                }
            }
            break;
        }
        self.sendTerminalControlState(surface_id, null, .unsupported);
    }

    fn dispatchAiAgentOpen(self: *Hub, request_id: []const u8) void {
        self.mutex.lock();
        const ctx = self.ai_agent_open_ctx;
        const open_fn = self.ai_agent_open_fn;
        self.mutex.unlock();

        if (ctx == null or open_fn == null) {
            self.sendAiAgentOpenResult(request_id, .failed);
            return;
        }
        open_fn.?(ctx.?, request_id);
    }
};

pub fn nextSurfaceId(out: *[16]u8) void {
    const id = next_surface_counter.fetchAdd(1, .monotonic);
    _ = std.fmt.bufPrint(out, "{x:0>16}", .{id}) catch unreachable;
}

// ---- message builders -----------------------------------------------------

pub fn buildOutputMessage(allocator: std.mem.Allocator, surface_id: []const u8, data: []const u8) ![]u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "{\"type\":\"output-bytes\",\"surfaceId\":\"");
    try appendJsonString(&out, allocator, surface_id);
    try out.appendSlice(allocator, "\",\"encoding\":\"hex\",\"data\":\"");
    try appendHex(&out, allocator, data);
    try out.appendSlice(allocator, "\"}");
    return out.toOwnedSlice(allocator);
}

pub fn buildAiAgentOpenResultMessage(
    allocator: std.mem.Allocator,
    request_id: []const u8,
    status: AiAgentOpenStatus,
) ![]u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "{\"type\":\"open-ai-agent-result\",\"requestId\":\"");
    try appendJsonString(&out, allocator, request_id);
    try out.appendSlice(allocator, "\",\"status\":\"");
    try out.appendSlice(allocator, aiAgentOpenStatusJson(status));
    try out.appendSlice(allocator, "\"}");
    return out.toOwnedSlice(allocator);
}

fn aiAgentOpenStatusJson(status: AiAgentOpenStatus) []const u8 {
    return switch (status) {
        .opened => "opened",
        .no_profile => "no-profile",
        .failed => "failed",
    };
}

// ---- JSON helpers ---------------------------------------------------------

pub fn isJsonMessageType(message: []const u8, comptime kind: []const u8) bool {
    return std.mem.indexOf(u8, message, "\"type\":\"" ++ kind ++ "\"") != null;
}

pub fn extractJsonString(message: []const u8, field: []const u8) ?[]const u8 {
    var needle_buf: [64]u8 = undefined;
    if (field.len + 4 > needle_buf.len) return null;

    needle_buf[0] = '"';
    @memcpy(needle_buf[1..][0..field.len], field);
    needle_buf[field.len + 1] = '"';
    needle_buf[field.len + 2] = ':';
    needle_buf[field.len + 3] = '"';
    const needle = needle_buf[0 .. field.len + 4];

    const start = std.mem.indexOf(u8, message, needle) orelse return null;
    var i = start + needle.len;
    const value_start = i;
    while (i < message.len) : (i += 1) {
        if (message[i] == '"') return message[value_start..i];
        if (message[i] == '\\') return null;
    }
    return null;
}

pub fn decodeHexAlloc(allocator: std.mem.Allocator, hex: []const u8) ![]u8 {
    if (hex.len % 2 != 0) return error.InvalidHex;
    const out = try allocator.alloc(u8, hex.len / 2);
    errdefer allocator.free(out);

    for (out, 0..) |*byte, i| {
        const high = try hexValue(hex[i * 2]);
        const low = try hexValue(hex[i * 2 + 1]);
        byte.* = (high << 4) | low;
    }
    return out;
}

fn hexValue(ch: u8) !u8 {
    return switch (ch) {
        '0'...'9' => ch - '0',
        'a'...'f' => ch - 'a' + 10,
        'A'...'F' => ch - 'A' + 10,
        else => error.InvalidHex,
    };
}

pub fn appendHex(out: *std.ArrayListUnmanaged(u8), allocator: std.mem.Allocator, data: []const u8) !void {
    const hex = "0123456789abcdef";
    for (data) |ch| {
        try out.append(allocator, hex[ch >> 4]);
        try out.append(allocator, hex[ch & 0x0f]);
    }
}

pub fn appendJsonString(out: *std.ArrayListUnmanaged(u8), allocator: std.mem.Allocator, data: []const u8) !void {
    const hex = "0123456789abcdef";
    var i: usize = 0;
    while (i < data.len) {
        const ch = data[i];
        switch (ch) {
            '"' => try out.appendSlice(allocator, "\\\""),
            '\\' => try out.appendSlice(allocator, "\\\\"),
            '\n' => try out.appendSlice(allocator, "\\n"),
            '\r' => try out.appendSlice(allocator, "\\r"),
            '\t' => try out.appendSlice(allocator, "\\t"),
            else => {
                if (ch < 0x20) {
                    try out.appendSlice(allocator, "\\u00");
                    try out.append(allocator, hex[ch >> 4]);
                    try out.append(allocator, hex[ch & 0x0f]);
                } else if (ch < 0x80) {
                    try out.append(allocator, ch);
                } else {
                    const len = std.unicode.utf8ByteSequenceLength(ch) catch {
                        try out.appendSlice(allocator, "\\ufffd");
                        i += 1;
                        continue;
                    };
                    if (i + len > data.len) {
                        try out.appendSlice(allocator, "\\ufffd");
                        i += 1;
                        continue;
                    }
                    _ = std.unicode.utf8Decode(data[i .. i + len]) catch {
                        try out.appendSlice(allocator, "\\ufffd");
                        i += 1;
                        continue;
                    };
                    try out.appendSlice(allocator, data[i .. i + len]);
                    i += len;
                    continue;
                }
            },
        }
        i += 1;
    }
}

// ---- tests ----------------------------------------------------------------

const TestTransport = struct {
    allocator: std.mem.Allocator,
    received: std.ArrayListUnmanaged([]u8) = .empty,

    fn send(ctx: *anyopaque, message: []const u8) void {
        const self: *TestTransport = @ptrCast(@alignCast(ctx));
        const copy = self.allocator.dupe(u8, message) catch return;
        self.received.append(self.allocator, copy) catch self.allocator.free(copy);
    }

    fn deinit(self: *TestTransport) void {
        for (self.received.items) |m| self.allocator.free(m);
        self.received.deinit(self.allocator);
    }
};

const TestSink = struct {
    buf: [64]u8 = undefined,
    len: usize = 0,

    fn write(ctx: *anyopaque, data: []const u8) void {
        const self: *TestSink = @ptrCast(@alignCast(ctx));
        self.len = @min(data.len, self.buf.len);
        @memcpy(self.buf[0..self.len], data[0..self.len]);
    }
};

const TestAiAgentOpenCtx = struct {
    called: bool = false,
    request_id_buf: [128]u8 = undefined,
    request_id_len: usize = 0,

    fn onOpen(ctx: *anyopaque, request_id: []const u8) void {
        const self: *TestAiAgentOpenCtx = @ptrCast(@alignCast(ctx));
        self.called = true;
        self.request_id_len = @min(request_id.len, self.request_id_buf.len);
        @memcpy(self.request_id_buf[0..self.request_id_len], request_id[0..self.request_id_len]);
    }
};

test "hub fans output out to every transport and dedupes layouts" {
    const allocator = std.testing.allocator;
    var hub = Hub.init(allocator);
    defer hub.deinit();
    var a = TestTransport{ .allocator = allocator };
    defer a.deinit();
    var b = TestTransport{ .allocator = allocator };
    defer b.deinit();
    hub.addTransport(&a, TestTransport.send);
    hub.addTransport(&b, TestTransport.send);

    hub.sendOutput("0000000000000001", "hi");
    hub.sendLayout("{\"type\":\"layout\",\"activeTab\":0,\"tabs\":[]}");
    hub.sendLayout("{\"type\":\"layout\",\"activeTab\":0,\"tabs\":[]}");

    try std.testing.expectEqual(@as(usize, 2), a.received.items.len);
    try std.testing.expectEqual(@as(usize, 2), b.received.items.len);
    try std.testing.expectEqualStrings(
        "{\"type\":\"output-bytes\",\"surfaceId\":\"0000000000000001\",\"encoding\":\"hex\",\"data\":\"6869\"}",
        a.received.items[0],
    );

    try std.testing.expect(hub.replayLastLayout(&b));
    try std.testing.expectEqualStrings("{\"type\":\"layout\",\"activeTab\":0,\"tabs\":[]}", b.received.items[2]);

    hub.removeTransport(&a);
    hub.sendOutput("0000000000000001", "x");
    try std.testing.expectEqual(@as(usize, 2), a.received.items.len);
    try std.testing.expectEqual(@as(usize, 4), b.received.items.len);
}

test "hub routes input-bytes to the registered surface sink" {
    const allocator = std.testing.allocator;
    var hub = Hub.init(allocator);
    defer hub.deinit();
    var sink = TestSink{};
    hub.registerSurface("0000000000000001".*, &sink, TestSink.write);

    hub.handleIncomingMessage("{\"type\":\"input-bytes\",\"surfaceId\":\"0000000000000001\",\"encoding\":\"hex\",\"data\":\"0d1b5b41\"}");
    try std.testing.expectEqualSlices(u8, "\r\x1b[A", sink.buf[0..sink.len]);

    hub.unregisterSurface("0000000000000001".*);
    sink.len = 0;
    hub.handleIncomingMessage("{\"type\":\"input-bytes\",\"surfaceId\":\"0000000000000001\",\"encoding\":\"hex\",\"data\":\"41\"}");
    try std.testing.expectEqual(@as(usize, 0), sink.len);
}

test "only the relay path supplies lease identity to terminal sinks" {
    const Sink = struct {
        state: terminal_control.State = .{},
        received: usize = 0,

        fn control(ctx: *anyopaque, request: terminal_control.Request) void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            _ = self.state.apply(request, .{}, 0);
        }

        fn write(ctx: *anyopaque, data: []const u8, identity: terminal_control.Identity) void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            if (self.state.authorize(identity) != null) self.received += data.len;
        }
    };
    var sink: Sink = .{};
    var hub = Hub.init(std.testing.allocator);
    defer hub.deinit();
    hub.registerTerminalSurface("0000000000000001".*, &sink, Sink.write, Sink.control, null);
    const acquire = "{\"type\":\"terminal-control\",\"surfaceId\":\"0000000000000001\",\"clientId\":\"owner\",\"action\":\"acquire\"}";
    const input = "{\"type\":\"input-bytes\",\"surfaceId\":\"0000000000000001\",\"clientId\":\"owner\",\"leaseId\":1,\"data\":\"41\"}";
    hub.handleIncomingMessage(acquire);
    try std.testing.expect(sink.state.holder == null);
    hub.handleRelayMessage(acquire);
    try std.testing.expectEqualStrings("owner", sink.state.holder.?.clientId());
    hub.handleIncomingMessage(input);
    try std.testing.expectEqual(@as(usize, 0), sink.received);
    hub.handleRelayMessage(input);
    try std.testing.expectEqual(@as(usize, 1), sink.received);
}

test "workspace actions use authenticated relay admission and the published window" {
    const allocator = std.testing.allocator;
    var hub = Hub.init(allocator);
    defer hub.deinit();
    var receiver: TestTransport = .{ .allocator = allocator };
    defer receiver.deinit();
    hub.addTransport(&receiver, TestTransport.send);
    hub.registerWorkspaceWakeup(struct {
        fn wake() void {}
    }.wake);

    var message = "{\"type\":\"workspace-action\",\"action\":\"create-tab\",\"requestId\":\"request-1\",\"clientId\":\"client-1\"}".*;
    hub.handleRelayMessage(&message);
    try std.testing.expect(std.mem.indexOf(u8, receiver.received.items[0], "\"status\":\"unsupported\"") != null);

    try std.testing.expect(hub.sendLayoutIfCurrent("{\"type\":\"layout\",\"workspaceActions\":true,\"tabs\":[]}", null, 1));
    hub.handleIncomingMessage(&message);
    try std.testing.expect(hub.takeWorkspaceRequest(1) == null);

    hub.handleRelayMessage(&message);
    @memset(&message, 'x');
    try std.testing.expect(hub.takeWorkspaceRequest(2) == null);
    const queued = hub.takeWorkspaceRequest(1).?.action;
    defer queued.deinit();
    try std.testing.expectEqualStrings("request-1", queued.value.requestId);
    try std.testing.expectEqualStrings("client-1", queued.value.clientId);
    hub.sendWorkspaceActionResult(queued.value, .{ .status = .ok, .tab_id = "0000000000000001".*, .surface_id = "0000000000000002".* });
    try std.testing.expectEqualStrings(
        "{\"type\":\"workspace-action-result\",\"requestId\":\"request-1\",\"clientId\":\"client-1\",\"status\":\"ok\",\"tabId\":\"0000000000000001\",\"surfaceId\":\"0000000000000002\"}",
        receiver.received.items[2],
    );
}

test "authenticated tab control shares the workspace FIFO with its mutations" {
    const allocator = std.testing.allocator;
    var hub = Hub.init(allocator);
    defer hub.deinit();
    hub.registerWorkspaceWakeup(struct {
        fn wake() void {}
    }.wake);
    try std.testing.expect(hub.sendLayoutIfCurrent("{\"type\":\"layout\",\"tabControl\":true,\"tabs\":[]}", null, 1));
    const acquire = "{\"type\":\"tab-control\",\"action\":\"acquire\",\"tabId\":\"0000000000000001\",\"clientId\":\"phone\"}";
    const action = "{\"type\":\"workspace-action\",\"action\":\"close-tab\",\"requestId\":\"test-1\",\"clientId\":\"phone\",\"tabId\":\"0000000000000001\",\"layoutRevision\":\"0000000000000002\",\"leaseId\":1}";
    hub.handleIncomingMessage(acquire);
    try std.testing.expect(hub.takeWorkspaceRequest(1) == null);
    hub.handleRelayMessage(acquire);
    hub.handleRelayMessage(action);
    try std.testing.expect(hub.takeWorkspaceRequest(2) == null);
    const first = hub.takeWorkspaceRequest(1).?;
    defer first.deinit();
    try std.testing.expectEqual(.acquire, first.control.value.action);
    try std.testing.expectEqualStrings("phone", first.control.value.clientId);
    const next = hub.takeWorkspaceRequest(1).?;
    defer next.deinit();
    try std.testing.expectEqual(.@"close-tab", next.action.value.action);
    try std.testing.expectEqual(@as(u32, 1), next.action.value.leaseId.?);
}

test "grid publication invalidates layouts from before the commit" {
    const allocator = std.testing.allocator;
    const surface_id = "0000000000000001";
    var hub = Hub.init(allocator);
    defer hub.deinit();
    var transport = TestTransport{ .allocator = allocator };
    defer transport.deinit();
    hub.addTransport(&transport, TestTransport.send);
    const epoch = hub.currentGridEpoch();
    hub.sendLayout("{\"type\":\"layout\",\"tabs\":[]}");
    hub.sendTerminalGrid(surface_id, .{ .cols = 1, .rows = 24 });
    try std.testing.expect(!hub.sendLayoutIfCurrent("{\"type\":\"layout\",\"tabs\":[{}]}", epoch, null));
    try std.testing.expect(hub.layoutNeedsGridRefresh());
    try std.testing.expect(!hub.replayLastLayout(&transport));
    hub.sendOutput(surface_id, "redraw");
    try std.testing.expectEqual(@as(usize, 3), transport.received.items.len);
    try std.testing.expectEqualStrings(
        "{\"type\":\"terminal-grid\",\"surfaceId\":\"0000000000000001\",\"cols\":1,\"rows\":24}",
        transport.received.items[1],
    );
    try std.testing.expect(isJsonMessageType(transport.received.items[2], "output-bytes"));

    hub.sendTerminalControlState(surface_id, null, .denied);
    try std.testing.expectEqualStrings(
        "{\"type\":\"terminal-control-state\",\"surfaceId\":\"0000000000000001\",\"clientId\":null,\"leaseId\":null,\"reason\":\"denied\"}",
        transport.received.items[3],
    );
}

test "open ai agent message dispatches request id" {
    const allocator = std.testing.allocator;
    var hub = Hub.init(allocator);
    defer hub.deinit();

    var ctx = TestAiAgentOpenCtx{};
    hub.registerAiAgentOpener(&ctx, TestAiAgentOpenCtx.onOpen);
    hub.handleIncomingMessage("{\"type\":\"open-ai-agent\",\"requestId\":\"remote-ai-1\"}");

    try std.testing.expect(ctx.called);
    try std.testing.expectEqualStrings("remote-ai-1", ctx.request_id_buf[0..ctx.request_id_len]);
}

test "open ai agent without registered opener broadcasts failed result" {
    const allocator = std.testing.allocator;
    var hub = Hub.init(allocator);
    defer hub.deinit();
    var t = TestTransport{ .allocator = allocator };
    defer t.deinit();
    hub.addTransport(&t, TestTransport.send);

    hub.handleIncomingMessage("{\"type\":\"open-ai-agent\",\"requestId\":\"remote-ai-1\"}");

    try std.testing.expectEqual(@as(usize, 1), t.received.items.len);
    try std.testing.expectEqualStrings(
        "{\"type\":\"open-ai-agent-result\",\"requestId\":\"remote-ai-1\",\"status\":\"failed\"}",
        t.received.items[0],
    );
}

test "open ai agent result message escapes request id" {
    const allocator = std.testing.allocator;
    const message = try buildAiAgentOpenResultMessage(allocator, "remote-\"one", .no_profile);
    defer allocator.free(message);

    try std.testing.expectEqualStrings(
        "{\"type\":\"open-ai-agent-result\",\"requestId\":\"remote-\\\"one\",\"status\":\"no-profile\"}",
        message,
    );
}

test "buildOutputMessage preserves PTY bytes as hex" {
    const allocator = std.testing.allocator;
    const message = try buildOutputMessage(allocator, "0000000000000001", "\x1b[31mhi\r\n");
    defer allocator.free(message);

    try std.testing.expectEqualStrings(
        "{\"type\":\"output-bytes\",\"surfaceId\":\"0000000000000001\",\"encoding\":\"hex\",\"data\":\"1b5b33316d68690d0a\"}",
        message,
    );
}

test "remote json string replaces invalid utf8 bytes" {
    const allocator = std.testing.allocator;
    const bad = [_]u8{ 'o', 'k', ' ', 0xff, ' ', 0xc3 };
    var out: std.ArrayListUnmanaged(u8) = .empty;
    defer out.deinit(allocator);

    try appendJsonString(&out, allocator, bad[0..]);
    try std.testing.expectEqualStrings("ok \\ufffd \\ufffd", out.items);
    try std.testing.expect(std.unicode.utf8ValidateSlice(out.items));
}

test "remote json string preserves valid multibyte utf8" {
    const allocator = std.testing.allocator;
    var out: std.ArrayListUnmanaged(u8) = .empty;
    defer out.deinit(allocator);

    try appendJsonString(&out, allocator, "标题 🚀");
    try std.testing.expectEqualStrings("标题 🚀", out.items);
    try std.testing.expect(std.unicode.utf8ValidateSlice(out.items));
}

test "decode input message bytes" {
    const allocator = std.testing.allocator;
    const bytes = try decodeHexAlloc(allocator, "0d1b5b41");
    defer allocator.free(bytes);

    try std.testing.expectEqualSlices(u8, "\r\x1b[A", bytes);
}

test "terminal image paste denies LAN and missing leases before staging and removes a rejected attachment" {
    const allocator = std.testing.allocator;
    const owner = "f9615093-77ee-4431-bfed-ab436d8510d3";
    const Sink = struct {
        authorized: usize = 0,
        path: ?[]u8 = null,
        staged_valid_image: bool = false,

        fn write(_: *anyopaque, _: []const u8, _: terminal_control.Identity) void {}

        fn authorize(ctx: *anyopaque, identity: terminal_control.Identity) image_paste.Authorization {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.authorized += 1;
            if (!std.mem.eql(u8, identity.client_id.?, owner) or identity.lease_id != 9) return .denied;
            return .{ .accepted = .{ .kind = .local, .epoch = 13 } };
        }

        fn enqueue(ctx: *anyopaque, _: terminal_control.Identity, target: image_paste.Target, text: []const u8) image_paste.Status {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            if (target.epoch != 13) return .failed;
            self.path = allocator.dupe(u8, std.mem.trim(u8, text, "\"")) catch return .failed;
            const contents = std.fs.cwd().readFileAlloc(allocator, self.path.?, 64) catch return .failed;
            defer allocator.free(contents);
            self.staged_valid_image = std.mem.eql(u8, contents, "\x89PNG\r\n\x1a\n");
            return .denied; // The lease can change while the temporary file is written.
        }
    };

    var hub = Hub.init(allocator);
    defer hub.deinit();
    var receiver: TestTransport = .{ .allocator = allocator };
    defer receiver.deinit();
    hub.addTransport(&receiver, TestTransport.send);
    var sink: Sink = .{};
    defer if (sink.path) |path| {
        std.fs.deleteFileAbsolute(path) catch {};
        allocator.free(path);
    };
    hub.registerTerminalSurface("0000000000000001".*, &sink, Sink.write, null, .{ .authorize = Sink.authorize, .enqueue = Sink.enqueue });
    const prefix =
        \\{"type":"terminal-image-paste","requestId":"paste-9","surfaceId":"0000000000000001","clientId":"
    ;
    const payload = prefix ++ owner ++ "\",\"mime\":\"image/png\",\"data\":\"iVBORw0KGgo=\"";
    hub.handleIncomingMessage(payload ++ ",\"leaseId\":9}");
    try std.testing.expectEqual(@as(usize, 0), receiver.received.items.len);
    hub.handleRelayMessage(payload ++ "}");
    try std.testing.expectEqual(@as(usize, 0), sink.authorized);
    const result =
        \\{"type":"terminal-image-paste-result","requestId":"paste-9","clientId":"
    ;
    const denied = result ++ owner ++ "\",\"status\":\"denied\"}";
    try std.testing.expectEqualStrings(denied, receiver.received.items[0]);

    hub.handleRelayMessage(payload ++ ",\"leaseId\":10}");
    try std.testing.expectEqual(@as(usize, 1), sink.authorized);
    try std.testing.expect(sink.path == null);
    try std.testing.expectEqualStrings(denied, receiver.received.items[1]);

    hub.handleRelayMessage(payload ++ ",\"leaseId\":9}");
    try std.testing.expect(sink.staged_valid_image);
    try std.testing.expectError(error.FileNotFound, std.fs.accessAbsolute(sink.path.?, .{}));
    try std.testing.expectEqualStrings(denied, receiver.received.items[2]);
}

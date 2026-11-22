//! Wire contract for authenticated Remote workspace mutations.

const std = @import("std");

pub const Id = [16]u8;
pub const max_tree_nodes = 127;
pub const max_tab_title_bytes = 256;

pub const Axis = enum { x, y };

pub const Node = struct {
    surfaceId: ?Id = null,
    axis: ?Axis = null,
    ratio: ?f64 = null,
};

pub const Action = enum { @"create-tab", @"add-pane", @"close-pane", @"close-tab", @"set-layout", @"rename-tab" };

pub const Request = struct {
    type: []const u8,
    requestId: []const u8,
    clientId: []const u8,
    action: Action,
    tabId: ?Id = null,
    layoutRevision: ?Id = null,
    leaseId: ?u32 = null,
    surfaceId: ?Id = null,
    splitTree: ?[]const Node = null,
    title: ?[]const u8 = null,
};

pub const Status = enum { ok, stale, unsupported, protected, limit, failed, denied };

pub const Result = struct {
    status: Status,
    tab_id: ?Id = null,
    surface_id: ?Id = null,
};

pub fn formatId(value: u64) Id {
    var id: Id = undefined;
    _ = std.fmt.bufPrint(&id, "{x:0>16}", .{value}) catch unreachable;
    return id;
}

pub fn validId(id: Id) bool {
    for (id) |byte| switch (byte) {
        '0'...'9', 'a'...'f' => {},
        else => return false,
    };
    return true;
}

fn validRequestId(id: []const u8) bool {
    if (id.len == 0 or id.len > 64) return false;
    for (id) |byte| {
        if (!std.ascii.isAlphanumeric(byte) and byte != '_' and byte != '-') return false;
    }
    return true;
}

/// The returned request owns its fields independently of the WebSocket frame.
pub fn parse(allocator: std.mem.Allocator, message: []const u8) ?std.json.Parsed(Request) {
    // Frame space for 127 flat nodes and the bounded identifiers.
    if (message.len > 16 * 1024) return null;
    const parsed = std.json.parseFromSlice(Request, allocator, message, .{ .allocate = .alloc_always }) catch return null;
    if (std.mem.eql(u8, parsed.value.type, "workspace-action") and validRequest(parsed.value)) return parsed;
    parsed.deinit();
    return null;
}

/// A single UTF-8 line of title text; an empty string clears the override.
pub fn validTabTitle(title: []const u8) bool {
    if (title.len > max_tab_title_bytes) return false;
    const view = std.unicode.Utf8View.init(title) catch return false;
    var codepoints = view.iterator();
    while (codepoints.nextCodepoint()) |codepoint| {
        switch (codepoint) {
            0...0x1f, 0x7f...0x9f, 0x2028, 0x2029 => return false,
            else => {},
        }
    }
    return true;
}

fn validRequest(request: Request) bool {
    if (!validRequestId(request.requestId) or request.clientId.len == 0 or request.clientId.len > 64) return false;

    if (request.action == .@"create-tab") {
        return request.tabId == null and request.layoutRevision == null and request.leaseId == null and request.surfaceId == null and request.splitTree == null and request.title == null;
    }
    if (!validId(request.tabId orelse return false) or !validId(request.layoutRevision orelse return false)) return false;
    if (request.action == .@"rename-tab") {
        return request.leaseId == null and request.surfaceId == null and request.splitTree == null and validTabTitle(request.title orelse return false);
    }
    if (request.title != null) return false;
    return switch (request.action) {
        .@"create-tab", .@"rename-tab" => unreachable,
        .@"add-pane", .@"close-pane" => request.splitTree == null and validId(request.surfaceId orelse return false),
        .@"close-tab" => request.surfaceId == null and request.splitTree == null,
        .@"set-layout" => request.surfaceId == null and validTree(request.splitTree orelse return false),
    };
}

pub fn validTree(nodes: []const Node) bool {
    if (nodes.len == 0 or nodes.len > max_tree_nodes) return false;
    var open_children: usize = 1;
    for (nodes) |node| {
        if (open_children == 0) return false;
        open_children -= 1;
        if (node.surfaceId) |surface_id| {
            if (!validId(surface_id) or node.axis != null or node.ratio != null) return false;
        } else {
            const ratio = node.ratio orelse return false;
            if (node.axis == null or !std.math.isFinite(ratio) or ratio <= 0 or ratio >= 1) return false;
            open_children += 2;
        }
    }
    return open_children == 0;
}

test "workspace wire requires stable targets and complete finite binary trees" {
    const a = std.testing.allocator;
    const prefix =
        \\{"type":"workspace-action","clientId":"browser","requestId":"id-1","action":"set-layout","tabId":"0123456789abcdef","layoutRevision":"1111111111111111","splitTree":
    ;
    const leaf = "{\"surfaceId\":\"0000000000000001\"}";
    const split = "{\"axis\":\"y\",\"ratio\":0.5}";
    const parsed = parse(a, prefix ++ "[" ++ split ++ "," ++ leaf ++ "," ++ leaf ++ "]}").?;
    defer parsed.deinit();
    try std.testing.expectEqual(Axis.y, parsed.value.splitTree.?[0].axis.?);
    try std.testing.expectEqualStrings("0000000000000001", &parsed.value.splitTree.?[1].surfaceId.?);
    try std.testing.expect(parse(a, prefix ++ "[" ++ split ++ "," ++ leaf ++ "]}") == null);
    try std.testing.expect(parse(a, prefix ++ "[" ++ leaf ++ "," ++ leaf ++ "]}") == null);
    try std.testing.expect(parse(a, prefix ++ "[{\"axis\":\"x\",\"ratio\":1}," ++ leaf ++ "," ++ leaf ++ "]}") == null);
    try std.testing.expect(parse(a, prefix ++ "[{\"axis\":\"x\",\"ratio\":1e999}," ++ leaf ++ "," ++ leaf ++ "]}") == null);
    try std.testing.expect(parse(a,
        \\{"type":"workspace-action","clientId":"browser","requestId":"id-2","action":"close-tab","tabId":"0123456789abcdef"}
    ) == null);
}

test "workspace rename accepts one UTF-8 line without a lease" {
    const a = std.testing.allocator;
    const target = "{\"type\":\"workspace-action\",\"clientId\":\"browser\",\"requestId\":\"rename-id\",\"action\":\"rename-tab\",\"tabId\":\"0123456789abcdef\",\"layoutRevision\":\"1111111111111111\"";
    const max_title = "🔧" ** 64;
    const titled = parse(a, target ++ ",\"title\":\"" ++ max_title ++ "\"}").?;
    defer titled.deinit();
    try std.testing.expectEqualStrings(max_title, titled.value.title.?);
    const cleared = parse(a, target ++ ",\"title\":\"\"}").?;
    defer cleared.deinit();
    try std.testing.expectEqualStrings("", cleared.value.title.?);
    try std.testing.expect(parse(a, target ++ "}") == null);
    try std.testing.expect(parse(a, target ++ ",\"title\":null}") == null);
    try std.testing.expect(parse(a, target ++ ",\"title\":\"Desk\",\"leaseId\":4}") == null);
    try std.testing.expect(parse(a, target ++ ",\"title\":\"Desk\",\"surfaceId\":\"0000000000000001\"}") == null);
    try std.testing.expect(parse(a, target ++ ",\"title\":\"" ++ max_title ++ "a\"}") == null);
    for ([_][]const u8{ "\\n", "\\u001b", "\\u007f", "\\u0085", "\\u2028", "\\u2029", "\\ud800" }) |control| {
        const invalid = try std.fmt.allocPrint(a, "{s},\"title\":\"a{s}b\"}}", .{ target, control });
        defer a.free(invalid);
        try std.testing.expect(parse(a, invalid) == null);
    }
    try std.testing.expect(!validTabTitle("\xff"));
    try std.testing.expect(validTabTitle("  Work  "));
}

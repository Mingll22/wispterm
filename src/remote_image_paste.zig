//! Relay image paste wire contract and temporary attachment staging.
const std = @import("std");
const control = @import("remote_terminal_control.zig");
const workspace = @import("remote_workspace.zig");
const platform_dirs = @import("platform/dirs.zig");
const platform_wsl = @import("platform/wsl.zig");
const terminal_paste = @import("terminal_paste.zig");

pub const wire_type = "terminal-image-paste";
pub const wire_prefix = "{\"type\":\"" ++ wire_type ++ "\"";
pub const max_image_bytes = 4 * 1024 * 1024;
const max_encoded_bytes = std.base64.standard.Encoder.calcSize(max_image_bytes);
pub const max_message_bytes = max_encoded_bytes + 512;

pub const Status = enum { queued, invalid, unsupported, denied, failed };

pub const TargetKind = enum { local, wsl };

pub const Target = struct {
    kind: TargetKind,
    epoch: u64,
};

pub const Authorization = union(enum) {
    accepted: Target,
    denied,
    unsupported,
};

pub const Wire = struct {
    type: []const u8,
    requestId: []const u8,
    clientId: []const u8,
    surfaceId: []const u8 = "",
    leaseId: ?std.json.Value = null,
    mime: []const u8 = "",
    data: []const u8 = "",

    pub fn identity(self: Wire) ?control.Identity {
        const value = self.leaseId orelse return null;
        // Leases issued by the desktop are positive u32 values. Larger
        // JSON-safe integers can never identify a lease on this host.
        if (value != .integer or value.integer <= 0) return null;
        const lease_id = std.math.cast(u32, value.integer) orelse return null;
        return .{ .client_id = self.clientId, .lease_id = lease_id };
    }

    pub fn validSurface(self: Wire) bool {
        return self.surfaceId.len == 16 and workspace.validId(self.surfaceId[0..16].*);
    }
};

const Mime = enum {
    png,
    jpeg,

    fn signature(self: Mime) []const u8 {
        return switch (self) {
            .png => "\x89PNG\r\n\x1a\n",
            .jpeg => "\xff\xd8\xff",
        };
    }

    fn extension(self: Mime) []const u8 {
        return switch (self) {
            .png => ".png",
            .jpeg => ".jpg",
        };
    }
};

pub const Image = struct {
    bytes: []u8,
    mime: Mime,
};

pub fn validRequestId(id: []const u8) bool {
    if (id.len == 0 or id.len > 80) return false;
    for (id) |byte| {
        if (!std.ascii.isAlphanumeric(byte) and byte != '-' and byte != '_') return false;
    }
    return true;
}

pub fn validClientId(id: []const u8) bool {
    if (id.len != 36) return false;
    for (id, 0..) |byte, i| {
        switch (i) {
            8, 13, 18, 23 => if (byte != '-') return false,
            else => if (!std.ascii.isHex(byte)) return false,
        }
    }
    return true;
}

pub fn decode(allocator: std.mem.Allocator, wire: Wire) error{ InvalidImage, OutOfMemory }!Image {
    const mime: Mime = if (std.mem.eql(u8, wire.mime, "image/png"))
        .png
    else if (std.mem.eql(u8, wire.mime, "image/jpeg"))
        .jpeg
    else
        return error.InvalidImage;

    if (wire.data.len > max_encoded_bytes) return error.InvalidImage;
    const decoder = std.base64.standard.Decoder;
    const size = decoder.calcSizeForSlice(wire.data) catch return error.InvalidImage;
    if (size < mime.signature().len or size > max_image_bytes) return error.InvalidImage;

    const bytes = try allocator.alloc(u8, size);
    errdefer allocator.free(bytes);
    decoder.decode(bytes, wire.data) catch return error.InvalidImage;
    if (!std.mem.startsWith(u8, bytes, mime.signature())) return error.InvalidImage;
    return .{ .bytes = bytes, .mime = mime };
}

pub const Attachment = struct {
    path: []u8,
    paste_text: []u8,

    pub fn deinit(self: Attachment, allocator: std.mem.Allocator, queued: bool) void {
        // Match the desktop clipboard attachment lifetime on success. The
        // application inside the terminal may open the file after this call.
        if (!queued) std.fs.deleteFileAbsolute(self.path) catch {};
        allocator.free(self.paste_text);
        allocator.free(self.path);
    }
};

pub fn stage(allocator: std.mem.Allocator, image: Image, kind: TargetKind) !Attachment {
    const dir = try platform_dirs.tempDir(allocator);
    defer allocator.free(dir);
    const name = try std.fmt.allocPrint(allocator, "wispterm-clipboard-{x:0>32}{s}", .{
        std.crypto.random.int(u128), image.mime.extension(),
    });
    defer allocator.free(name);
    const path = try std.fs.path.join(allocator, &.{ dir, name });
    errdefer allocator.free(path);
    if (!std.fs.path.isAbsolute(path) or std.mem.indexOfAny(u8, path, "\x00\r\n") != null)
        return error.InvalidTempPath;

    const guest_path = switch (kind) {
        .local => null,
        .wsl => (try platform_wsl.hostPathToGuestPathAlloc(allocator, path)) orelse return error.InvalidTempPath,
    };
    defer if (guest_path) |guest| allocator.free(guest);
    const paste_text = try terminal_paste.quotePath(allocator, guest_path orelse path);
    errdefer allocator.free(paste_text);

    // A randomly generated name isolates successive uploads. Exclusive create
    // prevents accidentally replacing a file that already exists.
    const file = try std.fs.createFileAbsolute(path, .{ .exclusive = true });
    errdefer std.fs.deleteFileAbsolute(path) catch {};
    defer file.close();
    try file.writeAll(image.bytes);
    return .{ .path = path, .paste_text = paste_text };
}

test "image paste validates standard base64 and the declared image signature" {
    const allocator = std.testing.allocator;
    var wire: Wire = .{ .type = wire_type, .requestId = "paste-1", .clientId = "f9615093-77ee-4431-bfed-ab436d8510d3", .mime = "image/png", .data = "iVBORw0KGgo=" };
    const png = try decode(allocator, wire);
    defer allocator.free(png.bytes);
    try std.testing.expectEqualStrings("\x89PNG\r\n\x1a\n", png.bytes);
    wire.data = "iVBORw0KGgo";
    try std.testing.expectError(error.InvalidImage, decode(allocator, wire));
    wire.data = "iVBORw0KGgp=";
    try std.testing.expectError(error.InvalidImage, decode(allocator, wire));
    wire.data = "/9j/";
    try std.testing.expectError(error.InvalidImage, decode(allocator, wire));
    wire.mime = "image/jpeg";
    const jpeg = try decode(allocator, wire);
    defer allocator.free(jpeg.bytes);
    try std.testing.expectEqualStrings("\xff\xd8\xff", jpeg.bytes);
}

test "image paste caps decoded size even when base64 fits the assembly limit" {
    const allocator = std.testing.allocator;
    const encoded = try allocator.alloc(u8, max_encoded_bytes);
    defer allocator.free(encoded);
    @memset(encoded, 'A');
    const wire: Wire = .{ .type = wire_type, .requestId = "bounded", .clientId = "", .mime = "image/png", .data = encoded };
    try std.testing.expectError(error.InvalidImage, decode(allocator, wire));
}

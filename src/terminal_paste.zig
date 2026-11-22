//! Encoding shared by desktop and leased remote PTY paste.
const std = @import("std");

/// Returns owned bytes only when framing or normalization is required.
pub fn encode(allocator: std.mem.Allocator, data: []const u8, bracketed: bool) !?[]u8 {
    const start = "\x1b[200~";
    const end = "\x1b[201~";
    if (bracketed) {
        // Queue the whole transaction so another write cannot split the frame.
        const framed = try std.mem.concat(allocator, u8, &.{ start, data, end });
        sanitize(framed[start.len .. framed.len - end.len], true);
        return framed;
    }
    for (data) |byte| {
        if (isPasteStripByte(byte) or byte == '\n') {
            const normalized = try allocator.dupe(u8, data);
            sanitize(normalized, false);
            return normalized;
        }
    }
    return null;
}

fn sanitize(data: []u8, bracketed: bool) void {
    for (data) |*byte| {
        if (isPasteStripByte(byte.*)) {
            byte.* = ' ';
        } else if (!bracketed and byte.* == '\n') {
            byte.* = '\r';
        }
    }
}

fn isPasteStripByte(byte: u8) bool {
    return switch (byte) {
        0x00, // NUL
        0x08, // BS
        0x05, // ENQ
        0x04, // EOT
        0x1B, // ESC
        0x7F, // DEL
        0x03, // VINTR (Ctrl+C)
        0x1C, // VQUIT (Ctrl+\)
        0x15, // VKILL (Ctrl+U)
        0x1A, // VSUSP (Ctrl+Z)
        0x11, // VSTART (Ctrl+Q)
        0x13, // VSTOP (Ctrl+S)
        0x17, // VWERASE (Ctrl+W)
        0x16, // VLNEXT (Ctrl+V)
        0x12, // VREPRINT (Ctrl+R)
        0x0F, // VDISCARD (Ctrl+O)
        => true,
        else => false,
    };
}

pub fn quotePath(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    if (std.mem.indexOfAny(u8, path, " \t\"") == null) return allocator.dupe(u8, path);
    return std.fmt.allocPrint(allocator, "\"{s}\"", .{path});
}

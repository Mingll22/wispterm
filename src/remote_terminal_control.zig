//! Ownership and resize intent for one real PTY. Callers serialize access.
const std = @import("std");
const GridSize = @import("core/geometry.zig").GridSize;

pub const duration_ms = 60 * std.time.ms_per_s;
pub const Action = enum { acquire, takeover, renew, release, resize };
pub const Reason = enum { acquired, taken, released, expired, desktop, denied, unsupported };

pub const Request = struct {
    client_id: []const u8,
    action: Action,
    lease_id: ?u32 = null,
    grid: ?GridSize = null,
};

pub const Identity = struct {
    client_id: ?[]const u8 = null,
    lease_id: ?u32 = null,
};

pub const Holder = struct {
    client_id: [64]u8 = undefined,
    len: usize,
    id: u32,
    expires_at_ms: u64,
    grid: GridSize,

    pub fn clientId(self: *const Holder) []const u8 {
        return self.client_id[0..self.len];
    }
};

pub const State = struct {
    desktop_grid: GridSize = .{},
    holder: ?Holder = null,
    // Tag both desktop and remote queued writes. A writer may already be in
    // a PTY syscall at a transition, but an unstarted write cannot cross it.
    input_epoch: u64 = 0,
    next_lease_id: u32 = 1,

    pub fn targetGrid(self: *const State) GridSize {
        return if (self.holder) |holder| holder.grid else self.desktop_grid;
    }

    pub fn apply(self: *State, request: Request, actual_grid: GridSize, now_ms: u64) ?Reason {
        switch (request.action) {
            .acquire, .takeover => {
                if (request.client_id.len == 0 or request.client_id.len > @sizeOf(@FieldType(Holder, "client_id"))) return .denied;
                const replacing = self.holder != null;
                if (request.action == .acquire) {
                    if (self.holder) |*holder| {
                        return if (std.mem.eql(u8, holder.clientId(), request.client_id)) .acquired else .denied;
                    }
                }

                self.holder = .{
                    .len = request.client_id.len,
                    .id = self.next_lease_id,
                    .expires_at_ms = now_ms + duration_ms,
                    .grid = request.grid orelse if (replacing) actual_grid else self.desktop_grid,
                };
                @memcpy(self.holder.?.client_id[0..request.client_id.len], request.client_id);
                self.next_lease_id = if (self.next_lease_id == std.math.maxInt(u32)) 1 else self.next_lease_id + 1;
                self.input_epoch +%= 1;
                return if (replacing) .taken else .acquired;
            },
            .renew, .release, .resize => {
                const holder = if (self.holder) |*holder| holder else return .denied;
                if (!matches(holder, .{ .client_id = request.client_id, .lease_id = request.lease_id })) return .denied;
                switch (request.action) {
                    .renew => holder.expires_at_ms = now_ms + duration_ms,
                    .release => {
                        _ = self.reclaim();
                        return .released;
                    },
                    .resize => holder.grid = request.grid orelse return .denied,
                    else => unreachable,
                }
                return null;
            },
        }
    }

    pub fn expire(self: *State, now_ms: u64) bool {
        const holder = self.holder orelse return false;
        if (now_ms < holder.expires_at_ms) return false;
        return self.reclaim();
    }

    pub fn reclaim(self: *State) bool {
        if (self.holder == null) return false;
        self.holder = null;
        self.input_epoch +%= 1;
        return true;
    }

    pub fn authorize(self: *const State, identity: Identity) ?u64 {
        const accepts = if (self.holder) |*holder| matches(holder, identity) else identity.lease_id == null;
        return if (accepts) self.input_epoch else null;
    }
};

fn matches(holder: *const Holder, identity: Identity) bool {
    return holder.id == (identity.lease_id orelse return false) and
        std.mem.eql(u8, holder.clientId(), identity.client_id orelse return false);
}

pub fn sameGrid(a: GridSize, b: GridSize) bool {
    return a.cols == b.cols and a.rows == b.rows;
}

test "takeover invalidates the old queued writes and queued resize intent" {
    var state: State = .{};
    const desktop_write = state.authorize(.{}).?;
    try std.testing.expectEqual(.acquired, state.apply(.{ .client_id = "first", .action = .acquire }, .{}, 0).?);
    const first: Identity = .{ .client_id = "first", .lease_id = state.holder.?.id };
    const first_write = state.authorize(first).?;
    try std.testing.expect(first_write != desktop_write);
    try std.testing.expect(state.authorize(.{}) == null);
    try std.testing.expect(state.authorize(.{ .client_id = "spoof", .lease_id = first.lease_id }) == null);
    try std.testing.expectEqual(.denied, state.apply(.{ .client_id = "second", .action = .acquire }, .{}, 1).?);
    try std.testing.expectEqualStrings("first", state.holder.?.clientId());
    try std.testing.expectEqual(null, state.apply(.{ .client_id = "first", .lease_id = first.lease_id, .action = .resize, .grid = .{ .cols = 40, .rows = 16 } }, .{}, 2));

    try std.testing.expectEqual(.taken, state.apply(.{ .client_id = "second", .action = .takeover }, .{}, 3).?);
    try std.testing.expect(state.holder.?.id != first.lease_id.?);
    try std.testing.expect(state.input_epoch != first_write);
    try std.testing.expect(state.authorize(first) == null);
    try std.testing.expect(sameGrid(state.targetGrid(), .{}));
}

test "renew extends the monotonic deadline and expiry restores the latest desktop size" {
    var state: State = .{};
    _ = state.apply(.{ .client_id = "client", .action = .acquire, .grid = .{ .cols = 36 } }, .{}, 100);
    const lease_id = state.holder.?.id;
    state.desktop_grid = .{ .cols = 132, .rows = 60 };
    try std.testing.expectEqual(null, state.apply(.{ .client_id = "client", .lease_id = lease_id, .action = .renew }, .{}, 20_000));
    try std.testing.expect(!state.expire(60_100));
    try std.testing.expect(state.expire(80_000));
    try std.testing.expect(sameGrid(state.targetGrid(), state.desktop_grid));
    try std.testing.expect(state.authorize(.{ .client_id = "client", .lease_id = lease_id }) == null);
    try std.testing.expect(state.authorize(.{}) != null);
}

//! Remote lease ownership and PTY resize intent. Callers serialize access.
const std = @import("std");
const GridSize = @import("core/geometry.zig").GridSize;
const workspace = @import("remote_workspace.zig");

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
    origin: enum { relay, lan } = .relay,
};

pub const max_tab_grids = 16;

pub const TabGrid = struct {
    surfaceId: workspace.Id,
    cols: u16,
    rows: u16,

    pub fn size(self: TabGrid) GridSize {
        return .{ .cols = self.cols, .rows = self.rows };
    }
};

pub const TabRequest = struct {
    type: []const u8,
    tabId: workspace.Id,
    clientId: []const u8,
    action: Action,
    leaseId: ?u32 = null,
    grids: ?[]const TabGrid = null,

    pub fn identity(self: TabRequest) Identity {
        return .{ .client_id = self.clientId, .lease_id = self.leaseId };
    }

    pub fn parse(allocator: std.mem.Allocator, message: []const u8) ?std.json.Parsed(TabRequest) {
        if (message.len > 2048) return null;
        const parsed = std.json.parseFromSlice(TabRequest, allocator, message, .{ .allocate = .alloc_always }) catch return null;
        if (parsed.value.valid()) return parsed;
        parsed.deinit();
        return null;
    }

    fn valid(request: TabRequest) bool {
        if (!std.mem.eql(u8, request.type, "tab-control") or !workspace.validId(request.tabId) or !validClientId(request.clientId)) return false;
        switch (request.action) {
            .acquire, .takeover => return request.leaseId == null and request.grids == null,
            .renew, .release => return request.leaseId != null and request.leaseId.? != 0 and request.grids == null,
            .resize => {
                if ((request.leaseId orelse 0) == 0) return false;
                const grids = request.grids orelse return false;
                if (grids.len == 0 or grids.len > max_tab_grids) return false;
                for (grids, 0..) |grid, index| {
                    if (!workspace.validId(grid.surfaceId) or grid.cols < 2 or grid.cols > 512 or grid.rows < 1 or grid.rows > 256) return false;
                    for (grids[0..index]) |previous| {
                        if (std.mem.eql(u8, &previous.surfaceId, &grid.surfaceId)) return false;
                    }
                }
                return true;
            },
        }
    }
};

const max_client_id = 64;

fn validClientId(id: []const u8) bool {
    return id.len != 0 and id.len <= max_client_id;
}

pub const TabGrant = struct {
    client_id: [max_client_id]u8,
    len: usize,
    id: u32,
    renewed_at: std.time.Instant,

    fn init(client_id: []const u8, id: u32, now: std.time.Instant) TabGrant {
        var grant: TabGrant = .{ .client_id = undefined, .len = client_id.len, .id = id, .renewed_at = now };
        @memcpy(grant.client_id[0..client_id.len], client_id);
        return grant;
    }

    pub fn clientId(self: *const TabGrant) []const u8 {
        return self.client_id[0..self.len];
    }

    pub fn matches(self: *const TabGrant, identity: Identity) bool {
        return identity.origin == .relay and self.id == (identity.lease_id orelse return false) and
            std.mem.eql(u8, self.clientId(), identity.client_id orelse return false);
    }

    pub fn remainingNs(self: TabGrant, now: std.time.Instant) u64 {
        const elapsed = if (now.order(self.renewed_at) == .lt) 0 else now.since(self.renewed_at);
        return duration_ms * std.time.ns_per_ms -| elapsed;
    }

    pub fn live(self: TabGrant) bool {
        return self.remainingNs(std.time.Instant.now() catch return false) != 0;
    }
};

/// One grant and one deadline for the live split tree, owned by the UI thread.
pub const TabLease = struct {
    grant: ?TabGrant = null,
    next_id: u32 = 1,

    pub fn apply(self: *TabLease, request: TabRequest, now: std.time.Instant) ?Reason {
        switch (request.action) {
            .acquire, .takeover => {
                if (!validClientId(request.clientId)) return .denied;
                if (request.action == .acquire) {
                    if (self.grant) |*grant| {
                        return if (std.mem.eql(u8, grant.clientId(), request.clientId)) .acquired else .denied;
                    }
                }
                const replacing = self.grant != null;
                self.grant = TabGrant.init(request.clientId, self.next_id, now);
                self.next_id = nextLeaseId(self.next_id);
                return if (replacing) .taken else .acquired;
            },
            .renew, .release, .resize => {
                const grant = if (self.grant) |*grant| grant else return .denied;
                if (!grant.matches(request.identity()) or grant.remainingNs(now) == 0) return .denied;
                switch (request.action) {
                    .renew => grant.renewed_at = now,
                    .release => {
                        self.grant = null;
                        return .released;
                    },
                    .resize => {},
                    else => unreachable,
                }
                return null;
            },
        }
    }

    pub fn authorizes(self: *const TabLease, identity: Identity) bool {
        const grant = if (self.grant) |*grant| grant else return false;
        return grant.matches(identity) and grant.live();
    }
};

const TabMember = union(enum) {
    legacy,
    idle,
    leased: struct {
        grant: TabGrant,
        grid: GridSize,
    },
};

fn nextLeaseId(current: u32) u32 {
    return if (current == std.math.maxInt(u32)) 1 else current + 1;
}

pub const Holder = struct {
    client_id: [max_client_id]u8 = undefined,
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
    tab: TabMember = .legacy,

    pub fn targetGrid(self: *const State) GridSize {
        if (self.tab == .leased) return self.tab.leased.grid;
        return if (self.holder) |holder| holder.grid else self.desktop_grid;
    }

    pub fn tabManaged(self: *const State) bool {
        return self.tab != .legacy;
    }

    pub fn active(self: *const State) bool {
        return self.tab == .leased or self.holder != null;
    }

    /// The host holds all affected members' locks while changing a grant.
    /// Renewal only updates the common deadline. A takeover discards queued
    /// resize intent from the prior owner and starts from the confirmed grid.
    pub fn mirrorTab(self: *State, managed: bool, grant: ?TabGrant, actual_grid: GridSize) void {
        if (!managed) {
            if (self.tab == .legacy) return;
            self.tab = .legacy;
        } else if (grant) |next| {
            if (self.tab == .leased and self.tab.leased.grant.id == next.id) {
                self.tab.leased.grant = next;
                return;
            }
            self.tab = .{ .leased = .{ .grant = next, .grid = if (self.tab == .leased) actual_grid else self.desktop_grid } };
        } else {
            if (self.tab == .idle) return;
            self.tab = .idle;
        }
        self.holder = null;
        self.input_epoch +%= 1;
    }

    pub fn setTabGrid(self: *State, grid: GridSize) void {
        std.debug.assert(self.tab == .leased);
        self.tab.leased.grid = grid;
    }

    pub fn admitsGrid(self: *const State, grid: GridSize) bool {
        return (self.tab != .leased or self.tab.leased.grant.live()) and sameGrid(self.targetGrid(), grid);
    }

    pub fn admitsEpoch(self: *const State, epoch: u64) bool {
        return self.input_epoch == epoch and (self.tab != .leased or self.tab.leased.grant.live());
    }

    pub fn apply(self: *State, request: Request, actual_grid: GridSize, now_ms: u64) ?Reason {
        if (self.tabManaged()) return .unsupported;
        switch (request.action) {
            .acquire, .takeover => {
                if (!validClientId(request.client_id)) return .denied;
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
                self.next_lease_id = nextLeaseId(self.next_lease_id);
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

    pub fn authorize(self: *const State, identity: ?Identity) ?u64 {
        const accepts = switch (self.tab) {
            .legacy => if (self.holder) |*holder| matches(holder, identity orelse .{}) else identity == null or identity.?.lease_id == null,
            .idle => if (identity) |remote| remote.origin == .lan else true,
            .leased => |lease| lease.grant.matches(identity orelse return null) and lease.grant.live(),
        };
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

test "tab control requires one valid lease and distinct bounded member grids" {
    const allocator = std.testing.allocator;
    const prefix =
        \\{"type":"tab-control","tabId":"0000000000000001","clientId":"phone","action":"resize","leaseId":9,"grids":
    ;
    const first = "{\"surfaceId\":\"0000000000000002\",\"cols\":40,\"rows\":18}";
    const parsed = TabRequest.parse(allocator, prefix ++ "[" ++ first ++ "]}").?;
    defer parsed.deinit();
    try std.testing.expectEqual(@as(u32, 9), parsed.value.leaseId.?);
    try std.testing.expectEqual(GridSize{ .cols = 40, .rows = 18 }, parsed.value.grids.?[0].size());
    try std.testing.expect(TabRequest.parse(allocator, prefix ++ "[]}") == null);
    try std.testing.expect(TabRequest.parse(allocator, prefix ++ "[" ++ first ++ "," ++ first ++ "]}") == null);
    try std.testing.expect(TabRequest.parse(allocator, prefix ++ "[{\"surfaceId\":\"0000000000000002\",\"cols\":513,\"rows\":18}]}") == null);
    try std.testing.expect(TabRequest.parse(allocator,
        \\{"type":"tab-control","tabId":"0000000000000001","clientId":"phone","action":"renew"}
    ) == null);
}

test "one tab renewal extends both member deadlines and expiry invalidates both input gates" {
    const start = try std.time.Instant.now();
    const Clock = struct {
        fn advance(instant: std.time.Instant, seconds: u64) std.time.Instant {
            const os = @import("builtin").os.tag;
            var next = instant;
            switch (os) {
                .windows => next.timestamp += seconds * std.os.windows.QueryPerformanceFrequency(),
                .uefi, .wasi => next.timestamp += seconds * std.time.ns_per_s,
                else => next.timestamp.sec += @intCast(seconds),
            }
            return next;
        }
    };
    var lease: TabLease = .{};
    var request: TabRequest = .{
        .type = "tab-control",
        .tabId = "0000000000000001".*,
        .clientId = "phone",
        .action = .acquire,
    };
    try std.testing.expectEqual(.acquired, lease.apply(request, start).?);
    request.leaseId = lease.grant.?.id;
    request.action = .renew;
    try std.testing.expectEqual(null, lease.apply(request, Clock.advance(start, 30)));
    try std.testing.expect(lease.grant.?.remainingNs(Clock.advance(start, 60)) == 30 * std.time.ns_per_s);
    try std.testing.expect(lease.grant.?.remainingNs(Clock.advance(start, 91)) == 0);
    try std.testing.expectEqual(.denied, lease.apply(request, Clock.advance(start, 91)).?);

    var a: State = .{};
    var b: State = .{ .desktop_grid = .{ .cols = 90, .rows = 28 } };
    a.mirrorTab(true, lease.grant, .{});
    b.mirrorTab(true, lease.grant, .{});
    const a_epoch = a.authorize(request.identity()).?;
    const b_epoch = b.authorize(request.identity()).?;
    try std.testing.expect(a.authorize(null) == null and b.authorize(null) == null);
    try std.testing.expect(a.authorize(.{ .origin = .lan }) == null);
    try std.testing.expectEqual(.unsupported, a.apply(.{ .client_id = "other", .action = .takeover }, .{}, 0).?);
    a.mirrorTab(true, null, .{});
    b.mirrorTab(true, null, .{});
    try std.testing.expect(!a.admitsEpoch(a_epoch) and !b.admitsEpoch(b_epoch));
    try std.testing.expect(a.authorize(request.identity()) == null and b.authorize(request.identity()) == null);
    try std.testing.expect(a.authorize(null) != null and b.authorize(null) != null);
    try std.testing.expect(a.authorize(.{ .origin = .lan }) != null);
    try std.testing.expect(a.authorize(.{}) == null);
    try std.testing.expectEqual(b.desktop_grid, b.targetGrid());
}

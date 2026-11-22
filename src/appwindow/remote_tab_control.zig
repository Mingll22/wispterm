//! Host-side lease for an eligible terminal tab. The UI thread owns the live
//! split tree and changes every member's PTY gate before publishing a grant.
const std = @import("std");
const Surface = @import("../Surface.zig");
const SplitTree = @import("../split_tree.zig");
const remote_control = @import("../remote_terminal_control.zig");
const remote_hub = @import("../remote_hub.zig");
const workspace = @import("../remote_workspace.zig");

pub const State = struct {
    enabled: bool = false,
    lease: remote_control.TabLease = .{},

    pub fn setEnabled(self: *State, tree: *const SplitTree, enabled: bool) void {
        if (self.enabled == enabled) return;
        std.debug.assert(self.lease.grant == null);
        self.enabled = enabled;
        self.mirror(tree, .immediate);
    }

    pub fn attach(self: *const State, surface: *Surface) void {
        if (!self.enabled) return;
        surface.lockRemoteTabControl();
        defer surface.unlockRemoteTabControl();
        surface.setRemoteTabControlLocked(true, self.lease.grant, .immediate);
    }

    pub fn detach(self: *const State, surface: *Surface) void {
        if (!self.enabled) return;
        surface.lockRemoteTabControl();
        defer surface.unlockRemoteTabControl();
        // The departing surface may still have an IO thread while it closes.
        surface.setRemoteTabControlLocked(true, null, .immediate);
    }

    pub fn request(
        self: *State,
        tree: *const SplitTree,
        hub: *remote_hub.Hub,
        wire: remote_control.TabRequest,
    ) void {
        if (!self.enabled) {
            hub.sendTabControlState(wire.tabId, null, .unsupported);
            return;
        }
        const now = std.time.Instant.now() catch {
            self.publish(hub, wire.tabId, .unsupported);
            return;
        };
        _ = self.expire(tree, hub, wire.tabId, now);
        const reason = self.lease.apply(wire, now);
        if (reason == .denied) {
            self.publish(hub, wire.tabId, .denied);
            return;
        }
        switch (wire.action) {
            .acquire, .takeover, .renew, .release => self.mirror(tree, .immediate),
            .resize => if (!resize(tree, wire.grids.?)) {
                self.publish(hub, wire.tabId, .denied);
                return;
            },
        }
        if (reason) |value| self.publish(hub, wire.tabId, value);
    }

    pub fn reclaim(
        self: *State,
        tree: *const SplitTree,
        hub: ?*remote_hub.Hub,
        id: ?workspace.Id,
        reason: remote_control.Reason,
        resize_policy: Surface.ResizePolicy,
    ) bool {
        if (self.lease.grant == null) return false;
        self.lease.grant = null;
        self.mirror(tree, resize_policy);
        if (hub) |remote| if (id) |tab_id| self.publish(remote, tab_id, reason);
        return true;
    }

    pub fn expire(self: *State, tree: *const SplitTree, hub: *remote_hub.Hub, id: workspace.Id, now: std.time.Instant) ?u64 {
        const grant = self.lease.grant orelse return null;
        const remaining = grant.remainingNs(now);
        if (remaining != 0) return remaining;
        _ = self.reclaim(tree, hub, id, .expired, .immediate);
        return null;
    }

    fn mirror(self: *const State, tree: *const SplitTree, resize_policy: Surface.ResizePolicy) void {
        const members = Members.lock(tree);
        defer members.unlock();
        for (members.list()) |surface| surface.setRemoteTabControlLocked(self.enabled, self.lease.grant, resize_policy);
    }

    fn publish(self: *const State, hub: *remote_hub.Hub, id: workspace.Id, reason: remote_control.Reason) void {
        hub.sendTabControlState(id, if (self.lease.grant) |*grant| grant else null, reason);
    }
};

fn resize(tree: *const SplitTree, grids: []const remote_control.TabGrid) bool {
    const members = Members.lock(tree);
    defer members.unlock();
    var targets: [remote_control.max_tab_grids]*Surface = undefined;
    for (grids, 0..) |grid, index| {
        targets[index] = for (members.list()) |surface| {
            if (std.mem.eql(u8, &surface.remote_id, &grid.surfaceId)) break surface;
        } else return false;
    }
    for (grids, targets[0..grids.len]) |grid, surface| surface.setRemoteTabGridLocked(grid.size());
    return true;
}

const Members = struct {
    surfaces: [(workspace.max_tree_nodes + 1) / 2]*Surface = undefined,
    len: usize = 0,

    fn lock(tree: *const SplitTree) Members {
        var members: Members = .{};
        var it = tree.surfaces();
        while (it.next()) |entry| {
            entry.surface.lockRemoteTabControl();
            members.surfaces[members.len] = entry.surface;
            members.len += 1;
        }
        return members;
    }

    fn list(self: *const Members) []const *Surface {
        return self.surfaces[0..self.len];
    }

    fn unlock(self: *const Members) void {
        var index = self.len;
        while (index > 0) {
            index -= 1;
            self.surfaces[index].unlockRemoteTabControl();
        }
    }
};

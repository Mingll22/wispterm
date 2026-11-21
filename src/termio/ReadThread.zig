/// Blocking PTY reader thread.
///
/// Runs a tight blocking read loop on the PTY output stream, processing VT
/// data under the render lock.
///
/// This is critical for resize: some PTY backends emit a redraw when the grid
/// size changes. The pending read on this thread keeps output draining while
/// the writer thread applies the resize.
///
/// Shutdown is delegated to the platform PTY backend.
const std = @import("std");
const Command = @import("../Command.zig");
const Surface = @import("../Surface.zig");
const window_backend = @import("../platform/window_backend.zig");
const read_coalesce = @import("read_coalesce.zig");

/// Large reads keep the per-chunk overhead (render-lock acquisition, VT parse
/// setup, OSC/agent scans, UI wakeup) off the hot path during output floods:
/// fewer, bigger chunks instead of thousands of 4KB ones. Both PTY backends
/// accept arbitrary buffer sizes.
const READ_BUF_SIZE = 64 * 1024;

/// After PTY EOF/EIO, retry waitpid this long so a single WNOHANG cannot
/// leave a defunct child. Short enough that a process which closed the
/// slave and kept running cannot hang the reader thread.
const CHILD_REAP_TIMEOUT_MS: u64 = 250;

pub fn threadMain(surface: *Surface) void {
    defer surface.markStopped();

    var scratch: [READ_BUF_SIZE]u8 = undefined;
    var pending: std.ArrayListUnmanaged(u8) = .empty;
    defer pending.deinit(surface.allocator);

    while (!surface.exited.load(.acquire)) {
        const bytes_read = surface.pty.readOutput(&scratch) catch |err| {
            switch (handleReadError(surface, err)) {
                .retry => continue,
                .stop => return,
            }
        };
        if (bytes_read == 0) {
            if (!surface.exited.load(.acquire)) {
                surface.markExited(.eof, surface.command.waitUntilReaped(CHILD_REAP_TIMEOUT_MS));
            }
            return;
        }

        pending.clearRetainingCapacity();
        if (!appendOutput(surface, &pending, scratch[0..bytes_read])) return;
        while (true) {
            if (!drainAvailableOutput(surface, &pending, &scratch)) return;
            if (processOutput(surface, pending.items)) break;
            if (surface.exited.load(.acquire)) return;
            // The writer is in a native resize. Keep draining its output so
            // the resize can complete, but wait for the confirmed grid before
            // publishing these same bytes to the VT and remote transports.
            std.Thread.sleep(std.time.ns_per_ms);
        }
        if (markExitedIfProcessEndedAfterOutput(surface)) return;
    }
}

fn appendOutput(surface: *Surface, pending: *std.ArrayListUnmanaged(u8), data: []const u8) bool {
    pending.appendSlice(surface.allocator, data) catch |err| {
        surface.failIo(.pty_read, err);
        return false;
    };
    return true;
}

fn drainAvailableOutput(
    surface: *Surface,
    pending: *std.ArrayListUnmanaged(u8),
    scratch: *[READ_BUF_SIZE]u8,
) bool {
    while (!surface.exited.load(.acquire)) {
        const available = surface.pty.outputAvailable() orelse break;
        const to_read = if (surface.resize_in_progress.load(.acquire))
            @min(available, scratch.len)
        else
            read_coalesce.nextDrainLen(available, scratch.len, pending.items.len);
        if (to_read == 0) break;

        const bytes_read = surface.pty.readOutput(scratch[0..to_read]) catch |err| switch (handleReadError(surface, err)) {
            .retry => continue,
            .stop => break,
        };
        if (bytes_read == 0) {
            if (!surface.exited.load(.acquire)) {
                surface.markExited(.eof, surface.command.waitUntilReaped(CHILD_REAP_TIMEOUT_MS));
            }
            break;
        }
        if (!appendOutput(surface, pending, scratch[0..bytes_read])) return false;
    }
    return true;
}

fn processOutput(surface: *Surface, data: []const u8) bool {
    surface.render_state.mutex.lock();
    defer surface.render_state.mutex.unlock();
    if (surface.resize_in_progress.load(.acquire)) return false;

    if (surface.remote_hub.load(.acquire)) |hub| {
        var offset: usize = 0;
        while (offset < data.len) {
            const end = @min(offset + READ_BUF_SIZE, data.len);
            hub.sendOutput(&surface.remote_id, data[offset..end]);
            offset = end;
        }
    }

    surface.resetOscBatch();
    surface.feedVtWithWispTermImageFallback(data);
    surface.scanForOscTitle(data);
    // One wakeup per UI consume cycle is enough — the render loop drains all
    // pending output on a single frame; per-chunk posts only flood the
    // platform event queue during output bursts. The exception is the chunk
    // that ends a synchronized frame (mode 2026): dirty is already set by
    // then — by the mode change itself, or latched since the render loop
    // deferred the frame — so the frame end has to post the wakeup, or the
    // finished frame waits for the loop's idle timeout.
    const first_dirty = surface.markOutputDirty();
    const frame_ended = surface.takeSynchronizedFrameEndedLocked();
    if (first_dirty or frame_ended) window_backend.postWakeup();
    return true;
}

const ExitAfterOutput = struct {
    available: ?usize,
    status: ?Command.Exit,
};

fn shouldMarkExitedAfterOutput(sample: ExitAfterOutput) bool {
    return sample.available != null and sample.available.? == 0 and sample.status != null;
}

fn markExitedIfProcessEndedAfterOutput(surface: *Surface) bool {
    const available = surface.pty.outputAvailable();
    if (available == null or available.? != 0) return false;

    const status = surface.pollExitStatus() orelse return false;
    if (!shouldMarkExitedAfterOutput(.{ .available = available, .status = status })) return false;

    surface.markExited(.eof, status);
    return true;
}

const ReadErrorAction = enum { retry, stop };

fn handleReadError(surface: *Surface, err: anyerror) ReadErrorAction {
    if (err == error.ReadInterrupted) {
        return if (surface.exited.load(.acquire)) .stop else .retry;
    }

    if (surface.exited.load(.acquire)) return .stop;

    if (err == error.BrokenPipe) {
        surface.markExited(.broken_pipe, surface.command.waitUntilReaped(CHILD_REAP_TIMEOUT_MS));
        return .stop;
    }

    surface.failIo(.pty_read, err);
    return .stop;
}

test "read thread marks process exit after drained output only" {
    try std.testing.expect(shouldMarkExitedAfterOutput(.{ .available = 0, .status = Command.Exit{ .exited = 0 } }));
    try std.testing.expect(!shouldMarkExitedAfterOutput(.{ .available = 12, .status = Command.Exit{ .exited = 0 } }));
    try std.testing.expect(!shouldMarkExitedAfterOutput(.{ .available = 0, .status = null }));
    try std.testing.expect(!shouldMarkExitedAfterOutput(.{ .available = null, .status = Command.Exit{ .exited = 0 } }));
}

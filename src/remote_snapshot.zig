const std = @import("std");
const ghostty_vt = @import("ghostty-vt");
const jupyter_detect = @import("jupyter/detect.zig");

pub const default_max_history_rows: usize = 10_000;

/// Smaller history budget for the live agent/Copilot snapshot path. The full
/// active screen is always included; only this many recent scrollback rows are
/// prepended, so the live interactive screen at the bottom is never crowded out
/// or truncated away. WeChat's remote path keeps the larger default.
pub const agent_max_history_rows: usize = 400;

const SnapshotFormat = enum {
    plain,
    vt,
};

/// Web-console replay of the host VT screen, including cell styles and
/// input-affecting modes. Live output continues from this state after attach.
/// Text consumers use `allocTerminalSnapshot`.
pub fn allocTerminalSnapshotWithModes(
    allocator: std.mem.Allocator,
    terminal: *const ghostty_vt.Terminal,
    max_history_rows: usize,
) ![]u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    // Must precede the content so it lands in the same screen as on the host.
    if (terminal.screens.active_key == .alternate)
        try out.appendSlice(allocator, "\x1b[?1049h");

    try appendTerminalRows(allocator, &out, terminal, max_history_rows, .vt);

    try appendInputModes(allocator, &out, terminal);
    return out.toOwnedSlice(allocator);
}

/// Emit only deviations from xterm defaults so a mode-less shell snapshot
/// stays escape-free.
fn appendInputModes(
    allocator: std.mem.Allocator,
    out: *std.ArrayListUnmanaged(u8),
    terminal: *const ghostty_vt.Terminal,
) !void {
    const modes = &terminal.modes;
    if (modes.get(.cursor_keys)) try out.appendSlice(allocator, "\x1b[?1h");
    if (!modes.get(.cursor_visible)) try out.appendSlice(allocator, "\x1b[?25l");
    if (modes.get(.focus_event)) try out.appendSlice(allocator, "\x1b[?1004h");
    if (modes.get(.bracketed_paste)) try out.appendSlice(allocator, "\x1b[?2004h");
    // No ?1007 (alternate scroll): xterm.js doesn't implement it — on the alt
    // buffer it always converts wheel to arrow keys, which is what we want.
    switch (terminal.flags.mouse_event) {
        .none => return,
        .x10 => try out.appendSlice(allocator, "\x1b[?9h"),
        .normal => try out.appendSlice(allocator, "\x1b[?1000h"),
        .button => try out.appendSlice(allocator, "\x1b[?1002h"),
        .any => try out.appendSlice(allocator, "\x1b[?1003h"),
    }
    switch (terminal.flags.mouse_format) {
        .x10 => {},
        .utf8 => try out.appendSlice(allocator, "\x1b[?1005h"),
        .sgr => try out.appendSlice(allocator, "\x1b[?1006h"),
        .urxvt => try out.appendSlice(allocator, "\x1b[?1015h"),
        .sgr_pixels => try out.appendSlice(allocator, "\x1b[?1016h"),
    }
}

pub fn allocTerminalSnapshot(
    allocator: std.mem.Allocator,
    terminal: *const ghostty_vt.Terminal,
    max_history_rows: usize,
) ![]u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    try appendTerminalRows(allocator, &out, terminal, max_history_rows, .plain);
    return out.toOwnedSlice(allocator);
}

fn appendTerminalRows(
    allocator: std.mem.Allocator,
    out: *std.ArrayListUnmanaged(u8),
    terminal: *const ghostty_vt.Terminal,
    max_history_rows: usize,
    comptime format: SnapshotFormat,
) !void {
    const screen = terminal.screens.active;
    const pages = &screen.pages;
    const history_total = pages.total_rows -| pages.rows;
    const history_start = history_total -| max_history_rows;
    var rows = pages.rowIterator(
        .right_down,
        .{ .screen = .{ .x = 0, .y = @intCast(history_start) } },
        null,
    );

    var wrote_row = false;
    var prev_wrapped = false;
    var style: ghostty_vt.Style = .{};
    while (rows.next()) |pin| {
        // Replay soft wraps as one logical line.
        if (wrote_row and !prev_wrapped) {
            // Scrolling with a non-default background can fill the new row
            // with that background before any cells are written.
            if (format == .vt) try appendStyleChange(allocator, out, &style, .{});
            try out.appendSlice(allocator, "\r\n");
        }
        wrote_row = true;

        const page = &pin.node.data;
        const row = pin.rowAndCell().row;
        const page_cells = page.getCells(row);
        const cells = page_cells[0..@min(page_cells.len, pages.cols)];
        // A colored cell that triggers an automatic wrap can scroll and fill
        // the new row with its background. Replay the tail to restore defaults.
        const wrap_can_fill = format == .vt and prev_wrapped and
            snapshotCellStyle(page, &cells[0]).bg_color != .none;
        var end_col = cells.len;
        if (!row.wrap and !wrap_can_fill) {
            while (end_col > 0) : (end_col -= 1) {
                const cell = &cells[end_col - 1];
                const cp = cell.codepoint();
                if (cp != 0 and cp != ' ') break;
                if (format == .vt and (cell.hasStyling() or
                    cell.content_tag == .bg_color_palette or cell.content_tag == .bg_color_rgb)) break;
            }
        }
        // Emit one cell on an otherwise empty continuation to trigger the wrap.
        if (format == .vt and prev_wrapped and end_col == 0) end_col = 1;
        prev_wrapped = row.wrap;

        for (cells[0..end_col]) |*cell| {
            switch (cell.wide) {
                .spacer_head, .spacer_tail => continue,
                .narrow, .wide => {},
            }
            if (format == .vt) {
                try appendStyleChange(allocator, out, &style, snapshotCellStyle(page, cell));
            }
            try appendCellText(allocator, out, page, cell, format);
        }
    }

    // Restore SGR state for live writes that begin without a style sequence.
    if (format == .vt) try appendStyleChange(allocator, out, &style, screen.cursor.style);
}

fn snapshotCellStyle(page: *const ghostty_vt.Page, cell: *const ghostty_vt.Cell) ghostty_vt.Style {
    var style: ghostty_vt.Style = if (cell.hasStyling()) page.styles.get(page.memory, cell.style_id).* else .{};
    // Ghostty stores background-only cells separately from SGR-styled text.
    switch (cell.content_tag) {
        .bg_color_palette => style.bg_color = .{ .palette = cell.content.color_palette },
        .bg_color_rgb => {
            const rgb = cell.content.color_rgb;
            style.bg_color = .{ .rgb = .{ .r = rgb.r, .g = rgb.g, .b = rgb.b } };
        },
        else => {},
    }
    return style;
}

fn appendStyleChange(
    allocator: std.mem.Allocator,
    out: *std.ArrayListUnmanaged(u8),
    style: *ghostty_vt.Style,
    next: ghostty_vt.Style,
) !void {
    if (style.eql(next)) return;
    try out.print(allocator, "{f}", .{next.formatterVt()});
    style.* = next;
}

fn appendCellText(
    allocator: std.mem.Allocator,
    out: *std.ArrayListUnmanaged(u8),
    page: *const ghostty_vt.Page,
    cell: *const ghostty_vt.Cell,
    comptime format: SnapshotFormat,
) !void {
    const cp = cell.codepoint();
    if (cp == 0 or (format == .plain and cp == ' ')) {
        try out.append(allocator, ' ');
        return;
    }

    var buf: [4]u8 = undefined;
    const len = std.unicode.utf8Encode(@intCast(cp), &buf) catch {
        try out.append(allocator, ' ');
        return;
    };
    try out.appendSlice(allocator, buf[0..len]);

    if (!cell.hasGrapheme()) return;
    if (page.lookupGrapheme(cell)) |extra_cps| {
        for (extra_cps) |ecp| {
            const extra_len = std.unicode.utf8Encode(@intCast(ecp), &buf) catch continue;
            try out.appendSlice(allocator, buf[0..extra_len]);
        }
    }
}

test "remote terminal snapshot includes scrollback before active screen" {
    var terminal = try ghostty_vt.Terminal.init(std.testing.allocator, .{
        .cols = 16,
        .rows = 3,
        .max_scrollback = 1024,
    });
    defer terminal.deinit(std.testing.allocator);

    var stream = terminal.vtStream();
    defer stream.deinit();
    stream.nextSlice("line1\r\nline2\r\nline3\r\nline4\r\nline5\r\nline6");

    const snapshot = try allocTerminalSnapshot(std.testing.allocator, &terminal, 1024);
    defer std.testing.allocator.free(snapshot);

    try std.testing.expect(std.mem.indexOf(u8, snapshot, "line1") != null);
    try std.testing.expect(std.mem.indexOf(u8, snapshot, "line6") != null);
    try std.testing.expectEqual(terminal.screens.active.pages.total_rows, snapshotRowCount(snapshot));
}

fn snapshotRowCount(snapshot: []const u8) usize {
    if (snapshot.len == 0) return 0;
    return std.mem.count(u8, snapshot, "\r\n") + 1;
}

test "agent snapshot caps history to the most recent rows but keeps the active screen" {
    var terminal = try ghostty_vt.Terminal.init(std.testing.allocator, .{
        .cols = 16,
        .rows = 3,
        .max_scrollback = 4096,
    });
    defer terminal.deinit(std.testing.allocator);

    var stream = terminal.vtStream();
    defer stream.deinit();
    var i: usize = 1;
    while (i <= 13) : (i += 1) {
        var buf: [32]u8 = undefined;
        const line = std.fmt.bufPrint(&buf, "row{d}\r\n", .{i}) catch unreachable;
        stream.nextSlice(line);
    }

    // Cap history to 2 rows: oldest scrollback dropped, active screen kept.
    const snapshot = try allocTerminalSnapshot(std.testing.allocator, &terminal, 2);
    defer std.testing.allocator.free(snapshot);

    try std.testing.expect(std.mem.indexOf(u8, snapshot, "row1\r\n") == null);
    try std.testing.expect(std.mem.indexOf(u8, snapshot, "row13") != null);
}

test "web snapshot mirrors alt-screen and mouse-tracking modes (issue #502)" {
    var terminal = try ghostty_vt.Terminal.init(std.testing.allocator, .{
        .cols = 20,
        .rows = 4,
        .max_scrollback = 1024,
    });
    defer terminal.deinit(std.testing.allocator);

    var stream = terminal.vtStream();
    defer stream.deinit();
    // The modes Claude Code sets at startup, captured from a live PTY.
    stream.nextSlice("\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004hTUI FRAME");

    const snapshot = try allocTerminalSnapshotWithModes(std.testing.allocator, &terminal, 1024);
    defer std.testing.allocator.free(snapshot);

    // Alt-screen switch must precede the content so it lands in the alt buffer.
    try std.testing.expect(std.mem.startsWith(u8, snapshot, "\x1b[?1049h"));
    const content_at = std.mem.indexOf(u8, snapshot, "TUI FRAME").?;
    for ([_][]const u8{ "\x1b[?1003h", "\x1b[?1006h", "\x1b[?1004h", "\x1b[?2004h" }) |mode| {
        try std.testing.expect(std.mem.indexOfPos(u8, snapshot, content_at, mode) != null);
    }
}

test "web snapshot of a plain shell stays escape-free and keeps scrollback" {
    var terminal = try ghostty_vt.Terminal.init(std.testing.allocator, .{
        .cols = 16,
        .rows = 3,
        .max_scrollback = 1024,
    });
    defer terminal.deinit(std.testing.allocator);

    var stream = terminal.vtStream();
    defer stream.deinit();
    stream.nextSlice("line1\r\nline2\r\nline3\r\nline4\r\nline5");

    const snapshot = try allocTerminalSnapshotWithModes(std.testing.allocator, &terminal, 1024);
    defer std.testing.allocator.free(snapshot);

    try std.testing.expect(std.mem.indexOfScalar(u8, snapshot, 0x1b) == null);
    try std.testing.expect(std.mem.indexOf(u8, snapshot, "line1") != null);
    try std.testing.expect(std.mem.indexOf(u8, snapshot, "line5") != null);
}

test "web replay keeps the composer fill on styled spaces and erased rows" {
    const alloc = std.testing.allocator;
    const options: ghostty_vt.Terminal.Options = .{ .cols = 16, .rows = 4 };
    var source = try ghostty_vt.Terminal.init(alloc, options);
    defer source.deinit(alloc);
    var source_stream = source.vtStream();
    defer source_stream.deinit();
    source_stream.nextSlice(
        "\x1b[48;2;30;30;30m\x1b[38;5;250mAsk Codex   \x1b[K\x1b[0m\r\n" ++
            "\x1b[48;5;238m\x1b[2K\x1b[0m\r\n" ++
            " \x1b[7m \x1b[0m  tail\x1b[38;2;12;34;56m",
    );

    const plain = try allocTerminalSnapshot(alloc, &source, 0);
    defer alloc.free(plain);
    try std.testing.expectEqualStrings("Ask Codex\r\n\r\n    tail\r\n", plain);

    const snapshot = try allocTerminalSnapshotWithModes(alloc, &source, 0);
    defer alloc.free(snapshot);
    var replay = try ghostty_vt.Terminal.init(alloc, options);
    defer replay.deinit(alloc);
    var replay_stream = replay.vtStream();
    defer replay_stream.deinit();
    replay_stream.nextSlice(snapshot);

    const pages = &replay.screens.active.pages;
    const label = pages.getCell(.{ .active = .{ .x = 0, .y = 0 } }).?;
    try std.testing.expectEqual(@as(u21, 'A'), label.cell.codepoint());
    try std.testing.expect(label.style().fg_color.eql(.{ .palette = 250 }));
    const gray: ghostty_vt.Style.Color = .{ .rgb = .{ .r = 30, .g = 30, .b = 30 } };
    for (0..options.cols) |col| {
        const x: ghostty_vt.size.CellCountInt = @intCast(col);
        const styled_row = pages.getCell(.{ .active = .{ .x = x, .y = 0 } }).?;
        try std.testing.expect(gray.eql(styled_row.style().bg_color));
        const erased_row = pages.getCell(.{ .active = .{ .x = x, .y = 1 } }).?;
        try std.testing.expect(erased_row.style().bg_color.eql(.{ .palette = 238 }));
    }

    const inverse = pages.getCell(.{ .active = .{ .x = 1, .y = 2 } }).?;
    const gap = pages.getCell(.{ .active = .{ .x = 2, .y = 2 } }).?;
    const empty_row = pages.getCell(.{ .active = .{ .x = 0, .y = 3 } }).?;
    try std.testing.expect(inverse.style().flags.inverse);
    try std.testing.expect(gap.style().default());
    try std.testing.expect(empty_row.style().default());
    try std.testing.expect(source.screens.active.cursor.style.eql(replay.screens.active.cursor.style));
}

test "web replay preserves styling across a wrap at a wide grapheme" {
    const alloc = std.testing.allocator;
    const options: ghostty_vt.Terminal.Options = .{
        .cols = 8,
        .rows = 3,
        .default_modes = .{ .grapheme_cluster = true },
    };
    var source = try ghostty_vt.Terminal.init(alloc, options);
    defer source.deinit(alloc);
    var source_stream = source.vtStream();
    defer source_stream.deinit();
    source_stream.nextSlice("1234567\x1b[48;5;235m界\xcc\x81 \x1b[0mz");

    const snapshot = try allocTerminalSnapshotWithModes(alloc, &source, 0);
    defer alloc.free(snapshot);
    var replay = try ghostty_vt.Terminal.init(alloc, options);
    defer replay.deinit(alloc);
    var replay_stream = replay.vtStream();
    defer replay_stream.deinit();
    replay_stream.nextSlice(snapshot);

    const first = replay.screens.active.pages.getCell(.{ .active = .{ .x = 0, .y = 0 } }).?;
    try std.testing.expect(first.row.wrap);
    const wide = replay.screens.active.pages.getCell(.{ .active = .{ .x = 0, .y = 1 } }).?;
    try std.testing.expectEqual(@as(u21, '界'), wide.cell.codepoint());
    try std.testing.expectEqual(.wide, wide.cell.wide);
    try std.testing.expectEqualSlices(u21, &.{0x301}, wide.node.data.lookupGrapheme(wide.cell).?);
    try std.testing.expect(wide.style().bg_color.eql(.{ .palette = 235 }));
    const next = replay.screens.active.pages.getCell(.{ .active = .{ .x = 3, .y = 1 } }).?;
    try std.testing.expectEqual(@as(u21, 'z'), next.cell.codepoint());
    try std.testing.expect(next.style().default());
}

test "web replay preserves the default tail of a styled wrapped row after scrollback" {
    const alloc = std.testing.allocator;
    const options: ghostty_vt.Terminal.Options = .{ .cols = 8, .rows = 3 };
    var source = try ghostty_vt.Terminal.init(alloc, options);
    defer source.deinit(alloc);
    var source_stream = source.vtStream();
    defer source_stream.deinit();
    source_stream.nextSlice(
        "history\r\nhistory\r\nhistory\r\nhistory\r\nhistory\r\nhistory" ++
            "\x1b[2J\x1b[H12345678\x1b[48;5;235ma\x1b[0mz",
    );

    const snapshot = try allocTerminalSnapshotWithModes(alloc, &source, 10);
    defer alloc.free(snapshot);
    var replay = try ghostty_vt.Terminal.init(alloc, options);
    defer replay.deinit(alloc);
    var replay_stream = replay.vtStream();
    defer replay_stream.deinit();
    replay_stream.nextSlice(snapshot);

    const last_col: ghostty_vt.Point = .{ .active = .{ .x = 7, .y = 1 } };
    const original_tail = source.screens.active.pages.getCell(last_col).?;
    const replayed_tail = replay.screens.active.pages.getCell(last_col).?;
    const replayed_lead = replay.screens.active.pages.getCell(.{ .active = .{ .x = 0, .y = 1 } }).?;
    try std.testing.expect(snapshotCellStyle(&original_tail.node.data, original_tail.cell).bg_color == .none);
    try std.testing.expect(snapshotCellStyle(&replayed_tail.node.data, replayed_tail.cell).bg_color == .none);
    try std.testing.expect(replayed_lead.style().bg_color.eql(.{ .palette = 235 }));
}

test "soft-wrapped line is joined into one logical line (no \\r\\n mid-wrap)" {
    // Regression: a long Jupyter URL printed into a terminal narrower than the
    // URL soft-wraps across rows. The snapshot must NOT insert \r\n at the wrap
    // boundary, or `jupyter_detect` (which treats \r/\n as non-URL bytes) splits
    // the URL and fails to match it — the macOS/narrow-window detection bug.
    var terminal = try ghostty_vt.Terminal.init(std.testing.allocator, .{
        .cols = 40,
        .rows = 6,
        .max_scrollback = 1024,
    });
    defer terminal.deinit(std.testing.allocator);

    var stream = terminal.vtStream();
    defer stream.deinit();
    const url = "http://localhost:8888/lab?token=abcdef0123456789abcdef0123456789";
    stream.nextSlice("To access the server, open this URL:\r\n    ");
    stream.nextSlice(url);
    stream.nextSlice("\r\n");

    const snapshot = try allocTerminalSnapshot(std.testing.allocator, &terminal, 1024);
    defer std.testing.allocator.free(snapshot);

    // The full URL must survive intact across the soft-wrap boundary.
    try std.testing.expect(std.mem.indexOf(u8, snapshot, url) != null);

    // End-to-end: the snapshot of a narrow terminal must still let the detector
    // find the wrapped Jupyter URL (the user-visible macOS auto-detect bug).
    const result = try jupyter_detect.findJupyterUrls(std.testing.allocator, snapshot);
    defer result.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 1), result.urls.len);
    try std.testing.expectEqualStrings(url, result.urls[0]);
}

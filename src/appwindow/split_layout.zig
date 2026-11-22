//! Split layout computation for AppWindow.
//!
//! Computes pixel rectangles for each surface in a split tree, handles
//! hit-testing for split dividers, and provides surface-at-point lookup.

const std = @import("std");
const AppWindow = @import("../AppWindow.zig");
const tab = AppWindow.tab;
const input = AppWindow.input;
const overlays = AppWindow.overlays;
const font = AppWindow.font;
const Surface = @import("../Surface.zig");
const SplitTree = @import("../split_tree.zig");
const renderer = @import("../renderer.zig");
const preview_close_button = @import("../input/preview_close_button.zig");

const TabState = tab.TabState;
pub const MAX_SPLITS_PER_TAB = tab.MAX_SPLITS_PER_TAB;
const SPLIT_DIVIDER_WIDTH = tab.SPLIT_DIVIDER_WIDTH;
pub const DEFAULT_PADDING = tab.DEFAULT_PADDING;

/// Pixel rectangle for a split leaf, including computed terminal dimensions.
/// The leaf may be a terminal or a non-terminal pane (e.g. a preview); use
/// `surface()` to get the *Surface (null for non-terminal panes). `cols`/`rows`
/// are 0 for non-terminal panes.
pub const SplitRect = struct {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    cols: u16,
    rows: u16,
    pane: SplitTree.Pane,
    handle: SplitTree.Node.Handle,

    /// The terminal surface for this rect, or null if it holds a non-terminal
    /// pane (e.g. a preview).
    pub fn surface(self: SplitRect) ?*Surface {
        return self.pane.surface();
    }
};

/// A leaf pane plus its handle at a given window point. Unlike `surfaceAtPoint`,
/// this also reports non-terminal panes (e.g. previews) so focus can target them.
pub const PaneHit = struct {
    pane: SplitTree.Pane,
    handle: SplitTree.Node.Handle,
};

/// Hit test result for split dividers
pub const DividerHit = struct {
    handle: SplitTree.Node.Handle,
    layout: SplitTree.Split.Layout,
};

/// Computed split rects for the active tab (updated each frame)
pub threadlocal var g_split_rects: [MAX_SPLITS_PER_TAB]SplitRect = undefined;
pub threadlocal var g_split_rect_count: usize = 0;

/// Clear cached split rectangles after a split tree mutation.
pub fn invalidateCachedRects() void {
    g_split_rect_count = 0;
}

/// Returns true if a cached split rect still points at the active tab's tree.
pub fn cachedRectIsLive(rect: SplitRect) bool {
    const active_tab = tab.activeTab() orelse return false;
    if (rect.handle.idx() >= active_tab.tree.nodes.len) return false;
    return switch (active_tab.tree.nodes[rect.handle.idx()]) {
        .leaf => |pane| std.meta.eql(pane, rect.pane),
        .split => false,
    };
}

/// The lone visible leaf's terminal surface, or null when the active layout is
/// not exactly one terminal pane (several panes, or a single non-terminal pane
/// such as a preview). The render paths use this to gate the simple
/// single-surface fast path; preview-only layouts must take the generic
/// pane-dispatching path so they still paint.
pub fn soleTerminalSurface() ?*Surface {
    if (g_split_rect_count != 1) return null;
    return g_split_rects[0].surface();
}

/// Window-pixel origin of a terminal surface's cell grid.
pub const GridOrigin = struct {
    x: i32,
    y: i32,
};

/// Where the render loop draws a surface's cell grid, in window pixels, so
/// mouse hit-testing maps onto the cells the user actually sees.
///
/// Split panes draw inside their rect's viewport at `rect + padding`. The lone
/// terminal pane instead draws at `titlebar + pad.top` (see the single-surface
/// path in `AppWindow`). `computeSplitLayout` extends an edge rect to the
/// window's left edge but not to the top, so a lone pane's `rect.y` sits
/// `DEFAULT_PADDING` below the titlebar; subtract it to land on the drawn grid.
pub fn gridOrigin(rect: SplitRect, pad: renderer.size.Padding, single_pane: bool) GridOrigin {
    const top_inset: i32 = if (single_pane) @intCast(DEFAULT_PADDING) else 0;
    return .{
        .x = rect.x + @as(i32, @intCast(pad.left)),
        .y = rect.y - top_inset + @as(i32, @intCast(pad.top)),
    };
}

/// Find the terminal surface under a given point (window coordinates).
/// Returns null if no terminal surface is found at that position (non-terminal
/// panes such as previews are skipped).
pub fn surfaceAtPoint(x: i32, y: i32) ?*Surface {
    for (0..g_split_rect_count) |i| {
        const rect = g_split_rects[i];
        if (!cachedRectIsLive(rect)) continue;
        if (x >= rect.x and x < rect.x + rect.width and
            y >= rect.y and y < rect.y + rect.height)
        {
            if (rect.pane.surface()) |s| return s;
        }
    }
    return null;
}

/// Find the leaf pane (terminal OR non-terminal) under a given point.
/// Returns null if the point is not inside any live leaf rect.
pub fn paneAtPoint(x: i32, y: i32) ?PaneHit {
    for (0..g_split_rect_count) |i| {
        const r = g_split_rects[i];
        if (!cachedRectIsLive(r)) continue;
        if (x >= r.x and x < r.x + r.width and y >= r.y and y < r.y + r.height)
            return .{ .pane = r.pane, .handle = r.handle };
    }
    return null;
}

/// If (x, y) lands on a preview pane's top-right close (×) button, return that
/// preview's handle; null otherwise. Mirrors the button geometry the preview
/// renderer draws (shared via preview_close_button), so the clickable box and
/// the drawn box stay in sync. Only live preview leaves are considered.
pub fn previewCloseButtonAtPoint(x: i32, y: i32) ?SplitTree.Node.Handle {
    const xf: f32 = @floatFromInt(x);
    const yf: f32 = @floatFromInt(y);
    for (0..g_split_rect_count) |i| {
        const r = g_split_rects[i];
        if (!cachedRectIsLive(r)) continue;
        switch (r.pane) {
            .preview => {
                if (preview_close_button.contains(
                    @floatFromInt(r.x),
                    @floatFromInt(r.y),
                    @floatFromInt(r.width),
                    xf,
                    yf,
                )) return r.handle;
            },
            .terminal => {},
        }
    }
    return null;
}

pub const ContentRect = struct { x: f32, y: f32, w: f32, h: f32 };

/// The rectangle the active tab's split tree is laid out in, in framebuffer
/// pixels: the window minus the titlebar, the side panels, and
/// `DEFAULT_PADDING` on all four sides. This is the rectangle the render
/// loop passes to `computeSplitLayout`; divider hit-testing and dragging must
/// use the same one or the grab band drifts off the drawn divider.
pub fn splitContentRect(fb_width: anytype, fb_height: anytype, titlebar_h: f32, left_panels_w: f32, right_panels_w: f32) ContentRect {
    const pad: f32 = @floatFromInt(DEFAULT_PADDING);
    return .{
        .x = left_panels_w + pad,
        .y = titlebar_h + pad,
        .w = @as(f32, @floatFromInt(fb_width)) - left_panels_w - right_panels_w - 2 * pad,
        .h = @as(f32, @floatFromInt(fb_height)) - titlebar_h - 2 * pad,
    };
}

test "splitContentRect matches the rectangle the render loop lays splits out in" {
    // Render loop: content_y = padding + titlebar, content_h = fb_h - content_y - padding.
    const rect = splitContentRect(@as(u32, 1000), @as(u32, 700), 40, 200, 300);
    try std.testing.expectEqual(@as(f32, 210), rect.x);
    try std.testing.expectEqual(@as(f32, 50), rect.y);
    try std.testing.expectEqual(@as(f32, 480), rect.w);
    try std.testing.expectEqual(@as(f32, 640), rect.h);
}

/// Check if a point is over a split divider.
/// Returns the split node handle and layout if found, null otherwise.
pub fn hitTestDivider(x: i32, y: i32) ?DividerHit {
    const active_tab = tab.activeTab() orelse return null;
    if (active_tab.tree.isEmpty() or !active_tab.tree.isSplit()) return null;

    const allocator = AppWindow.g_allocator orelse return null;
    var spatial = active_tab.tree.spatial(allocator) catch return null;
    defer spatial.deinit(allocator);

    // Get content area dimensions
    const win = AppWindow.g_window orelse return null;
    const fb = win.getFramebufferSize();
    const left_panels_w = AppWindow.leftPanelsWidth();
    const right_panels_w = AppWindow.rightPanelsWidthForWindow(fb.width);
    const content = splitContentRect(fb.width, fb.height, AppWindow.currentTitlebarHeight(), left_panels_w, right_panels_w);
    const content_x = content.x;
    const content_y = content.y;
    const content_w = content.w;
    const content_h = content.h;

    const xf: f32 = @floatFromInt(x);
    const yf: f32 = @floatFromInt(y);
    const half_hit = input.SPLIT_DIVIDER_HIT_WIDTH / 2;

    // Check each split node for divider hit
    for (active_tab.tree.nodes, 0..) |node, i| {
        switch (node) {
            .split => |s| {
                const handle: SplitTree.Node.Handle = @enumFromInt(i);
                const slot = spatial.slots[i];

                // Convert normalized coords to pixels
                const slot_x = content_x + @as(f32, @floatCast(slot.x)) * content_w;
                const slot_y = content_y + @as(f32, @floatCast(slot.y)) * content_h;
                const slot_w = @as(f32, @floatCast(slot.width)) * content_w;
                const slot_h = @as(f32, @floatCast(slot.height)) * content_h;

                switch (s.layout) {
                    .horizontal => {
                        // Vertical divider line at ratio position
                        const div_x = slot_x + slot_w * @as(f32, @floatCast(s.ratio));
                        if (xf >= div_x - half_hit and xf <= div_x + half_hit and
                            yf >= slot_y and yf <= slot_y + slot_h)
                        {
                            return .{ .handle = handle, .layout = .horizontal };
                        }
                    },
                    .vertical => {
                        // Horizontal divider line at ratio position
                        const div_y = slot_y + slot_h * @as(f32, @floatCast(s.ratio));
                        if (yf >= div_y - half_hit and yf <= div_y + half_hit and
                            xf >= slot_x and xf <= slot_x + slot_w)
                        {
                            return .{ .handle = handle, .layout = .vertical };
                        }
                    },
                }
            },
            .leaf => {},
        }
    }

    return null;
}

const PixelRect = struct { x: i32, y: i32, w: i32, h: i32 };

fn panePixelRect(slot: SplitTree.Spatial.Slot, content: PixelRect) PixelRect {
    // Convert normalized coords to pixels
    const x_f: f32 = @as(f32, @floatCast(slot.x)) * @as(f32, @floatFromInt(@max(content.w, 1)));
    const y_f: f32 = @as(f32, @floatCast(slot.y)) * @as(f32, @floatFromInt(@max(content.h, 1)));
    const w_f: f32 = @as(f32, @floatCast(slot.width)) * @as(f32, @floatFromInt(@max(content.w, 1)));
    const h_f: f32 = @as(f32, @floatCast(slot.height)) * @as(f32, @floatFromInt(@max(content.h, 1)));

    // Apply divider insets (half-divider on each side adjacent to other splits)
    var px: i32 = content.x + @as(i32, @intFromFloat(x_f));
    var py: i32 = content.y + @as(i32, @intFromFloat(y_f));
    var pw: i32 = @as(i32, @intFromFloat(w_f));
    var ph: i32 = @as(i32, @intFromFloat(h_f));

    // Inset for dividers (only if not at edge)
    const half_div = @divTrunc(SPLIT_DIVIDER_WIDTH, 2);
    const at_left_edge = slot.x < 0.001;
    const at_right_edge = slot.x + slot.width >= 0.999;
    if (slot.x > 0.001) {
        px += half_div;
        pw -= half_div;
    }
    if (slot.x + slot.width < 0.999) {
        pw -= half_div;
    }
    if (slot.y > 0.001) {
        py += half_div;
        ph -= half_div;
    }
    if (slot.y + slot.height < 0.999) {
        ph -= half_div;
    }

    // Extend splits at left edge to window edge (consistent left margin)
    if (at_left_edge) {
        px -= @intCast(DEFAULT_PADDING);
        pw += @intCast(DEFAULT_PADDING);
    }

    // Extend splits at right edge to window edge (so scrollbar hugs window edge)
    if (at_right_edge) {
        pw += @intCast(DEFAULT_PADDING);
    }
    pw = @max(pw, 1);
    ph = @max(ph, 1);

    return .{ .x = px, .y = py, .w = pw, .h = ph };
}

fn desktopLayout(rect: PixelRect, content: PixelRect, slot: SplitTree.Spatial.Slot) Surface.DesktopLayout {
    return .{
        .width = @intCast(rect.w),
        .height = @intCast(rect.h),
        .cell_width = font.cell_width,
        .cell_height = font.cell_height,
        .padding = .{
            .top = DEFAULT_PADDING,
            .bottom = DEFAULT_PADDING,
            .left = DEFAULT_PADDING,
            .right = @intFromFloat(overlays.SCROLLBAR_WIDTH + DEFAULT_PADDING),
        },
        .split = .{ slot.x, slot.y, slot.width, slot.height },
        .content_size = .{ content.w, content.h },
    };
}

/// Apply Web-authored geometry through the same pixel/grid path as painting,
/// including for a background tab with no cached viewport rectangles.
pub fn updateRemoteWorkspaceGeometry(allocator: std.mem.Allocator, tree: *const SplitTree, area: ContentRect) void {
    const content: PixelRect = .{ .x = @intFromFloat(area.x), .y = @intFromFloat(area.y), .w = @intFromFloat(area.w), .h = @intFromFloat(area.h) };
    var spatial = tree.spatial(allocator) catch return;
    defer spatial.deinit(allocator);
    var it = tree.surfaces();
    while (it.next()) |entry| {
        const slot = spatial.slots[entry.handle.idx()];
        entry.surface.setRemoteWorkspaceLayout(desktopLayout(panePixelRect(slot, content), content, slot));
    }
}

/// A native window resize affects every direct terminal in the window,
/// including tabs not currently rendered. Use the same geometry as painting.
pub fn updateRemoteWindowGeometry(width: i32, height: i32) void {
    const allocator = AppWindow.g_allocator orelse return;
    const area = splitContentRect(width, height, AppWindow.currentTitlebarHeight(), AppWindow.leftPanelsWidth(), AppWindow.rightPanelsWidthForWindow(width));
    const content: PixelRect = .{ .x = @intFromFloat(area.x), .y = @intFromFloat(area.y), .w = @intFromFloat(area.w), .h = @intFromFloat(area.h) };
    const active_tab = AppWindow.activeTab();
    for (tab.g_tabs[0..tab.g_tab_count]) |maybe_tab| {
        const tab_state = maybe_tab orelse continue;
        if (tab_state.tree.isEmpty()) continue;
        var spatial = tab_state.tree.spatial(allocator) catch continue;
        defer spatial.deinit(allocator);
        var it = tab_state.tree.surfaces();
        while (it.next()) |entry| {
            if (!entry.surface.supportsRemoteControl()) continue;
            if (tab_state == active_tab and !entry.surface.remoteControlActive()) continue;
            const slot = spatial.slots[entry.handle.idx()];
            _ = entry.surface.setScreenSizeWithPolicy(desktopLayout(panePixelRect(slot, content), content, slot), .coalesced);
        }
    }
}

/// Claim each affected PTY at the desktop input event, before the next paint
/// computes its new natural grid. Other split subtrees keep their leases.
pub fn reclaimSplitControls(tree: *const SplitTree, handle: SplitTree.Node.Handle) void {
    switch (tree.nodes[handle.idx()]) {
        .leaf => |pane| if (pane.surface()) |surface| surface.reclaimRemoteControl(),
        .split => |split| {
            reclaimSplitControls(tree, split.left);
            reclaimSplitControls(tree, split.right);
        },
    }
}

/// Compute split layout for a tab, returning pixel rects for each surface.
/// Each surface is resized to fit its allocated area with proper padding.
/// Returns the number of surfaces (0 if tree is empty).
pub fn computeSplitLayout(
    active_tab: *const TabState,
    content_x: i32,
    content_y: i32,
    content_w: i32,
    content_h: i32,
    cw: f32, // font.cell_width
    ch: f32, // font.cell_height
) usize {
    g_split_rect_count = 0;
    // Consume the one-shot immediate-resize request before any early return.
    // Tab switches always request it, and the render gate treats a pending
    // request as "must render". Paneless tabs (AI Chat, Settings, …) have an
    // empty tree; returning before the consume latched the flag and re-rendered
    // every loop iteration until a terminal tab was shown (issue #675).
    const immediate_resize = AppWindow.consumeImmediateLayoutResize();
    if (active_tab.tree.isEmpty()) return 0;
    const content: PixelRect = .{ .x = content_x, .y = content_y, .w = content_w, .h = content_h };

    // Get spatial representation (normalized 0-1 coordinates)
    const allocator = AppWindow.g_allocator orelse return 0;
    var spatial = active_tab.tree.spatial(allocator) catch return 0;
    defer spatial.deinit(allocator);

    _ = cw;
    _ = ch;

    const resize_policy: Surface.ResizePolicy = if (immediate_resize)
        .immediate
    else
        .coalesced;

    var count: usize = 0;
    var it = active_tab.tree.panes();
    while (it.next()) |entry| {
        if (count >= MAX_SPLITS_PER_TAB) break;

        const slot = spatial.slots[entry.handle.idx()];

        const rect = panePixelRect(slot, content);

        // Surface-only work: resize the terminal and track resize-overlay
        // bookkeeping. Non-terminal panes (e.g. previews) have no grid to size,
        // so we skip this entirely and store zero cols/rows for them.
        if (entry.pane.surface()) |surface| {
            const resized = surface.setScreenSizeWithPolicy(desktopLayout(rect, content, slot), resize_policy);

            if (resized) {
                AppWindow.applyUiEffect(.{ .needs_rebuild = true });
                // Show resize overlay with new dimensions (but not during divider drag,
                // which has its own per-surface overlay logic)
                if (!input.g_divider_dragging) {
                    overlays.resizeOverlayShow(surface.size.grid.cols, surface.size.grid.rows);
                }
            }

            // Track per-surface size changes for divider drag overlay
            if (input.g_divider_dragging) {
                const cols = surface.size.grid.cols;
                const rows = surface.size.grid.rows;
                if (cols != surface.resize_overlay_last_cols or rows != surface.resize_overlay_last_rows) {
                    surface.resize_overlay_active = true;
                    surface.resize_overlay_last_cols = cols;
                    surface.resize_overlay_last_rows = rows;
                }
            }
        }

        g_split_rects[count] = .{
            .x = rect.x,
            .y = rect.y,
            .width = rect.w,
            .height = rect.h,
            .cols = if (entry.pane.surface()) |s| s.size.grid.cols else 0,
            .rows = if (entry.pane.surface()) |s| s.size.grid.rows else 0,
            .pane = entry.pane,
            .handle = entry.handle,
        };
        count += 1;
    }

    g_split_rect_count = count;
    return count;
}

test "split_layout: soleTerminalSurface only for a single terminal rect" {
    const PreviewPane = @import("../preview/pane.zig");
    const saved_count = g_split_rect_count;
    const saved_rect = g_split_rects[0];
    defer {
        g_split_rect_count = saved_count;
        g_split_rects[0] = saved_rect;
    }

    var surface: Surface = undefined;
    var preview: PreviewPane = undefined;
    const terminal_rect = SplitRect{
        .x = 0,
        .y = 0,
        .width = 100,
        .height = 100,
        .cols = 80,
        .rows = 24,
        .pane = .{ .terminal = &surface },
        .handle = .root,
    };
    const preview_rect = SplitRect{
        .x = 0,
        .y = 0,
        .width = 100,
        .height = 100,
        .cols = 0,
        .rows = 0,
        .pane = .{ .preview = &preview },
        .handle = .root,
    };

    // No rects → null.
    g_split_rect_count = 0;
    try std.testing.expect(soleTerminalSurface() == null);

    // One terminal rect → its surface.
    g_split_rects[0] = terminal_rect;
    g_split_rect_count = 1;
    try std.testing.expectEqual(@as(?*Surface, &surface), soleTerminalSurface());

    // One preview rect → null (preview-only layouts must take the generic path).
    g_split_rects[0] = preview_rect;
    try std.testing.expect(soleTerminalSurface() == null);

    // Multiple rects → null even if the first is a terminal.
    g_split_rects[0] = terminal_rect;
    g_split_rect_count = 2;
    try std.testing.expect(soleTerminalSurface() == null);
}

test "split_layout: paneless tab consumes the immediate-resize request" {
    // Issue #675: a tab switch requests an immediate layout resize, and the
    // render gate re-renders while it is pending. A paneless tab (AI Chat,
    // Settings, …) must still consume it, or the loop never goes idle.
    defer _ = AppWindow.consumeImmediateLayoutResize();
    const ai_chat_tab = TabState{ .kind = .ai_chat, .tree = SplitTree.empty };

    AppWindow.requestImmediateLayoutResize();
    try std.testing.expectEqual(@as(usize, 0), computeSplitLayout(&ai_chat_tab, 0, 0, 800, 600, 8, 16));
    try std.testing.expect(!AppWindow.consumeImmediateLayoutResize());
}

test "split_layout: gridOrigin matches the drawn grid for single and split panes" {
    var surface: Surface = undefined;
    const titlebar_h: i32 = 34;
    const left_panels_w: i32 = 40;
    // A lone pane's rect as computeSplitLayout builds it: x extended to the
    // left panels edge, y left at DEFAULT_PADDING below the titlebar.
    const rect = SplitRect{
        .x = left_panels_w,
        .y = titlebar_h + @as(i32, @intCast(DEFAULT_PADDING)),
        .width = 800,
        .height = 600,
        .cols = 80,
        .rows = 24,
        .pane = .{ .terminal = &surface },
        .handle = .root,
    };
    const pad = renderer.size.Padding{ .top = 13, .bottom = 13, .left = 11, .right = 24 };

    // Single pane: the render loop draws at (left_panels_w + pad.left, titlebar + pad.top).
    const single = gridOrigin(rect, pad, true);
    try std.testing.expectEqual(left_panels_w + 11, single.x);
    try std.testing.expectEqual(titlebar_h + 13, single.y);

    // Split pane: drawn inside the rect viewport at rect + padding.
    const split = gridOrigin(rect, pad, false);
    try std.testing.expectEqual(rect.x + 11, split.x);
    try std.testing.expectEqual(rect.y + 13, split.y);
}

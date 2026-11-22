/// A terminal surface — the core unit of WispTerm.
/// Each Surface is a fully independent terminal session, owning a PTY,
/// terminal state machine, selection, and OSC title state.
///
/// Modeled after Ghostty's `src/Surface.zig`:
/// - Ghostty: Surface owns terminal, PTY, IO thread, renderer thread
/// - WispTerm (Phase 1): Surface owns terminal, PTY, selection, OSC state
///   (IO thread added in Phase 2, renderer stays in main.zig for now)
///
/// TabState in main.zig becomes a thin wrapper: `{ surface: *Surface }`.
const std = @import("std");
const builtin = @import("builtin");
const ghostty_vt = @import("ghostty-vt");
const build_options = @import("build_options");
const Pty = @import("pty.zig").Pty;
const Command = @import("Command.zig");
const renderer = @import("renderer.zig");
const termio = @import("termio.zig");
const Config = @import("config.zig");
const Renderer = @import("renderer/Renderer.zig");
const RemoteHub = @import("remote_hub.zig");
const remote_control = @import("remote_terminal_control.zig");
const remote_image_paste = @import("remote_image_paste.zig");
const terminal_paste = @import("terminal_paste.zig");
const GridSize = @import("core/geometry.zig").GridSize;
const remote_transport = @import("platform/remote_transport.zig");
const threading = @import("platform/threading.zig");
const agent_detector = @import("terminal_agents/detector.zig");
const live_transcript = @import("terminal_agents/live_transcript.zig");
const screen_detect = @import("terminal_agents/screen_detect.zig");
const session_persist = @import("session_persist.zig");
const window_backend = @import("platform/window_backend.zig");
const sync_output = @import("sync_output.zig");
const mouse_wheel_scroll = @import("input/mouse_wheel_scroll.zig");
const notification = @import("notification.zig");
const platform_pty_command = @import("platform/pty_command.zig");
const surface_registry = @import("surface_registry.zig");
const platform_process = @import("platform/process.zig");
const platform_local_path = @import("platform/local_path.zig");
const ssh_connection_mod = @import("ssh/connection.zig");
const clipboard_osc52 = @import("clipboard_osc52.zig");
const osc_title = @import("osc_title.zig");

const Surface = @This();
const io_log = std.log.scoped(.surface_io);

// ============================================================================
// Types
// ============================================================================

/// Selection state for text selection.
/// Rows are stored as absolute scrollback positions (viewport offset + screen row)
/// so the selection stays anchored to the text when scrolling.
pub const Selection = struct {
    /// A click can leave an anchor even when there is no visible selection yet.
    has_anchor: bool = false,
    start_col: usize = 0,
    start_row: usize = 0,
    end_col: usize = 0,
    end_row: usize = 0,
    /// Active selections are rendered and copied; anchor-only clicks are not.
    active: bool = false,
};

pub const Operation = enum {
    event_loop,
    pty_read,
    pty_write,
    pty_resize,
    terminal_resize,
    thread_spawn,
    thread_shutdown,
    respawn,
};

pub const IoFailure = struct {
    operation: Operation,
    error_code: anyerror,
    timestamp_ms: i64,
};

pub const ExitReason = enum {
    eof,
    broken_pipe,
    user_closed,
};

pub const ExitInfo = struct {
    reason: ExitReason,
    status: ?Command.Exit = null,
    timestamp_ms: i64,
};

pub const IoState = union(enum) {
    starting,
    running,
    stopping,
    stopped,
    exited: ExitInfo,
    failed: IoFailure,
};

const ImageOscParseState = enum {
    ground,
    esc,
    /// Swallow tmux/screen title sequences: ESC k <title> ST.
    screen_title,
    /// Saw ESC inside a screen-title sequence; next byte may be '\' (ST).
    screen_title_esc,
    osc_prefix,
    image_osc,
    image_osc_esc,
    image_overflow,
    image_overflow_esc,
    passthrough_osc,
    passthrough_osc_esc,
    /// Waiting for the ';' that follows "7748" in an agent-state OSC.
    agent_osc_prefix,
    /// Collecting the payload bytes of an OSC 7748 agent-state marker.
    agent_osc,
    /// Saw ESC inside an agent_osc payload; next byte should be '\' (ST).
    agent_osc_esc,
    /// Agent OSC payload overflowed the cap; drain until terminator.
    agent_overflow,
    /// Saw ESC inside agent_overflow; next byte should be '\' (ST).
    agent_overflow_esc,
};

const WISPTERM_IMAGE_OSC_PREFIX = "7747;WispTermImage=";
const WISPTERM_IMAGE_OSC_MAX = 16 * 1024;

/// OSC number prefix shared by image (7747) and agent (7748): the bytes "774".
const WISPTERM_PRIVATE_OSC_SHARED = "774";
/// Maximum agent marker payload size (bytes after "7748;"); sequences longer
/// than this are silently discarded via the overflow states.
const WISPTERM_AGENT_OSC_MAX = 4096;
const WISPTERM_AGENT_SESSION_PATH_MAX = 4096;

/// Coarse launch environment for terminal-side integrations such as path paste.
pub const LaunchKind = platform_pty_command.LaunchKind;

pub const SshConnection = ssh_connection_mod.SshConnection;

// ============================================================================
// VT stream handler — wraps ghostty's readonly handler to intercept bell
// ============================================================================

/// Custom VT stream handler that delegates to the readonly handler but
/// intercepts the bell action to set a flag on the Surface.
/// This keeps bell detection independent from backend-specific PTY behavior
/// and the readonly handler's raw byte handling.
pub const VtHandler = struct {
    /// The inner readonly handler type, obtained via Terminal.vtHandler's return type.
    const InnerHandler = @typeInfo(@TypeOf(ghostty_vt.Terminal.vtHandler)).@"fn".return_type.?;

    /// ghostty-vt's device-attributes reply type, derived from the effect
    /// callback signature so it tracks the dependency without a re-export.
    const DeviceAttributes = blk: {
        const Fn = @typeInfo(@FieldType(InnerHandler.Effects, "device_attributes")).optional.child;
        break :blk @typeInfo(@typeInfo(Fn).pointer.child).@"fn".return_type.?;
    };

    /// XTVERSION (`CSI > 0 q`) reply. Identifies the real emulator; apps that
    /// branch on this string (VTE/xterm.js workarounds) must not mistake us
    /// for those.
    const xtversion_string = "WispTerm " ++ build_options.app_version;

    inner: InnerHandler,
    surface: *Surface,

    pub fn init(terminal: *ghostty_vt.Terminal, surface: *Surface) VtHandler {
        var inner = terminal.vtHandler();
        // Answer terminal query sequences by writing the reply back to the PTY.
        // This notably includes the Kitty keyboard protocol query (`CSI ? u`):
        // full-screen TUIs (Claude Code, Codex, …) probe for protocol support
        // and, without a reply, conclude it is unsupported and never enable it —
        // leaving Shift+Enter indistinguishable from Enter. See issue #302.
        inner.effects.write_pty = &writePtyResponse;
        // Primary/secondary/tertiary device attributes (`CSI c`, `CSI > c`,
        // `CSI = c`). ghostty-vt's readonly handler leaves this effect null, so
        // DA1 went unanswered. TUIs that probe `CSI ? u` + `CSI c` together
        // (grok) treat the Kitty reply as proof the terminal responds and then
        // wait for DA1 without a timeout — a blank alternate screen forever.
        // Newer Windows pseudo-console hosts also send DA1 to the terminal
        // hosting them and gate scroll optimizations on the reply. Same answer as Ghostty's
        // termio/stream_handler.zig: `CSI ? 62 ; 22 c` (VT220 + ANSI color).
        inner.effects.device_attributes = &deviceAttributes;
        inner.effects.xtversion = &xtversion;
        return .{
            .inner = inner,
            .surface = surface,
        };
    }

    fn deviceAttributes(_: *InnerHandler) DeviceAttributes {
        return .{};
    }

    fn xtversion(_: *InnerHandler) []const u8 {
        return xtversion_string;
    }

    /// Forward a terminal-generated response (Kitty keyboard query, DSR, mode
    /// reports, …) to the PTY. Invoked on the IO reader thread while parsing
    /// output; the mailbox copies the bytes and hands them to the IO writer
    /// thread, so this is safe from here. The owning Surface is recovered from
    /// the handler's terminal pointer, which aliases `&surface.terminal`.
    fn writePtyResponse(handler: *InnerHandler, data: [:0]const u8) void {
        const surface: *Surface = @fieldParentPtr("terminal", handler.terminal);
        surface.queuePtyWriteImpl(data, null) catch |err| mailbox_log.warn(
            "dropped terminal query reply ({d} bytes): {s}",
            .{ data.len, @errorName(err) },
        );
    }

    /// The read-only Ghostty handler tracks OSC color changes but leaves
    /// queries to its host. Reply on the originating PTY using its colors.
    fn replyToColorQueries(self: *VtHandler, op: ghostty_vt.StreamAction.Value(.color_operation)) void {
        var requests = op.requests.constIterator(0);
        while (requests.next()) |request| {
            if (request.* != .query or request.query != .dynamic) continue;
            const slot = request.query.dynamic;
            const colors = &self.inner.terminal.colors;
            const theme = self.surface.terminal_theme_colors;
            const rgb = switch (slot) {
                .foreground => colors.foreground.get() orelse theme.foreground,
                .background => colors.background.get() orelse theme.background,
                else => continue,
            };

            var buf: [40]u8 = undefined;
            const response = std.fmt.bufPrintZ(
                &buf,
                "\x1b]{d};rgb:{x:0>4}/{x:0>4}/{x:0>4}{s}",
                .{ @intFromEnum(slot), @as(u16, rgb.r) * 257, @as(u16, rgb.g) * 257, @as(u16, rgb.b) * 257, op.terminator.string() },
            ) catch unreachable;
            writePtyResponse(&self.inner, response);
        }
    }

    pub fn deinit(self: *VtHandler) void {
        self.inner.deinit();
    }

    pub fn vt(
        self: *VtHandler,
        comptime action: ghostty_vt.StreamAction.Tag,
        value: ghostty_vt.StreamAction.Value(action),
    ) void {
        // Bells, notifications, and clipboard writes are staged here on the IO
        // thread and consumed by the main loop's pre-render-gate sweep. Each
        // posts its own wakeup: background-tab output does not wake the UI
        // (its dirty flag stays latched), so these must not rely on it.
        if (action == .bell) {
            self.surface.bell_pending.store(true, .release);
            window_backend.postWakeup();
            return;
        }

        if (action == .show_desktop_notification) {
            notification.ingest(
                &self.surface.notif_queue,
                value.title,
                value.body,
            );
            window_backend.postWakeup();
            return;
        }

        // OSC 52 clipboard writes: ghostty's read-only handler discards these,
        // so we decode the payload here and hand the text to the main thread,
        // which owns the system clipboard.
        if (action == .clipboard_contents) {
            self.surface.ingestClipboardWrite(value.kind, value.data);
            window_backend.postWakeup();
            return;
        }

        const sync_before = self.surface.terminal.modes.get(.synchronized_output);
        const sync_mode_touched = switch (action) {
            .set_mode,
            .reset_mode,
            .restore_mode,
            => value.mode == .synchronized_output,
            else => false,
        };
        self.inner.vt(action, value);
        if (action == .color_operation) self.replyToColorQueries(value);
        const sync_after = self.surface.terminal.modes.get(.synchronized_output);
        if (sync_mode_touched or sync_before != sync_after) {
            self.surface.noteSynchronizedOutputMode(sync_after);
        }
    }
};

/// Our custom stream type using the bell-aware handler.
pub const VtStream = ghostty_vt.Stream(VtHandler);

// ============================================================================
// Core state
// ============================================================================

const TerminalThemeColors = struct {
    foreground: ghostty_vt.color.RGB,
    background: ghostty_vt.color.RGB,

    fn fromTheme(theme: Config.Theme) TerminalThemeColors {
        return .{
            .foreground = rgbFromColor(theme.foreground),
            .background = rgbFromColor(theme.background),
        };
    }

    fn rgbFromColor(color: Config.Color) ghostty_vt.color.RGB {
        return .{
            .r = @intFromFloat(@round(color[0] * 255)),
            .g = @intFromFloat(@round(color[1] * 255)),
            .b = @intFromFloat(@round(color[2] * 255)),
        };
    }
};

// Each window supplies its defaults from its own UI thread. Surfaces retain a
// copy for use by their PTY reader under the render-state mutex.
threadlocal var creation_theme_colors = TerminalThemeColors.fromTheme(Config.Theme.default());

pub fn setCreationThemeColors(theme: Config.Theme) void {
    creation_theme_colors = TerminalThemeColors.fromTheme(theme);
}

pub fn updateTerminalThemeColorsLocked(self: *Surface, theme: Config.Theme) void {
    self.terminal_theme_colors = TerminalThemeColors.fromTheme(theme);
}

allocator: std.mem.Allocator,
terminal: ghostty_vt.Terminal,
terminal_theme_colors: TerminalThemeColors,
pty: Pty,
command: Command,
selection: Selection,
render_state: renderer.State,
launch_kind: LaunchKind,
advertise_terminal_capabilities: bool,
ssh_connection: ?SshConnection,
remote_hub: std.atomic.Value(?*RemoteHub.Hub) = .init(null),
remote_id: [16]u8,

/// The desktop layout asks for a natural grid; a live lease may override it.
/// The IO writer alone publishes the confirmed grid under the render lock.
remote_terminal: struct {
    mutex: std.Thread.Mutex = .{},
    enabled: bool = false,
    clock: std.time.Timer = undefined,
    state: remote_control.State = .{},
    desktop_layout: ?DesktopLayout = null,
} = .{},
confirmed_grid: std.atomic.Value(u32) = .init(packGrid(.{})),

/// The command + cwd this surface was launched with, owned copies kept so the
/// panel can be re-run in place after its process exits (Enter-to-reconnect).
/// Null for virtual/tmux panes (no child) and if the dup ever fails.
respawn_command: ?platform_pty_command.OwnedCommandLine = null,
respawn_cwd: ?platform_pty_command.OwnedCwd = null,

/// Size information for this surface (screen size, cell size, padding).
/// Used by the renderer to position content correctly.
size: renderer.size.Size = .{},

// ============================================================================
// IO threads (Ghostty two-thread architecture: writer + reader)
// ============================================================================

/// Mailbox for sending messages from main thread to IO writer thread.
mailbox: termio.Mailbox,

/// IO writer thread state (xev event loop, coalesce timer, etc.).
/// Heap-allocated so the pointer stays stable when passed to the thread.
io_thread_state: ?*termio.Thread = null,

/// IO writer thread (xev event loop — handles resize, future messages).
io_writer_thread: ?std.Thread = null,

/// IO reader thread (blocking PTY output loop).
io_reader_thread: ?std.Thread = null,

// ============================================================================
// Per-surface renderer (Ghostty architecture)
// ============================================================================

/// Per-surface renderer with its own cell buffers
surface_renderer: Renderer,

/// Dirty flag — set by the IO thread on new PTY output, consumed by the main
/// render loop's event-driven render gate.
dirty: std.atomic.Value(bool) = std.atomic.Value(bool).init(true),

/// Deadline state for DEC synchronized output mode (2026).
sync_output_state: sync_output.State = .{},

/// Sub-row wheel remainder for this surface (Ghostty: `mouse.pending_scroll_y`).
/// UI thread only.
wheel_scroll: mouse_wheel_scroll.Accumulator = .{},

/// Set when the PTY process has exited.
exited: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),

/// Thread-safe terminal IO lifecycle. `exited` remains as the cheap legacy
/// stop flag; this carries the reason surfaced to callers and UI.
io_state_mutex: std.Thread.Mutex = .{},
io_state: IoState = .starting,

/// SSH password autofill timing. When an SSH session (re)connects the saved
/// password is typed once the remote password prompt appears. Per-surface (not
/// a single global slot) so many sessions restoring at once each get filled.
/// `deadline` == 0 means not armed; `due` is the earliest inject time (gives
/// the prompt a moment to settle). The password itself is read from
/// `ssh_connection` at inject time — not stored here.
ssh_autofill_due_ms: i64 = 0,
ssh_autofill_deadline_ms: i64 = 0,

/// Set while the IO writer thread is resizing PTY and terminal state.
/// The reader thread still drains PTY output during this window, but
/// delays VT parsing until terminal.resize has caught up to the new grid.
resize_in_progress: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),

// ============================================================================
// Bell state
// ============================================================================

/// Set by the IO thread when BEL (0x07) is detected in PTY output.
/// Cleared by the main thread after handling the bell notification.
bell_pending: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),

/// Timestamp of the last bell notification, for rate limiting (100ms like Ghostty).
last_bell_time: i64 = 0,

// ============================================================================
// Desktop notification state (OSC 9 / OSC 777)
// ============================================================================

/// Notifications pushed by the IO reader thread, drained on the main thread.
notif_queue: notification.Queue = .{},

// ============================================================================
// OSC 52 clipboard write state
// ============================================================================

/// Pending OSC 52 clipboard text, decoded by the IO reader thread and drained
/// by the main thread (which owns the platform clipboard). Latest write wins:
/// a new sequence frees and replaces an undrained one. Owned by `allocator`.
clipboard_write_pending: ?[]u8 = null,
clipboard_write_mutex: std.Thread.Mutex = .{},
/// Last delivered notification's content hash + time, for dedup / rate limit.
last_notif_hash: u64 = 0,
last_notif_time: i64 = 0,

/// Bell indicator opacity (0.0 = hidden, 1.0 = fully visible).
/// Fades in when bell fires, fades out on active tab after hold period.
bell_opacity: f32 = 0,

/// Whether the bell indicator should be showing (drives the fade target).
bell_indicator: bool = false,

/// Timestamp (ms) when the bell indicator was activated, for the 1s hold on active tabs.
bell_indicator_time: i64 = 0,

// ============================================================================
// Scrollbar state (per-surface, macOS-style overlay with fade)
// ============================================================================

scrollbar_opacity: f32 = 0,
scrollbar_show_time: i64 = 0,

// Per-surface resize overlay state (for divider dragging)
resize_overlay_active: bool = false, // Whether to show resize overlay on this surface
resize_overlay_last_cols: u16 = 0, // Last known cols (to detect changes)
resize_overlay_last_rows: u16 = 0, // Last known rows (to detect changes)

// ============================================================================
// Reference counting (for split tree mutations)
// ============================================================================

/// Reference count for split tree management. When a surface is added to
/// a split tree, it gets ref'd. When removed, it gets unref'd. When the
/// ref count reaches 0, the surface is destroyed.
ref_count: u32 = 1,

// ============================================================================
// OSC title fields
// ============================================================================

window_title: [256]u8 = undefined,
window_title_len: usize = 0,

/// User-set title override. When set, this takes priority over automatic titles.
/// Set via double-click on tab or keyboard shortcut. Clear by setting len to 0.
title_override: [256]u8 = undefined,
title_override_len: usize = 0,
title_osc: osc_title.Scanner = .{},
osc7_title: [256]u8 = undefined,
osc7_title_len: usize = 0,
got_osc7_this_batch: bool = false,

wispterm_image_osc_state: ImageOscParseState = .ground,
wispterm_image_osc_buf: std.ArrayListUnmanaged(u8) = .empty,

/// Fixed-size payload buffer for OSC 7748 agent-state markers. Sized to
/// WISPTERM_AGENT_OSC_MAX; no heap allocation needed for these small sequences.
wispterm_agent_osc_buf: [WISPTERM_AGENT_OSC_MAX]u8 = undefined,
wispterm_agent_osc_buf_len: usize = 0,
agent_session_path_buf: [WISPTERM_AGENT_SESSION_PATH_MAX]u8 = undefined,
agent_session_path_len: usize = 0,
agent_capabilities: agent_detector.AgentCapabilities = .{},

/// True once this surface has received an authoritative OSC 7748 agent-state
/// marker. Reset when the foreground command is no longer a known agent.
agent_osc_active: bool = false,

// Raw CWD path from OSC 7 (Unix-style, e.g., "/home/user/dir")
cwd_path: [512]u8 = undefined,
cwd_path_len: usize = 0,

// Platform launch CWD. Used as a fallback for shells that do not emit OSC 7.
initial_cwd_path: [512]u8 = undefined,
initial_cwd_path_len: usize = 0,

// Lightweight app/agent state. State transitions come from OSC 7748 hook
// markers or, without a hook, from screen detection (`agent_screen`); app
// identity may also be seeded from the foreground command.
agent_detection: agent_detector.Detection = .{},

/// Session log of the agent running in this pane, rendered for remote clients
/// (see terminal_agents/live_transcript.zig). Main thread only.
agent_transcript: live_transcript.LiveTranscript = .{},

/// Screen-detection bookkeeping (identity source, output epoch, seen state).
/// Owned by `terminal_agents/screen_detect.zig`; the IO thread only bumps its
/// output epoch (see `markOutputDirty`).
agent_screen: screen_detect.SurfaceState = .{},

/// Packed mirror of `agent_detection` for readers on other threads (the ctl
/// server's `agent-state`, the Copilot tool worker). Writers of
/// `agent_detection` call `publishAgentDetection` afterwards.
agent_detection_shared: std.atomic.Value(u32) = std.atomic.Value(u32).init(0),

/// Last agent state seen by the main loop's notification poll (edge detection;
/// UI thread only — see AppWindow.pollAgentMarker).
agent_notify_prev_state: agent_detector.State = .none,
/// When a `done` edge was staged (ms since epoch); 0 = none. The notification
/// only fires if the agent is still done `notification.agent_done_quiet_ms`
/// later — goal-loop agents bounce done→running between milestones.
agent_done_staged_ms: i64 = 0,

// ============================================================================
// VT stream
// ============================================================================

/// Persistent VT stream for terminal output. This must live across PTY reads so
/// split UTF-8 sequences and escape sequences keep their parser state.
vt_stream: VtStream,

fn initVtStream(self: *Surface) VtStream {
    return VtStream.initAlloc(
        self.terminal.screens.active.alloc,
        VtHandler.init(&self.terminal, self),
    );
}

// ============================================================================
// Lifecycle
// ============================================================================

/// Initialize a new Surface with its own PTY and terminal.
/// If cwd is provided, the shell will start in that directory.
pub fn init(
    allocator: std.mem.Allocator,
    cols: u16,
    rows: u16,
    shell_cmd: platform_pty_command.CommandLine,
    scrollback_limit: u32,
    cursor_style: Config.CursorStyle,
    cursor_blink: bool,
    cwd: platform_pty_command.Cwd,
    advertise_terminal_capabilities: bool,
) !*Surface {
    const surface = try allocator.create(Surface);
    errdefer allocator.destroy(surface);
    applyFieldDefaults(surface);

    // Initialize terminal
    surface.terminal = ghostty_vt.Terminal.init(allocator, .{
        .cols = cols,
        .rows = rows,
        .max_scrollback = scrollback_limit,
        .default_modes = .{ .grapheme_cluster = true },
        .kitty_image_storage_limit = 50 * 1024 * 1024,
        .kitty_image_loading_limits = .all,
    }) catch |err| {
        return err;
    };
    errdefer surface.terminal.deinit(allocator);

    // Set cursor style/blink from config
    surface.terminal.screens.active.cursor.cursor_style = switch (cursor_style) {
        .bar => .bar,
        .block => .block,
        .underline => .underline,
        .block_hollow => .block_hollow,
    };
    surface.terminal.modes.set(.cursor_blinking, cursor_blink);

    // Open PTY, then ask the PTY backend to attach the child process.
    // Cleanup on any later failure is handled exclusively by errdefer; catch
    // blocks must NOT also deinit manually or resources get torn down twice
    // (double ClosePseudoConsole/CloseHandle = heap corruption on Windows; see
    // issue #65, where a missing PowerShell made command.start fail).
    surface.pty = try Pty.open(.{ .ws_col = cols, .ws_row = rows });
    errdefer surface.pty.deinit();

    surface.command = .{};
    try surface.command.start(&surface.pty, shell_cmd, cwd, advertise_terminal_capabilities);
    errdefer surface.command.deinit();

    const ready = try finishInit(surface, allocator, cols, rows, platform_pty_command.launchKindForCommand(shell_cmd), cwd, advertise_terminal_capabilities, false);
    ready.setRespawnTarget(allocator, shell_cmd, cwd);
    return ready;
}

/// Give every field that declares a default its default value.
///
/// `allocator.create` returns undefined memory (0xAA-filled in Debug) and the
/// constructors assign fields one at a time rather than through a struct
/// literal, so a declaration default is NOT applied on its own. A field added
/// with `= .{}` but forgotten in `finishInit` would otherwise stay garbage:
/// `agent_transcript` did, and closing the tab freed a 0xAAAA… pointer.
/// Ghostty avoids this class of bug by building the surface with one
/// `self.* = .{ ... }` literal; this is the equivalent for our piecewise init.
/// Must run before any other field is written.
fn applyFieldDefaults(surface: *Surface) void {
    inline for (@typeInfo(Surface).@"struct".fields) |field| {
        if (field.defaultValue()) |value| @field(surface, field.name) = value;
    }
}

/// Shared constructor tail for `init` (real PTY + child) and `initVirtual`
/// (virtual PTY, no child). The terminal, `pty`, and `command` are already set
/// up by the caller (with their `errdefer`s); this initializes every remaining
/// field and spawns the IO threads. `launch_kind`/`cwd` differ per caller.
fn finishInit(
    surface: *Surface,
    allocator: std.mem.Allocator,
    cols: u16,
    rows: u16,
    launch_kind: LaunchKind,
    cwd: platform_pty_command.Cwd,
    advertise_terminal_capabilities: bool,
    is_virtual: bool,
) !*Surface {
    // Init remaining fields
    surface.allocator = allocator;
    surface.selection = .{};
    surface.render_state = renderer.State.init(&surface.terminal);
    surface.terminal_theme_colors = creation_theme_colors;
    surface.launch_kind = launch_kind;
    surface.advertise_terminal_capabilities = advertise_terminal_capabilities;
    surface.ssh_connection = null;
    surface.ssh_autofill_due_ms = 0;
    surface.ssh_autofill_deadline_ms = 0;
    surface.respawn_command = null;
    surface.respawn_cwd = null;
    RemoteHub.nextSurfaceId(&surface.remote_id);
    surface.remote_terminal.state.desktop_grid = .{ .cols = cols, .rows = rows };
    surface.confirmed_grid.store(packGrid(.{ .cols = cols, .rows = rows }), .release);
    if (!is_virtual and remote_transport.backendForOs(builtin.os.tag) != .unsupported) {
        if (std.time.Timer.start()) |clock| {
            surface.remote_terminal.clock = clock;
            surface.remote_terminal.enabled = true;
        } else |_| {}
    }
    surface.vt_stream = surface.initVtStream();
    errdefer surface.vt_stream.deinit();
    surface.dirty = std.atomic.Value(bool).init(true);
    surface.sync_output_state = .{};
    surface.exited = std.atomic.Value(bool).init(false);
    surface.io_state_mutex = .{};
    surface.io_state = .starting;
    surface.resize_in_progress = std.atomic.Value(bool).init(false);

    // Desktop-notification state. `allocator.create` returns undefined memory
    // and this constructor initializes every field explicitly (struct-default
    // values are NOT applied here), so these must be set or notif_queue's mutex
    // is garbage — the first handleNotification()/Queue.pop() lock then aborts
    // with os_unfair_lock corruption (SIGKILL on the first frame).
    surface.notif_queue = .{};
    surface.last_notif_hash = 0;
    surface.last_notif_time = 0;

    // OSC 52 clipboard write state. Same caveat as notif_queue above: the mutex
    // must be explicitly initialized or its first lock corrupts on garbage memory.
    surface.clipboard_write_pending = null;
    surface.clipboard_write_mutex = .{};

    // Initialize mailbox for main thread → IO writer communication
    surface.mailbox = try termio.Mailbox.init();
    errdefer surface.mailbox.deinit();
    surface.io_thread_state = null;
    surface.io_writer_thread = null;
    surface.io_reader_thread = null;

    // Initialize grid size to match terminal dimensions.
    // This prevents spurious resize on first render when computeSplitLayout
    // calls setScreenSize - without this, the default 80x24 would differ from
    // the actual terminal dimensions, triggering a resize that can corrupt
    // terminal state if the shell has already output content.
    surface.size.grid.cols = cols;
    surface.size.grid.rows = rows;

    // Initialize per-surface renderer (Ghostty architecture)
    surface.surface_renderer = Renderer.init(surface);

    // Init OSC state
    surface.window_title_len = 0;
    surface.title_override_len = 0;
    surface.title_osc = .{};
    surface.osc7_title_len = 0;
    surface.got_osc7_this_batch = false;
    surface.wispterm_image_osc_state = .ground;
    surface.wispterm_image_osc_buf = .empty;
    surface.wispterm_agent_osc_buf_len = 0;
    surface.agent_session_path_len = 0;
    surface.agent_capabilities = .{};
    surface.agent_osc_active = false;
    surface.cwd_path_len = 0;
    surface.initial_cwd_path_len = 0;
    surface.agent_detection = .{};
    surface.agent_screen = .{};
    surface.agent_detection_shared = std.atomic.Value(u32).init(0);
    surface.captureInitialCwd(cwd);

    // Init bell state
    surface.bell_pending = std.atomic.Value(bool).init(false);
    surface.last_bell_time = 0;
    surface.bell_opacity = 0;
    surface.bell_indicator = false;
    surface.bell_indicator_time = 0;

    // Init scrollbar state
    surface.scrollbar_opacity = 0;
    surface.scrollbar_show_time = 0;

    // Init ref count (for split tree ownership)
    surface.ref_count = 1;

    // Initialize IO writer thread state (xev loop, async handles)
    const thread_state = try allocator.create(termio.Thread);
    errdefer allocator.destroy(thread_state);
    thread_state.* = try termio.Thread.init();
    errdefer thread_state.deinit();
    surface.io_thread_state = thread_state;

    // Spawn IO writer thread (xev event loop — handles resize, future messages)
    surface.io_writer_thread = std.Thread.spawn(threading.surface_thread_spawn_config, termio.Thread.threadMain, .{ thread_state, surface }) catch |err| {
        std.debug.print("Failed to spawn IO writer thread: {}\n", .{err});
        surface.failIo(.thread_spawn, err);
        return err;
    };
    errdefer {
        // Stop the writer thread before any deeper cleanup runs.
        if (surface.io_thread_state) |st| st.stop.notify() catch {};
        if (surface.io_writer_thread) |t| t.join();
    }

    // Spawn IO reader thread (blocking PTY output loop)
    surface.io_reader_thread = std.Thread.spawn(threading.surface_thread_spawn_config, termio.ReadThread.threadMain, .{surface}) catch |err| {
        std.debug.print("Failed to spawn IO reader thread: {}\n", .{err});
        surface.failIo(.thread_spawn, err);
        return err;
    };

    surface.setIoRunning();

    // The renderer thread is kept as a future integration point, but the actual
    // snapshot/rebuild path still runs on the main thread today. Starting it now
    // only adds an idle per-surface thread and stack without moving work off the
    // main render loop.

    // Last step (after every fallible init step): the agent request worker may
    // only touch this surface while it stays registered.
    surface_registry.register(surface, surface.remote_id[0..]);

    return surface;
}

/// Build a Surface around a pre-opened *virtual* PTY (`Pty.openVirtual`).
/// Used for tmux control-mode panes: there is no child process — the Phase 2
/// controller feeds pane output into the PTY and reads keystrokes back across
/// the pair's controller side. The caller retains that controller (typically
/// in a `tmux/pane.zig` PaneMap); this Surface owns only the `pty` end.
///
/// `command` is left as `.{}` (pid -1): its `wait()` reports "still running"
/// and its `deinit()` is a no-op, so the no-child pane never looks "exited"
/// until its controller is closed (which gives the reader an EOF).
pub fn initVirtual(
    allocator: std.mem.Allocator,
    cols: u16,
    rows: u16,
    pty: Pty,
    scrollback_limit: u32,
    cursor_style: Config.CursorStyle,
    cursor_blink: bool,
) !*Surface {
    const surface = try allocator.create(Surface);
    errdefer allocator.destroy(surface);
    applyFieldDefaults(surface);

    surface.terminal = ghostty_vt.Terminal.init(allocator, .{
        .cols = cols,
        .rows = rows,
        .max_scrollback = scrollback_limit,
        .default_modes = .{ .grapheme_cluster = true },
        .kitty_image_storage_limit = 50 * 1024 * 1024,
        .kitty_image_loading_limits = .all,
    }) catch |err| {
        return err;
    };
    errdefer surface.terminal.deinit(allocator);

    surface.terminal.screens.active.cursor.cursor_style = switch (cursor_style) {
        .bar => .bar,
        .block => .block,
        .underline => .underline,
        .block_hollow => .block_hollow,
    };
    surface.terminal.modes.set(.cursor_blinking, cursor_blink);

    // Adopt the caller's virtual PTY; no child process is launched.
    surface.pty = pty;
    errdefer surface.pty.deinit();
    surface.command = .{};
    errdefer surface.command.deinit();

    // A virtual tmux pane has no independent underlying PTY to resize.
    return finishInit(surface, allocator, cols, rows, .ssh, null, false, true);
}

/// Deinitialize and free a Surface.
/// Stops the IO thread first, then cleans up PTY and terminal.
pub fn deinit(self: *Surface, allocator: std.mem.Allocator) void {
    // 0. Withdraw the surface from the agent-tool liveness registry. This
    // blocks until any in-flight guarded access on the agent request worker
    // finishes, so nothing below can tear state out from under it.
    surface_registry.unregister(self);
    self.agent_transcript.deinit(allocator);

    // 1. Release renderer-owned CPU buffers.
    self.surface_renderer.deinit();

    if (self.remote_hub.load(.acquire)) |hub| {
        hub.unregisterSurface(self.remote_id);
    }

    // 2. Signal both IO threads to stop.
    self.beginStopping();

    // Stop the writer thread (xev event loop) via its stop async
    if (self.io_thread_state) |state| {
        state.stop.notify() catch {};
    }

    // Cancel the reader thread's blocking PTY output read.
    self.pty.cancelOutputRead();

    // Join both threads
    if (self.io_writer_thread) |thread| {
        thread.join();
        self.io_writer_thread = null;
    }
    if (self.io_reader_thread) |thread| {
        thread.join();
        self.io_reader_thread = null;
    }
    self.markStopped();
    self.remote_hub.store(null, .release);

    // Clean up writer thread state and mailbox
    if (self.io_thread_state) |state| {
        state.deinit();
        self.allocator.destroy(state);
        self.io_thread_state = null;
    }
    self.mailbox.deinit();

    // 3. Now safe to tear down everything — no other thread is accessing.
    if (self.clipboard_write_pending) |pending| {
        self.allocator.free(pending);
        self.clipboard_write_pending = null;
    }
    self.freeRespawnTarget(allocator);
    self.wispterm_image_osc_buf.deinit(allocator);
    self.vt_stream.deinit();
    self.command.deinit();
    self.pty.deinit();
    self.terminal.deinit(allocator);
    allocator.destroy(self);
}

/// Increase the reference count of this surface.
/// Used by SplitTree when a surface is added to a new tree.
pub fn ref(self: *Surface) *Surface {
    self.ref_count += 1;
    return self;
}

/// Decrease the reference count of this surface.
/// When the count reaches 0, the surface is destroyed.
/// Used by SplitTree when a surface is removed from a tree.
pub fn unref(self: *Surface, allocator: std.mem.Allocator) void {
    self.ref_count -= 1;
    if (self.ref_count == 0) {
        self.deinit(allocator);
    }
}

pub fn setSshConnection(
    self: *Surface,
    user: []const u8,
    host: []const u8,
    port: []const u8,
    password: []const u8,
    proxy_jump: []const u8,
    password_auth: bool,
    legacy_algorithms: bool,
) void {
    var conn = SshConnection.fromParts(.{
        .user = user,
        .host = host,
        .port = port,
        .password = password,
        .proxy_jump = proxy_jump,
        .auth_method = if (password_auth) .password else .credentials,
    });
    conn.legacy_algorithms = legacy_algorithms;
    self.setSshConnectionValue(conn);
}

pub fn setSshConnectionValue(self: *Surface, conn: SshConnection) void {
    self.remote_terminal.mutex.lock();
    defer self.remote_terminal.mutex.unlock();
    self.launch_kind = .ssh;
    self.ssh_connection = conn;
}

pub fn currentIoState(self: *Surface) IoState {
    self.io_state_mutex.lock();
    defer self.io_state_mutex.unlock();
    return self.io_state;
}

pub fn acceptsInput(self: *Surface) bool {
    return switch (self.currentIoState()) {
        .running => true,
        else => false,
    };
}

pub fn isExited(self: *Surface) bool {
    return switch (self.currentIoState()) {
        .exited => true,
        else => false,
    };
}

/// Whether this existing surface can be restarted in place. The original
/// command and identity stay attached to the same tab/split.
pub fn canRespawn(self: *Surface) bool {
    if (self.respawn_command == null) return false;
    return switch (self.currentIoState()) {
        .exited, .failed => true,
        else => false,
    };
}

fn setIoRunning(self: *Surface) void {
    self.io_state_mutex.lock();
    defer self.io_state_mutex.unlock();
    if (self.io_state == .starting) self.io_state = .running;
}

pub fn beginStopping(self: *Surface) void {
    self.io_state_mutex.lock();
    defer self.io_state_mutex.unlock();
    switch (self.io_state) {
        .failed, .exited, .stopped => {},
        else => self.io_state = .stopping,
    }
    self.exited.store(true, .release);
}

pub fn markStopped(self: *Surface) void {
    self.io_state_mutex.lock();
    defer self.io_state_mutex.unlock();
    switch (self.io_state) {
        .failed, .exited, .stopped => {},
        else => self.io_state = .stopped,
    }
}

pub fn pollExitStatus(self: *Surface) ?Command.Exit {
    return self.command.wait(false) catch |err| {
        io_log.warn("process exit poll failed err={s}", .{@errorName(err)});
        return null;
    };
}

pub fn markExited(self: *Surface, reason: ExitReason, status: ?Command.Exit) void {
    const info: ExitInfo = .{
        .reason = reason,
        .status = status,
        .timestamp_ms = std.time.milliTimestamp(),
    };
    var should_notify = false;

    self.io_state_mutex.lock();
    switch (self.io_state) {
        .failed, .exited, .stopped => {},
        .stopping => self.io_state = .stopped,
        else => {
            self.io_state = .{ .exited = info };
            should_notify = true;
        },
    }
    self.exited.store(true, .release);
    self.io_state_mutex.unlock();

    if (!should_notify) return;
    io_log.info("surface io exited reason={s}", .{@tagName(reason)});
    self.releaseRemoteControl(.released, .immediate);
    self.requestWriterStop();
    self.paintIoStatus(.{ .exited = info });
    window_backend.postWakeup();
}

pub fn failIo(self: *Surface, operation: Operation, err: anyerror) void {
    const failure: IoFailure = .{
        .operation = operation,
        .error_code = err,
        .timestamp_ms = std.time.milliTimestamp(),
    };
    var should_notify = false;

    self.io_state_mutex.lock();
    switch (self.io_state) {
        .failed, .exited, .stopped => {},
        else => {
            self.io_state = .{ .failed = failure };
            should_notify = true;
        },
    }
    self.exited.store(true, .release);
    self.io_state_mutex.unlock();

    if (!should_notify) return;
    self.releaseRemoteControl(.released, .immediate);
    if (builtin.is_test) {
        io_log.warn("surface io failed operation={s} err={s}", .{ @tagName(operation), @errorName(err) });
    } else {
        io_log.err("surface io failed operation={s} err={s}", .{ @tagName(operation), @errorName(err) });
    }
    self.requestWriterStop();
    if (self.io_reader_thread != null) self.pty.cancelOutputRead();
    self.paintIoStatus(.{ .failed = failure });
    window_backend.postWakeup();
}

fn requestWriterStop(self: *Surface) void {
    if (self.io_thread_state) |state| {
        state.stop.notify() catch |err| {
            io_log.warn("failed to notify io writer stop err={s}", .{@errorName(err)});
        };
    }
}

/// Build the terminal status line printed when IO ends. Pure (no terminal
/// access) so it is unit-testable. `show_reconnect_hint` appends the
/// Enter-to-reconnect prompt to a normal exit message.
fn formatIoStatusMessage(buf: []u8, state: IoState, show_reconnect_hint: bool) ?[]const u8 {
    const hint = if (show_reconnect_hint) " Press Enter to reconnect." else "";
    return switch (state) {
        .failed => |failure| std.fmt.bufPrint(
            buf,
            "\r\n[WispTerm] Terminal IO failed during {s}: {s}\r\n",
            .{ @tagName(failure.operation), @errorName(failure.error_code) },
        ) catch null,
        .exited => |info| exited: {
            if (info.status) |status| switch (status) {
                .exited => |code| break :exited std.fmt.bufPrint(
                    buf,
                    "\r\n[WispTerm] Process exited with code {d}.{s}\r\n",
                    .{ code, hint },
                ) catch null,
                .unknown => {},
            };
            break :exited std.fmt.bufPrint(
                buf,
                "\r\n[WispTerm] Process exited.{s}\r\n",
                .{hint},
            ) catch null;
        },
        else => null,
    };
}

fn paintIoStatus(self: *Surface, state: IoState) void {
    self.render_state.mutex.lock();
    defer self.render_state.mutex.unlock();

    var buf: [256]u8 = undefined;
    // Only a panel with a stored command can actually reconnect (virtual/tmux
    // panes and dup failures leave respawn_command null), so gate the hint.
    const message = formatIoStatusMessage(&buf, state, self.respawn_command != null) orelse return;

    self.terminal.printString(message) catch |err| {
        io_log.warn("failed to paint io status err={s}", .{@errorName(err)});
        return;
    };
    self.clearSynchronizedOutputLocked();
}

/// Re-run this panel's original command in place after its process exited
/// (Enter-to-reconnect). Keeps the terminal/scrollback; replaces the whole IO
/// subsystem. Main-thread only (spawns threads, touches the mailbox). No-op
/// unless the panel has exited or failed and has a stored command.
pub fn respawn(self: *Surface) void {
    switch (self.currentIoState()) {
        // .failed too: a respawn that fails to acquire a PTY lands here, and
        // the user must still be able to press Enter to retry.
        .exited, .failed => {},
        else => return,
    }
    const owned_cmd = self.respawn_command orelse {
        io_log.warn("respawn requested but no stored command", .{});
        return;
    };
    const cmd = platform_pty_command.commandLineFromOwned(owned_cmd);
    const cwd: platform_pty_command.Cwd =
        if (self.respawn_cwd) |c| platform_pty_command.cwdFromOwned(c) else null;
    const desktop_grid = self.desktopGrid();
    const cols = desktop_grid.cols;
    const rows = desktop_grid.rows;

    // Both IO threads already returned (reader on EOF, writer on the stop
    // notify markExited sent) but were never joined. Collect them before
    // anything new starts.
    if (self.io_thread_state) |state| state.stop.notify() catch {};
    self.pty.cancelOutputRead();
    if (self.io_writer_thread) |t| {
        t.join();
        self.io_writer_thread = null;
    }
    if (self.io_reader_thread) |t| {
        t.join();
        self.io_reader_thread = null;
    }

    // Acquire the new IO subsystem into locals FIRST. On any failure the OLD
    // pty/command/mailbox/thread_state are still the surface's fields and stay
    // deinit-safe — we just report failure and the old "exited" state holds.
    var new_pty = Pty.open(.{ .ws_col = cols, .ws_row = rows }) catch |err|
        return self.respawnFailed(err);
    var new_command: Command = .{};
    new_command.start(&new_pty, cmd, cwd, self.advertise_terminal_capabilities) catch |err| {
        new_pty.deinit();
        return self.respawnFailed(err);
    };
    var new_mailbox = termio.Mailbox.init() catch |err| {
        new_command.deinit();
        new_pty.deinit();
        return self.respawnFailed(err);
    };
    const new_state = self.allocator.create(termio.Thread) catch |err| {
        new_mailbox.deinit();
        new_command.deinit();
        new_pty.deinit();
        return self.respawnFailed(err);
    };
    new_state.* = termio.Thread.init() catch |err| {
        self.allocator.destroy(new_state);
        new_mailbox.deinit();
        new_command.deinit();
        new_pty.deinit();
        return self.respawnFailed(err);
    };

    // Commit: tear down the OLD subsystem, swap in the new one.
    if (self.io_thread_state) |state| {
        state.deinit();
        self.allocator.destroy(state);
        self.io_thread_state = null;
    }
    self.mailbox.deinit();
    self.command.deinit();
    self.pty.deinit();
    self.pty = new_pty;
    self.command = new_command;
    self.mailbox = new_mailbox;
    self.io_thread_state = new_state;

    // Sync the retained grid to the (possibly resized-while-exited) pane size,
    // clear the visible screen, then print a separator.
    //
    // The clear is load-bearing for SSH reconnect: the previous session's
    // "password:" prompt would otherwise linger in the viewport, and the SSH
    // password autofill (which scans the viewport for a prompt) would match that
    // stale line and type the password in plaintext BEFORE the real prompt shows
    // up. Erasing the screen makes the only on-screen prompt the reconnect's own.
    // Scrollback above the viewport is preserved (ED 2 erases the screen only).
    {
        self.render_state.mutex.lock();
        defer self.render_state.mutex.unlock();
        self.terminal.resize(self.allocator, cols, rows) catch {};
        self.commitTerminalGridLocked(.{ .cols = self.terminal.cols, .rows = self.terminal.rows });
        self.vt_stream.nextSlice("\x1b[2J\x1b[H");
        self.terminal.printString("[WispTerm] Reconnecting...\r\n") catch {};
        self.clearSynchronizedOutputLocked();
    }

    // The reader loops on `!exited`; clear it and reset lifecycle BEFORE spawn.
    self.exited.store(false, .release);
    self.io_state_mutex.lock();
    self.io_state = .starting;
    self.io_state_mutex.unlock();

    // ponytail: thread-spawn failure after the swap marks the surface failed
    // with the NEW resources owned (still deinit-safe); we don't unwind the
    // swap. Same residual exposure finishInit already has. Make spawn pre-swap
    // only if this ever actually bites.
    self.io_writer_thread = std.Thread.spawn(
        threading.surface_thread_spawn_config,
        termio.Thread.threadMain,
        .{ new_state, self },
    ) catch |err| {
        self.failIo(.thread_spawn, err);
        return;
    };
    self.io_reader_thread = std.Thread.spawn(
        threading.surface_thread_spawn_config,
        termio.ReadThread.threadMain,
        .{self},
    ) catch |err| {
        self.failIo(.thread_spawn, err);
        return;
    };

    self.setIoRunning();
    self.dirty.store(true, .release);
    window_backend.postWakeup();
}

/// Reconnect could not open a fresh PTY/command. The old (exited) resources are
/// untouched and remain owned by the surface; surface a failure message.
fn respawnFailed(self: *Surface, err: anyerror) void {
    io_log.warn("respawn failed: {s}", .{@errorName(err)});
    self.failIo(.respawn, err);
}

// ============================================================================
// Size and Resize
// ============================================================================

pub const ResizePolicy = enum {
    coalesced,
    immediate,
};

pub const DesktopLayout = struct {
    width: u32,
    height: u32,
    cell_width: f32,
    cell_height: f32,
    padding: renderer.size.Padding,
    // Preserve split geometry before cell or pixel rounding, so a real
    // boundary adjustment still reclaims ownership at the same cell count.
    split: [4]f32,
    content_size: [2]i32,
};

/// Update native layout intent. Remote grid commits do not change this input.
pub fn setScreenSizeWithPolicy(
    self: *Surface,
    layout: DesktopLayout,
    resize_policy: ResizePolicy,
) bool {
    return self.applyDesktopLayout(layout, resize_policy, .desktop);
}

/// A Web workspace edit changes the desktop grid underneath a browser lease.
/// The lease remains in control of the PTY until it is released or reclaimed.
pub fn setRemoteWorkspaceLayout(self: *Surface, layout: DesktopLayout) void {
    _ = self.applyDesktopLayout(layout, .immediate, .remote_workspace);
}

const LayoutOrigin = enum { desktop, remote_workspace };

pub fn desktopLayoutChanged(self: *Surface, layout: DesktopLayout) bool {
    self.remote_terminal.mutex.lock();
    defer self.remote_terminal.mutex.unlock();
    const previous = self.remote_terminal.desktop_layout orelse return false;
    return !std.meta.eql(previous, layout);
}

fn applyDesktopLayout(self: *Surface, layout: DesktopLayout, resize_policy: ResizePolicy, origin: LayoutOrigin) bool {
    self.remote_terminal.mutex.lock();
    defer self.remote_terminal.mutex.unlock();
    const state = &self.remote_terminal.state;
    const previous_desktop = state.desktop_grid;
    const previous_target = state.targetGrid();
    const geometry_changed = if (self.remote_terminal.desktop_layout) |previous| !std.meta.eql(previous, layout) else false;
    self.remote_terminal.desktop_layout = layout;

    self.size.screen = .{ .width = layout.width, .height = layout.height };
    self.size.cell.width = layout.cell_width;
    self.size.cell.height = layout.cell_height;
    self.size.padding = layout.padding;
    self.size.computeGrid();
    state.desktop_grid = self.size.grid;
    if (geometry_changed and origin == .desktop and state.reclaim()) self.publishControlStateLocked(.desktop);

    const target = state.targetGrid();
    if (!remote_control.sameGrid(previous_target, target)) self.queueGrid(target, resize_policy);
    // Keep native mouse/selection geometry aligned with the remotely sized VT.
    if (state.active()) self.size.grid = self.confirmedGrid();
    return !remote_control.sameGrid(previous_desktop, state.desktop_grid);
}

fn desktopGrid(self: *Surface) GridSize {
    self.remote_terminal.mutex.lock();
    defer self.remote_terminal.mutex.unlock();
    return self.remote_terminal.state.desktop_grid;
}

fn packGrid(grid: GridSize) u32 {
    return @as(u32, grid.cols) << 16 | grid.rows;
}

pub fn confirmedGrid(self: *const Surface) GridSize {
    const packed_grid = self.confirmed_grid.load(.acquire);
    return .{ .cols = @intCast(packed_grid >> 16), .rows = @truncate(packed_grid) };
}

pub const ResizePixels = struct { width: u32, height: u32 };

/// Recheck the coalesced request before admitting it to the PTY. A takeover,
/// desktop resize or expiration may have invalidated it while queued.
pub fn prepareResize(self: *Surface, grid: GridSize) ?ResizePixels {
    self.remote_terminal.mutex.lock();
    defer self.remote_terminal.mutex.unlock();
    if (self.remote_terminal.enabled) self.expireRemoteControlLocked();
    if (!self.remote_terminal.state.admitsGrid(grid) or remote_control.sameGrid(self.confirmedGrid(), grid)) return null;
    return .{
        .width = @intFromFloat(@as(f32, @floatFromInt(grid.cols)) * self.size.cell.width),
        .height = @intFromFloat(@as(f32, @floatFromInt(grid.rows)) * self.size.cell.height),
    };
}

/// Caller holds the render lock so the reader cannot send post-resize bytes
/// before the authoritative grid is enqueued on the same transport.
pub fn commitTerminalGridLocked(self: *Surface, grid: GridSize) void {
    if (self.confirmed_grid.swap(packGrid(grid), .acq_rel) == packGrid(grid)) return;
    if (!self.remote_terminal.enabled) return;
    if (self.remote_hub.load(.acquire)) |hub| hub.sendTerminalGrid(&self.remote_id, grid);
}

pub fn supportsRemoteControl(self: *Surface) bool {
    if (!self.remote_terminal.enabled or !self.acceptsInput()) return false;
    self.remote_terminal.mutex.lock();
    defer self.remote_terminal.mutex.unlock();
    return !self.remote_terminal.state.tabManaged();
}

pub fn supportsTabControl(self: *const Surface) bool {
    return self.remote_terminal.enabled;
}

pub fn supportsRemoteImagePaste(self: *Surface) bool {
    if (builtin.os.tag != .windows or !self.remote_terminal.enabled or !self.acceptsInput()) return false;
    self.remote_terminal.mutex.lock();
    defer self.remote_terminal.mutex.unlock();
    return self.launch_kind != .ssh;
}

pub fn usesBracketedPaste(self: *Surface) bool {
    // Snapshot the negotiated mode under the same lock as the VT reader. The
    // paste encoder and PTY mailbox can run after the reader is unblocked.
    self.render_state.mutex.lock();
    defer self.render_state.mutex.unlock();
    return self.terminal.modes.get(.bracketed_paste);
}

pub fn remoteControlActive(self: *Surface) bool {
    if (!self.remote_terminal.enabled) return false;
    self.remote_terminal.mutex.lock();
    defer self.remote_terminal.mutex.unlock();
    return self.remote_terminal.state.active();
}

/// The tab controller locks all affected surfaces before changing ownership.
pub fn lockRemoteTabControl(self: *Surface) void {
    self.remote_terminal.mutex.lock();
}

pub fn unlockRemoteTabControl(self: *Surface) void {
    self.remote_terminal.mutex.unlock();
}

pub fn setRemoteTabControlLocked(self: *Surface, managed: bool, grant: ?remote_control.TabGrant, policy: ResizePolicy) void {
    const state = &self.remote_terminal.state;
    const previous = state.targetGrid();
    const had_legacy_holder = state.holder != null;
    state.mirrorTab(managed, grant, self.confirmedGrid());
    const target = state.targetGrid();
    if (!remote_control.sameGrid(previous, target)) self.queueGrid(target, policy);
    if (had_legacy_holder and state.holder == null) self.publishControlStateLocked(.released);
}

pub fn setRemoteTabGridLocked(self: *Surface, grid: GridSize) void {
    const state = &self.remote_terminal.state;
    if (remote_control.sameGrid(state.targetGrid(), grid)) return;
    state.setTabGrid(grid);
    self.queueGrid(grid, .coalesced);
}

fn queueGrid(self: *Surface, grid: GridSize, policy: ResizePolicy) void {
    self.queueIo(switch (policy) {
        .coalesced => .{ .resize = grid },
        .immediate => .{ .resize_immediate = grid },
    });
}

fn publishControlStateLocked(self: *Surface, reason: remote_control.Reason) void {
    if (self.remote_hub.load(.acquire)) |hub| {
        const holder = if (self.remote_terminal.state.holder) |*holder| holder else null;
        hub.sendTerminalControlState(&self.remote_id, holder, reason);
    }
}

fn releaseRemoteControl(self: *Surface, reason: remote_control.Reason, policy: ResizePolicy) void {
    if (!self.remote_terminal.enabled) return;
    self.remote_terminal.mutex.lock();
    defer self.remote_terminal.mutex.unlock();
    if (self.remote_terminal.state.reclaim()) {
        self.queueGrid(self.remote_terminal.state.desktop_grid, policy);
        self.publishControlStateLocked(reason);
    }
}

pub fn reclaimRemoteControl(self: *Surface) void {
    self.releaseRemoteControl(.desktop, .coalesced);
}

fn expireRemoteControlLocked(self: *Surface) void {
    if (self.remote_terminal.state.expire(self.remote_terminal.clock.read() / std.time.ns_per_ms)) {
        self.queueGrid(self.remote_terminal.state.desktop_grid, .immediate);
        self.publishControlStateLocked(.expired);
    }
}

/// The termio xev timer wakes at the deadline even when the terminal is idle.
pub fn remoteControlRemainingMs(self: *Surface) ?u64 {
    if (!self.remote_terminal.enabled) return null;
    self.remote_terminal.mutex.lock();
    defer self.remote_terminal.mutex.unlock();
    self.expireRemoteControlLocked();
    const holder = self.remote_terminal.state.holder orelse return null;
    const now_ms = self.remote_terminal.clock.read() / std.time.ns_per_ms;
    return @max(1, holder.expires_at_ms -| now_ms);
}

fn remoteControlRequest(ctx: *anyopaque, request: remote_control.Request) void {
    const self: *Surface = @ptrCast(@alignCast(ctx));
    self.remote_terminal.mutex.lock();
    defer self.remote_terminal.mutex.unlock();
    if (!self.acceptsInput()) {
        _ = self.remote_terminal.state.reclaim();
        self.publishControlStateLocked(.unsupported);
        return;
    }
    self.expireRemoteControlLocked();
    const state = &self.remote_terminal.state;
    const previous = state.targetGrid();
    const reason = state.apply(request, self.confirmedGrid(), self.remote_terminal.clock.read() / std.time.ns_per_ms);
    const target = state.targetGrid();
    if (!remote_control.sameGrid(previous, target)) {
        self.queueGrid(target, if (state.holder == null) .immediate else .coalesced);
    }
    if (reason) |value| self.publishControlStateLocked(value);
    // A grant or renewal with unchanged dimensions still needs the timer.
    if (state.holder != null) self.mailbox.notify();
}

/// Number of notify+yield attempts to give the writer thread a chance to drain
/// a full mailbox before we give up on a write. Bounded so we never spin.
const MAILBOX_FULL_RETRIES = 64;

const mailbox_log = std.log.scoped(.mailbox);

/// Failure modes of queuePtyWrite. A caller MUST handle these — there is no
/// silent-drop path. A fire-and-forget caller may `catch |e| log...` but the
/// outcome is always surfaced.
pub const QueueWriteError = error{
    /// The owning surface is no longer accepting input (stopping/exited/failed);
    /// the PTY process is gone and the IO writer thread is tearing down.
    SurfaceExited,
    /// A remote controller owns the surface or this input's lease is stale.
    RemoteControlActive,
    /// The payload ring stayed full across the bounded notify+retry window;
    /// the write was NOT delivered and NOT dropped behind the caller's back.
    BackpressureTimeout,
    /// Allocating the heap copy for a large write failed.
    OutOfMemory,
};

/// Queue a resize (control-lane) message to the IO writer thread. Infallible:
/// resize uses the mailbox's last-writer-wins control fields, which never
/// occupy a payload slot and can never report `.full`. Writes must NOT go
/// through here — use queuePtyWrite, which surfaces backpressure.
pub fn queueIo(self: *Surface, msg: termio.Message) void {
    switch (msg) {
        .resize => |grid| self.mailbox.setResize(grid),
        .resize_immediate => |grid| self.mailbox.setImmediateResize(grid),
        .write_small, .write_alloc => unreachable, // use queuePtyWrite
    }
    self.mailbox.notify();
}

/// Queue bytes to the PTY input pipe through the IO writer thread.
/// This mirrors Ghostty's write-message boundary so local and remote input
/// share the same PTY write path instead of writing directly to the pipe.
///
/// On a full payload ring we notify the writer and retry a bounded number of
/// times, yielding between attempts to let it drain (the mutex is released
/// between attempts). If it is still full after the bound we RETURN
/// `error.BackpressureTimeout` rather than discarding the bytes and pretending
/// success — the caller decides how loud to be. We NEVER use msg.deinit() to
/// implicitly mean "delivered".
pub fn queuePtyWrite(self: *Surface, data: []const u8) QueueWriteError!void {
    return self.queueControlledWrite(data, null);
}

fn queueControlledWrite(self: *Surface, data: []const u8, identity: ?remote_control.Identity) QueueWriteError!void {
    if (!self.acceptsInput()) return error.SurfaceExited;
    const epoch: ?u64 = if (self.remote_terminal.enabled) blk: {
        self.remote_terminal.mutex.lock();
        defer self.remote_terminal.mutex.unlock();
        self.expireRemoteControlLocked();
        break :blk self.remote_terminal.state.authorize(identity) orelse return error.RemoteControlActive;
    } else null;
    return self.queuePtyWriteImpl(data, epoch);
}

pub fn admitPtyWrite(self: *Surface, epoch: ?u64) bool {
    if (!self.acceptsInput()) return false;
    const authorized_epoch = epoch orelse return true;
    self.remote_terminal.mutex.lock();
    defer self.remote_terminal.mutex.unlock();
    self.expireRemoteControlLocked();
    return self.remote_terminal.state.admitsEpoch(authorized_epoch);
}

fn queuePtyWriteImpl(self: *Surface, data: []const u8, epoch: ?u64) QueueWriteError!void {
    if (!self.acceptsInput()) return error.SurfaceExited;
    const msg = termio.Message.writeReqWithEpoch(self.allocator, data, epoch) catch
        return error.OutOfMemory;

    var attempt: usize = 0;
    while (true) {
        switch (self.mailbox.sendWrite(msg)) {
            .queued => {
                self.mailbox.notify();
                return;
            },
            .full => {
                // Wake the writer so it drains, then yield and retry. The mutex
                // is released between attempts (sendWrite locks per call), so
                // the writer's popWrite() can make progress.
                self.mailbox.notify();
                attempt += 1;
                if (attempt >= MAILBOX_FULL_RETRIES) {
                    // The bytes were never enqueued; free our copy and report
                    // the backpressure instead of silently dropping input.
                    msg.deinit();
                    return error.BackpressureTimeout;
                }
                std.Thread.yield() catch {};
            },
        }
    }
}

pub fn attachRemoteHub(self: *Surface, hub: ?*RemoteHub.Hub) void {
    self.remote_hub.store(hub, .release);
    if (hub) |h| {
        h.registerTerminalSurface(
            self.remote_id,
            self,
            remoteWrite,
            if (self.remote_terminal.enabled) remoteControlRequest else null,
            if (builtin.os.tag == .windows and self.remote_terminal.enabled)
                .{ .authorize = authorizeRemoteImagePaste, .enqueue = enqueueRemoteImagePaste }
            else
                null,
        );
    }
}

fn authorizeRemoteImagePaste(ctx: *anyopaque, identity: remote_control.Identity) remote_image_paste.Authorization {
    const surface: *Surface = @ptrCast(@alignCast(ctx));
    if (!surface.acceptsInput()) return .unsupported;
    if (identity.origin != .relay or (identity.lease_id orelse 0) == 0 or identity.client_id == null)
        return .denied;

    surface.remote_terminal.mutex.lock();
    defer surface.remote_terminal.mutex.unlock();
    const kind: remote_image_paste.TargetKind = switch (surface.launch_kind) {
        .local => .local,
        .wsl => .wsl,
        .ssh => return .unsupported,
    };
    surface.expireRemoteControlLocked();
    const epoch = surface.remote_terminal.state.authorize(identity) orelse return .denied;
    return .{ .accepted = .{ .kind = kind, .epoch = epoch } };
}

fn enqueueRemoteImagePaste(
    ctx: *anyopaque,
    identity: remote_control.Identity,
    expected: remote_image_paste.Target,
    text: []const u8,
) remote_image_paste.Status {
    const surface: *Surface = @ptrCast(@alignCast(ctx));
    const allocator = surface.allocator;
    const encoded = terminal_paste.encode(allocator, text, surface.usesBracketedPaste()) catch return .failed;
    defer if (encoded) |bytes| allocator.free(bytes);

    switch (authorizeRemoteImagePaste(ctx, identity)) {
        .accepted => |target| {
            if (target.epoch != expected.epoch or target.kind != expected.kind) return .denied;
        },
        .denied => return .denied,
        .unsupported => return .unsupported,
    }
    // The writer fences the whole paste against any lease changes after this
    // check, using the same epoch as other leased terminal input.
    surface.queuePtyWriteImpl(encoded orelse text, expected.epoch) catch return .failed;
    return .queued;
}

fn remoteWrite(ctx: *anyopaque, data: []const u8, identity: remote_control.Identity) void {
    const surface: *Surface = @ptrCast(@alignCast(ctx));
    surface.queueControlledWrite(data, identity) catch |err| {
        if (err == error.RemoteControlActive) return;
        mailbox_log.warn("dropped remote write ({d} bytes): {s}", .{ data.len, @errorName(err) });
    };
}

/// Get the padding for rendering. Returns the computed padding
/// which includes both explicit padding and balanced centering.
pub fn getPadding(self: *const Surface) renderer.size.Padding {
    return self.size.padding;
}

// ============================================================================
// Title
// ============================================================================

/// Get the display title for this surface.
pub fn getTitle(self: *const Surface) []const u8 {
    // User override takes highest priority (like Ghostty's title_override)
    if (self.title_override_len > 0)
        return self.title_override[0..self.title_override_len];
    if (self.osc7_title_len > 0)
        return self.osc7_title[0..self.osc7_title_len];
    if (self.window_title_len > 0)
        return self.window_title[0..self.window_title_len];
    return "wispterm";
}

/// Set a manual title override. Pass empty slice to clear.
pub fn setTitleOverride(self: *Surface, title: []const u8) void {
    const len = @min(title.len, self.title_override.len);
    @memcpy(self.title_override[0..len], title[0..len]);
    self.title_override_len = len;
}

/// Set the working directory used for path resolution. Used by the tmux
/// bridge, which sources cwd from `#{pane_current_path}` rather than OSC 7
/// (tmux consumes OSC 7). Truncates to the cwd_path buffer.
pub fn setCwdPath(self: *Surface, path: []const u8) void {
    const n = @min(self.cwd_path.len, path.len);
    @memcpy(self.cwd_path[0..n], path[0..n]);
    self.cwd_path_len = n;
}

/// Note the pane's current foreground command (from tmux `#{pane_current_command}`),
/// classified to an agent App. Two effects:
///  - If the command is no longer an agent (`.none`) and an OSC marker had been
///    driving this surface, release the authoritative latch so the heuristic
///    detector resumes (the agent process has exited back to a shell).
///  - Otherwise, if no app is known yet and the OSC marker isn't driving the
///    surface, seed `agent_detection.app` from the (reliable) process name so the
///    badge identifies the agent even before output heuristics fire.
pub fn noteAgentCommand(self: *Surface, app: agent_detector.App) void {
    if (app == .none) {
        if (self.agent_osc_active) self.agent_osc_active = false;
        self.agent_session_path_len = 0;
        self.agent_capabilities = .{};
        self.agent_screen.seed(.none);
        return;
    }
    if (app != .pi) {
        self.agent_session_path_len = 0;
        self.agent_capabilities = .{};
    }
    if (!self.agent_osc_active and self.agent_detection.app == .none) {
        self.agent_detection.app = app;
        self.publishAgentDetection();
    }
    self.agent_screen.seed(app);
}

/// Refresh the cross-thread mirror after `agent_detection` changed.
pub fn publishAgentDetection(self: *Surface) void {
    self.agent_detection_shared.store(self.agent_detection.pack(), .release);
}

/// `agent_detection` as last published, readable from any thread.
pub fn agentDetectionShared(self: *const Surface) agent_detector.Detection {
    return agent_detector.Detection.unpack(self.agent_detection_shared.load(.acquire));
}

/// Queue a host command for session restore or graceful close.
pub fn queueInput(self: *Surface, data: []const u8) bool {
    self.queuePtyWrite(data) catch return false;
    return true;
}

/// Start Pi from a restored local/WSL shell using a shell-neutral quoted path.
/// Paths containing shell interpolation/quote characters are rejected rather
/// than turned into an unsafe startup command.
pub fn queuePiSessionResume(self: *Surface, path: []const u8) bool {
    var buf: [8192]u8 = undefined;
    const command = session_persist.formatPiSessionResumeCommand(&buf, path) orelse return false;
    return self.queueInput(command);
}

/// Return the launch context of this surface.
pub fn launchKind(self: *const Surface) platform_pty_command.LaunchKind {
    return self.launch_kind;
}

/// Return the current Pi JSONL session path reported by the companion, if any.
pub fn piSessionPath(self: *const Surface) ?[]const u8 {
    if (self.agent_detection.app != .pi or self.agent_session_path_len == 0) return null;
    return self.agent_session_path_buf[0..self.agent_session_path_len];
}

pub fn piSupportsGracefulExit(self: *const Surface) bool {
    return self.agent_detection.app == .pi and self.agent_capabilities.graceful_exit;
}

/// Get the current working directory path (from OSC 7), or null if not set.
/// Returns a Unix-style path (e.g., "/home/user/dir" or "/mnt/c/Users/...").
pub fn getCwd(self: *const Surface) ?[]const u8 {
    if (self.cwd_path_len > 0)
        return self.cwd_path[0..self.cwd_path_len];
    return null;
}

/// True when the alternate screen buffer is active. Used as a cheap, local
/// signal that a full-screen app (notably an attached `tmux`) is running:
/// plain tmux consumes OSC 7, so the OSC 7-derived cwd goes stale and a live
/// remote pane-cwd query is preferred for path resolution.
pub fn isAltScreenActive(self: *const Surface) bool {
    return self.terminal.screens.active_key == .alternate;
}

/// Get the platform launch directory for shells that do not report OSC 7.
pub fn getInitialCwd(self: *const Surface) ?[]const u8 {
    if (self.initial_cwd_path_len > 0)
        return self.initial_cwd_path[0..self.initial_cwd_path_len];
    return null;
}

/// Best-effort current working directory for resolving relative paths.
/// Tries, in order: the OSC 7-reported cwd; a live query of the shell
/// process's cwd (POSIX proc lookup — covers zsh and other shells that don't
/// emit OSC 7); the launch cwd. Caller owns the returned slice.
pub fn dupeCurrentCwd(self: *const Surface, allocator: std.mem.Allocator) ?[]u8 {
    if (self.getCwd()) |c| return allocator.dupe(u8, c) catch null;
    if (self.command.cwdQueryId()) |pid| {
        if (platform_process.processCwd(allocator, pid)) |live| return live;
    }
    if (self.getInitialCwd()) |c| return allocator.dupe(u8, c) catch null;
    return null;
}

/// Coarse classification for session persistence. Distinct from `LaunchKind`
/// (which separates `local` from `wsl` for path translation) because v1
/// session restore only cares about local-vs-remote — WSL surfaces are
/// classified as `local_shell` and are not faithfully restored. v2 may
/// reuse `LaunchKind` directly when WSL restoration is supported.
pub const SurfaceKind = enum { local_shell, ssh };

/// Classify the surface for session persistence. Currently distinguishes
/// SSH from everything else; browser/markdown surfaces are not handled
/// because they are out of scope for v1 of session restore.
pub fn surfaceKind(self: *const Surface) SurfaceKind {
    if (self.ssh_connection != null) return .ssh;
    return .local_shell;
}

fn captureInitialCwd(self: *Surface, cwd: platform_pty_command.Cwd) void {
    if (platform_pty_command.cwdToUtf8(&self.initial_cwd_path, cwd)) |path| {
        self.initial_cwd_path_len = path.len;
        return;
    }

    const path = std.process.getCwd(&self.initial_cwd_path) catch return;
    self.initial_cwd_path_len = path.len;
}

/// Store owned copies of the launch command/cwd for Enter-to-reconnect.
/// `CommandLine`/`Cwd` are platform-native (`u8` POSIX / `u16` Windows); we
/// dup with the element unit so this is cross-platform. Best-effort: on dup
/// failure the field stays null and reconnect is simply unavailable.
fn setRespawnTarget(
    self: *Surface,
    allocator: std.mem.Allocator,
    cmd: platform_pty_command.CommandLine,
    cwd: platform_pty_command.Cwd,
) void {
    const CmdUnit = std.meta.Child(platform_pty_command.CommandLine);
    self.respawn_command = allocator.dupeZ(CmdUnit, cmd) catch null;
    self.respawn_cwd = if (cwd) |c|
        (allocator.dupeZ(platform_pty_command.CwdUnit, std.mem.span(c)) catch null)
    else
        null;
}

fn freeRespawnTarget(self: *Surface, allocator: std.mem.Allocator) void {
    if (self.respawn_command) |c| platform_pty_command.freeCommandLine(allocator, c);
    if (self.respawn_cwd) |c| platform_pty_command.freeCwd(allocator, c);
    self.respawn_command = null;
    self.respawn_cwd = null;
}

/// Reset OSC batch state — call before each PTY read batch.
pub fn resetOscBatch(self: *Surface) void {
    self.got_osc7_this_batch = false;
}

/// Decode an OSC 52 clipboard write (IO reader thread) and stage it for the
/// main thread. Read queries / clears / undecodable payloads are dropped.
pub fn ingestClipboardWrite(self: *Surface, kind: u8, data: []const u8) void {
    const action = clipboard_osc52.decode(self.allocator, kind, data) catch return;
    const text = switch (action) {
        .write => |t| t,
        .ignore => return,
    };
    self.clipboard_write_mutex.lock();
    defer self.clipboard_write_mutex.unlock();
    if (self.clipboard_write_pending) |old| self.allocator.free(old);
    self.clipboard_write_pending = text;
}

/// Take ownership of any pending OSC 52 clipboard text (main thread). The
/// caller must free the returned slice with `self.allocator`.
pub fn takeClipboardWrite(self: *Surface) ?[]u8 {
    self.clipboard_write_mutex.lock();
    defer self.clipboard_write_mutex.unlock();
    const text = self.clipboard_write_pending;
    self.clipboard_write_pending = null;
    return text;
}

/// Mark PTY output pending for the render loop. Returns true when this is the
/// first mark since the UI last consumed the flag — the caller should post
/// exactly one wakeup then, instead of flooding the platform event queue with
/// one message per output chunk.
pub fn markOutputDirty(self: *Surface) bool {
    self.agent_screen.noteOutput();
    return !self.dirty.swap(true, .release);
}

/// Track DEC synchronized output mode (2026) transitions. This mirrors
/// Ghostty's behavior: rendering waits while the mode is enabled, but a
/// watchdog prevents an application from hiding the terminal indefinitely.
pub fn noteSynchronizedOutputMode(self: *Surface, enabled: bool) void {
    if (enabled) {
        self.sync_output_state.start(std.time.milliTimestamp());
    } else {
        self.sync_output_state.end();
        self.surface_renderer.force_rebuild = true;
    }
    self.dirty.store(true, .release);
}

/// True once after the application ended a synchronized frame. The IO thread
/// posts a wakeup on it: by then the dirty flag is already set (by the mode
/// notification above, or latched from a deferred frame), so
/// `markOutputDirty` alone would not wake the render loop. Caller must hold
/// render_state.mutex.
pub fn takeSynchronizedFrameEndedLocked(self: *Surface) bool {
    return self.sync_output_state.takeFrameEnded();
}

/// Clear synchronized output after an external terminal state change such as
/// resize. Caller must hold render_state.mutex.
pub fn clearSynchronizedOutputLocked(self: *Surface) void {
    self.terminal.modes.set(.synchronized_output, false);
    self.sync_output_state.stop();
    self.surface_renderer.force_rebuild = true;
    self.dirty.store(true, .release);
}

/// Return true while a visible frame should be deferred for synchronized
/// output. Caller must hold render_state.mutex.
pub fn synchronizedOutputPendingLocked(self: *Surface) bool {
    return switch (self.sync_output_state.poll(
        self.terminal.modes.get(.synchronized_output),
        std.time.milliTimestamp(),
    )) {
        .inactive => false,
        .pending => true,
        .expired => expired: {
            self.terminal.modes.set(.synchronized_output, false);
            self.surface_renderer.force_rebuild = true;
            self.dirty.store(true, .release);
            break :expired false;
        },
    };
}

/// Feed terminal output to the VT parser, translating WispTerm's private OSC
/// image fallback back into the Ghostty/Kitty APC protocol in stream order.
pub fn feedVtWithWispTermImageFallback(self: *Surface, data: []const u8) void {
    var passthrough_start: usize = 0;

    for (data, 0..) |byte, i| {
        switch (self.wispterm_image_osc_state) {
            .ground => {
                if (byte == 0x1b) {
                    if (i > passthrough_start) {
                        self.vt_stream.nextSlice(data[passthrough_start..i]);
                    }
                    self.wispterm_image_osc_state = .esc;
                    passthrough_start = i + 1;
                }
            },
            .esc => {
                if (byte == ']') {
                    self.wispterm_image_osc_buf.clearRetainingCapacity();
                    self.wispterm_image_osc_state = .osc_prefix;
                    passthrough_start = i + 1;
                } else if (byte == 'k') {
                    // GNU screen/tmux title sequence: ESC k <title> ESC \.
                    // ghostty-vt doesn't implement ESC k yet; forwarding it
                    // lets the title payload (often the running command such
                    // as "ls" or "cd") render as stray pane text.
                    self.wispterm_image_osc_state = .screen_title;
                    passthrough_start = i + 1;
                } else {
                    self.vt_stream.nextSlice("\x1b");
                    self.vt_stream.nextSlice(data[i .. i + 1]);
                    self.wispterm_image_osc_state = .ground;
                    passthrough_start = i + 1;
                }
            },
            .screen_title => switch (byte) {
                0x07 => {
                    self.wispterm_image_osc_state = .ground;
                    passthrough_start = i + 1;
                },
                0x1b => {
                    self.wispterm_image_osc_state = .screen_title_esc;
                    passthrough_start = i + 1;
                },
                else => passthrough_start = i + 1,
            },
            .screen_title_esc => {
                self.wispterm_image_osc_state = if (byte == '\\') .ground else .screen_title;
                passthrough_start = i + 1;
            },
            .osc_prefix => {
                const matched = self.wispterm_image_osc_buf.items.len;
                if (matched < WISPTERM_IMAGE_OSC_PREFIX.len and
                    byte == WISPTERM_IMAGE_OSC_PREFIX[matched])
                {
                    if (!self.appendWispTermImageOscByte(byte)) {
                        self.wispterm_image_osc_buf.clearRetainingCapacity();
                        self.wispterm_image_osc_state = .image_overflow;
                    } else if (self.wispterm_image_osc_buf.items.len == WISPTERM_IMAGE_OSC_PREFIX.len) {
                        self.wispterm_image_osc_buf.clearRetainingCapacity();
                        self.wispterm_image_osc_state = if (self.reserveWispTermImageOscPayload())
                            .image_osc
                        else
                            .image_overflow;
                    }
                    passthrough_start = i + 1;
                } else if (matched == WISPTERM_PRIVATE_OSC_SHARED.len and byte == '8') {
                    // The first 3 bytes ("774") are shared between image (7747)
                    // and agent (7748) OSCs.  Seeing '8' here means this is the
                    // private agent-state OSC — transition to wait for the ';'.
                    self.wispterm_image_osc_buf.clearRetainingCapacity();
                    self.wispterm_agent_osc_buf_len = 0;
                    self.wispterm_image_osc_state = .agent_osc_prefix;
                    passthrough_start = i + 1;
                } else {
                    self.replayNonImageOscPrefix();
                    self.vt_stream.nextSlice(data[i .. i + 1]);
                    self.wispterm_image_osc_state = switch (byte) {
                        0x07 => .ground,
                        0x1b => .passthrough_osc_esc,
                        else => .passthrough_osc,
                    };
                    passthrough_start = i + 1;
                }
            },
            .agent_osc_prefix => {
                // Waiting for the ';' that completes "7748;" after the shared "774" + "8".
                if (byte == ';') {
                    self.wispterm_image_osc_state = .agent_osc;
                } else {
                    // Not a valid agent OSC — replay "\x1b]7748" + this byte as
                    // passthrough so the VT sees it and the byte is not swallowed.
                    self.vt_stream.nextSlice("\x1b]7748");
                    self.vt_stream.nextSlice(data[i .. i + 1]);
                    self.wispterm_image_osc_state = switch (byte) {
                        0x07 => .ground,
                        0x1b => .passthrough_osc_esc,
                        else => .passthrough_osc,
                    };
                }
                passthrough_start = i + 1;
            },
            .agent_osc => switch (byte) {
                0x07 => {
                    // BEL terminator — complete marker.
                    self.handleWispTermAgentOsc();
                    self.wispterm_image_osc_state = .ground;
                    passthrough_start = i + 1;
                },
                0x1b => {
                    // Possible ST (ESC \) terminator.
                    self.wispterm_image_osc_state = .agent_osc_esc;
                    passthrough_start = i + 1;
                },
                else => {
                    if (self.wispterm_agent_osc_buf_len < WISPTERM_AGENT_OSC_MAX) {
                        self.wispterm_agent_osc_buf[self.wispterm_agent_osc_buf_len] = byte;
                        self.wispterm_agent_osc_buf_len += 1;
                    } else {
                        // Payload exceeded cap — switch to overflow drain.
                        self.wispterm_agent_osc_buf_len = 0;
                        self.wispterm_image_osc_state = .agent_overflow;
                    }
                    passthrough_start = i + 1;
                },
            },
            .agent_osc_esc => {
                if (byte == '\\') {
                    // ST terminator — complete marker.
                    self.handleWispTermAgentOsc();
                    self.wispterm_image_osc_state = .ground;
                } else {
                    // Not a valid ST; treat the ESC + this byte as part of payload.
                    if (self.wispterm_agent_osc_buf_len + 2 <= WISPTERM_AGENT_OSC_MAX) {
                        self.wispterm_agent_osc_buf[self.wispterm_agent_osc_buf_len] = 0x1b;
                        self.wispterm_agent_osc_buf_len += 1;
                        self.wispterm_agent_osc_buf[self.wispterm_agent_osc_buf_len] = byte;
                        self.wispterm_agent_osc_buf_len += 1;
                        self.wispterm_image_osc_state = .agent_osc;
                    } else {
                        self.wispterm_agent_osc_buf_len = 0;
                        self.wispterm_image_osc_state = .agent_overflow;
                    }
                }
                passthrough_start = i + 1;
            },
            .agent_overflow => switch (byte) {
                0x07 => {
                    self.wispterm_image_osc_state = .ground;
                    passthrough_start = i + 1;
                },
                0x1b => {
                    self.wispterm_image_osc_state = .agent_overflow_esc;
                    passthrough_start = i + 1;
                },
                else => passthrough_start = i + 1,
            },
            .agent_overflow_esc => {
                self.wispterm_image_osc_state = if (byte == '\\') .ground else .agent_overflow;
                passthrough_start = i + 1;
            },
            .image_osc => switch (byte) {
                0x07 => {
                    self.handleWispTermImageOsc();
                    self.wispterm_image_osc_state = .ground;
                    passthrough_start = i + 1;
                },
                0x1b => {
                    self.wispterm_image_osc_state = .image_osc_esc;
                    passthrough_start = i + 1;
                },
                else => {
                    if (!self.appendWispTermImageOscByte(byte)) {
                        self.wispterm_image_osc_buf.clearRetainingCapacity();
                        self.wispterm_image_osc_state = .image_overflow;
                    }
                    passthrough_start = i + 1;
                },
            },
            .image_osc_esc => {
                if (byte == '\\') {
                    self.handleWispTermImageOsc();
                    self.wispterm_image_osc_state = .ground;
                } else {
                    if (!self.appendWispTermImageOscByte(0x1b) or
                        !self.appendWispTermImageOscByte(byte))
                    {
                        self.wispterm_image_osc_buf.clearRetainingCapacity();
                        self.wispterm_image_osc_state = .image_overflow;
                    } else {
                        self.wispterm_image_osc_state = .image_osc;
                    }
                }
                passthrough_start = i + 1;
            },
            .image_overflow => switch (byte) {
                0x07 => {
                    self.wispterm_image_osc_state = .ground;
                    passthrough_start = i + 1;
                },
                0x1b => {
                    self.wispterm_image_osc_state = .image_overflow_esc;
                    passthrough_start = i + 1;
                },
                else => passthrough_start = i + 1,
            },
            .image_overflow_esc => {
                self.wispterm_image_osc_state = if (byte == '\\') .ground else .image_overflow;
                passthrough_start = i + 1;
            },
            .passthrough_osc => switch (byte) {
                0x07 => {
                    if (i + 1 > passthrough_start) {
                        self.vt_stream.nextSlice(data[passthrough_start .. i + 1]);
                    }
                    self.wispterm_image_osc_state = .ground;
                    passthrough_start = i + 1;
                },
                0x1b => self.wispterm_image_osc_state = .passthrough_osc_esc,
                else => {},
            },
            .passthrough_osc_esc => {
                if (byte == '\\') {
                    if (i + 1 > passthrough_start) {
                        self.vt_stream.nextSlice(data[passthrough_start .. i + 1]);
                    }
                    self.wispterm_image_osc_state = .ground;
                    passthrough_start = i + 1;
                } else {
                    self.wispterm_image_osc_state = .passthrough_osc;
                }
            },
        }
    }

    switch (self.wispterm_image_osc_state) {
        .ground, .passthrough_osc, .passthrough_osc_esc => {
            if (data.len > passthrough_start) {
                self.vt_stream.nextSlice(data[passthrough_start..]);
            }
        },
        else => {},
    }
}

fn appendWispTermImageOscByte(self: *Surface, byte: u8) bool {
    if (self.wispterm_image_osc_buf.items.len >= WISPTERM_IMAGE_OSC_MAX) return false;
    self.wispterm_image_osc_buf.append(self.allocator, byte) catch return false;
    return true;
}

fn reserveWispTermImageOscPayload(self: *Surface) bool {
    self.wispterm_image_osc_buf.ensureTotalCapacity(self.allocator, WISPTERM_IMAGE_OSC_MAX) catch return false;
    return true;
}

fn replayNonImageOscPrefix(self: *Surface) void {
    self.vt_stream.nextSlice("\x1b]");
    if (self.wispterm_image_osc_buf.items.len > 0) {
        self.vt_stream.nextSlice(self.wispterm_image_osc_buf.items);
        self.wispterm_image_osc_buf.clearRetainingCapacity();
    }
}

/// Called when a complete OSC 7748 agent-state marker has been received.
/// The payload (bytes after "7748;") is in wispterm_agent_osc_buf[0..len].
/// If parseMarker succeeds, the Detection is applied and the heuristic is
/// suppressed. The marker is consumed (not forwarded to the VT).
fn handleWispTermAgentOsc(self: *Surface) void {
    const payload = self.wispterm_agent_osc_buf[0..self.wispterm_agent_osc_buf_len];
    self.wispterm_agent_osc_buf_len = 0;
    if (agent_detector.parseMarkerInfo(payload, self.agent_session_path_buf[0..])) |info| {
        self.agent_detection = info.detection;
        self.agent_capabilities = info.capabilities;
        self.agent_session_path_len = @min(info.session_path.len, self.agent_session_path_buf.len);
        self.agent_osc_active = true;
        if (info.session_path.len > 0) self.agent_transcript.setPath(self.allocator, info.session_path);
        self.publishAgentDetection();
    }
}

fn handleWispTermImageOsc(self: *Surface) void {
    defer self.wispterm_image_osc_buf.clearRetainingCapacity();

    const kitty = self.wispterm_image_osc_buf.items;
    if (std.mem.indexOfScalar(u8, kitty, ';') == null) return;

    const seq = self.allocator.alloc(u8, 3 + kitty.len + 2) catch return;
    defer self.allocator.free(seq);

    seq[0] = 0x1b;
    seq[1] = '_';
    seq[2] = 'G';
    @memcpy(seq[3 .. 3 + kitty.len], kitty);
    seq[3 + kitty.len] = 0x1b;
    seq[4 + kitty.len] = '\\';

    self.vt_stream.nextSlice(seq);
}

/// Scan PTY output for OSC 0/1/2/7 title sequences.
/// Handles sequences split across multiple reads via state machine.
pub fn scanForOscTitle(self: *Surface, data: []const u8) void {
    self.title_osc.feed(data, self, onTitleOscEvent);
}

fn onTitleOscEvent(self: *Surface, event: osc_title.Event) void {
    self.updateTitle(event.text, event.code);
}

/// Update the surface title from an OSC sequence.
/// Like Ghostty, reject titles that aren't valid UTF-8 — this filters out
/// garbage from random byte streams (e.g. cat /dev/urandom) that happen to
/// form accidental OSC sequences.
fn updateTitle(self: *Surface, title: []const u8, osc_num: u8) void {
    if (title.len == 0) return;
    if (!std.unicode.utf8ValidateSlice(title)) return;

    if (osc_num == 7) {
        // OSC 7: file://host/path — extract the path
        self.got_osc7_this_batch = true;
        if (platform_local_path.pathFromFileUri(title)) |raw_path| {
            var native_buf: [512]u8 = undefined;
            const path = if (builtin.os.tag == .windows)
                platform_local_path.forLocalOpen(raw_path, &native_buf) orelse raw_path
            else
                raw_path;

            // Store raw path for CWD inheritance
            const raw_len = @min(path.len, self.cwd_path.len);
            @memcpy(self.cwd_path[0..raw_len], path[0..raw_len]);
            self.cwd_path_len = raw_len;

            // Format for display (with ~ for home)
            const home_prefix = "/home/";
            if (std.mem.startsWith(u8, path, home_prefix)) {
                const after_home = path[home_prefix.len..];
                const user_end = std.mem.indexOfScalar(u8, after_home, '/') orelse after_home.len;
                const home_len = home_prefix.len + user_end;

                const rest = path[home_len..];
                self.osc7_title[0] = '~';
                const rest_len = @min(rest.len, self.osc7_title.len - 1);
                @memcpy(self.osc7_title[1 .. 1 + rest_len], rest[0..rest_len]);
                self.osc7_title_len = 1 + rest_len;
            } else {
                const path_len = @min(path.len, self.osc7_title.len);
                @memcpy(self.osc7_title[0..path_len], path[0..path_len]);
                self.osc7_title_len = path_len;
            }
        }
    } else {
        // OSC 0/1/2 — skip if we already got OSC 7 in this same batch
        if (self.got_osc7_this_batch) return;

        const friendly = platform_pty_command.friendlyShellTitle(title);

        // Accept and clear OSC 7 cache
        self.osc7_title_len = 0;
        const friendly_len = @min(friendly.len, self.window_title.len);
        @memcpy(self.window_title[0..friendly_len], friendly[0..friendly_len]);
        self.window_title_len = friendly_len;
    }
}

test "applyFieldDefaults initializes defaulted fields the constructors never assign" {
    // Mimic what `allocator.create` hands back in a Debug build.
    var surface: Surface = undefined;
    @memset(std.mem.asBytes(&surface), 0xAA);
    applyFieldDefaults(&surface);

    // These four were left as 0xAA garbage by `finishInit`.
    try std.testing.expect(surface.agent_transcript.path == null);
    try std.testing.expect(surface.agent_transcript.json == null);
    try std.testing.expectEqual(agent_detector.State.none, surface.agent_notify_prev_state);
    try std.testing.expectEqual(@as(i64, 0), surface.agent_done_staged_ms);
    try std.testing.expect(!surface.resize_overlay_active);
    try std.testing.expectEqual(@as(u32, 1), surface.ref_count);

    // The crash: closing a tab ran this on an undefined transcript and freed
    // 0xAAAAAAAAAAAAAAAA. On a defaulted one it must be a no-op.
    surface.agent_transcript.deinit(std.testing.allocator);
}

test "Surface exposes init and initVirtual (forces analysis of the shared finishInit refactor)" {
    // Address-of forces full semantic analysis + codegen of both constructors,
    // and therefore of the shared finishInit they call. Without this, an unused
    // initVirtual could carry a refactor bug that the headless suite never sees.
    _ = &init;
    _ = &initVirtual;

    const info = @typeInfo(@TypeOf(initVirtual)).@"fn";
    // allocator, cols, rows, pty, scrollback_limit, cursor_style, cursor_blink
    try std.testing.expectEqual(@as(usize, 7), info.params.len);
    try std.testing.expect(info.params[3].type.? == Pty);
}

// Build just enough of a Surface to drive the VT stream and capture the bytes
// the terminal writes back to the PTY (no real PTY or IO threads).
fn vtResponseHarness(surface: *Surface) !void {
    surface.allocator = std.testing.allocator;
    surface.terminal = try ghostty_vt.Terminal.init(std.testing.allocator, .{
        .cols = 80,
        .rows = 24,
    });
    surface.terminal_theme_colors = TerminalThemeColors.fromTheme(Config.Theme.default());
    surface.mailbox = try termio.Mailbox.init();
    surface.vt_stream = surface.initVtStream();
    surface.io_state_mutex = .{};
    surface.io_state = .running;
    surface.exited = std.atomic.Value(bool).init(false);
}

fn vtResponseHarnessDeinit(surface: *Surface) void {
    surface.vt_stream.deinit();
    surface.mailbox.deinit();
    surface.terminal.deinit(std.testing.allocator);
}

fn expectPtyResponse(surface: *Surface, expected: []const u8) !void {
    // The popped message owns the bytes; assert while it is still in scope so
    // the slice into write_small.data stays valid.
    const msg = surface.mailbox.popWrite() orelse return error.NoPtyResponse;
    switch (msg) {
        .write_small => |*w| try std.testing.expectEqualStrings(expected, w.data[0..w.len]),
        else => return error.UnexpectedMessage,
    }
}

test "kitty keyboard query is answered back to the PTY (issue #302)" {
    var surface: Surface = undefined;
    try vtResponseHarness(&surface);
    defer vtResponseHarnessDeinit(&surface);

    // crossterm/Claude Code probe support with `CSI ? u`. With no flags pushed
    // yet the terminal must report 0 so the app knows the protocol exists.
    surface.vt_stream.nextSlice("\x1b[?u");
    try expectPtyResponse(&surface, "\x1b[?0u");

    // After the app pushes the disambiguate flag, the query reflects it — this
    // is the round-trip that makes the app actually turn the protocol on.
    surface.vt_stream.nextSlice("\x1b[>1u");
    surface.vt_stream.nextSlice("\x1b[?u");
    try expectPtyResponse(&surface, "\x1b[?1u");
}

test "primary device attributes query is answered back to the PTY" {
    var surface: Surface = undefined;
    try vtResponseHarness(&surface);
    defer vtResponseHarnessDeinit(&surface);

    // grok sends `CSI ? u` then `CSI c` and, once the Kitty reply proves the
    // terminal answers queries, waits for DA1 with no timeout. Without this
    // reply it sits on a blank alternate screen forever.
    surface.vt_stream.nextSlice("\x1b[?u\x1b[c");
    try expectPtyResponse(&surface, "\x1b[?0u");
    try expectPtyResponse(&surface, "\x1b[?62;22c");

    // Secondary DA (`CSI > c`) is part of the same probe family and must not
    // stay silent either.
    surface.vt_stream.nextSlice("\x1b[>c");
    const msg = surface.mailbox.popWrite() orelse return error.NoPtyResponse;
    switch (msg) {
        .write_small => |*w| {
            const reply = w.data[0..w.len];
            try std.testing.expect(std.mem.startsWith(u8, reply, "\x1b[>"));
            try std.testing.expect(std.mem.endsWith(u8, reply, "c"));
        },
        else => return error.UnexpectedMessage,
    }
}

test "OSC color queries report the surface's desktop colors to the PTY" {
    var surface: Surface = undefined;
    try vtResponseHarness(&surface);
    defer vtResponseHarnessDeinit(&surface);
    surface.updateTerminalThemeColorsLocked(Config.Theme.parseThemeContent(
        "foreground = #abcdef\nbackground = #234567",
    ));

    // Codex probes both defaults before drawing its composer fill. A
    // compound query advances from foreground (10) to background (11).
    surface.vt_stream.nextSlice("\x1b]10;?;?\x1b\\");
    try expectPtyResponse(&surface, "\x1b]10;rgb:abab/cdcd/efef\x1b\\");
    try expectPtyResponse(&surface, "\x1b]11;rgb:2323/4545/6767\x1b\\");

    surface.vt_stream.nextSlice("\x1b]11;#111213\x07");
    try std.testing.expect(surface.mailbox.popWrite() == null);
    surface.vt_stream.nextSlice("\x1b]11;?\x07");
    try expectPtyResponse(&surface, "\x1b]11;rgb:1111/1212/1313\x07");

    surface.vt_stream.nextSlice("\x1b]111\x07\x1b]11;?\x07");
    try expectPtyResponse(&surface, "\x1b]11;rgb:2323/4545/6767\x07");
}

test "XTVERSION query reports WispTerm and its version" {
    var surface: Surface = undefined;
    try vtResponseHarness(&surface);
    defer vtResponseHarnessDeinit(&surface);

    surface.vt_stream.nextSlice("\x1b[>0q");
    try expectPtyResponse(&surface, "\x1bP>|WispTerm " ++ build_options.app_version ++ "\x1b\\");
}

// queuePtyWrite needs surface.allocator, surface.mailbox, and the IO lifecycle
// state (acceptsInput gates writes), so a tiny harness is enough to exercise its
// outcome contract. io_state must be .running for writes to be accepted.
fn writeOutcomeHarness(surface: *Surface) !void {
    surface.allocator = std.testing.allocator;
    surface.remote_terminal = .{};
    surface.mailbox = try termio.Mailbox.init();
    surface.exited = std.atomic.Value(bool).init(false);
    surface.io_state_mutex = .{};
    surface.io_state = .running;
}

fn writeOutcomeHarnessDeinit(surface: *Surface) void {
    surface.mailbox.deinit();
}

test "queuePtyWrite returns SurfaceExited when the surface stops accepting input" {
    var surface: Surface = undefined;
    try writeOutcomeHarness(&surface);
    defer writeOutcomeHarnessDeinit(&surface);

    surface.io_state = .stopped; // acceptsInput() is true only while .running
    try std.testing.expectError(error.SurfaceExited, surface.queuePtyWrite("hello"));
}

test "queuePtyWrite returns BackpressureTimeout when the payload ring stays full" {
    var surface: Surface = undefined;
    try writeOutcomeHarness(&surface);
    defer writeOutcomeHarnessDeinit(&surface);

    // Saturate the payload ring directly so every queuePtyWrite retry sees a
    // full ring (no writer thread is draining it in this harness).
    while (true) {
        var small: termio.Message.WriteSmall = .{ .len = 1 };
        small.data[0] = 'x';
        if (surface.mailbox.sendWrite(.{ .write_small = small }) == .full) break;
    }

    // The write is neither delivered nor silently dropped — it is reported.
    try std.testing.expectError(error.BackpressureTimeout, surface.queuePtyWrite("y"));

    // The original queued writes are untouched: the full ring evicted nothing.
    var drained: usize = 0;
    while (surface.mailbox.popWrite()) |msg| {
        msg.deinit();
        drained += 1;
    }
    try std.testing.expect(drained > 0);
}

test "queuePtyWrite enqueues a write onto the payload ring on success" {
    var surface: Surface = undefined;
    try writeOutcomeHarness(&surface);
    defer writeOutcomeHarnessDeinit(&surface);

    try surface.queuePtyWrite("ok");

    const msg = surface.mailbox.popWrite() orelse return error.MissingMessage;
    defer msg.deinit();
    switch (msg) {
        .write_small => |*w| try std.testing.expectEqualStrings("ok", w.data[0..w.len]),
        else => return error.UnexpectedMessage,
    }
}

test "native geometry reclaims an unchanged cell grid and drops stale leased input" {
    var surface: Surface = undefined;
    try writeOutcomeHarness(&surface);
    defer writeOutcomeHarnessDeinit(&surface);
    surface.remote_hub = .init(null);
    surface.confirmed_grid = .init(packGrid(.{}));
    surface.size = .{};
    surface.remote_terminal.enabled = true;
    surface.remote_terminal.clock = try std.time.Timer.start();

    var layout: DesktopLayout = .{
        .width = 800,
        .height = 480,
        .cell_width = 10,
        .cell_height = 20,
        .padding = .{},
        .split = .{ 0, 0, 1, 1 },
        .content_size = .{ 800, 480 },
    };
    try std.testing.expect(!surface.setScreenSizeWithPolicy(layout, .coalesced));
    remoteControlRequest(&surface, .{ .client_id = "phone", .action = .acquire });
    const identity: remote_control.Identity = .{ .client_id = "phone", .lease_id = surface.remote_terminal.state.holder.?.id };
    try surface.queueControlledWrite("queued", identity);
    try std.testing.expectError(error.RemoteControlActive, surface.queuePtyWrite("desktop"));
    try std.testing.expect(!surface.setScreenSizeWithPolicy(layout, .coalesced));
    try std.testing.expect(surface.remoteControlActive());

    layout.width += 1;
    try std.testing.expect(!surface.setScreenSizeWithPolicy(layout, .coalesced));
    try std.testing.expect(!surface.remoteControlActive());
    try std.testing.expectError(error.RemoteControlActive, surface.queueControlledWrite("stale", identity));
    const queued = surface.mailbox.popWrite() orelse return error.MissingLeasedWrite;
    defer queued.deinit();
    try std.testing.expect(!surface.admitPtyWrite(queued.write_small.input_epoch));
    try std.testing.expect(surface.prepareResize(.{}) == null);
    try surface.queuePtyWrite("desktop");
}

test "a tab takeover fences both PTY mailboxes and restores each desktop grid on reclaim" {
    const allocator = std.testing.allocator;
    const SplitTree = @import("split_tree.zig");
    const TabControl = @import("appwindow/remote_tab_control.zig").State;
    var a: Surface = undefined;
    try writeOutcomeHarness(&a);
    defer writeOutcomeHarnessDeinit(&a);
    var b: Surface = undefined;
    try writeOutcomeHarness(&b);
    defer writeOutcomeHarnessDeinit(&b);
    const surfaces = [_]*Surface{ &a, &b };
    const desktop_grids = [_]GridSize{ .{ .cols = 88, .rows = 29 }, .{ .cols = 70, .rows = 27 } };

    var hub = RemoteHub.Hub.init(allocator);
    defer hub.deinit();
    for (surfaces, desktop_grids, 1..) |surface, grid, id| {
        surface.remote_terminal.enabled = true;
        surface.remote_terminal.clock = try std.time.Timer.start();
        surface.remote_terminal.state.desktop_grid = grid;
        surface.size = .{};
        surface.ref_count = 1;
        surface.confirmed_grid = .init(packGrid(grid));
        surface.remote_hub = .init(null);
        surface.remote_id = @import("remote_workspace.zig").formatId(id);
        surface.attachRemoteHub(&hub);
    }

    const nodes = [_]SplitTree.Node{
        .{ .split = .{ .layout = .horizontal, .ratio = 0.5, .left = @enumFromInt(1), .right = @enumFromInt(2) } },
        .{ .leaf = .{ .terminal = &a } },
        .{ .leaf = .{ .terminal = &b } },
    };
    var tree = try SplitTree.cloneNodes(allocator, &nodes, null);
    defer tree.deinit();
    var control: TabControl = .{};
    control.setEnabled(&tree, true);
    remoteControlRequest(&a, .{ .client_id = "legacy", .action = .takeover });
    try std.testing.expect(!a.remoteControlActive());
    try std.testing.expectError(error.RemoteControlActive, a.queueControlledWrite("unleased browser input", .{ .client_id = "phone" }));

    var request: remote_control.TabRequest = .{
        .type = "tab-control",
        .tabId = "1000000000000001".*,
        .clientId = "phone",
        .action = .acquire,
    };
    control.request(&tree, &hub, request);
    const old: remote_control.Identity = .{ .client_id = "phone", .lease_id = control.lease.grant.?.id };
    for (surfaces) |surface| {
        try surface.queueControlledWrite("valid", old);
        try std.testing.expectError(error.RemoteControlActive, surface.queuePtyWrite("desktop"));
    }

    const remote_grid: GridSize = .{ .cols = 44, .rows = 15 };
    var grids = [_]remote_control.TabGrid{
        .{ .surfaceId = a.remote_id, .cols = remote_grid.cols, .rows = remote_grid.rows },
        .{ .surfaceId = "000000000000001f".*, .cols = desktop_grids[1].cols, .rows = desktop_grids[1].rows },
    };
    request.action = .resize;
    request.leaseId = old.lease_id;
    request.grids = &grids;
    control.request(&tree, &hub, request);
    try std.testing.expect(a.mailbox.takePendingResize() == null);
    try std.testing.expect(b.mailbox.takePendingResize() == null);

    grids[1].surfaceId = b.remote_id;
    control.request(&tree, &hub, request);
    try std.testing.expectEqual(remote_grid, a.mailbox.takePendingResize().?);
    try std.testing.expect(b.mailbox.takePendingResize() == null);
    // A writer has already confirmed this grid before the next owner arrives.
    a.confirmed_grid.store(packGrid(remote_grid), .release);

    request.action = .takeover;
    request.clientId = "tablet";
    request.leaseId = null;
    request.grids = null;
    control.request(&tree, &hub, request);
    const current: remote_control.Identity = .{ .client_id = "tablet", .lease_id = control.lease.grant.?.id };
    try std.testing.expect(current.lease_id != old.lease_id);
    for (surfaces) |surface| {
        const queued = surface.mailbox.popWrite() orelse return error.MissingLeasedWrite;
        defer queued.deinit();
        try std.testing.expect(!surface.admitPtyWrite(queued.write_small.input_epoch));
        try std.testing.expectError(error.RemoteControlActive, surface.queueControlledWrite("stale", old));
        try surface.queueControlledWrite("current", current);
    }
    try std.testing.expect(a.mailbox.takePendingImmediateResize() == null);

    try std.testing.expect(control.reclaim(&tree, &hub, request.tabId, .desktop, .coalesced));
    for (surfaces) |surface| {
        const queued = surface.mailbox.popWrite() orelse return error.MissingLeasedWrite;
        defer queued.deinit();
        try std.testing.expect(!surface.admitPtyWrite(queued.write_small.input_epoch));
        try std.testing.expectError(error.RemoteControlActive, surface.queueControlledWrite("released", current));
        try surface.queuePtyWrite("desktop");
    }
    try std.testing.expectEqual(desktop_grids[0], a.mailbox.takePendingResize().?);
    try std.testing.expect(b.mailbox.takePendingResize() == null);
}

test "web workspace geometry preserves the lease and only changes the natural grid" {
    var surface: Surface = undefined;
    try writeOutcomeHarness(&surface);
    defer writeOutcomeHarnessDeinit(&surface);
    surface.remote_hub = .init(null);
    surface.confirmed_grid = .init(packGrid(.{}));
    surface.size = .{};
    surface.remote_terminal.enabled = true;
    surface.remote_terminal.clock = try std.time.Timer.start();

    var layout: DesktopLayout = .{
        .width = 800,
        .height = 480,
        .cell_width = 10,
        .cell_height = 20,
        .padding = .{},
        .split = .{ 0, 0, 1, 1 },
        .content_size = .{ 800, 480 },
    };
    _ = surface.setScreenSizeWithPolicy(layout, .immediate);
    remoteControlRequest(&surface, .{ .client_id = "phone", .action = .acquire });

    layout.width = 400;
    layout.split[2] = 0.5;
    surface.setRemoteWorkspaceLayout(layout);
    try std.testing.expectEqual(GridSize{ .cols = 40, .rows = 24 }, surface.desktopGrid());
    try std.testing.expectEqual(GridSize{}, surface.remote_terminal.state.targetGrid());
    try std.testing.expect(surface.mailbox.takePendingImmediateResize() == null);
    _ = surface.setScreenSizeWithPolicy(layout, .immediate);
    try std.testing.expect(surface.remoteControlActive());

    layout.width += 1;
    _ = surface.setScreenSizeWithPolicy(layout, .coalesced);
    try std.testing.expect(!surface.remoteControlActive());
    try std.testing.expectEqual(GridSize{ .cols = 40, .rows = 24 }, surface.mailbox.takePendingResize().?);
}

fn ioStateHarness(surface: *Surface) !void {
    surface.allocator = std.testing.allocator;
    surface.remote_terminal = .{};
    surface.terminal = try ghostty_vt.Terminal.init(std.testing.allocator, .{
        .cols = 80,
        .rows = 24,
    });
    surface.render_state = renderer.State.init(&surface.terminal);
    surface.surface_renderer = Renderer.init(surface);
    surface.io_state_mutex = .{};
    surface.io_state = .running;
    surface.exited = std.atomic.Value(bool).init(false);
    surface.dirty = std.atomic.Value(bool).init(false);
    surface.io_thread_state = null;
    surface.io_writer_thread = null;
    surface.io_reader_thread = null;
}

fn ioStateHarnessDeinit(surface: *Surface) void {
    surface.surface_renderer.deinit();
    surface.terminal.deinit(std.testing.allocator);
}

test "Surface failIo records first failure, wakes rendering, and blocks input" {
    var surface: Surface = undefined;
    try ioStateHarness(&surface);
    defer ioStateHarnessDeinit(&surface);

    try std.testing.expect(surface.acceptsInput());

    surface.failIo(.pty_write, error.BrokenPipe);
    try std.testing.expect(!surface.acceptsInput());
    try std.testing.expect(surface.exited.load(.acquire));
    try std.testing.expect(surface.dirty.load(.acquire));

    switch (surface.currentIoState()) {
        .failed => |failure| {
            try std.testing.expectEqual(Operation.pty_write, failure.operation);
            try std.testing.expectEqual(error.BrokenPipe, failure.error_code);
        },
        else => return error.ExpectedFailedState,
    }

    surface.failIo(.pty_resize, error.ResizeFailed);
    switch (surface.currentIoState()) {
        .failed => |failure| {
            try std.testing.expectEqual(Operation.pty_write, failure.operation);
            try std.testing.expectEqual(error.BrokenPipe, failure.error_code);
        },
        else => return error.ExpectedFailedState,
    }
}

test "Surface markExited preserves a normal exit as non-failure and blocks input" {
    var surface: Surface = undefined;
    try ioStateHarness(&surface);
    defer ioStateHarnessDeinit(&surface);

    surface.markExited(.eof, .{ .exited = 0 });

    try std.testing.expect(!surface.acceptsInput());
    try std.testing.expect(surface.exited.load(.acquire));
    switch (surface.currentIoState()) {
        .exited => |info| {
            try std.testing.expectEqual(ExitReason.eof, info.reason);
            try std.testing.expectEqual(@as(?Command.Exit, .{ .exited = 0 }), info.status);
        },
        else => return error.ExpectedExitedState,
    }
}

test "Surface respawn target stores command and frees it without leaking" {
    var surface: Surface = undefined;
    surface.respawn_command = null;
    surface.respawn_cwd = null;

    // Build a platform CommandLine from utf8 so this compiles on Windows too.
    const owned = try platform_pty_command.allocCommandLineFromUtf8(
        std.testing.allocator,
        "ssh demo@host",
    );
    defer platform_pty_command.freeCommandLine(std.testing.allocator, owned);
    const cmd = platform_pty_command.commandLineFromOwned(owned);

    surface.setRespawnTarget(std.testing.allocator, cmd, null);
    try std.testing.expect(surface.respawn_command != null);
    try std.testing.expect(surface.respawn_cwd == null);

    var disp: [64]u8 = undefined;
    const got = platform_pty_command.commandLineDisplay(
        platform_pty_command.commandLineFromOwned(surface.respawn_command.?),
        &disp,
    );
    try std.testing.expectEqualStrings("ssh demo@host", got);

    // testing.allocator fails the test if freeRespawnTarget leaks or
    // double-frees.
    surface.freeRespawnTarget(std.testing.allocator);
    try std.testing.expect(surface.respawn_command == null);
}

test "respawn is a no-op unless the surface has exited with a stored command" {
    var surface: Surface = undefined;
    try ioStateHarness(&surface);
    defer ioStateHarnessDeinit(&surface);
    surface.respawn_command = null;
    surface.respawn_cwd = null;

    // .running (harness default): guard returns immediately, state unchanged.
    try std.testing.expect(!surface.isExited());
    surface.respawn();
    try std.testing.expect(surface.acceptsInput());

    // .exited but no stored command: returns at the command guard, before any
    // pty/thread work (which would crash on the null-threaded harness).
    surface.markExited(.eof, .{ .exited = 0 });
    try std.testing.expect(surface.isExited());
    surface.respawn();
    try std.testing.expect(surface.isExited());
}

test "exit status message shows the reconnect hint only when asked" {
    var buf: [256]u8 = undefined;
    const state: IoState = .{ .exited = .{
        .reason = .eof,
        .status = .{ .exited = 0 },
        .timestamp_ms = 0,
    } };

    const with_hint = formatIoStatusMessage(&buf, state, true).?;
    try std.testing.expect(std.mem.indexOf(u8, with_hint, "Process exited with code 0") != null);
    try std.testing.expect(std.mem.indexOf(u8, with_hint, "Press Enter to reconnect") != null);

    var buf2: [256]u8 = undefined;
    const no_hint = formatIoStatusMessage(&buf2, state, false).?;
    try std.testing.expect(std.mem.indexOf(u8, no_hint, "Press Enter to reconnect") == null);
}

test "remote image paste queues one bracketed PTY write under the same live lease epoch" {
    var surface: Surface = undefined;
    try writeOutcomeHarness(&surface);
    defer writeOutcomeHarnessDeinit(&surface);
    surface.terminal = try ghostty_vt.Terminal.init(std.testing.allocator, .{ .cols = 80, .rows = 24 });
    defer surface.terminal.deinit(std.testing.allocator);
    surface.render_state = renderer.State.init(&surface.terminal);
    surface.terminal.modes.set(.bracketed_paste, true);
    surface.launch_kind = .wsl;
    surface.remote_hub = .init(null);
    surface.confirmed_grid = .init(packGrid(.{}));
    surface.remote_terminal.enabled = true;
    surface.remote_terminal.clock = try std.time.Timer.start();

    const owner = "f9615093-77ee-4431-bfed-ab436d8510d3";
    var identity: remote_control.Identity = .{ .client_id = owner };
    try std.testing.expect(authorizeRemoteImagePaste(&surface, identity) == .denied);
    var lease: remote_control.TabLease = .{};
    _ = lease.apply(.{
        .type = "tab-control",
        .tabId = "0000000000000001".*,
        .clientId = owner,
        .action = .acquire,
    }, try std.time.Instant.now());
    surface.remote_terminal.state.mirrorTab(true, lease.grant, surface.confirmedGrid());
    identity.lease_id = lease.grant.?.id;
    const paste_text = "\"/mnt/c/Temp folder/wispterm-clipboard-random.png\"";
    const target = authorizeRemoteImagePaste(&surface, identity).accepted;
    try std.testing.expectEqual(.queued, enqueueRemoteImagePaste(&surface, identity, target, paste_text));

    const message = surface.mailbox.popWrite() orelse return error.MissingImagePaste;
    defer message.deinit();
    try std.testing.expectEqualStrings("\x1b[200~" ++ paste_text ++ "\x1b[201~", message.write_small.data[0..message.write_small.len]);
    try std.testing.expect(surface.admitPtyWrite(message.write_small.input_epoch));
    surface.remote_terminal.state.mirrorTab(true, null, surface.confirmedGrid());
    try std.testing.expect(!surface.admitPtyWrite(message.write_small.input_epoch));
    try std.testing.expectEqual(.denied, enqueueRemoteImagePaste(&surface, identity, target, paste_text));
    try std.testing.expect(surface.mailbox.popWrite() == null);
}

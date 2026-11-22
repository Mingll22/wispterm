# WispTerm project instructions

WispTerm is a Zig terminal emulator built on libghostty-vt. Windows is the
primary desktop target. macOS is supported and Linux is experimental.
`remote/` owns the browser console and relay.
For platform support questions, check [known limitations](KNOWN_ISSUES.md)
and the [roadmap](ROADMAP.md).

## Desktop work

- For desktop plans and feature changes, inspect the relevant Ghostty source
  with `gh` and describe its behavior in the design or change notes. Follow
  its config, theme, color, and cursor conventions where applicable. Use the
  [reference map](docs/decoupling-guide.md#7-ghostty-cross-reference) when
  choosing the counterpart and [build.zig.zon](build.zig.zon) when changing
  the pinned VT dependency.
- Before changing a platform seam or adding a host, read the
  [host and capability contracts](docs/architecture.md#the-host-interface-srcplatformwindow_backendzig).
  Keep OS access behind `src/platform/` facades. Keep feature state and behavior
  in their [owning domains](docs/architecture.md#integration-layer-vs-feature-domains)
  when editing AppWindow, input, or the overlay facade.
- When adding or changing a desktop screen, use the
  [three shared UI patterns](docs/architecture.md#desktop-ui-patterns). Every
  overlay or panel input that changes UI state must request a repaint through
  [UiEffect](docs/architecture.md#event-driven-repaint).
- When editing a watched integration or session file, move existing debt to the
  owning layer and lower its matching
  [source guard](docs/decoupling-guide.md#82-the-boundary-guards-srcsource_guards).
  To find a feature owner or move files, consult the
  [source layout guide](docs/source-layout.md).
- When changing a shortcut, synchronize the
  [README shortcut table](README.md#keyboard-shortcuts) and matching startup
  and command palette hints identified in the
  [shortcut guide](docs/development.md#keyboard-shortcut-changes).
- When implementing a plan under `plans/`, follow its agreed scope and get the
  user's consent before deviating. If the work is too large, split it with the user.

## Development and verification

- Target `dev` when integrating changes in this fork. For upstream
  submissions, follow [CONTRIBUTING.md](CONTRIBUTING.md).
- For desktop development, use direct Zig commands in Windows PowerShell.
  Use `zig build` for development and reserve `ReleaseFast` for shipping.
  See [building](docs/development.md#building) for the default target,
  toolchain source, and artifact checks.
- For desktop logic, use `zig build test` in the inner loop and run
  `zig build test-full` before integration. For platform-coupled tests or
  adding tests to the fast suite, read the
  [test scope and target rules](docs/development.md#tests-and-structural-guards).
- For Windows UI behavior, use a real visible app and
  [Win32 automation from PowerShell](docs/development.md#windows-ui-automation).
  For sluggish input, use the [frame probe](docs/development.md#frame-latency-diagnostics).
  For file adds, removals, renames, or moves, run the
  [Windows checkout checks](docs/development.md#windows-checkout-safety).
- For SSH/SCP changes, follow the [Windows OpenSSH rules](docs/development.md#windows-sshscp-compatibility)
  for real-profile verification, independent helper connections, and stderr.
  For configuration changes, use the [config reference](docs/configuration.md)
  for precedence, paths, and hot reload.

## Remote and releases

- For browser or relay work, read the [Remote guide](remote/README.md) for the
  wire protocol and development checks. The Ghostty comparison is waived for
  `remote/`. Follow the existing Remote architecture and the agreed Web and
  mobile behavior.
- Before changing version surfaces, read the
  [desktop release checklist](docs/development.md#version-sources). Change
  [Remote version surfaces](remote/README.md#remote-versions) only when the
  user includes the Web console in the release.

# Source Layout Management

Directory moves are allowed only after a responsibility boundary is already
stable. A move should describe ownership that exists today; it must not be used
as a substitute for splitting responsibilities.

Ghostty is the reference shape for mature terminal-code layout: it keeps root
integration files such as `App.zig`, `Surface.zig`, `input.zig`, `config.zig`,
`renderer.zig`, `pty.zig`, and `termio.zig` at the top, while cohesive domains
live in named directories such as `terminal/`, `renderer/`, `font/`, `input/`,
`config/`, `termio/`, `os/`, and `apprt/`. WispTerm should follow that bias:
move stable feature families into domain directories, but leave root integration
nodes alone until their ownership boundaries have converged.

## Source owners

| Work | Start here |
|---|---|
| Application lifecycle, tabs, splits, config and input | `src/main.zig`, `src/App.zig`, `src/AppWindow.zig`, `src/appwindow/`, `src/input.zig`, `src/input/`, `src/config.zig`, and `src/config_watcher.zig` |
| Terminal state, IO, fonts and rendering | `src/Surface.zig`, `src/termio/`, `src/platform/`, `src/apprt/`, `src/font/`, `src/themes/`, `src/renderer/`, and `shaders/`. See the [host and capability contracts](architecture.md#the-host-interface-srcplatformwindow_backendzig) for dependency direction. |
| Assistant and agents | `src/assistant/` owns conversations, scheduling, queues, and forks. `src/agent/`, `src/agent_tools/`, `src/tools/`, `src/research/`, and `src/ctl/` hold the agent runtime, tool catalog and control socket. `src/terminal_agents/` handles external agents and their sessions. The [vendored detection manifests](../src/terminal_agents/manifests/README.md) describe screen detection and provenance. |
| Desktop features | `src/command/`, `src/recipe/`, `src/preview/`, `src/browser/`, `src/html/`, `src/jupyter/`, `src/skill/`, `src/port_forward/`, `src/ssh/`, `src/tmux/`, `src/file_explorer.zig`, `src/chatops/`, `src/weixin/`, `src/feishu/`, `src/sync/`, and `src/credential/`. `src/assistant/`, `src/conversation_center/`, `src/memory_center/`, and `src/memory_digest/` hold their own state. |
| Remote | `src/remote_client.zig` and `src/appwindow/remote_sync.zig` bridge the desktop. `remote/src/client/` owns the browser, `remote/src/server/` the Node relay, and `remote/src/worker.ts` the Worker relay. See the [Remote guide](../remote/README.md) for protocol and deployment. |
| Build and release | `build.zig` and `build.zig.zon` define build options and dependencies. `pkg/` contains dependency build glue and `vendor/` contains vendored code such as the OpenGL loader. `debug/`, `src/benchmark/`, `packaging/`, and `release-notes/` contain automation, benchmarks, packaging, and release notes. `tools/` contains standalone terminal helpers and `plugins/skills/` contains bundled skills. |
| Documentation and plans | `docs/` contains the website and technical documentation. `docs/superpowers/` contains design specs and implementation plans. `plans/` contains project plans and historical notes. |

## Rules

- One directory PR moves one stable feature family.
- Directory PRs are mechanical: move files, update `@import` paths, update
  tests, docs, and source guards, then format.
- No behavior changes, public type renames, compatibility wrapper files, broad
  `mod.zig` re-export hubs, config changes, or opportunistic refactors.
- Directory names use domain names, not buckets such as `features/`, `services/`,
  `utils/`, or `models/`.
- Keep root integration files at `src/`: `main.zig`, `App.zig`,
  `AppWindow.zig`, `Surface.zig`, `input.zig`, `config.zig`,
  `process_runner.zig`, and `text_search.zig`.
- After every move, old active source imports must be gone and source guards must
  still cover the same boundary.

## Completed Stable Moves

These feature families have already moved into owner directories:

1. external terminal agent sessions -> `src/terminal_agents/sessions/`
2. command modules -> `src/command/`
3. preview modules -> `src/preview/`
4. small browser/html/jupyter families -> `src/browser/`, `src/html/`,
   `src/jupyter/`
5. skill modules -> `src/skill/`
6. port-forward modules -> `src/port_forward/`
7. AI conversation session and helpers -> `src/assistant/conversation/`
8. SSH/SCP helpers -> `src/ssh/`

Do not move `agent/`, overlay-owned SSH profile UI files, or the root integration
files without a separate ownership reason. Directory cleanup must stay
mechanical.

## Guard Checklist

Each directory PR must inspect and update these when paths change:

- `src/source_guards/global_state_guard.zig`
- `src/source_guards/input_feature_boundary_guard.zig`
- `src/source_guards/layered_dependency_guard.zig`
- `src/source_guards/overlay_boundary_guard.zig`
- `src/source_guards/process_runner_guard.zig`
- `src/test_fast.zig`
- `src/test_main.zig`
- `src/shared_compile_test.zig`

Do not raise ceilings. If the actual count drops, lower the ceiling.

## Validation

From Windows PowerShell, format the affected Zig sources and use the
[desktop verification commands](development.md#tests-and-structural-guards):

```powershell
zig build test
zig build test-full
```

Also search for old active paths after each family move. Historical plans may
keep old names, but active source imports must not.

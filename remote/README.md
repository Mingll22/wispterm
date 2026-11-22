# WispTerm Remote Console

Relay server for WispTerm remote access. Provides:

- Single-user login API.
- Signed login cookie.
- Static `xterm.js` browser console.
- WebSocket relay between WispTerm and one or more browsers.
- Browser input forwarding after the session is paired.

The browser mirrors WispTerm tabs and split panels from layout snapshots, then
routes input back to the selected surface.

## Tabs and split panels

On a connected desktop that supports workspace actions, **New tab** opens the
configured default terminal. Use **+** on the selected tab to add a terminal
up to four panes. On a phone, **+** and **Delete tab** are in the top bar.
The **×** in a terminal header closes that pane, and deleting a tab shows how
many terminals it will close. When the desktop requires confirmation for a
running program, close the terminal from WispTerm to review the prompt.

In **Settings → Split layout**, select **Mirror layout** or **Single panel**.
The browser saves the choice separately for desktop and phone widths. In
mirror mode, drag the handle in a pane header onto another pane's center to
swap the two panels, or onto an edge to split there. Aligned dividers move
together. Double-click a divider or press Enter while it is focused to restore
equal halves at every split. Existing shells stay attached to their panes.

## Interface language

The remote console starts in Simplified Chinese for Chinese browser languages and in English otherwise.
After signing in, select **Settings → Language** to choose **English** or **简体中文**. The browser saves the choice locally and refreshes the console, reconnecting with the saved session key if available.

## Deployment Options

Two parallel deployment targets are supported. Pick either one — they share
the same client (`src/client/`), the same routes, and the same on-the-wire
protocol, so the WispTerm client and browser behave identically.

| Option            | Runtime                | TLS / Routing                                        | State                           |
|-------------------|------------------------|------------------------------------------------------|---------------------------------|
| Cloudflare        | Cloudflare Workers     | Cloudflare-managed domain                            | Durable Object per session key  |
| Docker            | Node.js in a container | Platform-managed HTTPS, *or* your own nginx in front | In-memory map per session key   |

Both can be served on the same domain — just point DNS at whichever one you
want active. The Docker variant does **not** persist relay state across
container restarts; the WispTerm client reconnects and re-sends layout, so
this is harmless in practice.

---

## Option A — Cloudflare Workers

Install dependencies:

```powershell
npm install
```

Create a local Wrangler config from the example:

```powershell
Copy-Item .\wrangler.toml.example .\wrangler.toml
```

For deployment to your custom domain, uncomment and set this route in the local
`wrangler.toml`:

```toml
[[routes]]
pattern = "remote.example.com"
custom_domain = true
```

Set Worker secrets:

```powershell
wrangler secret put ADMIN_USERNAME
wrangler secret put ADMIN_PASSWORD_HASH
wrangler secret put SESSION_SIGNING_SECRET
```

`ADMIN_PASSWORD_HASH` currently uses:

```text
sha256:<lowercase-hex-sha256-of-password>
```

On Linux, generate it without adding a newline or losing backslashes:

```bash
IFS= read -r -s -p "Admin password: " PW; echo
printf '%s' "$PW" | sha256sum | awk '{print "sha256:" $1}'
unset PW
```

Build and deploy:

```powershell
npm run build
wrangler deploy
```

---

## Option B — Docker

Same login/relay logic as the Cloudflare Worker, packaged as a Node.js
container. TLS is **not** done in-process — something in front of the
container has to terminate HTTPS.

At runtime the container needs three secrets — same format as the Worker:

| Variable                  | Format / how to generate                                                |
|---------------------------|-------------------------------------------------------------------------|
| `ADMIN_USERNAME`          | plain string                                                            |
| `ADMIN_PASSWORD_HASH`     | `sha256:<hex>` — `printf '%s' "$PW" \| sha256sum`                       |
| `SESSION_SIGNING_SECRET`  | random — `openssl rand -hex 32`                                         |

How those reach the container depends on which sub-path you take.

### B1 — Build locally, push to a registry, host pulls

For container hosts that pull images from Docker Hub / GHCR / etc. and provide
their own HTTPS + port forwarding. The build runs on your machine; the host
only sees the published image.

```bash
# Replace <user>/<image> with your registry path.
docker build -t <user>/wispterm-remote:0.1.0 -t <user>/wispterm-remote:latest .

docker push <user>/wispterm-remote:0.1.0
docker push <user>/wispterm-remote:latest
```

If your host architecture might differ from your build machine, build
multi-arch instead:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t <user>/wispterm-remote:0.1.0 \
  --push .
```

Then in the host's control panel:

- Point the service at `<user>/wispterm-remote:<tag>`.
- Set the env vars from the table above (in the host's secret/env UI — do
  **not** bake them into the image).
- Forward the host's public HTTPS port to container port `8787`.

The image already exposes `8787` and listens on `0.0.0.0`, so no extra
configuration is needed.

### B2 — VPS / self-hosted with docker compose + nginx

For when you run the box yourself. `docker-compose.yml` and
`nginx.conf.example` are wired up for this:

```bash
cp .env.example .env && $EDITOR .env   # fill in the three secrets
docker compose up -d --build           # binds 127.0.0.1:8787
```

Then put nginx in front (see `nginx.conf.example` — covers HTTP→HTTPS
redirect, TLS, and the WebSocket upgrade headers needed for `/ws/*`):

```bash
sudo cp nginx.conf.example /etc/nginx/sites-available/wispterm-remote
sudo $EDITOR /etc/nginx/sites-available/wispterm-remote   # set server_name + cert paths
sudo ln -s /etc/nginx/sites-available/wispterm-remote /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Update with `git pull && docker compose up -d --build`.

### Local development without Docker

```bash
npm install
npm run dev          # static client (Vite, port 5173)
ADMIN_USERNAME=admin \
ADMIN_PASSWORD_HASH=sha256:... \
SESSION_SIGNING_SECRET=$(openssl rand -hex 32) \
REMOTE_COOKIE_SECURE=false \
npm run dev:server   # relay server, port 8787
```

For a local all-in-one mock login, build and run the Node relay with built-in
development credentials:

```bash
npm run dev:mock
# Open http://127.0.0.1:8787
# username: admin
# password: password
```

`dev:mock` only fills missing local environment variables for this command.
Production starts must still provide real `ADMIN_USERNAME`,
`ADMIN_PASSWORD_HASH`, and `SESSION_SIGNING_SECRET` values.

Set `REMOTE_COOKIE_SECURE=false` only for plain-HTTP local testing —
production must keep cookies marked `Secure` and front the server with HTTPS.

---

## Routes (both deployments)

- `GET /` serves the browser app.
- `POST /api/login` signs in the single configured user.
- `POST /api/logout` clears the login cookie.
- `GET /api/me` checks login state.
- `GET /ws/browser?session=<key>` connects the browser after login.
- `GET /ws/wispterm?session=<key>` connects the shared WispTerm RemoteClient.

## Weixin iLink Bridge

The Node.js Remote server can host a Weixin iLink Bot bridge. This is a Node
deployment feature in v1; Cloudflare Worker deployment does not run the Weixin
poller.

Runtime state is stored under `REMOTE_DATA_DIR` (default `./data`):

- `weixin/binding.json` stores the iLink bot token and bound user identifiers.
- `weixin/settings.json` stores bridge enablement and target Remote session.
- `weixin/sync_buf` stores the iLink update cursor.

This Remote server binding is separate from the desktop Zig direct binding
stored in WispTerm's config directory as `weixin.json`; enabling or unbinding
one does not disable or clear the other.

Authenticated routes:

- `GET /api/weixin/settings`
- `PUT /api/weixin/settings`
- `POST /api/weixin/bind/start`
- `GET /api/weixin/bind/status?qrcode=<session>`
- `DELETE /api/weixin/bind`

Send `/ping` from Weixin to confirm that the binding and server reply path are
working; the server replies `pong` without touching AI Chat. Plain Weixin text
is routed to the selected Remote session's AI Chat surface. If that session has
no AI Chat surface, the relay asks WispTerm to open a default Agent tab first;
WispTerm uses the desktop `New Agent` default profile path and reports a setup
message if no AI profile exists. After the prompt is routed to an AI Chat
surface, the server confirms receipt; setup, offline, or timeout errors can be
returned instead. The server checks the AI Chat snapshot at 10, 30, 60, and 120
seconds for progress, and also listens for later AI Chat snapshot updates. Tool
activity returns a still-processing reply; a completed AI answer returns the
latest assistant message. Direct terminal input requires `/term <command>` or
`/keys <text>`.

## Relay Messages

These same messages are also served directly over the local network by the
desktop app's `WISP2` channel (no relay, no WebSocket); the handshake and
framing are documented in
[`docs/configuration.md` → LAN direct protocol](../docs/configuration.md#lan-direct-protocol).

The WispTerm client sends PTY bytes as:

```json
{ "type": "output-bytes", "surfaceId": "0000000000000001", "encoding": "hex", "data": "..." }
```

WispTerm also sends layout snapshots so the browser can render tabs and split
panels separately. Each surface may include a snapshot of its screen plus recent
scrollback (up to 10,000 history rows), so a newly opened browser can show the
latest terminal content and scroll back through it. Terminal snapshots preserve
VT cell colors and input modes when the browser first connects:

```json
{ "type": "layout", "activeTab": 0, "tabs": [{ "surfaces": [{ "cols": 120, "rows": 32, "cursorX": 0, "cursorY": 31, "snapshot": "..." }] }] }
```

Browser input is routed back to the selected surface:

```json
{ "type": "input-bytes", "surfaceId": "0000000000000001", "encoding": "hex", "data": "0d" }
```

### Responsive terminal control

When the desktop advertises `tabControl: true`, an editable terminal tab has
one 60-second lease for all its panes. A foreground browser requests the selected
tab with `tab-control`, renews it once every 20 seconds, and sends the measured
rows and columns of the visible panes when they change. A single-pane view
measures the displayed pane while the same lease covers the rest of the tab.

A second browser can view the tab and explicitly choose **Take control** to
take over the whole group. Switching tabs, choosing **Release**, or letting the
lease expire restores the desktop grids. Desktop window or split changes
reclaim the affected tab immediately. The desktop applies PTY resizes only when
the effective grid changes and sends the new grid in order with terminal output.
Older desktops and terminals outside an editable group can still advertise
per-pane control through `terminalControl: true`.

Use the current tab actions in the selected sidebar row, collapsed desktop
rail, or mobile toolbar to add a pane, delete the tab, or transfer control.
The mouse wheel or a vertical touch swipe scrolls the terminal's history.
Mirrored splits highlight the pane selected for interaction.

### Workspace actions

Desktop layouts advertise `workspaceActions: true`. Editable terminal tabs
include a stable `tabId`, `layoutRevision` and `splitTree`. The tree is in
preorder, with `{ "surfaceId": "…" }` leaves and `{ "axis": "x", "ratio": 0.5 }`
branch nodes followed by both children. The `x` axis splits left/right and `y`
splits top/bottom.

An authenticated, paired browser submits `workspace-action` with a `requestId`
and one of `create-tab`, `add-pane`, `close-pane`, `close-tab`, or `set-layout`.
Tab actions include the published `tabId` and `layoutRevision`. A group under
tab control also requires the current `leaseId` for these changes. Pane actions
also provide a stable `surfaceId`, and `set-layout` carries the new tree for
the same terminals. The desktop rejects outdated revisions and checks the
target before applying a change. The relay routes `workspace-action-result`
to the requester; the resulting layout arrives in the shared desktop snapshot.

The relay can also ask WispTerm to create an Agent tab when Weixin input has no
AI Chat target:

```json
{ "type": "open-ai-agent", "requestId": "weixin-ai-1" }
```

WispTerm replies with the matching request id and a status of `opened`,
`no-profile`, or `failed`:

```json
{ "type": "open-ai-agent-result", "requestId": "weixin-ai-1", "status": "opened" }
```

The browser also accepts the older mock format:

```json
{ "type": "output", "data": "hello from mock WispTerm\r\n" }
```

## Security Notes

- Do not commit Worker secrets or the Docker `.env` file.
- Do not load third-party browser scripts into the console page.
- Replace the Phase 1 password hash format with a slow KDF before production.
- Add WispTerm device challenge/response before trusting `/ws/wispterm`.
- The Docker container speaks plain HTTP — never expose its port to the public
  internet directly. Always front it with a TLS terminator (your platform's
  proxy, or your own nginx) so browsers see HTTPS and the `Secure` cookie flag
  is honored.

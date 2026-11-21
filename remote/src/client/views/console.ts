import { getLocale, isRemoteLocale, setLocale, tr } from "../i18n";
import type { ConnectionStatus, LayoutSurface, MobileInputMode, MobileVisualZoom } from "../types";
import { iconClose, iconMenu, themeToggleMarkup } from "../icons";
import { bindThemeToggleButtons } from "../theme";
import { activeSurfaceIdForInput, currentTab, state } from "../state";
import {
  clearSessionKey,
  maskSessionKey,
  readSavedSessionKey,
  saveDesktopPanelMode,
  saveMobileVisualZoom,
  saveSidebarCollapsed,
} from "../storage";
import { escapeText, shortSurfaceId } from "../utils";
import { api, connect, disconnect } from "../transport";
import { webVersionLabel } from "../version";
import {
  disposeSurfaceViews,
  focusAndFitSelectedSurface,
  refitAllSurfaces,
  renderRemotePanels,
  syncSurfaceVisualZooms,
  syncTerminalNativeInputGuards,
  updateAiChatControls,
  updateSurfaceCursors,
} from "../surfaces";
import { applyVisualViewportSizing, isMobileRemoteShell, MOBILE_REMOTE_MEDIA_QUERY } from "../mobile_layout";
import {
  bindMobileTextInput,
  blurMobileTextInput,
  focusMobileTextInput,
  renderMobileTextInputMarkup,
} from "../mobile_text_input";
import { bindVirtualKeyboard, renderVirtualKeyboardMarkup, syncVirtualKeyboardInputMode } from "../vkbd";
import { MOBILE_VISUAL_ZOOM_LEVELS, mobileVisualZoomLabel } from "../mobile_visual_zoom";
import { selectedMobileSurfaceKind, shouldShowMobileVirtualKeyboard } from "../mobile_surface_mode";
import { remoteTabSelectionSidebarAction } from "../sidebar_behavior";
import {
  bindActionText,
  bridgeStatusText,
  fetchWeixinSettings,
  normalizeWeixinSettings,
  pollWeixinBindStatus,
  saveWeixinSettings,
  startWeixinBind,
  unbindWeixin,
  weixinBindStatusText,
  weixinErrorText,
  type WeixinSettingsResponse,
} from "../weixin";
import { connectionStatusOffline } from "../connection_status";

let viewportRefitBound = false;
let mobileSurfaceSelectorObserver: ResizeObserver | null = null;
let mobileSurfaceSelectorResizeBound = false;
let mobileSurfaceSelectorCollapseQueued = false;
let weixinBindTimer: ReturnType<typeof setTimeout> | null = null;
let weixinBindGeneration = 0;
let weixinState: WeixinSettingsResponse | null = null;
type SidebarPage = "tabs" | "dashboard" | "settings";
let sidebarPage: SidebarPage = "tabs";
const LANGUAGE_SETTINGS_RETURN_KEY = "wispterm.remote.languageSettingsReturn";
let currentConnectionStatus: ConnectionStatus = connectionStatusOffline(tr("Offline", "未连接"));
let statusLatencyHideTimer: ReturnType<typeof setTimeout> | null = null;

export function renderConsole(app: HTMLElement, onLogout: () => void): void {
  cleanupWeixinPanel();
  const returnToLanguageSettings = consumeLanguageSettingsReturn();
  if (returnToLanguageSettings) sidebarPage = "settings";

  const savedSessionKey = readSavedSessionKey();
  const hasSavedSessionKey = savedSessionKey.length > 0;
  let sessionKeyMasked = hasSavedSessionKey;
  const initialSessionInputValue = hasSavedSessionKey ? maskSessionKey(savedSessionKey) : savedSessionKey;

  app.innerHTML = `
    <section class="console-shell" data-kbd-visible="${state.kbdVisible}" data-mobile-surface-kind="none" data-mobile-vkbd-visible="false" data-mobile-input-mode="${state.mobileInputMode}" data-drawer-open="${state.drawerOpen}" data-sidebar-collapsed="${state.sidebarCollapsed}" data-desktop-panel-mode="${state.desktopPanelMode}" data-sidebar-page="${sidebarPage}">
      <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
      <aside class="sidebar glass-surface" id="sidebar">
        <div class="sidebar-main">
          <div class="sidebar-head">
            <span class="sidebar-wordmark">WispTerm</span>
            <div class="sidebar-head-actions">
              <span class="status-pip sidebar-status" id="sidebar-workspace-status" data-state="offline">${tr("Offline", "未连接")}</span>
              <button type="button" class="icon-button" id="drawer-close" aria-label="${tr("Close menu", "关闭菜单")}" title="${tr("Close menu", "关闭菜单")}">
                ${iconClose()}
              </button>
            </div>
          </div>

          <nav class="sidebar-page-nav" aria-label="${tr("Remote sidebar pages", "远程侧栏导航")}">
            <button type="button" class="sidebar-page-button${sidebarPage === "tabs" ? " active" : ""}" data-sidebar-page-target="tabs">${tr("Tabs", "标签页")}</button>
            <button type="button" class="sidebar-page-button${sidebarPage === "dashboard" ? " active" : ""}" data-sidebar-page-target="dashboard">${tr("Connect", "连接")}</button>
            <button type="button" class="sidebar-page-button${sidebarPage === "settings" ? " active" : ""}" data-sidebar-page-target="settings">${tr("Settings", "设置")}</button>
          </nav>

          <div class="sidebar-page${sidebarPage === "tabs" ? " active" : ""}" data-sidebar-page="tabs">
            <div id="remote-tabs" class="remote-tabs empty">${tr("Connect WispTerm to see its tabs", "连接桌面端后显示标签页")}</div>
          </div>

          <div class="sidebar-page${sidebarPage === "dashboard" ? " active" : ""}" data-sidebar-page="dashboard">
            <div class="status-panel dashboard-status">
              <button type="button" class="status-dot" id="status-dot" data-state="offline" aria-label="${tr("Not connected. Latency unavailable", "未连接，暂无延迟数据")}" title="${tr("Not connected. Latency unavailable", "未连接，暂无延迟数据")}"></button>
              <span id="status-text" aria-live="polite">${tr("Offline", "未连接")}</span>
              <span class="status-latency-detail" id="status-latency-detail" hidden>${tr("Latency unavailable", "暂无延迟数据")}</span>
            </div>
            <form id="connect-form" class="connect-panel">
              <label for="session-key">${tr("Session key", "会话密钥")}</label>
              <input id="session-key" name="session" type="password" spellcheck="false" autocomplete="off" value="${escapeText(initialSessionInputValue)}" required />
              <div class="form-actions connect-actions">
                <button type="submit">${tr("Connect", "连接")}</button>
                <button type="button" class="secondary-button" id="clear-session-button" ${hasSavedSessionKey ? "" : "hidden"}>${tr("Forget key", "断开并忘记")}</button>
              </div>
            </form>
            <details class="settings-group connection-health">
              <summary>${tr("Connection status", "运行状态")}</summary>
              <dl class="connection-health-rows" aria-live="polite">
                <div>
                  <dt>${tr("Relay", "中继")}</dt>
                  <dd id="relay-status"></dd>
                </div>
                <div>
                  <dt>${tr("Desktop", "桌面端")}</dt>
                  <dd id="desktop-status"></dd>
                </div>
              </dl>
            </details>
          </div>

          <div class="sidebar-page settings-page${sidebarPage === "settings" ? " active" : ""}" data-sidebar-page="settings">
          <div class="sidebar-section settings-section">
            <div class="panel language-panel">
              <fieldset id="remote-language" class="setting-options" aria-describedby="language-error">
                <legend>${tr("Language", "语言")}</legend>
                <label>
                  <input type="radio" name="remote-language" value="en"${getLocale() === "en" ? " checked" : ""} />
                  <span lang="en">English</span>
                </label>
                <label>
                  <input type="radio" name="remote-language" value="zh-CN"${getLocale() === "zh-CN" ? " checked" : ""} />
                  <span lang="zh-CN">简体中文</span>
                </label>
              </fieldset>
              <output class="language-error" id="language-error" aria-live="polite"></output>
            </div>
            <div class="panel" id="desktop-panel-mode">
              <fieldset class="setting-options">
                <legend>${tr("Desktop layout", "桌面布局")}</legend>
                <label>
                  <input type="radio" name="desktop-layout" value="layout"${state.desktopPanelMode === "layout" ? " checked" : ""} />
                  <span>${tr("Mirror layout", "镜像布局")}</span>
                </label>
                <label>
                  <input type="radio" name="desktop-layout" value="single"${state.desktopPanelMode === "single" ? " checked" : ""} />
                  <span>${tr("Single panel", "单面板")}</span>
                </label>
              </fieldset>
            </div>
            <div class="panel mobile-terminal-scale">
              <fieldset id="mobile-terminal-scale" class="setting-options">
                <legend>${tr("Terminal display scale", "终端显示缩放")}</legend>
                ${MOBILE_VISUAL_ZOOM_LEVELS.map((zoom) => `
                  <label>
                    <input type="radio" name="mobile-terminal-scale" value="${zoom}"${state.mobileVisualZoom === zoom ? " checked" : ""} />
                    <span>${mobileVisualZoomLabel(zoom)}</span>
                  </label>`).join("")}
              </fieldset>
            </div>
            <details class="settings-group">
              <summary>${tr("Weixin Direct", "微信直连")}</summary>
              <div class="panel weixin-panel" id="weixin-panel">
                <div class="weixin-head">
                  <div class="panel-label">${tr("Weixin Direct", "微信直连")}</div>
                  <span id="weixin-state-pill" class="weixin-state-pill" data-state="loading">${tr("Loading", "加载中")}</span>
                </div>
                <div id="weixin-status" class="weixin-status">${tr("Loading...", "加载中…")}</div>
                <label class="weixin-switch">
                  <span class="weixin-switch-copy">
                    <strong>${tr("Enable Weixin Direct", "启用微信直连")}</strong>
                    <small id="weixin-enabled-copy">${tr("Off", "关闭")}</small>
                  </span>
                  <input id="weixin-enabled" type="checkbox" />
                  <span class="weixin-switch-track" aria-hidden="true"></span>
                </label>
                <label>
                  ${tr("Target session", "目标会话")}
                  <select id="weixin-target-session"></select>
                </label>
                <div class="form-actions">
                  <button type="button" class="secondary-button" id="weixin-save">${tr("Save", "保存")}</button>
                  <button type="button" class="secondary-button weixin-bind-toggle" id="weixin-bind-toggle" data-mode="bind">${tr("Bind", "绑定")}</button>
                </div>
                <div id="weixin-qr" class="weixin-qr" hidden></div>
              </div>
            </details>
            <div class="settings-version">${escapeText(webVersionLabel())}</div>
          </div>
          </div>
        </div>

        <div class="sidebar-footer">
          <div class="sidebar-footer-actions">
            ${themeToggleMarkup("sidebar-footer-theme")}
            <button class="ghost-button" id="logout-button">${tr("Sign out", "退出登录")}</button>
          </div>
        </div>
      </aside>
      <div class="collapsed-controls">
        <button type="button" class="icon-button desktop-sidebar-toggle glass-surface" id="sidebar-expand" aria-label="${tr("Open sidebar", "打开侧栏")}" title="${tr("Open sidebar", "打开侧栏")}" aria-controls="sidebar" aria-expanded="${!state.sidebarCollapsed}">
          ${iconMenu()}
        </button>
        <span class="status-pip workspace-status glass-surface" id="workspace-status" data-state="offline">${tr("Offline", "未连接")}</span>
        ${themeToggleMarkup("collapsed-theme glass-surface")}
      </div>
      <section class="workspace">
        <header class="mobile-bar glass-surface">
          <button type="button" class="icon-button" id="drawer-open" aria-label="${tr("Open menu", "打开菜单")}" aria-controls="sidebar" aria-expanded="${state.drawerOpen}">
            ${iconMenu()}
          </button>
          <div class="mobile-bar-main">
            <span class="mobile-bar-title" id="mobile-workspace-title">${tr("Remote terminal", "远程终端")}</span>
            <div class="mobile-surface-selector" id="mobile-surface-selector" data-collapsed="false" data-open="false" hidden>
              <div class="mobile-surface-strip" id="mobile-surface-strip" aria-label="${tr("Surfaces", "面板")}"></div>
              <button type="button" class="mobile-surface-menu-toggle" id="mobile-surface-menu-toggle" aria-expanded="false" aria-controls="mobile-surface-menu"></button>
              <div class="mobile-surface-menu" id="mobile-surface-menu" hidden></div>
            </div>
          </div>
          <div class="mobile-chrome-controls">
            <div class="mobile-connection">
              <button type="button" class="status-pip" id="mobile-status-pip" data-state="offline" aria-label="${tr("Not connected. Latency unavailable", "未连接，暂无延迟数据")}" title="${tr("Not connected. Latency unavailable", "未连接，暂无延迟数据")}">${tr("Offline", "未连接")}</button>
              <span class="status-latency-popover" id="mobile-status-latency" hidden aria-live="polite">${tr("Latency unavailable", "暂无延迟数据")}</span>
            </div>
            <div class="mobile-terminal-actions" role="group" aria-label="${tr("Terminal input controls", "终端输入控制")}">
              <button type="button" class="mobile-input-mode-toggle" id="mobile-input-mode-toggle" data-mode="${state.mobileInputMode}" aria-label="${mobileInputModeToggleLabel(state.mobileInputMode)}" title="${mobileInputModeToggleLabel(state.mobileInputMode)}">
                ${mobileInputModeLabel(state.mobileInputMode)}
              </button>
              <button type="button" class="mobile-keyboard-toggle" id="kbd-toggle" aria-pressed="${state.kbdVisible}" aria-label="${tr("Toggle shortcut keyboard", "切换快捷键键盘")}" title="${tr("Toggle shortcut keyboard", "切换快捷键键盘")}">
                ${tr("Keys", "快捷键")}
              </button>
            </div>
          </div>
        </header>
        <div class="desktop-dock">
          <span id="workspace-title">${tr("Remote workspace", "远程工作区")}</span>
          <div class="surface-strip" id="surface-strip"></div>
          <span class="control-state" id="control-state" hidden>${tr("Read only", "只读")}</span>
        </div>
        <section class="terminal-panel">
          <div id="remote-panels" class="panels-stage empty"></div>
          <div class="connection-empty" id="connection-empty">
            <div class="connection-empty-content">
              <h2 id="connection-empty-title">${tr("Connect WispTerm", "连接桌面终端")}</h2>
              <p id="connection-empty-help">${tr("Use the session key from the WispTerm desktop app.", "使用桌面端 WispTerm 的会话密钥。")}</p>
              <button type="button" id="open-connection">${tr("Open connection", "打开连接")}</button>
            </div>
          </div>
        </section>
      </section>
      ${renderVirtualKeyboardMarkup()}
      ${renderMobileTextInputMarkup()}
    </section>
  `;

  document.querySelector<HTMLButtonElement>("#logout-button")?.addEventListener("click", async () => {
    cleanupWeixinPanel();
    await api("/api/logout", { method: "POST" });
    disconnect();
    disposeSurfaceViews();
    onLogout();
  });

  document.querySelector<HTMLFormElement>("#connect-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const typedValue = String(data.get("session") ?? "").trim();
    const sessionKey = sessionKeyMasked ? readSavedSessionKey() : typedValue;
    if (!sessionKey) return;
    connect(sessionKey);
    form.querySelector<HTMLInputElement>("input[name='session']")?.blur();
    if (sessionInput) sessionInput.value = maskSessionKey(sessionKey);
    sessionKeyMasked = true;
    if (clearSessionButton) clearSessionButton.hidden = false;
    setDrawerOpen(false);
  });

  const sessionInput = document.querySelector<HTMLInputElement>("#connect-form input[name='session']");
  const revealSessionInput = (): void => {
    if (!sessionKeyMasked || !sessionInput) return;
    sessionKeyMasked = false;
    sessionInput.value = "";
  };
  sessionInput?.addEventListener("focus", revealSessionInput);
  sessionInput?.addEventListener("pointerdown", revealSessionInput);
  const clearSessionButton = document.querySelector<HTMLButtonElement>("#clear-session-button");
  clearSessionButton?.addEventListener("click", () => {
    clearSessionKey();
    sessionKeyMasked = false;
    if (sessionInput) sessionInput.value = "";
    disconnect();
    state.layoutState = null;
    state.selectedSurfaceId = null;
    disposeSurfaceViews();
    renderRemoteWorkspace();
    clearSessionButton.hidden = true;
    sessionInput?.focus();
  });

  document.querySelector<HTMLButtonElement>("#open-connection")?.addEventListener("click", () => {
    setSidebarPage("dashboard");
    if (isMobileRemoteShell()) setDrawerOpen(true);
    else setSidebarCollapsed(false);
    document.querySelector<HTMLButtonElement>('[data-sidebar-page-target="dashboard"]')?.focus();
  });

  bindMobileChrome();
  document.querySelector("#mobile-terminal-scale")?.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const zoom = MOBILE_VISUAL_ZOOM_LEVELS.find((level) => String(level) === input.value);
    if (zoom !== undefined) setMobileVisualZoom(zoom);
  });
  bindViewportRefit();
  bindVirtualKeyboard(() => setKbdVisible(false));
  bindMobileTextInput();
  bindThemeToggleButtons();
  bindSidebarPages();
  setSidebarPage(sidebarPage);
  bindLocalePicker();
  if (returnToLanguageSettings) {
    setSidebarPage("settings");
    if (isMobileRemoteShell()) setDrawerOpen(true);
    else setSidebarCollapsed(false);
    document.querySelector<HTMLInputElement>("#remote-language input:checked")?.focus();
  }
  bindDesktopPanelMode();
  bindWeixinPanel();
  bindStatusLatencyDisclosure();
  setStatus(currentConnectionStatus);
  updateMobileSurfaceMode();
  syncMobileInputModeUi();
  syncMobileTextInputFocusForMode();
  updateInputUi();
  if (savedSessionKey) queueMicrotask(() => connect(savedSessionKey));
}

export function setStatus(status: ConnectionStatus): void {
  currentConnectionStatus = status;
  const dot = document.querySelector<HTMLButtonElement>("#status-dot");
  const label = document.querySelector<HTMLSpanElement>("#status-text");
  const accessibilityText = `${status.text}。 ${status.detail}`;
  const shortLabel =
    status.kind === "online" ? tr("Online", "已连接") :
    status.kind === "high-latency" ? tr("Slow", "高延迟") :
    status.kind === "connecting" ? tr("Linking", "连接中") : tr("Offline", "未连接");
  if (dot) {
    dot.dataset.state = status.kind;
    dot.title = accessibilityText;
    dot.setAttribute("aria-label", accessibilityText);
  }
  if (label) label.textContent = status.text;
  document.querySelectorAll<HTMLElement>("#mobile-status-pip, #workspace-status, #sidebar-workspace-status").forEach((pip) => {
    pip.dataset.state = status.kind;
    pip.textContent = shortLabel;
    pip.title = accessibilityText;
    pip.setAttribute("aria-label", accessibilityText);
  });
  renderConnectionLink("#relay-status", status.relay);
  renderConnectionLink("#desktop-status", status.desktop);
  renderConnectionEmpty();
  syncVisibleStatusLatencyDisclosure();
}

function renderConnectionLink(
  selector: string,
  state: ConnectionStatus["relay"] | ConnectionStatus["desktop"],
): void {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element || element.dataset.state === state) return;
  const labels = {
    online: tr("Connected", "已连接"),
    offline: tr("Not connected", "未连接"),
    connecting: tr("Connecting", "连接中"),
    unknown: tr("Unknown", "未确认"),
  };
  element.dataset.state = state;
  element.textContent = labels[state];
}

export function renderRemoteTabs(): void {
  const tabsRoot = document.querySelector<HTMLDivElement>("#remote-tabs");
  if (!tabsRoot) return;

  const layout = state.layoutState;
  if (!layout || layout.tabs.length === 0) {
    tabsRoot.className = "remote-tabs empty";
    tabsRoot.textContent = tr("Connect WispTerm to see its tabs", "连接桌面端后显示标签页");
    return;
  }

  if (tabsRoot.classList.contains("empty")) tabsRoot.replaceChildren();
  tabsRoot.className = "remote-tabs";
  const existing = new Map(
    Array.from(tabsRoot.querySelectorAll<HTMLButtonElement>("[data-tab-index]"))
      .map((button) => [Number(button.dataset.tabIndex), button]),
  );

  layout.tabs.forEach((tab, position) => {
    let button = existing.get(tab.index);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "tab-chip";
      button.dataset.tabIndex = String(tab.index);
      button.innerHTML = '<span class="tab-chip-label"></span><span class="tab-chip-count"></span>';
      button.addEventListener("click", () => {
        state.selectedTabIndex = tab.index;
        const activeTab = currentTab();
        state.selectedSurfaceId =
          activeTab?.focusedSurfaceId ?? activeTab?.surfaces[0]?.id ?? state.selectedSurfaceId;
        renderRemoteWorkspace();
        applyRemoteTabSelectionSidebarAction();
      });
    }
    existing.delete(tab.index);

    const active = tab.index === state.selectedTabIndex;
    const title = tab.title || tr(`Tab ${tab.index + 1}`, `标签页 ${tab.index + 1}`);
    const count = tab.surfaces.length;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.title = title;
    const label = button.querySelector<HTMLElement>(".tab-chip-label");
    if (label && label.textContent !== title) label.textContent = title;
    const countLabel = button.querySelector<HTMLElement>(".tab-chip-count");
    if (countLabel) {
      countLabel.hidden = count <= 1;
      countLabel.title = tr("Panels", "面板数量");
      if (countLabel.textContent !== String(count)) countLabel.textContent = String(count);
    }
    const before = tabsRoot.children[position] ?? null;
    if (before !== button) tabsRoot.insertBefore(button, before);
  });
  for (const button of existing.values()) button.remove();
}

function applyRemoteTabSelectionSidebarAction(): void {
  const action = remoteTabSelectionSidebarAction(isMobileRemoteShell());
  if (action === "close-drawer") setDrawerOpen(false);
}

export function renderRemoteWorkspace(): void {
  renderRemoteTabs();
  renderRemotePanels();
  renderSurfaceStrip();
  updateMobileSurfaceMode();
  updateInputUi();
}

function renderSurfaceStrip(): void {
  const strip = document.querySelector<HTMLDivElement>("#surface-strip");
  const tab = currentTab();
  const surfaces = tab?.surfaces ?? [];
  renderDesktopSurfaceStrip(strip, surfaces);
  renderMobileSurfaceSelector(surfaces);
}

function renderDesktopSurfaceStrip(strip: HTMLDivElement | null, surfaces: LayoutSurface[]): void {
  if (!strip) return;
  if (surfaces.length <= 1) {
    strip.replaceChildren();
    return;
  }
  strip.innerHTML = surfaces
    .map((surface) => {
      const active = surface.id === state.selectedSurfaceId ? " active" : "";
      const label = escapeText(surface.title || shortSurfaceId(surface.id));
      return `<button type="button" class="surface-chip${active}" data-surface-id="${escapeText(surface.id)}">${label}</button>`;
    })
    .join("");
  bindSurfaceButtons(strip);
}

function renderMobileSurfaceSelector(surfaces: LayoutSurface[]): void {
  const selector = document.querySelector<HTMLDivElement>("#mobile-surface-selector");
  const strip = document.querySelector<HTMLDivElement>("#mobile-surface-strip");
  const toggle = document.querySelector<HTMLButtonElement>("#mobile-surface-menu-toggle");
  const menu = document.querySelector<HTMLDivElement>("#mobile-surface-menu");
  if (!selector || !strip || !toggle || !menu) return;

  if (surfaces.length <= 1) {
    selector.hidden = true;
    selector.dataset.open = "false";
    selector.dataset.collapsed = "false";
    strip.replaceChildren();
    menu.replaceChildren();
    menu.hidden = true;
    toggle.textContent = "";
    toggle.setAttribute("aria-expanded", "false");
    return;
  }

  selector.hidden = false;
  const activeSurface =
    surfaces.find((surface) => surface.id === state.selectedSurfaceId) ?? surfaces[0] ?? null;
  const activeLabel = activeSurface ? activeSurface.title || shortSurfaceId(activeSurface.id) : tr("Surfaces", "面板");
  const activeLabelEscaped = escapeText(activeLabel);

  strip.innerHTML = surfaces
    .map((surface) => {
      const active = surface.id === state.selectedSurfaceId ? " active" : "";
      const label = escapeText(surface.title || shortSurfaceId(surface.id));
      return `<button type="button" class="surface-chip mobile-surface-chip${active}" data-surface-id="${escapeText(surface.id)}">${label}</button>`;
    })
    .join("");
  menu.innerHTML = surfaces
    .map((surface) => {
      const active = surface.id === state.selectedSurfaceId ? " active" : "";
      const label = escapeText(surface.title || shortSurfaceId(surface.id));
      return `<button type="button" class="mobile-surface-menu-item${active}" data-surface-id="${escapeText(surface.id)}">${label}</button>`;
    })
    .join("");
  toggle.innerHTML = `<span>${activeLabelEscaped}</span><span aria-hidden="true">▾</span>`;
  toggle.setAttribute("aria-label", tr(`Select panel. Current panel: ${activeLabel}`, `选择面板，当前为 ${activeLabel}`));
  toggle.onclick = () => {
    const open = selector.dataset.open === "true";
    setMobileSurfaceMenuOpen(!open);
  };

  bindSurfaceButtons(strip);
  bindSurfaceButtons(menu);
  queueMobileSurfaceSelectorCollapse();
}

function bindSurfaceButtons(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("[data-surface-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedSurfaceId = button.dataset.surfaceId ?? state.selectedSurfaceId;
      setMobileSurfaceMenuOpen(false);
      renderRemoteWorkspace();
      focusAndFitSelectedSurface();
    });
  });
}

function setMobileSurfaceMenuOpen(open: boolean): void {
  const selector = document.querySelector<HTMLDivElement>("#mobile-surface-selector");
  const toggle = document.querySelector<HTMLButtonElement>("#mobile-surface-menu-toggle");
  const menu = document.querySelector<HTMLDivElement>("#mobile-surface-menu");
  if (!selector || !toggle || !menu) return;
  const nextOpen = open && selector.dataset.collapsed === "true" && !selector.hidden;
  selector.dataset.open = String(nextOpen);
  toggle.setAttribute("aria-expanded", String(nextOpen));
  menu.hidden = !nextOpen;
}

function queueMobileSurfaceSelectorCollapse(): void {
  if (mobileSurfaceSelectorCollapseQueued) return;
  mobileSurfaceSelectorCollapseQueued = true;
  requestAnimationFrame(() => {
    mobileSurfaceSelectorCollapseQueued = false;
    syncMobileSurfaceSelectorCollapse();
  });
}

function syncMobileSurfaceSelectorCollapse(): void {
  const selector = document.querySelector<HTMLDivElement>("#mobile-surface-selector");
  const strip = document.querySelector<HTMLDivElement>("#mobile-surface-strip");
  if (!selector || !strip || selector.hidden) {
    setMobileSurfaceMenuOpen(false);
    return;
  }

  const menuWasOpen = selector.dataset.open === "true";
  selector.dataset.collapsed = "false";
  const shouldCollapse = strip.scrollWidth > strip.clientWidth + 1;
  selector.dataset.collapsed = String(shouldCollapse);

  if (!shouldCollapse) {
    setMobileSurfaceMenuOpen(false);
  } else if (menuWasOpen) {
    setMobileSurfaceMenuOpen(true);
  }
}

export function updateInputUi(): void {
  const connected = state.socket?.readyState === WebSocket.OPEN;
  const tab = currentTab();
  const selectedSurfaceId = state.selectedSurfaceId ?? tab?.surfaces[0]?.id ?? null;
  const selectedSurface = tab?.surfaces.find((surface) => surface.id === selectedSurfaceId);
  const writable = connected && (Boolean(activeSurfaceIdForInput()) || selectedSurface?.kind === "ai_chat");
  const label = document.querySelector<HTMLSpanElement>("#control-state");
  if (label) label.hidden = !connected || !selectedSurface || writable || selectedSurface.terminalControl === true;
  if (selectedSurface?.terminalControl && !writable) {
    blurMobileTextInput();
    if (state.kbdVisible) setKbdVisible(false);
  }

  renderConnectionEmpty();
  updateSurfaceCursors();
  updateAiChatControls();
}

function renderConnectionEmpty(): void {
  const empty = document.querySelector<HTMLElement>("#connection-empty");
  if (!empty) return;
  empty.hidden = Boolean(state.layoutState?.tabs.length);
  if (empty.hidden) return;

  const desktopConnected = currentConnectionStatus.desktop === "online";
  const title = empty.querySelector<HTMLElement>("#connection-empty-title");
  const help = empty.querySelector<HTMLElement>("#connection-empty-help");
  const openConnection = empty.querySelector<HTMLButtonElement>("#open-connection");
  if (title) {
    if (desktopConnected) {
      title.textContent = state.hasSeenLayout
        ? tr("No desktop tabs", "桌面端暂无标签页")
        : tr("Waiting for desktop tabs", "正在等待桌面端标签页");
    } else {
      title.textContent = currentConnectionStatus.kind === "connecting"
        ? tr("Connecting to WispTerm", "正在连接桌面端")
        : tr("Connect WispTerm", "连接桌面终端");
    }
  }
  if (help) {
    help.hidden = desktopConnected;
    if (!desktopConnected) {
      help.textContent = state.activeSessionKey && currentConnectionStatus.kind === "offline"
        ? tr("Check the session key or enable remote access in the desktop app.", "检查会话密钥，或确认桌面端已开启远程访问。")
        : tr("Use the session key from the WispTerm desktop app.", "使用桌面端 WispTerm 的会话密钥。");
    }
  }
  if (openConnection) openConnection.hidden = desktopConnected;
}

function updateMobileSurfaceMode(): void {
  const surfaceKind = selectedMobileSurfaceKind(
    state.layoutState,
    state.selectedTabIndex,
    state.selectedSurfaceId,
  );
  const shell = document.querySelector<HTMLElement>(".console-shell");
  if (shell) {
    shell.dataset.mobileSurfaceKind = surfaceKind;
    shell.dataset.mobileVkbdVisible = String(
      shouldShowMobileVirtualKeyboard(surfaceKind, state.kbdVisible, state.mobileInputMode),
    );
  }

  const keyboardToggle = document.querySelector<HTMLButtonElement>("#kbd-toggle");
  if (keyboardToggle) {
    const chatMode = surfaceKind === "ai_chat";
    keyboardToggle.hidden = chatMode;
    keyboardToggle.setAttribute("aria-hidden", String(chatMode));
    keyboardToggle.disabled = state.mobileInputMode === "view";
    const keyLabel = state.kbdVisible ? tr("Hide shortcut keyboard", "隐藏快捷键键盘") : tr("Show shortcut keyboard", "显示快捷键键盘");
    const label = state.mobileInputMode === "view" ? tr("Switch to Edit to use shortcut keys", "切换到编辑模式后使用快捷键") : keyLabel;
    keyboardToggle.setAttribute("aria-label", label);
    keyboardToggle.setAttribute("aria-pressed", String(state.kbdVisible));
    keyboardToggle.title = label;
  }
  const inputModeToggle = document.querySelector<HTMLButtonElement>("#mobile-input-mode-toggle");
  if (inputModeToggle) {
    const chatMode = surfaceKind === "ai_chat";
    inputModeToggle.hidden = chatMode;
    inputModeToggle.setAttribute("aria-hidden", String(chatMode));
  }
  syncMobileInputModeUi();
}

function bindMobileChrome(): void {
  document.querySelector<HTMLButtonElement>("#drawer-open")?.addEventListener("click", () => {
    setDrawerOpen(true);
  });
  document.querySelector<HTMLButtonElement>("#drawer-close")?.addEventListener("click", () => {
    if (isMobileRemoteShell()) {
      setDrawerOpen(false);
    } else {
      setSidebarCollapsed(true);
    }
  });
  document.querySelector<HTMLDivElement>("#sidebar-backdrop")?.addEventListener("click", () => {
    setDrawerOpen(false);
  });
  document.querySelector<HTMLButtonElement>("#sidebar-expand")?.addEventListener("click", () => {
    setSidebarCollapsed(false);
  });
  document.querySelector<HTMLButtonElement>("#kbd-toggle")?.addEventListener("click", () => {
    if (state.mobileInputMode === "view") return;
    setKbdVisible(!state.kbdVisible);
  });
  document.querySelector<HTMLButtonElement>("#mobile-input-mode-toggle")?.addEventListener("click", () => {
    setMobileInputMode(nextMobileInputMode(state.mobileInputMode));
  });
  bindMobileSurfaceSelectorLayout();
}

function bindMobileSurfaceSelectorLayout(): void {
  mobileSurfaceSelectorObserver?.disconnect();
  mobileSurfaceSelectorObserver = null;

  const selector = document.querySelector<HTMLDivElement>("#mobile-surface-selector");
  const bar = document.querySelector<HTMLElement>(".mobile-bar");
  if (selector && bar && "ResizeObserver" in window) {
    mobileSurfaceSelectorObserver = new ResizeObserver(() => {
      queueMobileSurfaceSelectorCollapse();
    });
    mobileSurfaceSelectorObserver.observe(selector);
    mobileSurfaceSelectorObserver.observe(bar);
  }

  if (!mobileSurfaceSelectorResizeBound) {
    mobileSurfaceSelectorResizeBound = true;
    window.addEventListener("resize", queueMobileSurfaceSelectorCollapse);
    document.addEventListener("pointerdown", (event) => {
      const selectorNow = document.querySelector<HTMLDivElement>("#mobile-surface-selector");
      if (!selectorNow || selectorNow.dataset.open !== "true") return;
      if (event.target instanceof Node && selectorNow.contains(event.target)) return;
      setMobileSurfaceMenuOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setMobileSurfaceMenuOpen(false);
    });
  }

  queueMobileSurfaceSelectorCollapse();
}

function setMobileInputMode(mode: MobileInputMode): void {
  if (state.mobileInputMode === mode) return;
  state.mobileInputMode = mode;
  if (mode === "view") {
    if (state.kbdVisible) setKbdVisible(false);
    blurMobileTextInput();
  } else {
    if (state.kbdVisible) setKbdVisible(false);
    else focusMobileTextInput();
  }
  syncTerminalNativeInputGuards();
  updateSurfaceCursors();
  syncMobileInputModeUi();
  updateMobileSurfaceMode();
}

function syncMobileInputModeUi(): void {
  const mode = state.mobileInputMode;
  const shell = document.querySelector<HTMLElement>(".console-shell");
  if (shell) shell.dataset.mobileInputMode = mode;

  const toggle = document.querySelector<HTMLButtonElement>("#mobile-input-mode-toggle");
  if (toggle) {
    const label = mobileInputModeToggleLabel(mode);
    toggle.dataset.mode = mode;
    toggle.textContent = mobileInputModeLabel(mode);
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  }

  syncVirtualKeyboardInputMode();
}

function setMobileVisualZoom(zoom: MobileVisualZoom): void {
  if (state.mobileVisualZoom === zoom) return;
  state.mobileVisualZoom = zoom;
  saveMobileVisualZoom(zoom);
  syncSurfaceVisualZooms();
}

function mobileInputModeLabel(mode: MobileInputMode): string {
  return mode === "edit" ? tr("Edit", "编辑") : tr("View", "查看");
}

function mobileInputModeToggleLabel(mode: MobileInputMode): string {
  return tr(`Switch to ${mobileInputModeLabel(nextMobileInputMode(mode)).toLowerCase()} mode`, `切换到${mobileInputModeLabel(nextMobileInputMode(mode))}模式`);
}

function nextMobileInputMode(mode: MobileInputMode): MobileInputMode {
  return mode === "edit" ? "view" : "edit";
}

function consumeLanguageSettingsReturn(): boolean {
  try {
    const shouldReturn = sessionStorage.getItem(LANGUAGE_SETTINGS_RETURN_KEY) === "1";
    sessionStorage.removeItem(LANGUAGE_SETTINGS_RETURN_KEY);
    return shouldReturn;
  } catch {
    return false;
  }
}

function bindLocalePicker(): void {
  const picker = document.querySelector<HTMLElement>("#remote-language");
  picker?.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !isRemoteLocale(input.value) || input.value === getLocale()) return;
    const previous = getLocale();
    if (!setLocale(input.value)) {
      const selected = picker.querySelector<HTMLInputElement>(`input[value="${previous}"]`);
      if (selected) selected.checked = true;
      const error = document.querySelector<HTMLOutputElement>("#language-error");
      if (error) error.textContent = tr("Could not save the language preference.", "无法保存语言设置。");
      return;
    }
    try {
      sessionStorage.setItem(LANGUAGE_SETTINGS_RETURN_KEY, "1");
    } catch {
      // The saved language still applies if the Settings page cannot be restored.
    }
    window.location.reload();
  });
}

function bindSidebarPages(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-sidebar-page-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const page = button.dataset.sidebarPageTarget;
      if (page === "tabs" || page === "dashboard" || page === "settings") {
        setSidebarPage(page);
      }
    });
  });
}

function setSidebarPage(page: SidebarPage): void {
  sidebarPage = page;
  const shell = document.querySelector<HTMLElement>(".console-shell");
  if (shell) shell.dataset.sidebarPage = page;

  document.querySelectorAll<HTMLElement>("[data-sidebar-page]").forEach((section) => {
    section.classList.toggle("active", section.dataset.sidebarPage === page);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-sidebar-page-target]").forEach((button) => {
    const active = button.dataset.sidebarPageTarget === page;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
}

function bindDesktopPanelMode(): void {
  document.querySelector("#desktop-panel-mode")?.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement) setDesktopPanelMode(event.target.value);
  });
}

function setDesktopPanelMode(value: string): void {
  if (value !== "layout" && value !== "single") return;
  if (state.desktopPanelMode === value) return;
  state.desktopPanelMode = value;
  saveDesktopPanelMode(value);
  const shell = document.querySelector<HTMLElement>(".console-shell");
  if (shell) shell.dataset.desktopPanelMode = value;
  renderRemoteWorkspace();
  refitAllSurfaces();
}

function bindViewportRefit(): void {
  const refit = (): void => {
    applyVisualViewportSizing(document.querySelector<HTMLElement>(".console-shell"));
    refitAllSurfaces();
  };

  refit();
  if (viewportRefitBound) return;
  viewportRefitBound = true;

  window.addEventListener("resize", refit, { passive: true });
  window.matchMedia(MOBILE_REMOTE_MEDIA_QUERY).addEventListener("change", syncSurfaceVisualZooms);
  window.visualViewport?.addEventListener("resize", refit);
  window.visualViewport?.addEventListener("scroll", refit);
}

function bindWeixinPanel(): void {
  document.querySelector<HTMLInputElement>("#weixin-enabled")?.addEventListener("change", (event) => {
    const copy = document.querySelector<HTMLElement>("#weixin-enabled-copy");
    if (copy) copy.textContent = (event.currentTarget as HTMLInputElement).checked ? tr("On", "开启") : tr("Off", "关闭");
  });
  document.querySelector<HTMLButtonElement>("#weixin-save")?.addEventListener("click", () => {
    void saveWeixinPanel();
  });
  document.querySelector<HTMLButtonElement>("#weixin-bind-toggle")?.addEventListener("click", () => {
    if (weixinState?.binding.bound) {
      void unbindWeixinPanel();
    } else {
      void startWeixinPanelBind();
    }
  });
  void refreshWeixinPanel(weixinBindGeneration);
}

function bindStatusLatencyDisclosure(): void {
  document.querySelector<HTMLButtonElement>("#status-dot")?.addEventListener("click", showStatusLatencyDisclosure);
  document.querySelector<HTMLButtonElement>("#mobile-status-pip")?.addEventListener("click", showStatusLatencyDisclosure);
}

function showStatusLatencyDisclosure(): void {
  const detail = currentConnectionStatus.detail;
  const desktop = document.querySelector<HTMLSpanElement>("#status-latency-detail");
  const mobile = document.querySelector<HTMLSpanElement>("#mobile-status-latency");
  if (desktop) {
    desktop.textContent = detail;
    desktop.hidden = false;
  }
  if (mobile) {
    mobile.textContent = detail;
    mobile.hidden = false;
  }
  if (statusLatencyHideTimer !== null) clearTimeout(statusLatencyHideTimer);
  statusLatencyHideTimer = setTimeout(() => {
    document.querySelector<HTMLSpanElement>("#status-latency-detail")?.setAttribute("hidden", "");
    document.querySelector<HTMLSpanElement>("#mobile-status-latency")?.setAttribute("hidden", "");
    statusLatencyHideTimer = null;
  }, 3500);
}

function syncVisibleStatusLatencyDisclosure(): void {
  for (const selector of ["#status-latency-detail", "#mobile-status-latency"]) {
    const target = document.querySelector<HTMLSpanElement>(selector);
    if (!target || target.hidden) continue;
    target.textContent = currentConnectionStatus.detail;
  }
}

function nextWeixinBindGeneration(): number {
  weixinBindGeneration += 1;
  return weixinBindGeneration;
}

function isCurrentWeixinBindGeneration(generation: number): boolean {
  return generation === weixinBindGeneration;
}

function cleanupWeixinPanel(): void {
  nextWeixinBindGeneration();
  if (weixinBindTimer) {
    clearTimeout(weixinBindTimer);
    weixinBindTimer = null;
  }
  weixinState = null;

  const qr = document.querySelector<HTMLDivElement>("#weixin-qr");
  if (qr) {
    qr.hidden = true;
    qr.replaceChildren();
  }
}

async function refreshWeixinPanel(generation = weixinBindGeneration): Promise<void> {
  const status = document.querySelector<HTMLDivElement>("#weixin-status");
  try {
    const next = await fetchWeixinSettings();
    if (!isCurrentWeixinBindGeneration(generation)) return;
    weixinState = {
      ...next,
      settings: normalizeWeixinSettings(next.settings),
    };
    renderWeixinPanel();
  } catch (error) {
    if (!isCurrentWeixinBindGeneration(generation)) return;
    if (status) status.textContent = weixinErrorText(error, tr("Load failed", "加载失败"));
  }
}

function renderWeixinPanel(): void {
  if (!weixinState) return;

  const status = document.querySelector<HTMLDivElement>("#weixin-status");
  const pill = document.querySelector<HTMLSpanElement>("#weixin-state-pill");
  const enabled = document.querySelector<HTMLInputElement>("#weixin-enabled");
  const enabledCopy = document.querySelector<HTMLElement>("#weixin-enabled-copy");
  const bindToggle = document.querySelector<HTMLButtonElement>("#weixin-bind-toggle");
  const target = document.querySelector("#weixin-target-session") as HTMLSelectElement | null;
  const state = weixinPanelState(weixinState);

  if (status) status.textContent = bridgeStatusText(weixinState.settings, weixinState.binding);
  if (pill) {
    pill.dataset.state = state;
    pill.textContent = state === "ready" ? tr("Ready", "已就绪") : state === "disabled" ? tr("Disabled", "已停用") : tr("Not bound", "未绑定");
  }
  if (enabled) enabled.checked = weixinState.settings.enabled;
  if (enabledCopy) enabledCopy.textContent = weixinState.settings.enabled ? tr("On", "开启") : tr("Off", "关闭");
  if (bindToggle) {
    const bound = weixinState.binding.bound;
    bindToggle.textContent = bindActionText(weixinState.binding);
    bindToggle.dataset.mode = bound ? "unbind" : "bind";
  }
  if (target) {
    const selected = weixinState.settings.target_session;
    const sessions = [...weixinState.sessions];
    if (selected && !sessions.some((session) => session.key === selected)) {
      sessions.unshift({ key: selected, connected: false });
    }

    target.innerHTML = [
      `<option value="">${tr("No target", "未选择目标")}</option>`,
      ...sessions.map((session) => {
        const connected = session.connected ? tr("Online", "已连接") : tr("offline", "离线");
        return `<option value="${escapeText(session.key)}"${session.key === selected ? " selected" : ""}>${escapeText(maskSessionKey(session.key))} (${connected})</option>`;
      }),
    ].join("");
  }
}

function weixinPanelState(next: WeixinSettingsResponse): "ready" | "disabled" | "unbound" {
  if (!next.binding.bound) return "unbound";
  if (!next.settings.enabled) return "disabled";
  return "ready";
}

async function saveWeixinPanel(): Promise<void> {
  const status = document.querySelector<HTMLDivElement>("#weixin-status");
  const enabled = document.querySelector<HTMLInputElement>("#weixin-enabled");
  const target = document.querySelector("#weixin-target-session") as HTMLSelectElement | null;
  if (!enabled || !target) return;

  if (status) status.textContent = tr("Saving...", "保存中…");
  const generation = weixinBindGeneration;
  try {
    const settings = normalizeWeixinSettings({
      enabled: enabled.checked,
      target_session: target.value,
      reply_timeout_ms: weixinState?.settings.reply_timeout_ms ?? 120000,
    });
    await saveWeixinSettings(settings);
    if (!isCurrentWeixinBindGeneration(generation)) return;
    await refreshWeixinPanel(generation);
  } catch (error) {
    if (!isCurrentWeixinBindGeneration(generation)) return;
    if (status) status.textContent = weixinErrorText(error, tr("Save failed", "保存失败"));
  }
}

async function startWeixinPanelBind(): Promise<void> {
  const status = document.querySelector<HTMLDivElement>("#weixin-status");
  const qr = document.querySelector<HTMLDivElement>("#weixin-qr");
  const generation = nextWeixinBindGeneration();
  if (weixinBindTimer) {
    clearTimeout(weixinBindTimer);
    weixinBindTimer = null;
  }

  if (status) status.textContent = tr("Starting...", "正在启动绑定…");
  try {
    const binding = await startWeixinBind();
    if (!isCurrentWeixinBindGeneration(generation)) return;
    if (qr) {
      qr.hidden = false;
      qr.innerHTML = `<img src="${escapeText(binding.qrcode_data_url)}" alt="${tr("Weixin bind QR code", "微信绑定二维码")}" /><div>${escapeText(weixinBindStatusText(binding.status))}</div>`;
    }
    if (status) status.textContent = weixinBindStatusText(binding.status);
    scheduleWeixinBindPoll(binding.qrcode, generation);
  } catch (error) {
    if (!isCurrentWeixinBindGeneration(generation)) return;
    if (status) status.textContent = weixinErrorText(error, tr("Bind failed", "绑定失败"));
  }
}

function scheduleWeixinBindPoll(qrcode: string, generation: number): void {
  if (!isCurrentWeixinBindGeneration(generation)) return;
  const status = document.querySelector<HTMLDivElement>("#weixin-status");
  if (weixinBindTimer) clearTimeout(weixinBindTimer);

  weixinBindTimer = setTimeout(() => {
    if (!isCurrentWeixinBindGeneration(generation)) return;
    weixinBindTimer = null;
    void (async () => {
      try {
        const next = await pollWeixinBindStatus(qrcode);
        if (!isCurrentWeixinBindGeneration(generation)) return;
        if (next.binding.bound || next.status === "bound") {
          const qr = document.querySelector<HTMLDivElement>("#weixin-qr");
          if (qr) {
            qr.hidden = true;
            qr.replaceChildren();
          }
          await refreshWeixinPanel(generation);
          return;
        }

        if (next.status === "expired" || next.status === "failed") {
          if (status) status.textContent = weixinBindStatusText(next.status, next.message);
          return;
        }

        if (status) status.textContent = weixinBindStatusText(next.status, next.message);
        scheduleWeixinBindPoll(qrcode, generation);
      } catch (error) {
        if (!isCurrentWeixinBindGeneration(generation)) return;
        if (status) status.textContent = weixinErrorText(error, tr("Check failed", "检查绑定状态失败"));
      }
    })();
  }, 2000);
}

async function unbindWeixinPanel(): Promise<void> {
  const status = document.querySelector<HTMLDivElement>("#weixin-status");
  const qr = document.querySelector<HTMLDivElement>("#weixin-qr");
  const generation = nextWeixinBindGeneration();
  if (weixinBindTimer) {
    clearTimeout(weixinBindTimer);
    weixinBindTimer = null;
  }
  if (qr) {
    qr.hidden = true;
    qr.replaceChildren();
  }

  if (status) status.textContent = tr("Unbinding Weixin...", "正在解绑微信…");
  try {
    await unbindWeixin();
    if (!isCurrentWeixinBindGeneration(generation)) return;
    await refreshWeixinPanel(generation);
  } catch (error) {
    if (!isCurrentWeixinBindGeneration(generation)) return;
    if (status) status.textContent = weixinErrorText(error, tr("Unbind failed", "解绑失败"));
  }
}

function setDrawerOpen(open: boolean): void {
  state.drawerOpen = open;
  const shell = document.querySelector<HTMLElement>(".console-shell");
  if (shell) shell.dataset.drawerOpen = String(open);
  document.querySelector("#drawer-open")?.setAttribute("aria-expanded", String(open));
}

function setSidebarCollapsed(collapsed: boolean): void {
  state.sidebarCollapsed = collapsed;
  saveSidebarCollapsed(collapsed);
  const shell = document.querySelector<HTMLElement>(".console-shell");
  if (shell) shell.dataset.sidebarCollapsed = String(collapsed);
  document.querySelector("#sidebar-expand")?.setAttribute("aria-expanded", String(!collapsed));
  document.querySelector<HTMLButtonElement>(collapsed ? "#sidebar-expand" : "#drawer-close")?.focus({ preventScroll: true });
  requestAnimationFrame(() => refitAllSurfaces());
}

function setKbdVisible(visible: boolean): void {
  if (visible && state.mobileInputMode === "view") return;
  state.kbdVisible = visible;
  if (visible) blurMobileTextInput();
  else if (state.mobileInputMode === "edit") focusMobileTextInput();
  const shell = document.querySelector<HTMLElement>(".console-shell");
  if (shell) shell.dataset.kbdVisible = String(visible);
  updateMobileSurfaceMode();
  requestAnimationFrame(() => refitAllSurfaces());
}

function syncMobileTextInputFocusForMode(): void {
  if (state.mobileInputMode === "edit" && !state.kbdVisible) {
    focusMobileTextInput();
  } else {
    blurMobileTextInput();
  }
}

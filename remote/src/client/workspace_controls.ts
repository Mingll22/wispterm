import { tr } from "./i18n";
import { isTabTitle, MAX_TAB_TITLE_BYTES } from "../workspace_protocol";
import { iconAdd, iconDelete, iconTabControl } from "./icons";
import { isMobileRemoteShell } from "./mobile_layout";
import { currentTab, state, tabControlId } from "./state";
import { tabControl } from "./tab_control";
import { sendWorkspaceAction, workspaceActionAvailable, type WorkspaceActionStatus, type WorkspaceCommand } from "./transport";
import type { LayoutTab } from "./types";
import { WEB_PANE_LIMIT, workspaceNodes } from "./workspace_layout";
import { bindWorkspacePanels } from "./workspace_panels";

type WorkspaceCallbacks = {
  selectTab: (index: number) => void;
  selectPane: (surfaceId: string) => void;
  created: () => void;
  previewEnded: () => void;
  controlChanged: () => void;
};

export function workspaceTabActionsMarkup(classes = "", controlPosition: "start" | "end" = "start"): string {
  const control = `<button type="button" class="icon-button tab-control-toggle" hidden>${iconTabControl(false)}</button>`;
  const actions = `
    <button type="button" class="icon-button tab-add-pane" hidden>${iconAdd()}</button>
    <button type="button" class="icon-button tab-delete" hidden>${iconDelete()}</button>`;
  return `
    <div class="workspace-tab-actions${classes}" role="group" aria-label="${tr("Selected tab actions", "当前标签操作")}" hidden>
      ${controlPosition === "end" ? actions + control : control + actions}
    </div>`;
}

export function bindWorkspaceControls(root: HTMLElement, callbacks: WorkspaceCallbacks) {
  const tabs = root.querySelector<HTMLElement>("#remote-tabs")!;
  const newTab = root.querySelector<HTMLButtonElement>("#new-remote-tab")!;
  const emptyNewTab = root.querySelector<HTMLButtonElement>("#empty-new-remote-tab")!;
  const globalActions = Array.from(root.querySelectorAll<HTMLElement>(".chrome-tab-actions"));
  const dialog = root.querySelector<HTMLDialogElement>("#close-remote-tab")!;
  const description = root.querySelector<HTMLElement>("#close-remote-tab-message")!;
  const status = root.querySelector<HTMLOutputElement>("#workspace-action-status")!;
  const stage = root.querySelector<HTMLElement>("#remote-panels")!;
  let confirmedAction: WorkspaceCommand | null = null;
  let tabTap: { key: string; timer: ReturnType<typeof setTimeout> } | null = null;

  const panels = bindWorkspacePanels(stage, {
    close: ({ tabId, layoutRevision }, surfaceId) => void run({ action: "close-pane", tabId, layoutRevision, surfaceId }),
    apply: ({ tabId, layoutRevision, tree: previous }, tree) => {
      const splitTree = workspaceNodes(tree);
      if (JSON.stringify(splitTree) === JSON.stringify(workspaceNodes(previous))) return;
      void run({ action: "set-layout", tabId, layoutRevision, splitTree });
    },
    select: callbacks.selectPane,
    previewEnded: callbacks.previewEnded,
  });

  newTab.addEventListener("click", () => void run({ action: "create-tab" }));
  emptyNewTab.addEventListener("click", () => void run({ action: "create-tab" }));
  globalActions.forEach(bindTabActions);
  dialog.addEventListener("close", () => {
    const action = confirmedAction;
    confirmedAction = null;
    if (dialog.returnValue === "close" && action) void run(action);
  });

  async function run(command: WorkspaceCommand): Promise<void> {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    status.textContent = tr("Waiting for WispTerm…", "等待桌面端处理…");
    const result = sendWorkspaceAction(command);
    update();
    const outcome = await result;
    if (!root.contains(status)) return;
    status.textContent = actionFeedback(outcome);
    if (outcome === "ok" && (command.action === "create-tab" || command.action === "add-pane")) callbacks.created();
    update();
    if (document.activeElement === document.body) {
      if (focused?.isConnected && !focused.closest("[inert], [hidden]") && !focused.matches(":disabled")) {
        focused.focus({ preventScroll: true });
      } else {
        (stage.querySelector<HTMLElement>(".remote-panel.selected .terminal-lease") ?? emptyNewTab).focus({ preventScroll: true });
      }
    }
  }

  function addPane(): void {
    const tab = currentTab();
    const last = tab?.surfaces.at(-1);
    if (!tab?.workspace || !last || tab.surfaces.length >= WEB_PANE_LIMIT) return;
    const { tabId, layoutRevision } = tab.workspace;
    void run({ action: "add-pane", tabId, layoutRevision, surfaceId: last.id });
  }

  function toggleControl(): void {
    const tabId = tabControlId();
    if (!tabId) return;
    if (tabControl.leaseId(tabId) === undefined) tabControl.takeOver(tabId);
    else tabControl.release(tabId);
    callbacks.controlChanged();
  }

  function requestCloseTab(): void {
    const tab = currentTab();
    if (!tab?.workspace) return;
    const { tabId, layoutRevision } = tab.workspace;
    const count = tab.surfaces.length;
    const title = tabTitle(tab);
    confirmedAction = { action: "close-tab", tabId, layoutRevision };
    description.textContent = tr(
      `Closing “${title}” will close all ${count} ${count === 1 ? "terminal" : "terminals"} in it.`,
      `删除「${title}」会关闭其中的 ${count} 个终端。`,
    );
    dialog.returnValue = "";
    dialog.showModal();
  }

  function renderTabs(): void {
    const layout = state.layoutState;
    if (!layout?.tabs.length) {
      tabs.className = "remote-tabs empty";
      tabs.textContent = layout?.workspaceActions
        ? tr("No tabs yet", "暂无标签页")
        : tr("Connect WispTerm to see its tabs", "连接桌面端后显示标签页");
      return;
    }

    if (tabs.classList.contains("empty")) tabs.replaceChildren();
    tabs.className = "remote-tabs";
    const existing = new Map(Array.from(tabs.children, (row) => [(row as HTMLElement).dataset.tabKey, row as HTMLElement]));
    layout.tabs.forEach((tab, position) => {
      const key = tab.workspace?.tabId ?? `index-${tab.index}`;
      const row = existing.get(key) ?? makeTabRow(key);
      existing.delete(key);
      const title = tabTitle(tab);
      const count = tab.surfaces.length;
      const active = tab.index === state.selectedTabIndex;
      const button = row.querySelector<HTMLButtonElement>(".tab-chip")!;
      button.dataset.tabIndex = String(tab.index);
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-label", tr(`${title}, ${count} ${count === 1 ? "panel" : "panels"}`, `${title}，${count} 个面板`));
      if (canRename(tab)) {
        button.title = tr(`${title} · Double-click or press F2 to rename`, `${title} · 双击或按 F2 改名`);
        button.setAttribute("aria-keyshortcuts", "F2");
      } else {
        button.title = title;
        button.removeAttribute("aria-keyshortcuts");
      }
      row.toggleAttribute("data-current", active);
      const label = row.querySelector<HTMLElement>(".tab-chip-label")!;
      const countLabel = row.querySelector<HTMLElement>(".tab-chip-count")!;
      if (label.textContent !== title) label.textContent = title;
      if (countLabel.textContent !== String(count)) countLabel.textContent = String(count);
      if (row !== tabs.children[position]) tabs.insertBefore(row, tabs.children[position] ?? null);
    });
    for (const row of existing.values()) row.remove();
  }

  function makeTabRow(key: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "workspace-tab-row";
    row.dataset.tabKey = key;
    row.innerHTML = `
      <button type="button" class="tab-chip"><span class="tab-chip-label"></span></button>
      <input type="text" class="tab-title-input" aria-label="${tr("Tab name", "标签名称")}" autocomplete="off" spellcheck="false" hidden>
      ${workspaceTabActionsMarkup("", "end")}
      <span class="tab-chip-count" aria-hidden="true"></span>`;
    const button = row.querySelector<HTMLButtonElement>(".tab-chip")!;
    const editor = row.querySelector<HTMLInputElement>(".tab-title-input")!;
    const tabForRow = () => state.layoutState?.tabs.find((tab) => tab.workspace?.tabId === key);
    let original = "";
    const select = () => callbacks.selectTab(Number(button.dataset.tabIndex));
    function startRename(): void {
      const tab = tabForRow();
      if (!editor.hidden || !canRename(tab) || !workspaceActionAvailable()) return;
      original = tab?.title ?? "";
      editor.value = original;
      button.hidden = true;
      editor.hidden = false;
      editor.focus();
      editor.select();
    }

    function stopRename(save: boolean, restoreFocus: boolean): void {
      if (editor.hidden) return;
      const title = editor.value;
      if (save && !isTabTitle(title)) {
        status.textContent = tr(
          `Enter a single-line name of up to ${MAX_TAB_TITLE_BYTES} UTF-8 bytes.`,
          `请输入单行名称，最多 ${MAX_TAB_TITLE_BYTES} 个 UTF-8 字节。`,
        );
        if (restoreFocus) {
          editor.setAttribute("aria-invalid", "true");
          return;
        }
        save = false;
      }
      editor.hidden = true;
      editor.removeAttribute("aria-invalid");
      button.hidden = false;
      if (restoreFocus) button.focus({ preventScroll: true });
      const target = tabForRow()?.workspace;
      if (save && target && title !== original) {
        void run({ action: "rename-tab", tabId: target.tabId, layoutRevision: target.layoutRevision, title });
      }
    }

    button.addEventListener("click", (event) => {
      const secondTap = tabTap?.key === key;
      if (tabTap) clearTimeout(tabTap.timer);
      tabTap = null;
      if (!event.detail || !isMobileRemoteShell() || !canRename(tabForRow())) {
        select();
        return;
      }
      if (secondTap) {
        startRename();
        return;
      }
      // Leave the drawer visible for a second tap on a renameable label.
      tabTap = { key, timer: setTimeout(() => {
        tabTap = null;
        if (state.drawerOpen && row.isConnected && editor.hidden) select();
      }, 300) };
    });
    button.addEventListener("dblclick", () => startRename());
    button.addEventListener("keydown", (event) => {
      if (event.key !== "F2" || !canRename(tabForRow())) return;
      event.preventDefault();
      startRename();
    });
    editor.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault();
      stopRename(event.key === "Enter", true);
    });
    editor.addEventListener("blur", () => stopRename(true, false));
    row.querySelector(".tab-chip-count")?.addEventListener("click", select);
    bindTabActions(row);
    return row;
  }

  function canRename(tab: LayoutTab | undefined): boolean {
    return state.layoutState?.tabRename === true && Boolean(tab?.workspace);
  }

  function bindTabActions(element: HTMLElement): void {
    element.querySelector(".tab-add-pane")?.addEventListener("click", addPane);
    element.querySelector(".tab-delete")?.addEventListener("click", requestCloseTab);
    element.querySelector(".tab-control-toggle")?.addEventListener("click", toggleControl);
  }

  function update(): void {
    const tab = currentTab();
    const supported = state.layoutState?.workspaceActions === true;
    newTab.hidden = !supported;
    emptyNewTab.hidden = !supported;
    newTab.disabled = !workspaceActionAvailable();
    emptyNewTab.disabled = newTab.disabled;
    const canEdit = Boolean(tab?.workspace && workspaceActionAvailable(tab));
    for (const group of tabs.querySelectorAll<HTMLElement>(".workspace-tab-actions")) {
      const current = Boolean(tab?.workspace && group.parentElement?.dataset.tabKey === tab.workspace.tabId);
      group.hidden = !current;
      if (current && tab) updateTabActions(group, tab, canEdit);
    }
    for (const group of globalActions) {
      group.hidden = !tab?.workspace;
      if (tab?.workspace) updateTabActions(group, tab, canEdit);
    }
    const mirror = (isMobileRemoteShell() ? state.mobilePanelMode : state.desktopPanelMode) === "layout";
    panels.update(tab, mirror, canEdit);
  }

  return { renderTabs, update };
}

function tabTitle(tab: LayoutTab): string {
  return tab.title?.trim() || tr(`Tab ${tab.index + 1}`, `标签页 ${tab.index + 1}`);
}

function updateTabActions(group: HTMLElement, tab: LayoutTab, available: boolean): void {
  const add = group.querySelector<HTMLButtonElement>(".tab-add-pane")!;
  const remove = group.querySelector<HTMLButtonElement>(".tab-delete")!;
  const control = group.querySelector<HTMLButtonElement>(".tab-control-toggle")!;
  const limit = tab.surfaces.length >= WEB_PANE_LIMIT;
  const title = tabTitle(tab);
  const tabId = tabControlId(tab);
  const held = tabId !== undefined && tabControl.leaseId(tabId) !== undefined;
  const requiresControl = tabId !== undefined && !held;
  group.toggleAttribute("data-control", tabId !== undefined);
  group.toggleAttribute("data-held", held);
  add.hidden = requiresControl;
  remove.hidden = requiresControl;
  const addLabel = tr(`Add terminal to ${title}`, `在「${title}」新增终端`);
  add.disabled = !available || limit;
  add.title = limit ? tr("Up to four terminals can be added from the web", "网页端最多新增到四个终端") : addLabel;
  add.setAttribute("aria-label", addLabel);
  remove.disabled = !available;
  const removeLabel = tr(`Delete tab ${title}`, `删除标签「${title}」`);
  remove.title = removeLabel;
  remove.setAttribute("aria-label", removeLabel);
  control.hidden = !tabId;
  control.disabled = !tabControl.isAvailable();
  if (control.hasAttribute("data-held") !== held) {
    control.toggleAttribute("data-held", held);
    control.innerHTML = iconTabControl(held);
  }
  control.title = held
    ? tr(`Return tab ${title} to WispTerm`, `归还标签「${title}」`)
    : tr(`Take control of tab ${title}`, `接管标签「${title}」`);
  control.setAttribute("aria-label", control.title);
}

function actionFeedback(outcome: WorkspaceActionStatus): string {
  switch (outcome) {
    case "ok": return "";
    case "stale": return tr("The desktop layout changed. Try again from the updated layout.", "桌面布局已变化，请在更新后的布局中重试。");
    case "denied": return tr("Take control of the tab before making changes.", "请接管当前标签后再修改。");
    case "protected": return tr("A terminal is running a program. Confirm its closure in WispTerm.", "终端中有程序在运行，请在 WispTerm 桌面端确认关闭。");
    case "limit": return tr("WispTerm has reached the tab or pane limit.", "已达到 WispTerm 的标签或面板上限。");
    case "unsupported": return tr("WispTerm cannot perform this action on the selected tab.", "WispTerm 无法在当前标签执行此操作。");
    case "offline": return tr("WispTerm is disconnected.", "WispTerm 桌面端未连接。");
    case "timeout": return tr("WispTerm did not confirm this action. Check the current layout.", "桌面端未确认此操作，请查看当前布局。");
    case "failed": return tr("WispTerm could not complete this action.", "WispTerm 未能完成此操作。");
  }
}

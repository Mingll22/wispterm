import { tr } from "./i18n";
import { iconAdd, iconDelete } from "./icons";
import { isMobileRemoteShell } from "./mobile_layout";
import { currentTab, state } from "./state";
import { sendWorkspaceAction, workspaceActionAvailable, type WorkspaceActionStatus, type WorkspaceCommand } from "./transport";
import type { LayoutTab } from "./types";
import { WEB_PANE_LIMIT, workspaceNodes } from "./workspace_layout";
import { bindWorkspacePanels } from "./workspace_panels";

type WorkspaceCallbacks = {
  selectTab: (index: number) => void;
  selectPane: (surfaceId: string) => void;
  created: () => void;
  previewEnded: () => void;
};

export function bindWorkspaceControls(root: HTMLElement, callbacks: WorkspaceCallbacks) {
  const tabs = root.querySelector<HTMLElement>("#remote-tabs")!;
  const newTab = root.querySelector<HTMLButtonElement>("#new-remote-tab")!;
  const emptyNewTab = root.querySelector<HTMLButtonElement>("#empty-new-remote-tab")!;
  const mobileActions = root.querySelector<HTMLElement>("#mobile-workspace-actions")!;
  const mobileAdd = root.querySelector<HTMLButtonElement>("#mobile-add-pane")!;
  const mobileDelete = root.querySelector<HTMLButtonElement>("#mobile-delete-tab")!;
  const dialog = root.querySelector<HTMLDialogElement>("#close-remote-tab")!;
  const description = root.querySelector<HTMLElement>("#close-remote-tab-message")!;
  const status = root.querySelector<HTMLOutputElement>("#workspace-action-status")!;
  const stage = root.querySelector<HTMLElement>("#remote-panels")!;
  let confirmedAction: WorkspaceCommand | null = null;

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
  mobileAdd.addEventListener("click", addPane);
  mobileDelete.addEventListener("click", requestCloseTab);
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
      button.title = title;
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
      <div class="workspace-tab-actions" role="group" aria-label="${tr("Selected tab actions", "当前标签操作")}" hidden>
        <button type="button" class="icon-button tab-add-pane">${iconAdd()}</button>
        <button type="button" class="icon-button tab-delete">${iconDelete()}</button>
      </div>
      <span class="tab-chip-count" aria-hidden="true"></span>`;
    const button = row.querySelector<HTMLButtonElement>(".tab-chip")!;
    const select = () => callbacks.selectTab(Number(button.dataset.tabIndex));
    button.addEventListener("click", select);
    row.querySelector(".tab-chip-count")?.addEventListener("click", select);
    row.querySelector(".tab-add-pane")?.addEventListener("click", addPane);
    row.querySelector(".tab-delete")?.addEventListener("click", requestCloseTab);
    return row;
  }

  function update(): void {
    const tab = currentTab();
    const available = workspaceActionAvailable();
    const supported = state.layoutState?.workspaceActions === true;
    newTab.hidden = !supported;
    emptyNewTab.hidden = !supported;
    newTab.disabled = !available;
    emptyNewTab.disabled = !available;
    mobileActions.hidden = !tab?.workspace;
    for (const group of tabs.querySelectorAll<HTMLElement>(".workspace-tab-actions")) {
      const current = Boolean(tab?.workspace && group.parentElement?.dataset.tabKey === tab.workspace.tabId);
      group.hidden = !current;
      if (current && tab) updateTabActions(group.querySelector(".tab-add-pane")!, group.querySelector(".tab-delete")!, tab, available);
    }
    if (tab?.workspace) updateTabActions(mobileAdd, mobileDelete, tab, available);
    const mirror = (isMobileRemoteShell() ? state.mobilePanelMode : state.desktopPanelMode) === "layout";
    panels.update(tab, mirror, available);
  }

  return { renderTabs, update };
}

function tabTitle(tab: LayoutTab): string {
  return tab.title?.trim() || tr(`Tab ${tab.index + 1}`, `标签页 ${tab.index + 1}`);
}

function updateTabActions(add: HTMLButtonElement, remove: HTMLButtonElement, tab: LayoutTab, available: boolean): void {
  const limit = tab.surfaces.length >= WEB_PANE_LIMIT;
  const title = tabTitle(tab);
  const addLabel = tr(`Add terminal to ${title}`, `在「${title}」新增终端`);
  add.disabled = !available || limit;
  add.title = limit ? tr("Up to four terminals can be added from the web", "网页端最多新增到四个终端") : addLabel;
  add.setAttribute("aria-label", addLabel);
  remove.disabled = !available;
  remove.title = tr(`Delete tab ${title}`, `删除标签「${title}」`);
  remove.setAttribute("aria-label", remove.title);
}

function actionFeedback(outcome: WorkspaceActionStatus): string {
  switch (outcome) {
    case "ok": return "";
    case "stale": return tr("The desktop layout changed. Try again from the updated layout.", "桌面布局已变化，请在更新后的布局中重试。");
    case "protected": return tr("A terminal is running a program. Confirm its closure in WispTerm.", "终端中有程序在运行，请在 WispTerm 桌面端确认关闭。");
    case "limit": return tr("WispTerm has reached the tab or pane limit.", "已达到 WispTerm 的标签或面板上限。");
    case "unsupported": return tr("WispTerm cannot perform this action on the selected tab.", "WispTerm 无法在当前标签执行此操作。");
    case "offline": return tr("WispTerm is disconnected.", "WispTerm 桌面端未连接。");
    case "timeout": return tr("WispTerm did not confirm this action. Check the current layout.", "桌面端未确认此操作，请查看当前布局。");
    case "failed": return tr("WispTerm could not complete this action.", "WispTerm 未能完成此操作。");
  }
}

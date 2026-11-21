export type RemoteTabSelectionSidebarAction = "close-drawer" | "keep-sidebar";

export function remoteTabSelectionSidebarAction(isMobileRemoteShell: boolean): RemoteTabSelectionSidebarAction {
  return isMobileRemoteShell ? "close-drawer" : "keep-sidebar";
}

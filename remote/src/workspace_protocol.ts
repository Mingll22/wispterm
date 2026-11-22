// Shared browser and relay workspace wire contract.
export type { WorkspaceAction, WorkspaceNode, WorkspaceResult } from "./server/workspace_protocol.js";
export { isTabTitle, isWorkspaceId, MAX_TAB_TITLE_BYTES, parseWorkspaceTree } from "./server/workspace_protocol.js";

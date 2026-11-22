import type { TabControlGrid, TabControlRequest, TabControlState } from "../tab_control_protocol";
import type { TerminalControlTarget } from "./terminal_control";

type SelectedTab = {
  id: string;
  measured: TabControlGrid[];
  requested: Map<string, TabControlGrid>;
  attempted: boolean;
  leaseId?: number;
  reason?: TabControlState["reason"];
};

export class TabControl {
  private clientId: string | null = null;
  private ready = false;
  private selected: SelectedTab | null = null;

  constructor(private readonly send: (request: TabControlRequest) => boolean) {}

  connect(clientId: string | null): void {
    if (clientId === this.clientId) return;
    this.clientId = clientId;
    this.selected = null;
  }

  setDesktopReady(ready: boolean): void {
    this.ready = ready;
    if (!ready) this.selected = null;
  }

  isAvailable(): boolean {
    return this.clientId !== null && this.ready;
  }

  leaseId(tabId: string): number | undefined {
    return this.selected?.id === tabId ? this.selected.leaseId : undefined;
  }

  reconcile(tabId: string | null, members: string[], targets: TerminalControlTarget[], foreground: boolean): void {
    if (!this.isAvailable()) return;
    const selected = this.select(tabId);
    if (!selected) return;
    const memberIds = new Set(members);
    selected.measured = targets.flatMap(({ surfaceId, grid }) =>
      grid && memberIds.has(surfaceId) ? [{ surfaceId, ...grid }] : []);
    for (const surfaceId of selected.requested.keys()) {
      if (!memberIds.has(surfaceId)) selected.requested.delete(surfaceId);
    }
    if (!foreground) return;
    if (!selected.attempted) this.acquire(selected, "acquire");
    else this.resize(selected);
  }

  takeOver(tabId: string): void {
    if (this.isAvailable() && this.selected?.id === tabId) this.acquire(this.selected, "takeover");
  }

  release(tabId: string): void {
    const selected = this.selected;
    if (selected?.id !== tabId || selected.leaseId === undefined) return;
    this.send({ type: "tab-control", action: "release", tabId, leaseId: selected.leaseId });
    selected.leaseId = undefined;
    selected.requested.clear();
    selected.reason = "released";
  }

  renew(): void {
    const selected = this.selected;
    if (selected?.leaseId === undefined) return;
    this.send({ type: "tab-control", action: "renew", tabId: selected.id, leaseId: selected.leaseId });
  }

  receive(message: TabControlState, foreground: boolean): boolean {
    if (!this.isAvailable()) return false;
    const { tabId, clientId, leaseId, reason } = message;
    const held = clientId === this.clientId && leaseId !== null;
    const selected = this.selected;
    if (selected?.id !== tabId) {
      // A grant may arrive after the browser switches away from its tab.
      if (held) this.send({ type: "tab-control", action: "release", tabId, leaseId });
      return false;
    }
    const previousLease = selected.leaseId;
    const previousReason = selected.reason;
    if (reason === "denied" && clientId === null && previousLease !== undefined) return false;
    selected.leaseId = held ? leaseId : undefined;
    selected.reason = reason;
    if (previousLease !== selected.leaseId) selected.requested.clear();
    if (reason === "expired" && previousLease !== undefined) selected.attempted = false;
    if (held && foreground) this.resize(selected);
    return previousLease !== selected.leaseId || previousReason !== reason;
  }

  private select(tabId: string | null): SelectedTab | null {
    if (this.selected?.id === tabId) return this.selected;
    if (this.selected) this.release(this.selected.id);
    this.selected = tabId === null ? null : {
      id: tabId, measured: [], requested: new Map(), attempted: false,
    };
    return this.selected;
  }

  private acquire(selected: SelectedTab, action: "acquire" | "takeover"): void {
    if (this.send({ type: "tab-control", action, tabId: selected.id })) selected.attempted = true;
  }

  private resize(selected: SelectedTab): void {
    if (selected.leaseId === undefined) return;
    const grids = selected.measured.filter((grid) => {
      const previous = selected.requested.get(grid.surfaceId);
      return previous?.cols !== grid.cols || previous.rows !== grid.rows;
    });
    // Desktop-created groups can be larger than a single wire message.
    for (let first = 0; first < grids.length; first += 16) {
      const batch = grids.slice(first, first + 16);
      if (!this.send({ type: "tab-control", action: "resize", tabId: selected.id, leaseId: selected.leaseId, grids: batch })) return;
      for (const grid of batch) selected.requested.set(grid.surfaceId, grid);
    }
  }
}

let sendRequest: (request: TabControlRequest) => boolean = () => false;
export const tabControl = new TabControl((request) => sendRequest(request));

export function setTabControlSender(sender: (request: TabControlRequest) => boolean): void {
  sendRequest = sender;
}

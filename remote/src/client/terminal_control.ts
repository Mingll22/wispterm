export const TERMINAL_LEASE_RENEW_INTERVAL_MS = 20_000;

export type TerminalGrid = { cols: number; rows: number };
export type TerminalControlRequest = { type: "terminal-control"; surfaceId: string } & (
  | ({ action: "acquire" | "takeover" } & TerminalGrid)
  | { action: "renew" | "release"; leaseId: number }
  | ({ action: "resize"; leaseId: number } & TerminalGrid)
);
export type TerminalControlReason =
  "acquired" | "taken" | "released" | "expired" | "desktop" | "denied" | "unsupported";
export type TerminalControlTarget = {
  surfaceId: string;
  grid?: TerminalGrid;
};

type VisibleTerminal = {
  grid?: TerminalGrid;
  requestedGrid?: TerminalGrid;
  attempted: boolean;
  leaseId?: number;
  owner?: string | null;
  reason?: TerminalControlReason;
};

export class TerminalControl {
  private clientId: string | null = null;
  private ready = false;
  private readonly visible = new Map<string, VisibleTerminal>();

  constructor(private readonly send: (request: TerminalControlRequest) => boolean) {}

  connect(clientId: string | null): void {
    if (clientId === this.clientId) return;
    this.clientId = clientId;
    this.visible.clear();
  }

  setDesktopReady(ready: boolean): void {
    if (ready === this.ready) return;
    this.ready = ready;
    if (!ready) this.visible.clear();
  }

  isAvailable(): boolean {
    return this.clientId !== null && this.ready;
  }

  leaseId(surfaceId: string): number | undefined {
    return this.visible.get(surfaceId)?.leaseId;
  }

  reason(surfaceId: string): TerminalControlReason | undefined {
    return this.visible.get(surfaceId)?.reason;
  }

  controlledByOther(surfaceId: string): boolean {
    const owner = this.visible.get(surfaceId)?.owner;
    return owner != null && owner !== this.clientId;
  }

  reconcile(targets: TerminalControlTarget[], foreground: boolean): void {
    if (!this.isAvailable()) return;
    const current = new Set(targets.map(({ surfaceId }) => surfaceId));
    for (const surfaceId of this.visible.keys()) {
      if (current.has(surfaceId)) continue;
      this.release(surfaceId);
      this.visible.delete(surfaceId);
    }
    for (const { surfaceId, grid } of targets) {
      let terminal = this.visible.get(surfaceId);
      if (!terminal) {
        terminal = { attempted: false };
        this.visible.set(surfaceId, terminal);
      }
      terminal.grid = grid;
      if (!foreground || !grid) continue;
      if (!terminal.attempted) this.requestControl(surfaceId, "acquire");
      else this.resize(surfaceId, terminal, grid);
    }
  }

  takeOver(surfaceId: string): void {
    this.requestControl(surfaceId, "takeover");
  }

  release(surfaceId: string): void {
    const terminal = this.visible.get(surfaceId);
    if (terminal?.leaseId === undefined) return;
    this.send({ type: "terminal-control", action: "release", surfaceId, leaseId: terminal.leaseId });
    terminal.leaseId = undefined;
    terminal.owner = null;
    terminal.reason = "released";
  }

  releaseAll(): void {
    for (const surfaceId of this.visible.keys()) this.release(surfaceId);
  }

  renew(): void {
    for (const [surfaceId, terminal] of this.visible) {
      if (terminal.leaseId === undefined) continue;
      this.send({ type: "terminal-control", action: "renew", surfaceId, leaseId: terminal.leaseId });
    }
  }

  receive(
    surfaceId: string,
    owner: string | null,
    leaseId: number | null,
    reason: TerminalControlReason,
    foreground: boolean,
  ): boolean {
    if (!this.isAvailable()) return false;
    const terminal = this.visible.get(surfaceId);
    const held = owner === this.clientId && leaseId !== null;
    if (!terminal) {
      // A tab may have been changed while its acquisition was in flight.
      if (held) this.send({ type: "terminal-control", action: "release", surfaceId, leaseId });
      return false;
    }
    const previousLease = terminal.leaseId;
    const previousOwner = terminal.owner;
    const previousReason = terminal.reason;
    terminal.leaseId = held ? leaseId : undefined;
    terminal.owner = owner;
    terminal.reason = reason;
    if (reason === "expired" && previousLease !== undefined) terminal.attempted = false;
    if (held && foreground && terminal.grid) this.resize(surfaceId, terminal, terminal.grid);
    return previousLease !== terminal.leaseId || previousOwner !== owner || previousReason !== terminal.reason;
  }

  private requestControl(surfaceId: string, action: "acquire" | "takeover"): void {
    const terminal = this.visible.get(surfaceId);
    if (!this.isAvailable() || !terminal?.grid) return;
    if (this.send({ type: "terminal-control", action, surfaceId, ...terminal.grid })) {
      terminal.attempted = true;
      terminal.requestedGrid = terminal.grid;
    }
  }

  private resize(surfaceId: string, terminal: VisibleTerminal, grid: TerminalGrid): void {
    if (terminal.leaseId === undefined ||
        (terminal.requestedGrid?.cols === grid.cols && terminal.requestedGrid.rows === grid.rows)) return;
    if (this.send({ type: "terminal-control", action: "resize", surfaceId, leaseId: terminal.leaseId, ...grid })) {
      terminal.requestedGrid = grid;
    }
  }
}

export function supportedTerminalGrid(dimensions: TerminalGrid): TerminalGrid {
  return { cols: Math.max(2, Math.min(512, dimensions.cols)), rows: Math.max(1, Math.min(256, dimensions.rows)) };
}

const controlReasons: ReadonlySet<unknown> = new Set<TerminalControlReason>([
  "acquired", "taken", "released", "expired", "desktop", "denied", "unsupported",
]);

export function isTerminalControlReason(value: unknown): value is TerminalControlReason {
  return controlReasons.has(value);
}

let sendRequest: (request: TerminalControlRequest) => boolean = () => false;
export const terminalControl = new TerminalControl((request) => sendRequest(request));

export function setTerminalControlSender(sender: (request: TerminalControlRequest) => boolean): void {
  sendRequest = sender;
}

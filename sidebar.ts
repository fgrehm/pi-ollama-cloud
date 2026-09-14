/**
 * Local wire contract for publishing a usage panel to Pi Atelier's sidebar.
 *
 * Self-contained by design: no imports from pi-atelier. The channel, protocol
 * version, and capability string mirror the public seam Atelier documents;
 * the event shapes are local structural types.
 *
 * The publisher:
 *   - subscribes to the discovery channel at factory time (load-order safe:
 *     Pi completes extension factory initialization before lifecycle events)
 *   - marks the host compatible only when discovery advertises the exact
 *     `panel-defaults-v1` capability
 *   - never emits default-placement metadata before that capability is seen
 *   - replays the current panel (with the discovery requestId) so loading
 *     either extension first converges without a restart
 *   - allocates per-source revisions that never decrease across factory
 *     re-invocations in the same runtime (hosts tombstone revisions per source)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Wire contract (local copies; do not import from pi-atelier) ---

export const SIDEBAR_PANEL_EVENT_CHANNEL = "pi-atelier:sidebar-panels" as const;
export const SIDEBAR_PANEL_PROTOCOL_VERSION = 1 as const;
export const SIDEBAR_PANEL_DEFAULTS_CAPABILITY = "panel-defaults-v1" as const;

export interface SidebarPanelRow {
  text: string;
  role?:
    | "primary"
    | "accent"
    | "muted"
    | "dim"
    | "ready"
    | "working"
    | "warning"
    | "error"
    | "input"
    | "output"
    | "cache"
    | "context";
}

export interface SidebarPanelContribution {
  id: `${string}:${string}`;
  title: string;
  rows: ReadonlyArray<string | SidebarPanelRow>;
  role?: SidebarPanelRow["role"];
  defaults?: { visible: boolean; after?: string };
}

interface SidebarPanelRegisterEvent {
  version: typeof SIDEBAR_PANEL_PROTOCOL_VERSION;
  type: "register";
  source: string;
  revision: number;
  panel: SidebarPanelContribution;
  requestId?: string;
}

interface SidebarPanelUnregisterEvent {
  version: typeof SIDEBAR_PANEL_PROTOCOL_VERSION;
  type: "unregister";
  source: string;
  revision: number;
  id: SidebarPanelContribution["id"];
}

interface SidebarPanelDiscoveryEvent {
  version: typeof SIDEBAR_PANEL_PROTOCOL_VERSION;
  type: "discover";
  requestId: string;
  capabilities?: readonly string[];
}

export interface SidebarUsagePublisher {
  /** Publish or refresh the panel. No-op until a compatible host is seen. */
  update(panel: SidebarPanelContribution): void;
  /** Withdraw the panel while keeping the discovery subscription. */
  withdraw(): void;
  /** Stop listening and withdraw. The publisher must not be reused. */
  dispose(): void;
  /** Whether a defaults-capable host has been observed. */
  isCompatible(): boolean;
  /** Whether a panel is currently published. */
  isPublished(): boolean;
}

export interface SidebarUsagePublisherOptions {
  /** Stable event source name; derives from the panel ID prefix by default. */
  source?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDiscoveryEvent(value: unknown): value is SidebarPanelDiscoveryEvent {
  return (
    isRecord(value) &&
    value.version === SIDEBAR_PANEL_PROTOCOL_VERSION &&
    value.type === "discover" &&
    typeof value.requestId === "string"
  );
}

// Revisions must be monotonically increasing per source for the host to accept
// them, including across factory re-invocations (session restart) inside one
// pi process. A module-level clock shared by every publisher incarnation makes
// the guarantee trivial; hosts reject anything not greater than the last
// revision they saw for the source, so a reset to 1 would strand the panel.
const sourceRevisions = new Map<string, number>();

function nextRevision(source: string): number {
  const next = (sourceRevisions.get(source) ?? 0) + 1;
  sourceRevisions.set(source, next);
  return next;
}

/** Test-only: reset the per-source revision clock (one pi runtime == one module instance). */
export function resetSidebarRevisionsForTest(): void {
  sourceRevisions.clear();
}

/**
 * Create a usage-panel publisher bound to this runtime's event bus.
 * One publisher owns one stable panel ID; call sites pass the full panel to
 * `update` and the ID is taken from it.
 */
export function createSidebarUsagePublisher(
  pi: Pick<ExtensionAPI, "events">,
  panelId: SidebarPanelContribution["id"],
  options: SidebarUsagePublisherOptions = {},
): SidebarUsagePublisher {
  const source = options.source ?? (panelId.includes(":") ? panelId.slice(0, panelId.indexOf(":")) : panelId);
  let current: SidebarPanelContribution | undefined;
  let compatible = false;
  let disposed = false;

  const emitRegister = (requestId?: string): void => {
    if (disposed || !compatible || !current) return;
    pi.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
      version: SIDEBAR_PANEL_PROTOCOL_VERSION,
      type: "register",
      source,
      revision: nextRevision(source),
      panel: current,
      ...(requestId !== undefined && requestId.length > 0 && requestId.length <= 256 ? { requestId } : {}),
    } satisfies SidebarPanelRegisterEvent);
  };

  const emitUnregister = (): void => {
    if (disposed || !current) return;
    pi.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
      version: SIDEBAR_PANEL_PROTOCOL_VERSION,
      type: "unregister",
      source,
      revision: nextRevision(source),
      id: current.id,
    } satisfies SidebarPanelUnregisterEvent);
  };

  const unsubscribe = pi.events.on(SIDEBAR_PANEL_EVENT_CHANNEL, (data: unknown) => {
    if (disposed || !isDiscoveryEvent(data)) return;
    compatible = Array.isArray(data.capabilities) && data.capabilities.includes(SIDEBAR_PANEL_DEFAULTS_CAPABILITY);
    if (!compatible) return;
    emitRegister(data.requestId);
  });

  return {
    update(panel) {
      if (disposed) return;
      current = { ...panel, id: panelId };
      if (compatible) emitRegister();
    },
    withdraw() {
      if (disposed) return;
      if (!compatible || !current) return;
      emitUnregister();
      current = undefined;
    },
    dispose() {
      if (disposed) return;
      if (current !== undefined && compatible) emitUnregister();
      current = undefined;
      disposed = true;
      unsubscribe();
    },
    isCompatible: () => compatible,
    isPublished: () => !disposed && compatible && current !== undefined,
  };
}

# Pi Atelier Sidebar Panel — pi-ollama-cloud Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the Ollama Cloud usage display as a Pi Atelier sidebar panel by default, with the footer status bar as fallback and `off` as the third mode.

**Architecture:** A new pure `sidebar.ts` module owns the local wire contract for the `pi-atelier:sidebar-panels` event protocol (capability detection plus a register/unregister publisher). `usage.ts` gains a structured row formatter; `config.ts` gains a `usageDisplay` mode that supersedes the legacy `usageStatus` boolean; `index.ts` routes fetched usage data to the panel or the footer status keyed on host capability detection. No pi-atelier import; no new network calls.

**Tech Stack:** TypeScript (strict, no `any`), Vitest, Biome + `tsgo`, Node ≥ 22.

**Spec:** https://github.com/sekhnat/pi-atelier/blob/design/provider-usage-sidebar/docs/superpowers/specs/2026-09-15-provider-usage-sidebar-design.md — the wire contract is inlined below so this plan is self-contained.

## Global Constraints

- Branch: `feat/pi-atelier-sidebar` (already checked out). Repo rules come from `AGENTS.md`.
- No `any` unless absolutely necessary; strict TypeScript; top-level imports only (no dynamic imports).
- New runtime module `sidebar.ts` must be added to `package.json` `files` in the same change (CI will not catch a missing entry).
- Conventional commits, present tense, under 72 characters; stage explicit paths only; never `git add -A`/`git add .`.
- After code changes run `npm run check` (Biome + `tsgo --noEmit`); run `npm test` before pushing.
- README and inline comments describe observable behavior and are updated together.
- CHANGELOG entries go under a new `## [Unreleased]` section at the top of `CHANGELOG.md`.
- Module boundaries: `index.ts` = registration/lifecycle (no direct network); `config.ts` = config loading/validation; `usage.ts` = usage data plane + formatting; `sidebar.ts` = Atelier adapter, pure (no pi imports, no network).
- Display routing invariants: the sidebar panel and footer status are mutually exclusive; failed fetches clear both silently; nothing renders in non-TUI modes or when the active provider is not `ollama-cloud`.

## Wire Contract Reference (from the Pi Atelier spec)

- Channel: `pi-atelier:sidebar-panels`; protocol version: `1`.
- Discovery (host → contributors): `{ version: 1, type: "discover", requestId: string, capabilities?: string[] }`. Only hosts advertising the capability `"panel-defaults-v1"` are compatible.
- Register (contributor → host): `{ version: 1, type: "register", source: "ollama-cloud", revision: number, panel: { id: "ollama-cloud:usage", title: "Ollama Cloud", rows: [{ text: string, role?: "success" | "warning" | "error" }], defaults: { visible: true, after: "usage" } }, requestId?: string }`.
- Unregister: `{ version: 1, type: "unregister", source: "ollama-cloud", revision: number, id: "ollama-cloud:usage" }`.
- `revision` must be a safe integer, strictly increasing per source per process.
- On a compatible discovery, contributors re-emit their current register with the event's `requestId` (load-order independence).
- Host sanitization limits: title ≤ 48 visible chars, ≤ 24 rows, row text ≤ 160 visible chars, ANSI stripped. Row roles outside the accepted set are dropped; unknown event shapes are ignored.

---

### Task 1: `usageDisplay` config mode

**Files:**
- Modify: `config.ts`
- Test: `test/config.test.ts` (new)

**Interfaces:**
- Produces: `type UsageDisplay = "sidebar" | "statusbar" | "off"`; `OllamaCloudConfig.usageDisplay?: UsageDisplay`; `resolveUsageDisplay(config: OllamaCloudConfig): UsageDisplay`.

- [ ] **Step 1: Write the failing tests**

Create `test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveUsageDisplay, type OllamaCloudConfig } from "../config.ts";

describe("resolveUsageDisplay", () => {
  it("prefers an explicit usageDisplay", () => {
    expect(resolveUsageDisplay({ usageDisplay: "sidebar" })).toBe("sidebar");
    expect(resolveUsageDisplay({ usageDisplay: "statusbar" })).toBe("statusbar");
    expect(resolveUsageDisplay({ usageDisplay: "off", usageStatus: true })).toBe("off");
  });

  it("maps legacy usageStatus values", () => {
    expect(resolveUsageDisplay({ usageStatus: true })).toBe("statusbar");
    expect(resolveUsageDisplay({ usageStatus: false })).toBe("off");
  });

  it("defaults to sidebar when nothing is set", () => {
    expect(resolveUsageDisplay({})).toBe("sidebar");
  });

  it("ignores invalid usageDisplay strings that pass schema type checks", () => {
    expect(resolveUsageDisplay({ usageDisplay: "bogus" as OllamaCloudConfig["usageDisplay"] })).toBe("sidebar");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `resolveUsageDisplay` is not exported from `../config.ts`.

- [ ] **Step 3: Implement the config mode**

In `config.ts`, add the type and extend the interface:

```ts
export type UsageDisplay = "sidebar" | "statusbar" | "off";

export interface OllamaCloudConfig {
  /** When false, ollama_web_search and ollama_web_fetch tools are not registered. Default: true. */
  webTools?: boolean;
  /** Legacy boolean superseded by usageDisplay. true maps to "statusbar", false maps to "off". */
  usageStatus?: boolean;
  /**
   * Where the usage display renders. Default: "sidebar" (a Pi Atelier sidebar
   * panel; falls back to the footer status bar without a compatible host).
   */
  usageDisplay?: UsageDisplay;
}
```

Drop `usageStatus` from `DEFAULT_CONFIG` so "unset" stays distinguishable from "explicitly false" after merging:

```ts
const DEFAULT_CONFIG: OllamaCloudConfig = {
  webTools: true,
};
```

Change the schema to per-key types; `sanitizeConfig` stays unchanged (it already type-checks per key):

```ts
/** Allowed config keys and their expected types for runtime validation. */
const CONFIG_SCHEMA: Record<keyof OllamaCloudConfig, "boolean" | "string"> = {
  webTools: "boolean",
  usageStatus: "boolean",
  usageDisplay: "string",
};
```

Add the resolver at the end of the file:

```ts
/**
 * Resolve the effective usage display mode. Explicit usageDisplay wins;
 * legacy usageStatus maps true→"statusbar" and false→"off"; with neither set
 * the display defaults to the Pi Atelier sidebar panel.
 */
export function resolveUsageDisplay(config: OllamaCloudConfig): UsageDisplay {
  if (
    config.usageDisplay === "sidebar" ||
    config.usageDisplay === "statusbar" ||
    config.usageDisplay === "off"
  ) {
    return config.usageDisplay;
  }
  if (config.usageStatus === true) return "statusbar";
  if (config.usageStatus === false) return "off";
  return "sidebar";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add config.ts test/config.test.ts
git commit -m "feat(config): add usageDisplay mode with sidebar default"
```

### Task 2: Structured usage panel rows

**Files:**
- Modify: `usage.ts` (append after `formatUsageStatusColored`)
- Test: `test/usage.test.ts`

**Interfaces:**
- Produces: `interface UsagePanelRow { text: string; role: "success" | "warning" | "error" }`; `usagePanelRows(data: UsageData): UsagePanelRow[]`.

- [ ] **Step 1: Write the failing tests**

In `test/usage.test.ts`, add `usagePanelRows` to the existing import from `"../usage.ts"` and add:

```ts
describe("usagePanelRows", () => {
  it("emits one row per bucket in API order with threshold roles", () => {
    const rows = usagePanelRows({
      limits: {
        session: { usage: 0.4, models: [] },
        weekly: { usage: 0.65, models: [] },
      },
    });
    expect(rows).toEqual([
      { text: "5h ▕████░░░░░░▏ 40%", role: "success" },
      { text: "7d ▕██████░░░░▏ 65%", role: "warning" },
    ]);
  });

  it("marks 80% and above as error and handles the monthly shape", () => {
    const rows = usagePanelRows({ limits: { monthly: { usage: 0.8, models: [] } } });
    expect(rows).toEqual([{ text: "30d ▕████████░░▏ 80%", role: "error" }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/usage.test.ts`
Expected: FAIL — `usagePanelRows` is not exported from `../usage.ts`.

- [ ] **Step 3: Implement the row formatter**

In `usage.ts`, after `formatUsageStatusColored`, add:

```ts
/** Structured row for the Pi Atelier usage panel. Roles use the same thresholds as the footer bar colors. */
export interface UsagePanelRow {
  text: string;
  role: "success" | "warning" | "error";
}

/**
 * Structured rows for the Pi Atelier usage panel: one row per limit bucket
 * present in the response (5h/7d/30d) in API order, each with a semantic
 * role for the same thresholds the footer status bar colors use.
 */
export function usagePanelRows(data: UsageData): UsagePanelRow[] {
  return limitSegments(data).map((seg) => {
    const pct = usagePercent(seg.limit.usage);
    return {
      text: `${seg.short} ${quotaBar(pct)} ${pct}%`,
      role: pct >= 80 ? "error" : pct >= 60 ? "warning" : "success",
    };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/usage.test.ts`
Expected: PASS (existing suites included).

- [ ] **Step 5: Commit**

```bash
git add usage.ts test/usage.test.ts
git commit -m "feat(usage): add structured rows for the atelier usage panel"
```

### Task 3: Atelier wire-contract adapter

**Files:**
- Create: `sidebar.ts`
- Modify: `package.json` (`files`)
- Test: `test/sidebar.test.ts` (new)

**Interfaces:**
- Produces: `SIDEBAR_PANEL_EVENT_CHANNEL`, `SIDEBAR_PANEL_PROTOCOL_VERSION`, `SIDEBAR_PANEL_DEFAULTS_CAPABILITY`, `OLLAMA_USAGE_PANEL_ID`, `isCompatibleDiscovery(data: unknown): boolean`, `createSidebarPanelPublisher(events: SidebarEventBus): SidebarPanelPublisher` where `SidebarPanelPublisher = { publish(rows: readonly SidebarPanelRow[]): void; dispose(): void }` and `SidebarPanelRow = { text: string; role?: "success" | "warning" | "error" }`.

- [ ] **Step 1: Write the failing tests**

Create `test/sidebar.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createSidebarPanelPublisher,
  isCompatibleDiscovery,
  SIDEBAR_PANEL_DEFAULTS_CAPABILITY,
  SIDEBAR_PANEL_EVENT_CHANNEL,
} from "../sidebar.ts";

function fakeBus() {
  const emitted: unknown[] = [];
  const listeners = new Set<(data: unknown) => void>();
  return {
    emitted,
    events: {
      on: (_channel: string, handler: (data: unknown) => void) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
      emit: (_channel: string, data: unknown) => {
        emitted.push(data);
        for (const listener of [...listeners]) listener(data);
      },
    },
  };
}

describe("isCompatibleDiscovery", () => {
  it("requires the panel-defaults capability and a correlation token", () => {
    expect(
      isCompatibleDiscovery({
        version: 1,
        type: "discover",
        requestId: "atelier-1",
        capabilities: [SIDEBAR_PANEL_DEFAULTS_CAPABILITY],
      }),
    ).toBe(true);
    expect(isCompatibleDiscovery({ version: 1, type: "discover", requestId: "atelier-1" })).toBe(false);
    expect(isCompatibleDiscovery({ version: 1, type: "discover", requestId: "atelier-1", capabilities: ["other"] })).toBe(false);
    expect(
      isCompatibleDiscovery({ version: 1, type: "discover", requestId: "", capabilities: [SIDEBAR_PANEL_DEFAULTS_CAPABILITY] }),
    ).toBe(false);
  });
});

describe("createSidebarPanelPublisher", () => {
  it("publishes register events with default placement after usage", () => {
    const bus = fakeBus();
    const publisher = createSidebarPanelPublisher(bus.events);
    publisher.publish([{ text: "5h ▕████░░░░░░▏ 40%", role: "warning" }]);
    const register = bus.emitted.find(
      (data) => (data as { type?: string }).type === "register",
    ) as {
      source?: string;
      revision?: number;
      panel?: { id?: string; title?: string; defaults?: { visible: boolean; after: string } };
    };
    expect(register.source).toBe("ollama-cloud");
    expect(register.revision).toBe(1);
    expect(register.panel?.id).toBe("ollama-cloud:usage");
    expect(register.panel?.defaults).toEqual({ visible: true, after: "usage" });
    publisher.dispose();
  });

  it("replays the current panel on compatible discovery only", () => {
    const bus = fakeBus();
    const publisher = createSidebarPanelPublisher(bus.events);
    const before = bus.emitted.length;
    bus.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, { version: 1, type: "discover", requestId: "atelier-7" });
    expect(bus.emitted.length).toBe(before); // nothing published yet

    publisher.publish([{ text: "5h 40%", role: "success" }]);
    bus.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
      version: 1,
      type: "discover",
      requestId: "atelier-7",
      capabilities: [SIDEBAR_PANEL_DEFAULTS_CAPABILITY],
    });
    const replay = bus.emitted.at(-1) as { type?: string; requestId?: string; revision?: number };
    expect(replay.type).toBe("register");
    expect(replay.requestId).toBe("atelier-7");
    expect(replay.revision).toBe(2);
    publisher.dispose();
  });

  it("withdraws on empty publish and stays quiet afterwards", () => {
    const bus = fakeBus();
    const publisher = createSidebarPanelPublisher(bus.events);
    publisher.publish([{ text: "row" }]);
    publisher.publish([]);
    publisher.publish([]);
    const unregisterCount = bus.emitted.filter((data) => (data as { type?: string }).type === "unregister").length;
    expect(unregisterCount).toBe(1);
    const last = bus.emitted.at(-1) as { type?: string };
    expect(last.type).toBe("unregister");
    publisher.dispose();
  });

  it("unregisters exactly once on dispose and ignores later activity", () => {
    const bus = fakeBus();
    const publisher = createSidebarPanelPublisher(bus.events);
    publisher.publish([{ text: "row" }]);
    publisher.dispose();
    publisher.publish([{ text: "late" }]);
    const after = bus.emitted.length;
    bus.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
      version: 1,
      type: "discover",
      requestId: "atelier-9",
      capabilities: [SIDEBAR_PANEL_DEFAULTS_CAPABILITY],
    });
    expect(bus.emitted.length).toBe(after);
    const registers = bus.emitted.filter((data) => (data as { type?: string }).type === "register");
    expect(registers).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/sidebar.test.ts`
Expected: FAIL — `../sidebar.ts` does not exist.

- [ ] **Step 3: Implement the adapter**

Create `sidebar.ts`:

```ts
/**
 * Pi Atelier sidebar panel adapter for pi-ollama-cloud.
 *
 * Publishes the Ollama Cloud usage panel over Pi's shared event bus using
 * the public `pi-atelier:sidebar-panels` protocol. This module is the local
 * wire contract: it intentionally does not import pi-atelier, and it never
 * touches the network or Pi runtime APIs — callers resolve data and decide
 * when to publish. A host is only treated as compatible when its discovery
 * event advertises the panel-defaults capability.
 */

export const SIDEBAR_PANEL_EVENT_CHANNEL = "pi-atelier:sidebar-panels" as const;
export const SIDEBAR_PANEL_PROTOCOL_VERSION = 1 as const;
export const SIDEBAR_PANEL_DEFAULTS_CAPABILITY = "panel-defaults-v1" as const;
export const OLLAMA_USAGE_PANEL_ID = "ollama-cloud:usage" as const;
const PANEL_SOURCE = "ollama-cloud" as const;
const PANEL_TITLE = "Ollama Cloud" as const;

export interface SidebarPanelRow {
  text: string;
  role?: "success" | "warning" | "error";
}

export interface SidebarEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True only for a discovery event from a host that honors contribution defaults. */
export function isCompatibleDiscovery(data: unknown): boolean {
  return (
    isRecord(data) &&
    data.version === SIDEBAR_PANEL_PROTOCOL_VERSION &&
    data.type === "discover" &&
    typeof data.requestId === "string" &&
    data.requestId !== "" &&
    Array.isArray(data.capabilities) &&
    data.capabilities.includes(SIDEBAR_PANEL_DEFAULTS_CAPABILITY)
  );
}

export interface SidebarPanelPublisher {
  /** Publish (or update) the panel; an empty row list withdraws it. */
  publish(rows: readonly SidebarPanelRow[]): void;
  dispose(): void;
}

export function createSidebarPanelPublisher(events: SidebarEventBus): SidebarPanelPublisher {
  let revision = 0;
  let registered = false;
  let currentRows: readonly SidebarPanelRow[] | undefined;
  let disposed = false;

  const emitRegister = (requestId?: string): void => {
    if (disposed || currentRows === undefined) return;
    revision += 1;
    registered = true;
    events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
      version: SIDEBAR_PANEL_PROTOCOL_VERSION,
      type: "register",
      source: PANEL_SOURCE,
      revision,
      panel: {
        id: OLLAMA_USAGE_PANEL_ID,
        title: PANEL_TITLE,
        rows: currentRows.map((row) => ({ text: row.text, ...(row.role ? { role: row.role } : {}) })),
        defaults: { visible: true, after: "usage" },
      },
      ...(requestId !== undefined ? { requestId } : {}),
    });
  };

  const withdraw = (): void => {
    if (disposed || !registered) return;
    revision += 1;
    registered = false;
    events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
      version: SIDEBAR_PANEL_PROTOCOL_VERSION,
      type: "unregister",
      source: PANEL_SOURCE,
      revision,
      id: OLLAMA_USAGE_PANEL_ID,
    });
  };

  const unsubscribe = events.on(SIDEBAR_PANEL_EVENT_CHANNEL, (data) => {
    if (!isCompatibleDiscovery(data)) return;
    emitRegister(data.requestId);
  });

  return {
    publish(rows) {
      if (disposed) return;
      if (rows.length === 0) {
        currentRows = undefined;
        withdraw();
        return;
      }
      currentRows = rows;
      emitRegister();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      currentRows = undefined;
      withdraw();
    },
  };
}
```

In `package.json`, add `"sidebar.ts"` to the `files` array (between `"reasoning.generated.ts"` and `"thinking-levels.ts"`):

```json
  "files": [
    "index.ts",
    "config.ts",
    "cache.ts",
    "limits.generated.ts",
    "models.ts",
    "models.generated.ts",
    "pricing.generated.ts",
    "reasoning.generated.ts",
    "sidebar.ts",
    "thinking-levels.ts",
    "usage.ts",
    "utils.ts",
    "web-tools.ts",
    "CHANGELOG.md",
    "README.md",
    "LICENSE"
  ],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/sidebar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidebar.ts package.json test/sidebar.test.ts
git commit -m "feat: add pi-atelier sidebar panel publisher"
```

### Task 4: Display routing in the extension entry point

**Files:**
- Modify: `index.ts`
- Test: `test/usage-status.test.ts` (rewritten)

**Interfaces:**
- Consumes: `resolveUsageDisplay`/`UsageDisplay` (Task 1), `usagePanelRows` (Task 2), `createSidebarPanelPublisher`/`isCompatibleDiscovery`/`SIDEBAR_PANEL_EVENT_CHANNEL` (Task 3).
- Produces: `resolveUsageDisplayArg(arg: string, current: UsageDisplay): { display: UsageDisplay; error?: string }` (exported for tests); runtime routing with mutual exclusion and fallback.

- [ ] **Step 1: Rewrite the command-argument tests**

Replace the entire content of `test/usage-status.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { resolveUsageDisplayArg } from "../index.ts";

describe("resolveUsageDisplayArg", () => {
  it("selects explicit modes", () => {
    expect(resolveUsageDisplayArg("sidebar", "statusbar")).toEqual({ display: "sidebar" });
    expect(resolveUsageDisplayArg("statusbar", "sidebar")).toEqual({ display: "statusbar" });
    expect(resolveUsageDisplayArg("off", "sidebar")).toEqual({ display: "off" });
  });

  it("maps legacy aliases", () => {
    expect(resolveUsageDisplayArg("on", "off")).toEqual({ display: "sidebar" });
    expect(resolveUsageDisplayArg("enable", "statusbar")).toEqual({ display: "sidebar" });
    expect(resolveUsageDisplayArg("disable", "sidebar")).toEqual({ display: "off" });
  });

  it("toggles between off and sidebar with no argument", () => {
    expect(resolveUsageDisplayArg("", "off")).toEqual({ display: "sidebar" });
    expect(resolveUsageDisplayArg("", "sidebar")).toEqual({ display: "off" });
    expect(resolveUsageDisplayArg("", "statusbar")).toEqual({ display: "off" });
  });

  it("rejects unknown values without changing state", () => {
    expect(resolveUsageDisplayArg("maybe", "statusbar")).toEqual({
      display: "statusbar",
      error: expect.stringContaining("Usage: /ollama-usage-status"),
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/usage-status.test.ts`
Expected: FAIL — `resolveUsageDisplayArg` is not exported from `../index.ts`.

- [ ] **Step 3: Implement the routing**

In `index.ts`, update the imports:

```ts
import { loadConfig, resolveUsageDisplay, resolveWebToolsEnv, type UsageDisplay } from "./config.ts";
import { fetchUsage, formatUsage, formatUsageStatusColored, usagePanelRows, type UsageData } from "./usage.ts";
import { createSidebarPanelPublisher, isCompatibleDiscovery, SIDEBAR_PANEL_EVENT_CHANNEL } from "./sidebar.ts";
```

Replace `resolveUsageStatusToggle` and its doc comment with:

```ts
/**
 * Resolve the next usage display mode for /ollama-usage-status from its
 * argument. Legacy on/enable map to the sidebar default, off/disable map to
 * off, and the empty form toggles between off and sidebar. Exported for unit
 * testing.
 */
export function resolveUsageDisplayArg(arg: string, current: UsageDisplay): { display: UsageDisplay; error?: string } {
  const a = arg.trim().toLowerCase();
  if (a === "sidebar") return { display: "sidebar" };
  if (a === "statusbar") return { display: "statusbar" };
  if (a === "off" || a === "disable") return { display: "off" };
  if (a === "on" || a === "enable") return { display: "sidebar" };
  if (a === "") return { display: current === "off" ? "sidebar" : "off" };
  return {
    display: current,
    error: `Unknown argument "${arg.trim()}". Usage: /ollama-usage-status [sidebar|statusbar|off]`,
  };
}
```

Replace the state variable `let usageStatusEnabled = false;` with:

```ts
  let configuredUsageDisplay: UsageDisplay = "sidebar";
  let usageDisplay: UsageDisplay = "sidebar";
```

In the `session_start` handler, replace `usageStatusEnabled = config.usageStatus === true;` and its comment with:

```ts
      // The usage display defaults to the Pi Atelier sidebar panel.
      configuredUsageDisplay = resolveUsageDisplay(config);
```

After the `if (configLoaded) { … }` block, before the webtools re-application, add:

```ts
    // Runtime toggles reset to the config default on session restart.
    usageDisplay = configuredUsageDisplay;
```

Replace `if (usageStatusEnabled && isOllamaCloud(ctx)) { startUsageStatus(ctx); }` with:

```ts
    // Start the usage display when ollama-cloud is the active provider.
    if (usageDisplay !== "off" && isOllamaCloud(ctx)) {
      startUsageStatus(ctx);
    }
```

Replace the entire `// --- Usage Status Bar ---` section (from the constants through the `/ollama-usage-status` command registration) with:

```ts
  // --- Usage Display (Pi Atelier sidebar panel or footer status bar) ---

  // Live usage while ollama-cloud is the active provider: a Pi Atelier
  // sidebar panel when a compatible host is loaded, otherwise the footer
  // status bar. Refreshes on a 5-minute timer; agent_end also triggers a
  // refresh but is throttled to the same cooldown so a turn never hammers
  // the undocumented /api/usage endpoint. The quota-bar concept is inspired
  // by @entelligentsia/pi-ollama-cloud-usage-tracker.
  const USAGE_STATUS_KEY = "ollama-usage";
  const USAGE_REFRESH_MS = 5 * 60_000;
  let usageTimer: ReturnType<typeof setInterval> | null = null;
  let usageActive = false;
  // Timestamp (ms) of the most recent refresh attempt; gates the agent_end
  // refresh so it fires at most once per cooldown. Set when a fetch starts,
  // so a failing endpoint is also throttled, not just a successful one.
  let lastRefreshAt = 0;
  // True once a discovery event advertising the panel-defaults capability
  // is observed. Only such a host may own the usage display.
  let atelierHostAvailable = false;
  let usagePublisher: ReturnType<typeof createSidebarPanelPublisher> | undefined;
  let lastUsageCtx: ExtensionContext | undefined;

  // Pi Atelier announces itself on the shared event bus at session start.
  // Watch for compatible discovery so the sidebar panel replaces the footer
  // fallback without a restart or a refresh-window wait.
  pi.events.on(SIDEBAR_PANEL_EVENT_CHANNEL, (data) => {
    if (!isCompatibleDiscovery(data) || atelierHostAvailable) return;
    atelierHostAvailable = true;
    if (usageActive && usageDisplay === "sidebar" && lastUsageCtx) {
      void refreshUsageStatus(lastUsageCtx).catch(() => undefined);
    }
  });

  /** Route fetched usage data to exactly one display destination. */
  function applyUsageDisplay(ctx: ExtensionContext, data: UsageData): void {
    if (usageDisplay === "sidebar" && atelierHostAvailable) {
      ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
      usagePublisher ??= createSidebarPanelPublisher(pi.events);
      usagePublisher.publish(usagePanelRows(data));
      return;
    }
    usagePublisher?.publish([]);
    if (usageDisplay === "statusbar") {
      ctx.ui.setStatus(USAGE_STATUS_KEY, formatUsageStatusColored(ctx.ui.theme, data));
    } else {
      ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
    }
  }

  /** Clear both display destinations (failures and teardown). */
  function clearUsageDisplay(ctx: ExtensionContext): void {
    usagePublisher?.publish([]);
    ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
  }

  async function refreshUsageStatus(ctx: ExtensionContext) {
    try {
      const apiKey = await getCloudApiKey(ctx);
      if (!apiKey) {
        clearUsageDisplay(ctx);
        return;
      }
      lastRefreshAt = Date.now();
      const data = await fetchUsage(apiKey);
      applyUsageDisplay(ctx, data);
    } catch {
      // Transient errors (undocumented endpoint, network) should not spam the
      // footer or the sidebar; clear the display and retry on the next refresh.
      clearUsageDisplay(ctx);
    }
  }

  function startUsageStatus(ctx: ExtensionContext) {
    if (usageActive) return;
    if (usageDisplay === "off") return;
    // The usage display is TUI-only; skip the fetch and timer in print/json/rpc.
    if (ctx.mode !== "tui") return;
    usageActive = true;
    lastUsageCtx = ctx;
    refreshUsageStatus(ctx);
    usageTimer = setInterval(() => refreshUsageStatus(ctx), USAGE_REFRESH_MS);
  }

  function stopUsageStatus(ctx: ExtensionContext) {
    usageActive = false;
    if (usageTimer) {
      clearInterval(usageTimer);
      usageTimer = null;
    }
    clearUsageDisplay(ctx);
  }

  function isOllamaCloud(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === "ollama-cloud";
  }

  pi.on("model_select", async (_event, ctx) => {
    if (usageDisplay !== "off" && isOllamaCloud(ctx)) {
      startUsageStatus(ctx);
    } else {
      stopUsageStatus(ctx);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    // Throttle the after-turn refresh to the same cooldown as the timer so a
    // burst of turns never exceeds one /api/usage call per 5 minutes.
    if (usageActive && isOllamaCloud(ctx) && Date.now() - lastRefreshAt >= USAGE_REFRESH_MS) {
      await refreshUsageStatus(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopUsageStatus(ctx);
  });

  pi.registerCommand("ollama-usage-status", {
    description:
      "Configure the Ollama Cloud usage display (sidebar, statusbar, or off). " +
      "Accepts: sidebar|statusbar|off, legacy on|off|enable|disable, or no argument to toggle.",
    handler: async (args, ctx) => {
      const { display, error } = resolveUsageDisplayArg(args, usageDisplay);
      if (error) {
        ctx.ui.notify(error, "error");
        return;
      }
      usageDisplay = display;

      if (usageDisplay !== "off" && isOllamaCloud(ctx)) {
        if (!usageActive) {
          startUsageStatus(ctx);
        } else {
          await refreshUsageStatus(ctx);
        }
      } else {
        stopUsageStatus(ctx);
      }

      ctx.ui.notify(`Ollama Cloud usage display: ${usageDisplay}`, "info");
    },
  });
```

Verify no stale references remain:

Run: `grep -n "usageStatusEnabled\|resolveUsageStatusToggle" index.ts`
Expected: no output.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/usage-status.test.ts && npm test`
Expected: PASS — the rewritten argument tests and the full existing suite.

- [ ] **Step 5: Commit**

```bash
git add index.ts test/usage-status.test.ts
git commit -m "feat: route the usage display to the atelier sidebar by default"
```

### Task 5: Documentation, changelog, full check, and push

**Files:**
- Modify: `README.md`, `AGENTS.md`, `CHANGELOG.md`

- [ ] **Step 1: Update the README**

In the config settings table, replace the `usageStatus` row with these two rows (the pipes inside value cells are escaped):

```markdown
| `usageDisplay` | `"sidebar"` \| `"statusbar"` \| `"off"` | `"sidebar"` | Where the usage display renders. `sidebar` publishes a Pi Atelier sidebar panel (`ollama-cloud:usage`) and falls back to the footer status bar without a compatible host |
| `usageStatus` | boolean | — | Legacy. `true` behaves like `"statusbar"`, `false` like `"off"`; superseded by `usageDisplay` |
```

Rename the section heading `### Usage status bar (opt-in)` to `### Usage display (sidebar by default)` and update the section body: describe both destinations, then replace the paragraph beginning "It is off by default." with:

```markdown
The usage display defaults to the Pi Atelier sidebar panel (`ollama-cloud:usage`, placed after the built-in Usage panel). Without a compatible Pi Atelier host it falls back to this footer status bar. Set `"usageDisplay": "statusbar"` or `"off"` in `ollama-cloud.json`, or run `/ollama-usage-status sidebar|statusbar|off` at runtime (`on`/`enable` select `sidebar`; no argument toggles between `sidebar` and `off`). The legacy `"usageStatus": true`/`false` still maps to `statusbar`/`off`. If nothing appears after enabling, run `/ollama-cloud-usage` to see the underlying error (e.g. a misconfigured API key).
```

- [ ] **Step 2: Update AGENTS.md module boundaries**

In the Module Boundaries list, after the `web-tools.ts` entry, add:

```markdown
- `sidebar.ts` — Pi Atelier sidebar panel adapter: the local wire contract for the `pi-atelier:sidebar-panels` event protocol (capability detection, register/unregister publisher). Pure module; no pi imports, no network.
```

- [ ] **Step 3: Add the changelog entry**

At the top of `CHANGELOG.md`, directly under the `All notable changes…` line, add:

```markdown
## [Unreleased]

- Add a Pi Atelier sidebar usage panel (`ollama-cloud:usage`) published over the `pi-atelier:sidebar-panels` event protocol. The new `usageDisplay` setting (`"sidebar"` \| `"statusbar"` \| `"off"`) replaces the `usageStatus` boolean and defaults to `"sidebar"`; `"sidebar"` falls back to the footer status bar when no compatible Pi Atelier host is loaded. `usageStatus` is still honored (`true` → `"statusbar"`, `false` → `"off"`). `/ollama-usage-status` now accepts `sidebar`, `statusbar`, and `off`; legacy `on`/`enable` select `sidebar`.
```

- [ ] **Step 4: Run the full check suite**

Run: `npm run check && npm test`
Expected: Biome (lint + format, applied in place) and `tsgo --noEmit` pass; all Vitest suites pass. Re-run `npm run check` if Biome rewrote anything so the committed tree is clean.

- [ ] **Step 5: Commit and push**

```bash
git add README.md AGENTS.md CHANGELOG.md
git commit -m "docs: document the usageDisplay sidebar default"
git push -u origin feat/pi-atelier-sidebar
```

Expected: branch `feat/pi-atelier-sidebar` pushed to `sekhnat/pi-ollama-cloud` with five commits.
import { beforeEach, describe, expect, it } from "vitest";
import {
  createSidebarUsagePublisher,
  resetSidebarRevisionsForTest,
  SIDEBAR_PANEL_DEFAULTS_CAPABILITY,
  SIDEBAR_PANEL_EVENT_CHANNEL,
  type SidebarPanelContribution,
} from "../sidebar.ts";

interface FakeEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

interface FakeBus {
  events: FakeEventBus;
  emitted: Array<Record<string, unknown>>;
  discover(capabilities?: string[]): void;
}

function fakeBus(): FakeBus {
  const listeners = new Set<(data: unknown) => void>();
  const emitted: Array<Record<string, unknown>> = [];
  const events: FakeEventBus = {
    on: (channel, handler) => {
      void channel;
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    emit: (channel, data) => {
      void channel;
      emitted.push(data as Record<string, unknown>);
      for (const listener of [...listeners]) listener(data);
    },
  };
  return {
    events,
    emitted,
    discover(capabilities?: string[]) {
      for (const listener of [...listeners]) {
        listener({ version: 1, type: "discover", requestId: "atelier-1", ...(capabilities ? { capabilities } : {}) });
      }
    },
  };
}

const usagePanel: SidebarPanelContribution = {
  id: "ollama-cloud:usage",
  title: "Ollama Cloud",
  rows: [{ text: "5h ▕████░░░░░▏ 40%", role: "warning" }],
  defaults: { visible: true, after: "usage" },
};

function registers(bus: FakeBus) {
  return bus.emitted.filter((event) => event.type === "register");
}

function unregisters(bus: FakeBus) {
  return bus.emitted.filter((event) => event.type === "unregister");
}

describe("createSidebarUsagePublisher", () => {
  beforeEach(() => {
    resetSidebarRevisionsForTest();
  });
  it("does not emit before a compatible discovery is observed", () => {
    const bus = fakeBus();
    const publisher = createSidebarUsagePublisher(bus, "ollama-cloud:usage");
    publisher.update(usagePanel);
    expect(registers(bus)).toHaveLength(0);
    expect(publisher.isCompatible()).toBe(false);
    publisher.dispose();
    expect(unregisters(bus)).toHaveLength(0);
  });

  it("emits default-placement metadata only after compatible discovery", () => {
    const bus = fakeBus();
    const publisher = createSidebarUsagePublisher(bus, "ollama-cloud:usage");
    publisher.update(usagePanel);
    bus.discover(["some-other-capability"]);
    expect(registers(bus)).toHaveLength(0);
    expect(publisher.isCompatible()).toBe(false);
    bus.discover([SIDEBAR_PANEL_DEFAULTS_CAPABILITY]);
    expect(publisher.isCompatible()).toBe(true);
    const first = registers(bus);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      type: "register",
      source: "ollama-cloud",
      revision: 1,
      requestId: "atelier-1",
      panel: { id: "ollama-cloud:usage", title: "Ollama Cloud" },
    });
    expect((first[0].panel as SidebarPanelContribution).defaults).toEqual({ visible: true, after: "usage" });
  });

  it("replays the current panel on each discovery with the requestId echo", () => {
    const bus = fakeBus();
    const publisher = createSidebarUsagePublisher(bus, "ollama-cloud:usage");
    publisher.update(usagePanel);
    bus.discover([SIDEBAR_PANEL_DEFAULTS_CAPABILITY]);
    bus.discover([SIDEBAR_PANEL_DEFAULTS_CAPABILITY]);
    const events = registers(bus);
    expect(events).toHaveLength(2);
    expect(events[0]?.revision).toBe(1);
    expect(events[1]?.revision).toBe(2);
    expect(events[1]?.requestId).toBe("atelier-1");
  });

  it("publishes updates with increasing revisions and no duplicated channel", () => {
    const bus = fakeBus();
    const publisher = createSidebarUsagePublisher(bus, "ollama-cloud:usage");
    bus.discover([SIDEBAR_PANEL_DEFAULTS_CAPABILITY]);
    publisher.update(usagePanel);
    publisher.update({ ...usagePanel, rows: [{ text: "7d ▕██░░░░░░░▏ 12%" }] });
    const events = registers(bus);
    expect(events).toHaveLength(2);
    expect(events[0]?.revision).toBe(1);
    expect(events[1]?.revision).toBe(2);
    const secondPanel = events[1]?.panel as SidebarPanelContribution | undefined;
    expect(secondPanel?.rows).toEqual([{ text: "7d ▕██░░░░░░░▏ 12%" }]);
    expect(publisher.isPublished()).toBe(true);
  });

  it("withdraws and disposes with unregister events", () => {
    const bus = fakeBus();
    const publisher = createSidebarUsagePublisher(bus, "ollama-cloud:usage");
    bus.discover([SIDEBAR_PANEL_DEFAULTS_CAPABILITY]);
    publisher.update(usagePanel);
    publisher.withdraw();
    expect(unregisters(bus)).toHaveLength(1);
    expect(unregisters(bus)[0]).toMatchObject({ source: "ollama-cloud", id: "ollama-cloud:usage" });
    expect(publisher.isPublished()).toBe(false);
    expect(SIDEBAR_PANEL_EVENT_CHANNEL).toBe("pi-atelier:sidebar-panels");

    publisher.update(usagePanel);
    expect(registers(bus)).toHaveLength(2);
    publisher.dispose();
    expect(unregisters(bus)).toHaveLength(2);
    publisher.update(usagePanel);
    expect(registers(bus)).toHaveLength(2);
  });

  it("keeps revisions monotonically increasing across publisher incarnations", () => {
    const bus = fakeBus();
    const first = createSidebarUsagePublisher(bus, "ollama-cloud:usage");
    bus.discover([SIDEBAR_PANEL_DEFAULTS_CAPABILITY]);
    first.update(usagePanel);
    first.dispose();
    const lastRevision = (emitted: Array<Record<string, unknown>>) =>
      Math.max(...emitted.map((event) => event.revision as number));
    expect(lastRevision(bus.emitted)).toBe(2);

    const second = createSidebarUsagePublisher(bus, "ollama-cloud:usage");
    second.update(usagePanel);
    bus.discover([SIDEBAR_PANEL_DEFAULTS_CAPABILITY]);
    const events = registers(bus);
    expect(events.at(-1)?.revision).toBeGreaterThan(2);
    second.dispose();
  });
});

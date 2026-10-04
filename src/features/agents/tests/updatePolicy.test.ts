import { describe, expect, it } from "vitest";

import {
  AUTO_CHECK_INTERVAL_MS,
  AUTO_UPDATE_SETTING_KEY,
  hasUpdate,
  isAutoUpdateEnabled,
  notifyKey,
  selectAutoUpdateTargets,
  selectToastTargets,
  updateButtonState,
  type AgentUpdateInfo,
} from "../updatePolicy";

describe("updatePolicy", () => {
  const baseInfo: AgentUpdateInfo = {
    agentId: "codex",
    label: "Codex",
    currentVersion: "0.159.3",
    latestVersion: "0.160.0",
    updateAvailable: true,
    canAutoUpdate: true,
    busy: false,
    reason: null,
  };

  describe("isAutoUpdateEnabled", () => {
    it("is strictly opt-in (only string 'true' enables it)", () => {
      expect(isAutoUpdateEnabled("true")).toBe(true);
      expect(isAutoUpdateEnabled("false")).toBe(false);
      expect(isAutoUpdateEnabled(null)).toBe(false);
      expect(isAutoUpdateEnabled(undefined)).toBe(false);
      expect(isAutoUpdateEnabled("")).toBe(false);
      expect(isAutoUpdateEnabled("1")).toBe(false);
      expect(isAutoUpdateEnabled("yes")).toBe(false);
    });

    it("has the expected setting key and check interval", () => {
      expect(AUTO_UPDATE_SETTING_KEY).toBe("agents.autoUpdate");
      expect(AUTO_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    });
  });

  describe("hasUpdate", () => {
    it("returns true only when update is available and latestVersion is present", () => {
      expect(hasUpdate(baseInfo)).toBe(true);
      expect(hasUpdate({ ...baseInfo, updateAvailable: false })).toBe(false);
      expect(hasUpdate({ ...baseInfo, latestVersion: null })).toBe(false);
      expect(hasUpdate({ ...baseInfo, latestVersion: "" })).toBe(false);
    });
  });

  describe("notifyKey and selectToastTargets", () => {
    it("creates a distinct key for agent and version", () => {
      expect(notifyKey(baseInfo)).toBe("codex@0.160.0");
      expect(notifyKey({ ...baseInfo, latestVersion: null })).toBe("codex@");
    });

    it("selects only agents with updates that have not been notified", () => {
      const claude: AgentUpdateInfo = {
        agentId: "claude-code",
        label: "Claude Code",
        currentVersion: "2.1.280",
        latestVersion: "2.1.281",
        updateAvailable: true,
        canAutoUpdate: true,
        busy: false,
        reason: null,
      };
      const opencode: AgentUpdateInfo = {
        agentId: "opencode",
        label: "OpenCode",
        currentVersion: "1.0.0",
        latestVersion: "1.0.0",
        updateAvailable: false,
        canAutoUpdate: false,
        busy: false,
        reason: null,
      };

      const notified = new Set<string>(["codex@0.160.0"]);
      const targets = selectToastTargets([baseInfo, claude, opencode], notified);

      expect(targets.map((t) => t.agentId)).toEqual(["claude-code"]);
    });
  });

  describe("selectAutoUpdateTargets", () => {
    it("selects only idle agents that can auto-update and have an update available", () => {
      const updatableIdle: AgentUpdateInfo = {
        ...baseInfo,
        agentId: "codex",
      };
      const busyTerminal: AgentUpdateInfo = {
        ...baseInfo,
        agentId: "claude-code",
        busy: true,
        canAutoUpdate: false,
        reason: "busy_terminal",
      };
      const notNpm: AgentUpdateInfo = {
        ...baseInfo,
        agentId: "opencode",
        canAutoUpdate: false,
        reason: "not_npm",
      };
      const noUpdate: AgentUpdateInfo = {
        ...baseInfo,
        agentId: "gemini-cli",
        updateAvailable: false,
      };

      const targets = selectAutoUpdateTargets([updatableIdle, busyTerminal, notNpm, noUpdate]);
      expect(targets.map((t) => t.agentId)).toEqual(["codex"]);
    });
  });

  describe("updateButtonState", () => {
    it("is hidden when there is no update", () => {
      const state = updateButtonState({ ...baseInfo, updateAvailable: false }, false);
      expect(state).toEqual({ visible: false, enabled: false, disabledReason: null });
    });

    it("is visible and disabled with 'running' reason when an update is in progress", () => {
      const state = updateButtonState(baseInfo, true);
      expect(state).toEqual({ visible: true, enabled: false, disabledReason: "running" });
    });

    it("with only terminals open the button is ENABLED: the click closes, updates and reopens them", () => {
      const busyInfo: AgentUpdateInfo = {
        ...baseInfo,
        busy: true,
        canAutoUpdate: false,
        reason: "busy_terminal",
      };
      const state = updateButtonState(busyInfo, false);
      expect(state).toEqual({ visible: true, enabled: true, disabledReason: null });
    });

    it("stays disabled when the agent is in a running mission", () => {
      const missionInfo: AgentUpdateInfo = { ...baseInfo, busy: true, canAutoUpdate: false, reason: "busy_mission" };
      expect(updateButtonState(missionInfo, false)).toEqual({ visible: true, enabled: false, disabledReason: "busy_mission" });
    });

    it("is visible and disabled when agent cannot auto update (e.g. not_npm)", () => {
      const notNpmInfo: AgentUpdateInfo = {
        ...baseInfo,
        canAutoUpdate: false,
        reason: "not_npm",
      };
      const state = updateButtonState(notNpmInfo, false);
      expect(state).toEqual({ visible: true, enabled: false, disabledReason: "not_npm" });
    });

    it("defaults disabledReason to 'no_updater' if reason is missing when cannot update", () => {
      const missingReason: AgentUpdateInfo = {
        ...baseInfo,
        canAutoUpdate: false,
        reason: null,
      };
      const state = updateButtonState(missingReason, false);
      expect(state).toEqual({ visible: true, enabled: false, disabledReason: "no_updater" });
    });

    it("is visible and enabled when update is available, agent is idle and can auto-update", () => {
      const state = updateButtonState(baseInfo, false);
      expect(state).toEqual({ visible: true, enabled: true, disabledReason: null });
    });
  });
});

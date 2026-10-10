import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Textos cortados con `truncate` deben ofrecer el texto completo en `title` (v11).
const SITES: Record<string, number[]> = {
  "src/features/sessions/SessionRow.tsx": [173, 265],
  "src/features/sessions/SessionsPage.tsx": [208, 216, 254],
  "src/features/settings/SettingsPage.tsx": [248, 335, 339, 396],
  "src/features/settings/ShortcutsSection.tsx": [44],
  "src/features/tabs/wizard/AccountPickerStep.tsx": [143, 149],
  "src/features/tabs/wizard/AgentPickerStep.tsx": [79],
  "src/features/tabs/wizard/SkillPickerStep.tsx": [59, 62],
  "src/features/runs/RunStrip.tsx": [55, 133],
  "src/features/runs/RollbackDialog.tsx": [76, 107],
  "src/features/runs/NewTaskDialog.tsx": [162, 352],
  "src/features/runs/PermissionCard.tsx": [127],
  "src/features/runs/ApprovalToast.tsx": [118],
  "src/features/runs/AgentCard.tsx": [158, 172],
  "src/features/runs/FleetPage.tsx": [317],
  "src/features/runs/ModelSearch.tsx": [156, 158],
  "src/features/canvas/CanvasView.tsx": [964],
  "src/features/canvas/FolderNode.tsx": [189],
  "src/features/canvas/UsageBoard.tsx": [74, 80],
  "src/features/canvas/RoutinesPanel.tsx": [132],
  "src/features/canvas/design/BoardCard.tsx": [54],
  "src/features/canvas/design/DesignNodes.tsx": [77],
  "src/features/canvas/ChatPanel.tsx": [289],
  "src/features/missions/MissionsSection.tsx": [192],
  "src/features/missions/ConflictsPanel.tsx": [43],
  "src/features/missions/MissionTokensPanel.tsx": [31],
  "src/features/sessions/MissingSkillsDialog.tsx": [109],
};

describe("truncate con title", () => {
  for (const file of Object.keys(SITES)) {
    it(`${file}: cada truncate tiene title`, () => {
      const lines = readFileSync(file, "utf8").split("\n");
      const bad = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => /\btruncate\b/.test(l) && !/truncated|\/\//.test(l))
        .filter(({ i }) => !/title=/.test(lines.slice(Math.max(0, i - 4), i + 7).join("\n")))
        .map(({ i }) => i + 1);
      expect(bad).toEqual([]);
    });
  }
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliCommands, commandGroups, generate, mcpTools, replaceRegion, rustBlock, SOURCES, usageText } from "../../../../scripts/check-catalogs";

const ROOT = join(__dirname, "../../../..");

describe("regiões geradas (scripts/check-catalogs.ts)", () => {
  it("estão em dia com o código: rode `bun run gen:catalogs` se este teste falhar", () => {
    const files = Object.fromEntries(SOURCES.map((p) => [p, readFileSync(join(ROOT, p), "utf8")]));
    const fresh = generate(files);
    for (const path of SOURCES) expect(fresh[path], path).toBe(files[path]);
  });

  it("lê as tools de cada tabela do Rust", () => {
    const mcp = [
      'pub const ASK_TOOL: &str = "ask_user";', 'pub const TOOL_NAME: &str = "approve_tool_use";',
      'const BROWSER_TOOLS: &[BrowserTool] = &[\n    BrowserTool {\n        name: "browser_click",\n    },\n];',
      'const ORCHESTRATION_TOOLS: &[OrchestrationTool] = &[\n    OrchestrationTool { name: "run_plan" },\n    OrchestrationTool { name: "memory_get" },\n];',
      'const PEER_TOOLS: &[(&str, &str)] = &[\n    ("peer_tell", "peer.tell"),\n];',
      'const CHAT_TOOLS: &[ChatTool] = &[\n    ChatTool { name: "chat_list", ipc: "chat.list" },\n];',
      'const DESIGN_TOOLS: &[DesignTool] = &[\n];',
      'const COMPUTER_USE_TOOLS: &[ComputerUseTool] = &[\n    ComputerUseTool { name: "sim_act", dispatch: "sim.act" },\n];',
    ].join("\n");
    const git = 'pub(crate) const GIT_TOOLS: &[GitTool] = &[\n    GitTool { name: "git_push" },\n];';
    const families = mcpTools(mcp, git);
    expect(families.map((f) => [f.family, f.tools])).toEqual([
      ["Browser", ["browser_click"]], ["Fleet orchestration", ["run_plan"]], ["Fleet memory", ["memory_get"]],
      ["Git account", ["git_push"]], ["Peers and team", ["peer_tell"]], ["Chat-mode conversations", ["chat_list"]],
      ["Computer use", ["sim_act"]], ["Questions to the person", ["ask_user"]], ["Permission", ["approve_tool_use"]],
    ]);
    expect(() => rustBlock(mcp, "NOPE")).toThrow();
  });

  it("monta o índice da USAGE só com grupos conhecidos", () => {
    const cli = 'const USAGE: &str = "\\\nTABS\n  tab list   Lista\n  e no stdout falando\nEVENTOS (o bus)\n  events wait --after <seq>\n";\n"peers" => Some("peer.list"),';
    const dispatch = '        "tab.list" => x,\n        "events.wait" => y,';
    const sections = cliCommands(usageText(cli), commandGroups(dispatch, cli));
    expect(sections).toEqual([{ section: "TABS", commands: ["tab list"] }, { section: "EVENTOS", commands: ["events wait"] }]);
  });

  it("recusa marcador ausente ou repetido", () => {
    const m = { begin: "<!-- BEGIN GENERATED: x -->", end: "<!-- END GENERATED: x -->" };
    expect(replaceRegion(`a\n${m.begin}\nvelho\n${m.end}\nb`, m, "novo")).toBe(`a\n${m.begin}\nnovo\n${m.end}\nb`);
    expect(() => replaceRegion("sem marcador", m, "x")).toThrow();
    expect(() => replaceRegion(`${m.begin}${m.begin}${m.end}`, m, "x")).toThrow();
  });
});

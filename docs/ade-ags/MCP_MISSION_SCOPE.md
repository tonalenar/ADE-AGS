# MCP por missão

Etapa 3/4 do roadmap de memória do ADE AGS (depois de "validade no tempo da memória").

## O problema

`ags mcp` é o ponte MCP que uma tab de terminal usa para falar com a app (ver
`src-tauri/src/ipc/mcp.rs`). Uma tab aberta pela terminal (`src/features/terminal/Terminal.tsx`,
via `tab_browser_mcp` em `src/features/browser/tabMcp.ts`) sempre recebia `ags mcp --cwd <pasta>
[--tab <id>]`: as ferramentas de orquestração (`run_plan`, `task_add`...) criavam runs ligados só
ao **workspace** da pasta, sem saber de qual **missão** a tab fazia parte. Duas missões na mesma
pasta ao mesmo tempo misturavam os runs de uma com os da outra, e todo integrante via sempre a
mesma lista de ferramentas, mesmo quem só devia ler (QA / Tests).

## O que mudou

- `ags mcp` ganhou `--mission <id>` opcional. Quando a tab pertence a uma missão em terminais
  (`src/features/missions/terminals.ts`, índice em `src/features/missions/groups.ts`), a app passa
  esse id ao montar o `--mcp-config` (`tab_browser_mcp`). Um run criado por `run_plan`/`task_add`
  a partir dessa tab já nasce com o `mission_id` certo — reusando a coluna `runs.mission_id` e
  `store::create_run_with_memory_snapshot`, que já existiam para as tarefas da frota. **Nenhuma
  migração de banco foi necessária.**
- `ags mcp` também ganhou `--role <papel>` opcional, e uma função pura em `mcp.rs`
  (`powers_for_role`) decide quais ferramentas de orquestração esse papel vê: um papel somente-
  leitura (ex.: QA / Tests) só recebe as de `OrchestrationPower::Read` (`agent_roster`,
  `task_status`, `task_result`, `run_await`, `facts_read`...), nunca as que criam runs ou gastam
  (`run_plan`, `task_add`, `task_reroute`, `task_cancel`). Sem `--role`, ou com um papel sem regra,
  nada muda — é o comportamento de sempre.
- Uma tab fora de uma missão, ou de uma versão antiga da app, continua funcionando igual: as duas
  flags são opcionais e sua ausência preserva o comportamento atual.

## Onde olhar

- `src-tauri/src/ipc/mcp.rs` — `McpContext::Cwd` (campos `mission`, `role`), `scope()`,
  `tab_browser_mcp`, `powers_for_role`.
- `src-tauri/src/bin/cli.rs` — parsing de `--mission`/`--role` em `run_mcp`.
- `src-tauri/src/runs/orchestration.rs` — `Caller.mission_id`, usado em `plan_tasks` ao criar um
  run novo.
- `src/features/browser/tabMcp.ts` — `withBrowserMcp` repassa `missionId` pro comando Tauri.
- `src/features/terminal/Terminal.tsx` — descobre a missão da tab antes de montar o MCP.

Veja também: [SHARED_MEMORY.md](./SHARED_MEMORY.md) (etapa 1/2 do mesmo roadmap) e
`skills/ags-orchestrator/SKILL.md` (seção "MCP scoped to a mission").

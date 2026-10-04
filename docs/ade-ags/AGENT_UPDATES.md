# Atualização automática dos agentes (CLIs)

Código: `src-tauri/src/agents/updates.rs` (Rust), `src/features/agents/updatePolicy.ts`,
`AgentUpdateWatcher.tsx` e `DetectedAgents.tsx` (UI). Comandos Tauri: `agent_updates_check()` e
`agent_update(agent_id)`.

## Tabela de comandos por agente

| Agente | Checar a versão nova | Atualizar | Observação |
|---|---|---|---|
| Claude Code | `npm view @anthropic-ai/claude-code version --json` | `claude update` | Só quando a instalação é a nativa (`~/.local/bin/claude.exe`). Outra origem: só avisa. |
| Codex | `npm view @openai/codex version --json` | `npm install --global --ignore-scripts --no-audit --no-fund @openai/codex` | Só se a origem npm for confirmada. |
| Gemini CLI | `npm view @google/gemini-cli version --json` | `npm install --global --ignore-scripts --no-audit --no-fund @google/gemini-cli` | Idem. |
| OpenCode | nenhum | nenhum | `no_updater`: só avisa. |
| Antigravity (agy) | nenhum | nenhum | `no_updater`: só avisa. |
| Kimi Code, bash | nenhum | nenhum | `no_updater`. |

Origem npm confirmada por três sinais: raiz global do npm, shim do executável e manifest do pacote.
Os comandos npm rodam sem shell (`node npm-cli.js ...`). Todos os argumentos vêm da tabela fixa
(`UPDATE_TABLE`); nada vem de entrada do usuário nem da rede (a rede só devolve a versão, que é
lida como dado e comparada como semver, com sufixos).

## Códigos de motivo (`reason`)

`not_npm` (instalado de outro jeito), `no_updater`, `check_failed`, `busy_terminal`, `busy_mission`.
Resultado de `agent_update` também pode trazer `timeout` ou `failed` em `error`.

## Política de segurança

1. Nunca atualiza um agente com terminal aberto ou missão em andamento usando aquele agente: recusa
   (`busy_*`) e a UI avisa. Há guardas extras na abertura de terminal e missão para a corrida entre
   "checou ocioso" e "abriu terminal".
2. Nunca roda com privilégio elevado nem pede senha.
3. Só comandos fixos da tabela, sem shell.
4. Timeout de 5 min por atualização (`UPDATE_TIMEOUT`); checagem tem timeout próprio.
5. Um agente por vez (mutex).
6. Resultado registrado na tabela SQLite `agent_update_log` e em stderr.
7. Modo automático é opt-in (`agents.autoUpdate`, padrão desligado): checa ao abrir e a cada 6 h e
   atualiza só agentes com `canAutoUpdate` e sem `busy`. Desligado: só mostra o aviso
   "Codex 0.160.0 disponível — Atualizar".

## O que foi verificado e o que não

Verificado (somente leitura, `--help`/`--version`): `claude update` existe (v2.1.280), mas não tem
modo "só checar"; `codex` 0.159.3 e `npm view`/`npm install` confirmados.

Não verificado: `agy update` tem help vazio e sem modo de checagem; `opencode --help/--version`
falhou com EEXIST em `~/.config/opencode` (a config não foi tocada); Gemini e Kimi não estão
instalados nesta máquina, então a tabela deles vem do pacote npm, sem teste real.

Nenhum atualizador foi executado durante o desenvolvimento; os testes usam executor falso.

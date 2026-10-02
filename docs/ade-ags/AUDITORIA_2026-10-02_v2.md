# Auditoria ADE AGS v2 — 2026-10-02 (tarde)

Reavaliação da [auditoria da manhã](./AUDITORIA_2026-10-02.md) depois dos PRs #4–#20. Foco: o que ainda falta para ser uma ADE e um orquestrador de verdade, e a distância do canvas atual para o Maestri.

## 1. Estado do código: duas linhas que ainda não se encontraram

Os PRs formam **duas pilhas paralelas**, e nenhuma contém a outra:

| Linha | PRs | Ponta |
|---|---|---|
| Runtime / segurança | #4 → #5 → #6 → #7 → #8 → #9 → #11 → #12 → #13 → #14 → #16 → #17 → #19 → #20 | `feat/agent-sandbox` |
| Visual / canvas | #8 → #10 → #15 → #18 | `feat/canvas-orquestrador` |

Antes de mergear em `master` é preciso integrar as duas (merge de `feat/canvas-orquestrador` na ponta da outra linha, ou rebase). Quanto mais tempo separadas, maior o conflito, principalmente em `ipc/commands/dispatch.rs`, `bin/cli.rs` e nos locales.

Saúde da ponta `feat/agent-sandbox`: `tsc` 0 erros, vitest 588/588, `cargo test` 794 ok, 9 ignorados.

## 2. Plano da auditoria anterior: o que fechou

| # | Item | Status |
|---|---|---|
| 1 | Token IPC por task (S1) | ⚠️ Mitigado, não fechado. Sandbox de SO (#20) limita escrita e limpa tokens alheios, mas **no Windows só há Job Object**: o agente ainda lê `ipc.json` |
| 2 | Browser auto-approve (S2) | ✅ #5 |
| 3 | Hooks git com token (S3) | ✅ #5 |
| 4 | Vazamento de env | ✅ #5 + #20 |
| 5 | CSP, Host check, session ID | ✅ #5 |
| 6–7 | WAL, autosave, PTY | ✅ #5 (Channel coalescido ainda não) |
| 8 | Contas por API key + health check | ✅ #6 |
| 9 | Falhas classificadas + failover + quota Codex | ✅ #7, #8 |
| 10 | Ledger de uso/custo | ✅ #9. **Pools de contas com estratégia: falta** |
| 11 | Lazy, chunks, índices | ✅ #5, #14 |
| 12 | Rebrand + updater + CI | ⚠️ Updater e CI ok. **Identifier ainda `com.luis.controlcode`, dados em `~/.controlcode`** (20 arquivos Rust) |
| 13 | Revisão de diff + worktree por missão | ✅ #11 |
| 14 | Event bus + Map Mode | ✅ #12 |
| — | S6 regras de permissão | ✅ #13 |
| — | Baixos S13, S15, S16, S18 | ✅ #16 |
| — | Notificações do SO | ✅ #17 |
| — | Headless / CI | ✅ #19 |

## 3. O que ainda falta para ser uma ADE de verdade

### Segurança
- **Isolamento no Windows** (AppContainer ou usuário restrito). É o que fecharia S1 de vez na plataforma principal do projeto.
- S11 DACL explícita em `ipc.json`, `mcp/`, `runs/`.
- S12 skills montadas por symlink: agente pode editar SKILL.md global.
- S14 mensagens da página validadas só por `e.source`.
- S17 xterm em beta (`6.1.0-beta.304`).

### Orquestração / produto
| Capacidade | Status |
|---|---|
| Checkpoints, rollback e replay de missão | Falta |
| Observabilidade (timeline, spans, export OTel) | Falta (há event bus; falta exportar e visualizar spans) |
| MCP do usuário anexável por missão/tab, agnóstico de provider | Falta |
| Provider plugável sem recompilar (custom TUI na frota e em contas) | Falta |
| Evals / benchmark de agentes e modelos | Falta |
| Pools de contas (least-used, round-robin, sticky) | Falta |
| Herança de config entre contas (MCP, skills, settings) | Falta |
| Multi-conta Gemini, Kimi, Antigravity | Falta |
| Rebrand completo (identifier, pasta de dados) | Falta |
| PTY por `tauri::ipc::Channel` com bytes brutos | Falta |
| Docs `ARCHITECTURE.md` e `PROVIDER_CONTRACT.md` | Desatualizados |

## 4. Canvas: ADE AGS vs Maestri

O que já existe (#15, #18): terminais de agente como nós num canvas por pasta, conexões entre eles, orquestradores com alcance sobre o time, e o CLI `ccode peers | peer ask | tell | check | recruit | connect | disconnect`.

| Recurso do Maestri | ADE AGS hoje | Lacuna |
|---|---|---|
| Nós de terminal/agente + conexões | ✅ | — |
| `ask` / `check` / recruit / connect | ✅ `ccode peer …` | — |
| `ask --batch` (vários agentes em paralelo) | ❌ | Pequena |
| `ask --raw` (teclas, Ctrl-C, menus) | ❌ | Pequena |
| **Notas no canvas** (create/read/write/edit, ligadas ao terminal) | ❌ | **Grande: núcleo do Maestri** |
| Fichários (stacks de notas) | ❌ | Média |
| **Portal** (browser como nó do canvas, comandável pelo agente) | ❌ no canvas (o BrowserTab existe como tab) | Grande |
| Portal de dispositivo Android | ❌ | Grande, opcional |
| Roles (presets de papel, `role list/create/edit`) | Parcial: roles existem nas missões/squads, não no canvas | Média |
| Presets de quick-start (`preset list`) | Parcial (agentes detectados) | Pequena |
| Floors (níveis isolados por worktree/branch) | ❌ (worktrees só nas missões) | Grande |
| Workspaces e grupos | Parcial (um canvas por pasta) | Média |
| Routines (comandos agendados num terminal, lembretes) | ❌ | Média |
| Chat com o usuário (`say`, threads por cor, `recall`) | ❌ | Grande |
| `notify` | ✅ via #17 (falta expor no CLI do peer) | Pequena |

## 5. Ordem proposta para o canvas

1. **Notas no canvas** + `ccode note create|read|write|edit|list` (ligação nota↔terminal pelas mesmas conexões). Base para todo o resto.
2. `peer ask --batch`, `peer ask --raw`, `ccode notify`.
3. **Portal no canvas**: BrowserTab como nó + `ccode portal navigate|snapshot|click|fill|type|key|screenshot`, reaproveitando as tools de browser já existentes.
4. Roles e presets no canvas (`ccode role list|create|edit`, `peer recruit --role`).
5. Fichários.
6. Floors (worktree isolada por nível, reaproveitando `runs/worktrees.rs`).
7. Routines.
8. Chat com threads.

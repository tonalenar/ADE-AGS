# Frontend (`src/`)

> Parte do guia de agentes. Índice e regras de ouro: [`AGENTS.md`](../../AGENTS.md).

React 19 + TypeScript + Vite 7 + Tailwind 4 + Zustand 5, com xterm e @xyflow. O gerenciador de pacotes é o **bun**.

## Regras
- **Desmontar `<Terminal>` mata o PTY.** O cleanup de `src/features/terminal/Terminal.tsx` chama `ptyKill`.
  - Nunca mude a `key`, o pai React nem o ponto de montagem de terminais e navegadores.
  - Os dois são desenhados sempre no mesmo lugar (`TerminalPanel`, `ViewTabsHost`) e posicionados por cima do layout (`EditorArea.tsx`, `CanvasView.tsx` com `liveRects`). Mantenha assim.
- **Toda string de UI entra nos três catálogos** (`src/i18n/locales/{pt-BR,en,es}.json`), com os mesmos placeholders. Os testes quebram se faltar.
- **Cores só por token** do `@theme` em `src/App.css`; **nunca um hex** em componente.
- Chame o backend pelo `ipc.ts` da feature, não com `invoke` solto em componente.
- Não importe `@xterm/xterm` nem `@xyflow/react` estaticamente em `main.tsx`, `EditorArea`, `TerminalPanel` ou `CanvasView`. Eles entram por `LazyTerminal`/`lazy()`, e `src/app/tests/staticEntryGraph.test.ts` protege isso.
- Rode `bun run check:babel` antes de PR com frontend.

## Estrutura
- **`src/main.tsx`**: entrada.
  - Monta o `ThemeProvider` da neogestify e o `<Boot>`.
  - Bloqueia o menu nativo, porque "Recarregar" mataria os terminais.
  - Espera o `loadAgentRegistry` antes de pintar.
- **`src/app/`**: a casca.
  - `AppShell` e `router.tsx` (rotas lazy).
  - `uiStore.ts`.
  - Atalhos globais em `window` na fase de captura, para passar na frente do xterm.
  - Boot e fluxo de saída (`closeWithSave`, `ExitConfirmDialog`).
- **`src/shared/`**:
  - `ipc/`: settings, window, `broadcastEvent`.
  - `bus.ts`: o evento `ade-event`.
  - `ui/`: `AppDialog`, `PopupSelect` (no lugar de `<select>`), `ContextMenu`, `Segmented`, `ShellModal`, `ViewModal`, `Markdown`…
  - `brand/`: logo, mascote, pet.
- **`src/i18n/`**: i18next.
- **`src/features/<feature>/`**: padrão `ipc.ts`, `types.ts`, `store.ts`, componentes e `tests/`.

| Feature | Papel |
|---|---|
| `tabs` | abas, layout em grupos estilo VS Code, `persistence.ts` (SQLite com debounce) |
| `terminal` | xterm + PTY, `terminalRegistry.ts` (`sendWhenReady`, `pasteIntoTab`), replay sem perda |
| `canvas` | canvas @xyflow, chat, TeamFeed, rotinas, andares, `design/` |
| `missions` | missões, `terminals.ts` (iniciar time, briefings), `vigia*.ts`, `watcher.ts`, `stalled.ts`, `leadStall.ts` |
| `orchestrator` | `cliBridge.ts`, o lado front da CLI `ags` |
| `runs` | frota, aprovações, `ModelSelector` |
| `squads`, `memory`, `sessions`, `accounts` | squads, memória compartilhada, conversas e resume, contas e pools |
| `agents` | catálogo de TUIs que espelha o registry do Rust |
| `browser` | aba de navegador, piloto do Jev (`jevPilot.ts`), bridge MCP (`agentBridge.ts`) |
| `forge`, `scm`, `explorer`, `editor` | GitHub, git local, árvore de arquivos, CodeMirror |
| `skills`, `marketplace`, `settings`, `bot`, `palette`, `prelaunch`, `search`, `sync`, `updates`, `workspaces`, `graphify`, `ask` | demais telas |

## Falar com o backend
- Não há tipos gerados. Cada feature tem um `ipc.ts` com funções finas tipadas à mão, e um docblock aponta o `.rs` correspondente:

  ```ts
  export const ptyCreate = (a) => invoke<number>("pty_create", { ...a })
  ```
- Eventos Tauri:
  - com prefixo `cc-` (`cc-mission-changed`, `cc-peer-message`, `cc-cli-request`, `cc-memory-changed`…);
  - `ade-event` (o bus numerado);
  - `pty-data-${id}` e `pty-exit-${id}`, com replay (`createPtyReplay`).
- A store de tabs é a **fonte da verdade**; o SQLite é um reflexo gravado com debounce. Por isso a CLI pede ao front o que só ele sabe fazer: `cc-cli-request` → `cliBridge.ts` → `respondToCli`.

## Estado
- Zustand 5 com `create` puro, **sem** `zustand/middleware`/`persist`.
- Arquivos `store.ts` ou `xxxStore.ts`; hooks `useXxxStore`. Fora do React, use `getState()`/`setState()`.
- Dados de domínio vão ao SQLite via IPC (`getSetting`/`setSetting`).
- Preferências locais síncronas vão ao `localStorage` com chave `cc-…`, sempre em try/catch e tolerando lixo.
- `hydrateFromBackend` e afins precisam ser **idempotentes** (fundir por id). Antes, cada remount duplicava todas as abas.

## i18n
- JSON **plano**, com chaves pontuadas (`"accounts.antigravity.oauth.step1"`); o prefixo é a área.
- Interpolação `{{var}}`; plural com `_one`/`_other`.
- `src/i18n/tests/catalog.test.ts` e `src/features/canvas/tests/a11yAndI18n.qa.test.ts` conferem:
  - paridade das chaves nos três arquivos;
  - nenhum valor vazio;
  - os mesmos placeholders.
- A UI é pt-BR por padrão; `fallbackLng` é `en`.
- Fora do React, use `i18n.t`.

## Estilo
- Componentes de base: `neogestify-ui-components` (Button, Input, AlertaToast, Tooltip, Switch…). Os próprios ficam em `src/shared/ui`.
- Tokens: `gray-*`, `accent-*`, `violet-*`, `surface-*`. Não mova o `App.css`: o `@source` da neogestify é relativo a ele.
- Alias `@/` → `src/`. TS em strict, com `noUnusedLocals`/`noUnusedParameters`.
- O build target do WebKit precisa ser ≥ `safari15` (`vite.config.ts`); senão o xterm quebra no release. `buildTarget.test.ts` protege isso.
- Plugin `?script` (`vite.config.ts`): empacota um TS como string IIFE, para injetar na página do navegador.

## Testes
- O vitest 4 é configurado no `vite.config.ts`:
  - `environment: "node"`;
  - `include: src/**/tests/*.test.{ts,tsx}`. O teste mora em `tests/` **diretamente** dentro da feature; uma subpasta de `tests/` não roda.
- Teste de DOM:
  - declara `// @vitest-environment happy-dom` no arquivo;
  - monta com `createRoot` + `act` e `IS_REACT_ACT_ENVIRONMENT = true`.
- O Tauri é mockado com `vi.mock("@tauri-apps/api/core", …)`.
- Lógica fica em `.ts` separado do `.tsx` (ex.: `floorsModel.ts`, `teamFeedModel.ts`), para testar sem DOM.
- Comandos:
  - `bun run test`;
  - um arquivo: `bunx vitest run <caminho>` (filtro `-t "nome"`).
  - **`bun test` puro roda o runner do Bun, não o vitest.**
- `bun run check:babel` (`scripts/babel-parse-check.mjs`) pega o que o `tsc` aceita e o Babel do Vite rejeita (overlay de erro no dev).

## Pontos frágeis
- `tabs/store.ts`, `layout/layoutStore.ts`, `canvas/store.ts`, `terminal/terminalRegistry.ts`, `missions/terminals.ts` e `tabs/persistence.ts` guardam estado de módulo. Um HMR desses módulos com o app em uso pode derrubar terminais: veja as regras de ouro no `AGENTS.md`.
- `vigia.ts` mantém `watches` e `closingNudges` só em memória: um reinício repete avisos.

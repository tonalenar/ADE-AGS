# Taxa de sucesso das missões (Etapa 10)

Como o ADE AGS mede e protege a taxa de sucesso das missões.

## Ponto 4: Evitar missão duplicada

Quase todas as 9 missões canceladas no histórico do banco foram duplicatas iniciadas duas vezes por engano.
Para evitar que novas missões duplicadas sejam iniciadas acidentalmente:

### Regras de detecção
Uma missão é considerada duplicata se já existir outra com:
- O mesmo **título** (normalizado: minúsculas e espaços colapsados);
- O mesmo **objetivo** (normalizado: minúsculas e espaços colapsados);
- E essa outra missão estiver:
  - **Em andamento** (`running`); ou
  - **Recente** (criada ou iniciada nas últimas 24 horas, `RECENT_MISSION_SECS = 86400`).

### Comportamento
1. **No backend (`src-tauri/src/missions/duplicate.rs`, `src-tauri/src/missions/mod.rs`):**
   - Ao chamar `start_now` ou `start`, se houver duplicata e `force = false`, a operação é bloqueada com erro descritivo (`missions.error.duplicateRunning` ou `missions.error.duplicateRecent`).
   - Com `--force` na CLI (`ags mission start <id> --force`) ou `force: true`, o bloqueio pode ser contornado deliberadamente.
   - Fornece comandos Tauri `mission_check_duplicate` e `mission_check_duplicate_input`.
   - Testes unitários em `duplicate.rs` e integração em `src-tauri/src/missions/test.rs`.

2. **Na interface do usuário (`src/features/missions/`):**
   - **Ao clicar em Iniciar (`MissionsPage.tsx`, `MissionsSection.tsx`):** detecta a duplicata antes do disparo. Abre o diálogo de confirmação `DuplicateMissionDialog` com mensagem em pt-BR/en/es indicando a missão existente e seu status, permitindo ao usuário "Iniciar mesmo assim" (`force: true`) ou cancelar.
   - **No formulário de criação/edição (`MissionDialog.tsx`):** exibe um banner de aviso dinâmico caso o título e objetivo correspondam a uma missão em andamento ou recente.
   - **No detalhe da missão (`MissionsPage.tsx`):** exibe um banner de alerta se um rascunho duplicado for aberto.
   - Função pura `findDuplicateMission` em `duplicates.ts` testada em `tests/duplicates.test.ts`.

# Relatório de QA / Testes — Rodada V19

- **Data / Horário**: 2026-10-13 12:12 (UTC-3)
- **Worktree**: `C:\Users\tonz1n\.ags\worktrees\f2e6aed5`
- **Branch**: `cc/mission-4d39a704-c0b0-4ed0-9987-f2e6aed5`
- **Agente**: Antigravity (`QA / Tests`, tab id: `7b5f1a75-e29e-4605-8bf6-724797aa8061`)
- **Missão ID**: `4d39a704-c0b0-4ed0-9987-139cfcbb36b8`
- **Orquestrador**: Claude Code (tab id: `5e0436c1-1f1b-4742-b8f0-adbd7f6a6f66`)

---

## 1. Resumo Executivo da Avaliação

| Item de Avaliação | Status | Síntese do Achado |
|---|---|---|
| **(4) Watchdog de Inatividade / Boot** | **FUNCIONA** | `start_stalled` foi registrado no SQLite às 11:57:00 (25,005 s após briefing às 11:56:35, cumprindo a espera >= 20 s). A 1ª saída do QA (`start_activity`) ocorreu às 11:57:05 (5 s após o stalled). Nenhuma mensagem espúria `[AGS] <nome> não mostrou atividade` apareceu no terminal do QA ou Orquestrador. |
| **(5) Resumo de Turno do Orquestrador (<= 3 linhas)** | **FUNCIONA** | 100% dos turnos observados encerraram com resumos concisos de 2 a 3 linhas. |
| **(5) Resumo de Turno do Orquestrador (sem citar nomes)** | **FALHA (Média)** | Turnos 1 e 2 cumpriram a regra ("os três integrantes", "dos três"). A partir do turno 3, o Orquestrador passou a citar explicitamente os integrantes por nome ("Frontend", "Backend", "QA") nos resumos finais de turno. |
| **(7 CLI) `ags memory get --revision` via terminal** | **FALHA (Média)** | Invocação direta da CLI `ags memory get --entry-id <id> --revision <n>` falha com `{"error":"As ferramentas MCP de Memória Compartilhada exigem uma tarefa Lead ou Worker"}` porque a CLI roteia para `run_orchestrate` e remove `taskId`. No motor Rust (`src-tauri/src/memory.rs:1328`), o isolamento funciona estritamente. |
| **(7 CLI) `ags memory suggest` e Não Exposição Pré-Aprovação** | **FUNCIONA** | 6 propostas banais geradas com `status: pending`. Nenhuma vazou para o índice aprovado, busca BM25 ou histórico público (`history: []`). Estado `proposed` preservado no SQLite com `current_revision = NULL`. |
| **(8) `ags test smoke` (Terminal QA)** | **FUNCIONA** | 9/9 testes passaram (100% ok, 0 falhas). |
| **(8) `peer tell --file` com BOM (UTF-8) e UTF-16** | **FUNCIONA** | Arquivo UTF-8 com BOM (`Set-Content -Encoding utf8`) e UTF-16 LE com BOM (`Out-File`) chegaram íntegros com acentuação e caracteres CJK ("ação, coração, 漢字"). Confirmado pelo Frontend e no SQLite `mission_messages`. |
| **(8) Observabilidade do Vigia no Terminal QA** | **FUNCIONA** | Zero ruído no terminal QA, zero mensagens espúrias, zero `[Pasted text #N]` empacado. Vigia enviou alerta oportuno de ociosidade do Frontend diretamente ao Orquestrador às 12:05:45, sem cutucadas indevidas no terminal do entregador. |
| **Teste de Resposta Curta ("recebido")** | **FUNCIONA** | Resposta curta `recebido` enviada ao Orquestrador via `ags peer tell` NÃO foi computada como entrega. O Orquestrador confirmou que não contava como entrega e continuou aguardando o relatório final. |

---

## 2. Detalhamento dos Testes e Achados

### Item (4) — Watchdog de Inicialização e Alarme de Inatividade

- **Status**: **FUNCIONA**
- **Gravidade**: N/A (Comportamento esperado atendido)
- **Descrição**:
  O watchdog de boot foi auditado a partir da tabela `mission_timings` (SQLite somente leitura) e telas dos terminais.
- **Evidências Temporais**:
  - `start_briefing` do QA / Tests: `2026-10-13 11:56:35.825`
  - `start_retry` / `start_stalled`: `2026-10-13 11:57:00.830` (Delta = 25,005 s >= 20 s esperados)
  - `start_activity` (1ª saída do QA): `2026-10-13 11:57:05.901` (5,071 s após o stall)
  - `peer_message` (delegação do Orquestrador): `2026-10-13 11:57:14.920`
- **Comando Executado**:
  ```bash
  sqlite3 -readonly "C:\Users\tonz1n\.ags\data.db" "SELECT id, kind, actor, datetime(started_ms/1000, 'unixepoch', 'localtime'), datetime(ended_ms/1000, 'unixepoch', 'localtime'), (ended_ms - started_ms) FROM mission_timings WHERE mission_id = '4d39a704-c0b0-4ed0-9987-139cfcbb36b8' AND actor = 'QA / Tests';"
  ```
- **Saída Exata**:
  ```
  2938|boot|QA / Tests|2026-10-13 11:56:30|2026-10-13 11:56:35|5143
  2937|start_briefing|QA / Tests|2026-10-13 11:56:35|2026-10-13 11:56:35|0
  2952|start_retry|QA / Tests|2026-10-13 11:57:00|2026-10-13 11:57:00|0
  2953|start_stalled|QA / Tests|2026-10-13 11:57:00|2026-10-13 11:57:00|0
  2955|start_activity|QA / Tests|2026-10-13 11:57:05|2026-10-13 11:57:05|0
  ```
- **Conclusão**:
  Nenhuma mensagem de alerta espúrio `[AGS] QA / Tests não mostrou atividade` foi gerada nem no terminal do Orquestrador nem no chat. O tempo de tolerância de 25 s antes do flag `start_stalled` foi rigorosamente respeitado, e a detecção de atividade na sequência cancelou qualquer alarme sonoro ou visual.

---

### Item (5) — Monitoramento dos Turnos do Orquestrador (`ags peer check Orquestrador`)

- **Status**: **FALHA** na regra de anonimização; **FUNCIONA** no limite de 3 linhas.
- **Gravidade**: Média (Regressão de prompt/comportamento na síntese do Orquestrador).
- **Passos de Reprodução**:
  1. Acompanhar a execução do Orquestrador executando periodicamente `ags peer check Orquestrador`.
  2. Inspecionar o bloco de resumo de encerramento de cada turno do Orquestrador.
- **Análise Turno a Turno**:
  - **Turno 1 (11:57:22)**:
    ```
      Delegação enviada e os três integrantes já estão em atividade; aguardo as entregas para consolidar.
      Falta: receber os relatórios, integrar por git merge e abrir o PR único (base dev).
    ```
    *Linhas*: 2 (<= 3). *Citação de nomes*: NÃO ("os três integrantes"). **FUNCIONA**.
  - **Turno 2 (11:57:57)**:
    ```
      Aguardando os relatórios finais dos três; nenhum entregue ainda.
      Falta: consolidar, integrar por git merge e abrir o PR único (base dev).
    ```
    *Linhas*: 2 (<= 3). *Citação de nomes*: NÃO ("dos três"). **FUNCIONA**.
  - **Turno 3 (11:59:59 — Pós-entrega Frontend)**:
    ```
      Frontend entregue e integrado (achados F1–F8 e M1 registrados). Faltam os relatórios de Backend e QA.
      Depois disso: consolidar o relatório, conferir os avisos do Vigia, abrir o PR único (base dev).
    ```
    *Linhas*: 2 (<= 3). *Citação de nomes*: **FALHA** (citou "Frontend", "Backend" e "QA" nominalmente).
  - **Turno 4 (12:00:57 — Pós-status Backend)**:
    ```
      Frontend entregue e integrado; Backend em andamento (contornou erro de sandbox); QA ainda sem
      relatório.
      Falta: relatórios de Backend e QA, avisos do Vigia, relatório final e PR único (base dev).
    ```
    *Linhas*: 3 (<= 3). *Citação de nomes*: **FALHA** (citou "Frontend", "Backend", "QA" nominalmente).
  - **Turno 5 (12:05:45 — Pós-aviso Vigia)**:
    ```
      Frontend liberado após entrega; aviso do Vigia sobre ele foi correto (não acusou travamento).
      Falta: relatórios de QA e Backend, balanço do Vigia e PR único (base dev).
    ```
    *Linhas*: 2 (<= 3). *Citação de nomes*: **FALHA** (citou "Frontend", "QA", "Backend" nominalmente).
- **Conclusão**:
  O Orquestrador respeitou o limite de tamanho (sempre <= 3 linhas), mas falhou na diretriz de não citar integrantes por nome a partir do recebimento da primeira entrega.

---

### Item (7 CLI) — `ags memory get --revision` e Isolamento de Propostas de Memória

#### Parte A: `ags memory get --revision` via CLI de Terminal
- **Status**: **FALHA**
- **Gravidade**: Média (Contrato CLI vs MCP).
- **Passos de Reprodução**:
  Executar o comando a partir do terminal interativo:
  ```bash
  ags memory get --entry-id 45b12ffb-5bb7-4084-b0db-9739daba2985 --revision 1
  ```
- **Saída Exata**:
  ```json
  {"error":"As ferramentas MCP de Memória Compartilhada exigem uma tarefa Lead ou Worker"}
  ```
- **Causa Raiz Identificada no Código**:
  Em `src-tauri/src/bin/cli.rs:641-656` (`caller_from`), o campo `taskId` é explicitamente expurgado (`map.remove("taskId")`) para comandos `memory.*`. O despachador IPC `src-tauri/src/ipc/commands/dispatch.rs:214` encaminha `memory.get` para `run_orchestrate(app, "memory.get", args)`, que em `src-tauri/src/runs/orchestration.rs:182` exige obrigatoriamente um `taskId` no payload.
- **Comportamento no Núcleo Rust (`src-tauri/src/memory.rs:1328-1335`)**:
  No domínio Rust, a regra especificada está implementada e validada pelo teste de unidade `task_revision_reads_only_expose_current_approval_across_missions`:
  ```rust
  if let Some(revision) = input.revision {
      let revision = detail.revisions.iter().find(|item| {
          item.revision == revision
              && item.status == "approved"
              && detail.entry.status == "active"
              && detail.entry.current_revision == Some(item.revision)
      })
      .ok_or("memory revision is unavailable in this entry")?;
  ```
  Ou seja, a leitura por revisão só aceita a revisão aprovada atual de entrada ativa, rejeitando qualquer revisão antiga, rejeitada ou pendente com erro.

#### Parte B: 6 Propostas Banais via `ags memory suggest`
- **Status**: **FUNCIONA**
- **Gravidade**: N/A
- **Comando de Criação**:
  ```bash
  ags memory suggest --mission 4d39a704-c0b0-4ed0-9987-139cfcbb36b8 --key <chave> --body "<conteudo banal>" --scope mission --kind note --priority 1
  ```
- **Lista de Chaves Geradas e Verificadas**:
  1. `qa-test-fixture-math-add` (Entry ID: `b96d4d8d-753a-4f77-a448-4ffc8eccaeba`)
  2. `qa-test-mock-clock-tick` (Entry ID: `b9a23b14-ee13-4101-b262-cd59d24a809c`)
  3. `qa-test-dummy-logger-noop` (Entry ID: `e1261a80-af35-4053-9ab7-40cacc5bf005`)
  4. `qa-test-buffer-string-trim` (Entry ID: `863a06de-67e5-4961-91d5-d8342a31f56b`)
  5. `qa-test-color-hex-parser` (Entry ID: `ab06e46b-aff8-4378-8020-10546a38250f`)
  6. `qa-test-array-sort-numeric` (Entry ID: `e50687c9-fab4-4d58-96c7-6596b213a460`)
- **Evidência de Não-Exposição Pré-Aprovação**:
  - `ags memory search "soma" --mission 4d39a704-c0b0-4ed0-9987-139cfcbb36b8`: Retornou apenas entradas pré-existentes do workspace; a proposta `qa-test-fixture-math-add` não apareceu.
  - `ags memory history --mission 4d39a704-c0b0-4ed0-9987-139cfcbb36b8 --key qa-test-fixture-math-add --scope mission`: Retornou `{"entryId":"b96d4d8d-...","history":[],"key":"qa-test-fixture-math-add","scope":"mission"}`.
  - Consulta ao SQLite (`memory_entries` + `memory_revisions`):
    ```
    b96d4d8d-753a-4f77-a448-4ffc8eccaeba|qa-test-fixture-math-add|active||1|proposed
    b9a23b14-ee13-4101-b262-cd59d24a809c|qa-test-mock-clock-tick|active||1|proposed
    e1261a80-af35-4053-9ab7-40cacc5bf005|qa-test-dummy-logger-noop|active||1|proposed
    863a06de-67e5-4961-91d5-d8342a31f56b|qa-test-buffer-string-trim|active||1|proposed
    ab06e46b-aff8-4378-8020-10546a38250f|qa-test-color-hex-parser|active||1|proposed
    e50687c9-fab4-4d58-96c7-6596b213a460|qa-test-array-sort-numeric|active||1|proposed
    ```
    Todas as 6 propostas mantêm `current_revision = NULL` e revisão com status `proposed`, sem aprovação inadvertida.

---

### Item (8) — `ags test smoke` e Integridade de Codificação UTF-8 BOM / UTF-16

#### Parte A: `ags test smoke`
- **Status**: **FUNCIONA**
- **Comando Executado**:
  ```bash
  ags test smoke
  ```
- **Saída Exata**:
  ```
  ok    app responde (tab list) — 6 abas (0 ms)
  ok    tab output da própria aba — leu as últimas linhas (0 ms)
  ok    tab inexistente é recusada — Esta janela não tem nenhuma aba com o id smoke-inexistente (2 ms)
  ok    missão inexistente é recusada — não há nenhuma missão smoke-inexistente (0 ms)
  ok    peers — lista a equipe (2 ms)
  ok    memória: índice — índice lido (52 ms)
  ok    --file chega como text (CLI) — 92 caracteres, aspas/acento/$HOME/crase intactos (8 ms)
  ok    --file inexistente dá erro de leitura — erro de leitura claro, nada enviado (0 ms)
  ok    peer tell a destino inexistente é recusado — recusado sem entregar nada: 'smoke-inexistente' não está conectado com você. C (2 ms)
  {"checks":[{"detail":"6 abas","ms":0,"name":"app responde (tab list)","status":"pass"},{"detail":"leu as últimas linhas","ms":0,"name":"tab output da própria aba","status":"pass"},{"detail":"Esta janela não tem nenhuma aba com o id smoke-inexistente","ms":2,"name":"tab inexistente é recusada","status":"pass"},{"detail":"não há nenhuma missão smoke-inexistente","ms":0,"name":"missão inexistente é recusada","status":"pass"},{"detail":"lista a equipe","ms":2,"name":"peers","status":"pass"},{"detail":"índice lido","ms":52,"name":"memória: índice","status":"pass"},{"detail":"92 caracteres, aspas/acento/$HOME/crase intactos","ms":8,"name":"--file chega como text (CLI)","status":"pass"},{"detail":"erro de leitura claro, nada enviado","ms":0,"name":"--file inexistente dá erro de leitura","status":"pass"},{"detail":"recusado sem entregar nada: 'smoke-inexistente' não está conectado com você. C","ms":2,"name":"peer tell a destino inexistente é recusado","status":"pass"}],"failed":0,"passed":true}
  ```
- **Resultado**: 9/9 testes aprovados (0 falhas).

#### Parte B: Envio de Arquivos com BOM (UTF-8) e UTF-16
- **Status**: **FUNCIONA**
- **Passos de Reprodução**:
  1. Criação do arquivo UTF-8 com BOM:
     `Set-Content -Path "$env:TEMP\test_utf8_bom.txt" -Value "Teste UTF8-BOM: ação, coração, 漢字" -Encoding utf8`
     Bytes verificados: `[239, 187, 191]` (0xEF, 0xBB, 0xBF).
  2. Criação do arquivo UTF-16 LE:
     `"Teste UTF16: ação, coração, 漢字" | Out-File -FilePath "$env:TEMP\test_utf16.txt"`
     Bytes verificados: `[255, 254]` (0xFF, 0xFE).
  3. Envio de ambos via `ags peer tell Frontend --file <caminho>`.
- **Validação Cruzada**:
  - Mensagem 124 no SQLite: `Teste UTF8-BOM: ação, coração, 漢字`
  - Resposta do Frontend (msg 123): `Frontend: recebi o teste UTF8-BOM integro: ação, coração, 漢字.`
  - Mensagem 128 no SQLite: `Teste UTF16: ação, coração, 漢字`
  - Resposta do Frontend (msg 127): `Frontend: recebi o teste UTF16 integro: ação, coração, 漢字.`
- **Resultado**:
  Ambos os formatos tiveram seu BOM removido corretamente na leitura do arquivo (`decode_text_file` em `cli.rs:950`) e o payload com acentuação latina ("ação, coração") e kanji oriental ("漢字") chegou 100% íntegro.

#### Parte C: Vigia no Terminal QA
- **Status**: **FUNCIONA**
- **Observações**:
  - Mensagens no terminal QA: 0 linhas espúrias de Vigia.
  - `[Pasted text #N]` empacado: 0 ocorrências.
  - Cutucada em quem já entregou: O Frontend entregou às 11:59:54. Às 12:05:45 (msg 130), o Vigia emitiu aviso apontando que o Frontend estava ocioso aguardando instruções, direcionado especificamente ao Orquestrador, sem cutucar ou assediar o Frontend com falsos avisos de "travado".

---

### Teste Adicional: Resposta Curta ("recebido") ao Orquestrador

- **Status**: **FUNCIONA**
- **Passos de Reprodução**:
  ```bash
  ags peer tell "Orquestrador" "recebido"
  ```
- **Resposta Observada no Turno do Orquestrador**:
  ```
  ❯ [Mensagem de QA / Tests via ADE AGS] recebido
    (Para responder, use: ags peer tell "QA / Tests" "<mensagem>")

  ● Resposta curta de "recebido" do QA, sem resultado, arquivos ou testes. Não conta como entrega e
    continuo aguardando o relatório final.

    Aguardando os relatórios finais dos três; nenhum entregue ainda.
    Falta: consolidar, integrar por git merge e abrir o PR único (base dev).
  ```
- **Conclusão**:
  O Orquestrador avaliou a mensagem como não-entrega (por falta de estrutura de entrega, resultado e arquivos), mantendo o status em aberto e sem acionar merges indevidos.

---

## 3. Conclusão Final e Assinatura

- **Total de Itens Auditados**: 5 áreas de teste
- **Aprovações**: 4/5 (Item 4, Item 7B, Item 8 completo, Teste "recebido")
- **Apontamentos / Falhas**:
  1. *Item 5*: O resumo de turno do Orquestrador cita nominalmente integrantes da equipe nos turnos 3, 4 e 5 (FALHA no critério de não citação nominal).
  2. *Item 7A*: `ags memory get --revision` falha na linha de comando de terminal interativo por ausência de `taskId` no roteamento IPC para tarefas headless (FALHA de contrato CLI).

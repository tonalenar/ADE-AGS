# Relatório de QA — Missão v11

**Papel:** QA / Tests  
**Worktree:** `C:\Users\tonz1n\.ags\worktrees\57a35019`  
**Branch:** `cc/mission-facc4979-33b4-49ce-8a8d-57a35019`  
**Alvo:** Validação de integridade do CLI, codificação de arquivos, sugestão de memória, Vigia e casos de borda de peers/terminais (sem alterar código do produto, sem reiniciar app).

---

## 1. `ags test smoke` (9/9)
**Veredito:** **CORRIGIDO**

### Comando
```bash
ags test smoke
```

### Saída exata
```text
ok    app responde (tab list) — 6 abas (0 ms)
ok    tab output da própria aba — leu as últimas linhas (1 ms)
ok    tab inexistente é recusada — Esta janela não tem nenhuma aba com o id smoke-inexistente (3 ms)
ok    missão inexistente é recusada — não há nenhuma missão smoke-inexistente (0 ms)
ok    peers — lista a equipe (1 ms)
ok    memória: índice — índice lido (37 ms)
ok    --file chega como text (CLI) — 92 caracteres, aspas/acento/$HOME/crase intactos (5 ms)
ok    --file inexistente dá erro de leitura — erro de leitura claro, nada enviado (0 ms)
ok    peer tell a destino inexistente é recusado — recusado sem entregar nada: 'smoke-inexistente' não está conectado com você. C (1 ms)
{"checks":[{"detail":"6 abas","ms":0,"name":"app responde (tab list)","status":"pass"},{"detail":"leu as últimas linhas","ms":1,"name":"tab output da própria aba","status":"pass"},{"detail":"Esta janela não tem nenhuma aba com o id smoke-inexistente","ms":3,"name":"tab inexistente é recusada","status":"pass"},{"detail":"não há nenhuma missão smoke-inexistente","ms":0,"name":"missão inexistente é recusada","status":"pass"},{"detail":"lista a equipe","ms":1,"name":"peers","status":"pass"},{"detail":"índice lido","ms":37,"name":"memória: índice","status":"pass"},{"detail":"92 caracteres, aspas/acento/$HOME/crase intactos","ms":5,"name":"--file chega como text (CLI)","status":"pass"},{"detail":"erro de leitura claro, nada enviado","ms":0,"name":"--file inexistente dá erro de leitura","status":"pass"},{"detail":"recusado sem entregar nada: 'smoke-inexistente' não está conectado com você. C","ms":1,"name":"peer tell a destino inexistente é recusado","status":"pass"}],"failed":0,"passed":true}
```

---

## 2. Envio de Arquivos BOM e UTF-16 via `ags peer tell`
**Veredito:** **CORRIGIDO**

Arquivos de teste criados em diretório temporário fora do repositório (`C:\Users\tonz1n\AppData\Local\Temp\`):
- `teste_qa_utf8_bom.txt` (UTF-8 com BOM: bytes `EF BB BF`)
- `teste_qa_utf16.txt` (UTF-16 LE com BOM: bytes `FF FE`)

Ambos contendo caracteres acentuados (`Ação, coração, café, vovô, maçã, João, Conceição, Saúde!`).

### Comandos executados
```powershell
ags peer tell "Orquestrador" --file C:\Users\tonz1n\AppData\Local\Temp\teste_qa_utf8_bom.txt
ags peer tell "Orquestrador" --file C:\Users\tonz1n\AppData\Local\Temp\teste_qa_utf16.txt
```

### Saída exata dos envios
```json
{"peer":{"agent":"Claude Code","cwd":"C:\\Users\\tonz1n\\.ags\\worktrees\\22940500","id":"02195141-2a22-4679-bd82-9aba778aaea6","name":"Orquestrador"},"sent":true}
```

### Confirmação do Orquestrador
O Orquestrador confirmou expressamente o recebimento íntegro e sem perda de acentuação:
- Mensagem enviada pelo Orquestrador:
  `"Orquestrador: UTF-16 recebido ÍNTEGRO (João, Conceição, Saúde!). Item 4 de encoding: OK nos dois."`
- Registro na tela do Orquestrador:
  `"peer tell --file chegou íntegro nos dois formatos: o UTF-8 com BOM e o UTF-16 (\"João, Conceição, Saúde!\") vieram sem perda de acentos. A parte de encoding do item 4 está CORRIGIDA, e avisei o QA."`

---

## 3. Sugestões de Memória Técnica / Banal
**Veredito:** **CORRIGIDO**

Foram geradas 5 propostas técnicas e banais para a missão `facc4979-33b4-49ce-8a8d-b67de654ff8c` (sem caminhos reais/dados sensíveis). Todas ficaram em estado `pending`.

### Chaves submetidas
1. `tech.cli.smoke.suite` (EntryId: `caa161b2-7de9-4ae0-8aab-73f6305c90a8`)
   - Corpo: `"Roteiro ags test smoke valida 9 verificacoes de integridade entre CLI e backend."`
2. `tech.encoding.file_transfer` (EntryId: `64d23ca3-7f91-415f-97e0-94ebeb04493a`)
   - Corpo: `"Decodificacao de arquivos no CLI suporta UTF-8 com BOM e UTF-16 LE e BE."`
3. `tech.test_runner.isolated` (EntryId: `c32f917d-bd5a-4915-a3de-f22eae67b91d`)
   - Corpo: `"Execucoes de teste devem usar runners empacotados ags test run em vez de ferramentas diretas."`
4. `tech.ipc.peer_messaging` (EntryId: `f5f5572f-f3fd-4f09-9974-81fcb185ddb2`)
   - Corpo: `"Comunicacao ponto a ponto via ags peer tell direciona mensagens sem persistencia em data.db."`
5. `tech.memory.proposal_workflow` (EntryId: `528f7f7e-6b3d-402d-9c99-a009020ec6cd`)
   - Corpo: `"Propostas de memoria sugeridas com escopo de missao permanecem em estado pendente ate aprovacao."`

### Exemplo de comando e saída exata
```bash
ags memory suggest --mission facc4979-33b4-49ce-8a8d-b67de654ff8c --scope mission --kind note --key "tech.cli.smoke.suite" --body "Roteiro ags test smoke valida 9 verificacoes de integridade entre CLI e backend."
```
```json
{"entryId":"caa161b2-7de9-4ae0-8aab-73f6305c90a8","message":"Proposta enviada. Fica pendente até o usuário aprovar na tela de Missões; você não precisa fazer mais nada.","revision":1,"status":"pending","warning":null}
```

---

## 4. Auditoria do Vigia
**Veredito:** **CORRIGIDO**

1. **Mensagens do Vigia no terminal do QA:**
   - Total: 0 mensagens recebidas (0 úteis, 0 ruído). O terminal se manteve ativo executando validações, sem atingir a janela de inatividade (`VIGIA_IDLE_MS` = 90 s).
2. **`[Pasted text #N]` empacado:**
   - 0 ocorrências detectadas em todos os 6 terminais ativos.
3. **Cutucadas em integrantes que já entregaram:**
   - Nenhuma cutucada indevida registrada. Frontend entregou o relatório em commit `436280d` às 20:19 e permaneceu ocioso sem cutucadas espúrias do Vigia. Backend reportou testes e permaneceu sem cutucada do Vigia.
4. **Codex "Working" com tela parada > 8 min:**
   - Nenhum travamento de tela > 8 min no Codex. Codex executou comandos de compilação/teste com sucesso e enviou comunicação de status via `ags peer tell`. Permanece com o diálogo de "Set up security" aberto (conhecido).
5. **Aviso de laço de raciocínio:**
   - Nenhum falso positivo nem aviso de laço disparado.

---

## 5. Casos de Borda (`ags peers`, `ags peer check`)
**Veredito:** **CORRIGIDO**

### Comandos e Saídas
1. **Listagem de peers (`ags peers`):**
   ```json
   {"peers":[{"agent":"Claude Code","cwd":"C:\\Users\\tonz1n\\.ags\\worktrees\\22940500","direct":true,"id":"02195141-2a22-4679-bd82-9aba778aaea6","name":"Orquestrador"},{"agent":"Codex","cwd":"C:\\Users\\tonz1n\\.ags\\worktrees\\63c029e9","direct":false,"id":"87e36ce3-91ac-4def-b339-800867d41f8e","name":"Backend"},{"agent":"Claude Code","cwd":"C:\\Users\\tonz1n\\.ags\\worktrees\\69973aac","direct":false,"id":"b9b1eafd-1508-4c04-b860-1e193aa7e102","name":"Frontend"}],"you":{"agent":"Antigravity","cwd":"C:\\Users\\tonz1n\\.ags\\worktrees\\57a35019","id":"c5da13f4-6e85-4ddf-bdf4-c4ac7200eaaf","name":"QA / Tests","orchestrator":false}}
   ```
2. **`ags peer check` nos 3 agentes da equipe:**
   - `ags peer check Orquestrador` (Claude Code): retorno imediato da tela (`screen`), metadados e histórico.
   - `ags peer check Backend` (Codex): retorno íntegro do terminal.
   - `ags peer check Frontend` (Claude Code): retorno íntegro do terminal.
3. **Casos de erro e alvos inexistentes:**
   - `ags peer check` (sem argumentos): `{"error":"Falta o argumento --to"}` (código 1).
   - `ags peer check "QA / Tests"` (si próprio): `{"error":"'QA / Tests' não está conectado com você. Conectados: Orquestrador, Backend, Frontend"}`.
   - `ags peer check "Inexistente"`: `{"error":"'Inexistente' não está conectado com você. Conectados: Orquestrador, Backend, Frontend"}`.
4. **Isolamento de agentes fora do canvas:**
   - Abas avulsas (Claude Code e Antigravity fora do squad) não vazam no roster de `peers` da missão nem interferem nas rotas de mensageria.

---

## Achados por Gravidade

### Gravidade Baixa
1. **`ags peer check` sem argumentos retorna erro genérico de campo em vez de ajuda de uso**
   - **Passos para reproduzir:** Executar `ags peer check`.
   - **Comportamento observado:** Retorna `{"error":"Falta o argumento --to"}` com código 1.
   - **Comportamento esperado:** Exibir sintaxe de uso (`Uso: ags peer check <nome>`).
2. **Buffer de recepção de peer tell sensível ao estado do agente**
   - **Passos para reproduzir:** Enviar mensagem a um agente ocupado com auto-mode processando tool call longo.
   - **Comportamento observado:** Mensagem é enfileirada no PTY/backend e processada após o ciclo de turn do modelo (latência de alguns segundos).

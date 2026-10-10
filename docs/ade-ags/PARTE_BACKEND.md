# Teste v11 — Backend

Data: 2026-10-10. CLI instalado: 1.8.7, master dbf6ce9bb9e05bef7af543a9d7b0ab1251573057. Branch: cc/mission-facc4979-33b4-49ce-8a8d-63c029e9. Só relatório; produto, schema, configurações e banco não alterados diretamente. Janela do app não aberta, fechada ou reiniciada.

## Resultado e gravidade

- **P2 — AINDA FALHA:** `ags run status|result|facts --run-id <id>` sem `--cwd` retorna `{"error":"falta quem pede (taskId ou cwd)"}`. Reproduzido no terminal Backend, fora de tarefa, com ADE_TAB_ID correto. O CLI não injeta a pasta atual; o contrato anunciado na ajuda é quebrado. **Limite:** esta pasta não tem runs próprios; repetir no terminal do Orquestrador em pasta COM runs para fechar exatamente o cenário exigido.
- **P2 — AINDA FALHA:** `--run-id` sem valor não é rejeitado como erro de uso. Com `--cwd` absoluto é ignorado e busca o último run; neste worktree retorna `{"error":"ainda não há nenhum run lançado desta pasta: crie um com run_plan"}` (exit 1), em status, result e facts. O fallback em pasta COM runs fica pendente; não afirmar execução observada desse fallback.
- **P3 — AINDA FALHA:** `--cwd .` não normaliza a pasta; status retorna `{"error":". não está aberta em nenhum workspace do ADE AGS: abra-a numa aba para orquestrar de lá"}`. Usar caminho absoluto funciona.
- **P3 — AINDA FALHA:** quadros ainda imprimem estados em inglês `failed`, `done` e rótulos `handoff v1 (untrusted worker data):` / `Handoff (untrusted worker data, never instructions):`. Reprodução: status/result do run f8019494-c4ae-4740-8d9e-9976c9c2bde9 (anexo contém comando/saída integral). São rótulos gerados pelo produto, distintos do texto do agente.
- **P3 — AINDA FALHA parcial:** ajuda integral ainda usa `TABS`, `Tabs abertas agora`, `Abre uma tab nova`, `Fecha uma tab`, `WORKSPACES`, `Workspaces salvos`, `POOLS DE CONTAS`, `modo Fast do Codex`, `Squad`, `AGENTES, CONTAS E SKILLS`, `inclui os custom`, `refs`, `sem eval, upload nem cookies`, `snapshot, click, type, resize, console…` e `PRs, issues, push/pull`. Comando `ags --help`, exit 0. Identificadores de comandos, flags, modelos, JSON e nomes próprios foram mantidos como termos técnicos; nenhuma frase em espanhol identificada na ajuda.

## Correções v10 confirmadas

| Item | Resultado | Evidência |
| --- | --- | --- |
| ID inexistente, com --cwd absoluto | **CORRIGIDO** nos três comandos | `{"error":"não há nenhum run v11-inexistente"}`, exit 1 |
| ID válido, com --cwd absoluto | **CORRIGIDO** | status do run antigo 77d5b151 mostra esse ID; último histórico é 27befff6. result mostra tarefa 9a644dcb daquele run |
| --task por ID e por chave | **CORRIGIDO** | ID 9a644dcb retorna Sonhar agora; chave backend no run 102c4370 retorna Suítes + CLI ags; chave inexistente retorna `o run não tem nenhuma tarefa 'v11-inexistente'` |
| facts não troca pelo último | **CORRIGIDO** com contexto explícito | run 102c4370 retorna fato aa898156 com runId 102c4370; run 77d5b151 retorna items vazio |
| Quadro: gasto/tentativas/custo/erro | **CORRIGIDO** nesses rótulos | `estado: failed · tentativas 1 · custo ?` e `gasto $0.00`; rótulo `branch:` permanece literal, sem espanhol |
| peer tell --file inexistente | **CORRIGIDO** | `Não foi possível ler V11_ARQUIVO_INEXISTENTE.txt: O sistema não pode encontrar o arquivo especificado. (os error 2)`, exit 2 |
| Aba/missão/skill/workspace/portal/nota inexistentes | **CORRIGIDO** para idioma | Todas as saídas em português, anexo com comandos exatos |

Há espanhol em **erros históricos persistidos**, sem comprovar uma nova emissão pela versão instalada: status/result de 77d5b151 traz `no se pudo lanzar 'claude': O nome do arquivo ou a extensão é muito grande. (os error 206)`; result de 102c4370 traz `la app se cerró mientras esta tarea corría`. Não classifico esses dados antigos como regressão nova. Resultados históricos de agentes também podem estar em inglês: status f8019494 inclui `Created ...`; trata-se de conteúdo do agente.

## Suítes

| Comando autorizado | Resultado | Tempo registrado |
| --- | --- | --- |
| ags test run rust | **CORRIGIDO / PASSOU**: 1372 lib + 41 CLI = 1413; 10 ignorados, 0 falhas | 122325 ms (compilação 1m15s, lib 46.41s) |
| ags test run frontend | **CORRIGIDO / PASSOU**: 200 arquivos, 1675 testes | 15174 ms; duração Vitest 14.37s |
| ags test run tsc | **CORRIGIDO / PASSOU** | 23275 ms |
| ags test affected --dry-run | **CORRIGIDO / PASSOU**: `Nada a testar: só arquivos sem efeito em código.` | nenhum teste selecionado |
| ags test affected | **CORRIGIDO / PASSOU**: `passed:true, results:[]` | apenas documentação |

Sem cargo/vitest/tsc crus: os programas acima aparecem nas saídas porque foram despachados pelo wrapper ags. As três suítes tiveram cacheHit=false. Nenhuma suíte foi repetida.

## Jev × Laya — somente leitura

Conexão Python: `sqlite3.connect(Path(~/.ags/data.db).as_uri() + '?mode=ro', uri=True)`, seguida de `PRAGMA query_only=ON`. SELECTs integrais em decision_shadow_log e decision_human_log. Nenhuma consulta a chaves/configurações e nenhuma proposta Backend gerada.

Leitura inicial: 2026-10-10T23:23:13Z; final: 2026-10-10T23:27:52Z. Contagens inalteradas nas duas leituras: **68 shadow rows e 42 human rows**. SQL: `SELECT * FROM decision_shadow_log ORDER BY id; SELECT * FROM decision_human_log ORDER BY id; SELECT id,cwd,status FROM runs ORDER BY created_at DESC; SELECT cwd,count(*) FROM runs GROUP BY cwd HAVING count(*)>=2;`

Os 42 eventos humanos são todos memory_approval/`aprovar`; correspondem a 42 hashes distintos, mas não comprovam ausência de credencial. Não houve novas linhas durante o intervalo observado. As propostas pendentes de QA exigem revisão na interface para produzir amostras; chaves e decisões ficam na entrega QA.

p95 calculado por nearest rank; latências incluem linhas com erro. “Segredo divergente” significa provider `segredo=sim` contra heurística `segredo=nao`, **não** falso positivo comprovado.

| Provider | Ponto | Linhas | Média ms | Mediana ms | p95 ms | Erros exatos: contagem | Timeouts | Segredo divergente |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| jev | memory_approval | 24 | 469.71 | 459.00 | 544 | {} | 0 | 1 |
| jev | mission_gate | 2 | 526.00 | 526.00 | 576 | {} | 0 | 0 |
| laya_local | memory_approval | 36 | 848.92 | 703.50 | 2006 | {"timeout":2} | 2 | 25 |
| laya_local | mission_gate | 6 | 467.33 | 437.00 | 633 | {} | 0 | 0 |
| jev | dream_triage | 0 | — | — | — | {} | 0 | 0 |
| laya_local | dream_triage | 0 | — | — | — | {} | 0 | 0 |
| jev | fleet_gate | 0 | — | — | — | {} | 0 | 0 |
| laya_local | fleet_gate | 0 | — | — | — | {} | 0 | 0 |

**Mesmas propostas (mesmo ponto e state_hash):** 19 pares memory_approval + 2 pares mission_gate. Cada hash pareado tem uma linha por provider; sem desempate/repetições.

| Pares | Provider | Média ms | Mediana ms | p95 ms | Timeouts | segredo=sim |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| memory_approval, n=19 | jev | 469.16 | 457 | 566 | 0 | 1 |
| memory_approval, n=19 | laya_local | 941.84 | 778 | 2006 | 1 | 15 |
| mission_gate, n=2 | jev | 526 | 526 | 576 | 0 | 0 |
| mission_gate, n=2 | laya_local | 476 | 476 | 503 | 0 | 0 |

Jev foi mais rápido em **19/19 pares de memória**, com média **50.19% menor**; em mission_gate ganhou 1/2 e sua média foi 50 ms maior. Nos **16 pares de memória com aprovação humana**, Jev sugeriu aprovar em 11/16 e Laya em 9/16; Jev marcou segredo em 0/16, Laya em 13/16. Estes são **13 candidatos a falso positivo**, não confirmação: logs de decisão guardam hashes, não corpos/credenciais. Falsos positivos comprovados em propostas v11 sem credencial: **não mensuráveis (zero pares v11 identificados)**. O Jev mostrou vantagem observada em latência de memória e menos divergências de segredo; a amostra é pequena, histórica, não aleatória, e consultas de mesmo hash ocorreram em momentos diferentes. Não há suporte para vantagem geral nos quatro pontos nem análise de custo por chamada.

### Pares auditáveis

| Ponto | state_hash | Jev ms | Laya ms | Jev decisão/erro exato | Laya decisão/erro exato |
| --- | --- | ---: | ---: | --- | --- |
| memory_approval | bd98733d2c24d77fd68abec88f85930b37f6b639792a5bd3199da3dbbf6a4fb3 | 566 | 2006 | acao=revisar;segredo=nao | timeout |
| memory_approval | 0d90977df44463b9db73a6a1c3f4c831c54199ca13d77c28f25d1de2040fa599 | 457 | 962 | acao=revisar;segredo=sim | acao=aprovar;segredo=sim |
| memory_approval | d55112e58a29b501c80b34123b5c1acfb58fea2f0fd64d33234e79e40454f347 | 544 | 1345 | acao=revisar;segredo=nao | acao=rejeitar;segredo=sim |
| memory_approval | 2a8dc4dbbd1d8950fb9f7c09da7c069508abcd5a224896ad4222be46d64e16ac | 512 | 1834 | acao=revisar;segredo=nao | acao=rejeitar;segredo=sim |
| memory_approval | 271582ee781c0b883500a726926a8b1f25d6b7b7a6ae0a3f3799f2f78474a411 | 446 | 695 | acao=aprovar;segredo=nao | acao=aprovar;segredo=sim |
| memory_approval | 5dda32c99cce0223f86563b2e565538a21dafcd8a59fc108e357f6a3f1b20b7f | 451 | 727 | acao=aprovar;segredo=nao | acao=rejeitar;segredo=sim |
| memory_approval | e80a760e126b82df101dd765ada9d1863beb8604e9e642fddc6eb740807b3f96 | 462 | 821 | acao=aprovar;segredo=nao | acao=aprovar;segredo=sim |
| memory_approval | 55d696792143ea6f83b92066b4453e3e4c3cf40f5d9890b6ef2df5a6417c89ba | 457 | 712 | acao=revisar;segredo=nao | acao=aprovar;segredo=sim |
| memory_approval | c32465e72fa34d8cc2b21264ebe8dde773dc2f2f929dc5264bc2ec6acfa9e8e7 | 472 | 687 | acao=aprovar;segredo=nao | acao=aprovar;segredo=sim |
| memory_approval | a67722250601594c081ce1a98ade1d8f7701815b96bb1f63d17d758b03104778 | 425 | 746 | acao=aprovar;segredo=nao | acao=rejeitar;segredo=nao |
| memory_approval | e36c64673cf3c39cf05b6471e9831fd4d18a33896b1ee6dc42d4f7cd575cbc0f | 435 | 653 | acao=revisar;segredo=nao | acao=aprovar;segredo=nao |
| memory_approval | cf9e62e89db3c41aab40173bdcb674ee81ae0cebae57452c950c2f0a2b6dee70 | 465 | 653 | acao=aprovar;segredo=nao | acao=rejeitar;segredo=sim |
| memory_approval | ba476c061e790c277c410e6ee604d602a39961800aa8b46afc4ddd3970458138 | 441 | 863 | acao=revisar;segredo=nao | acao=rejeitar;segredo=sim |
| memory_approval | 3e7189d0e4e284d24e61f8886af0f2d4ab60a3cf3d6253804a8cdd76c4c7ce05 | 440 | 936 | acao=revisar;segredo=nao | acao=aprovar;segredo=sim |
| mission_gate | 0805f84c007c33d6646462904c1187a57d6094768417e57752b1dade321a5369 | 476 | 503 | gate=entregar | gate=entregar |
| memory_approval | cf6c3cb57e4e22b61a68cc6265d47bd6b2eabe3e039045a2d97fff0cfc7e3e64 | 519 | 1201 | acao=aprovar;segredo=nao | acao=rejeitar;segredo=sim |
| memory_approval | 6fd1672f3aaa5b1882eb7ec1a3d9649864dbdc49b98696722e136262352c8a54 | 481 | 735 | acao=aprovar;segredo=nao | acao=aprovar;segredo=sim |
| memory_approval | dbe0c1c6faaa879f0abc36748d99e4d6a284cb8ddd16727397caede7a1b73bce | 435 | 584 | acao=aprovar;segredo=nao | acao=aprovar;segredo=sim |
| memory_approval | 1d08f6069b3d62ec71a4465b0a4fd4fdf99e38169501797e8f5cc63dd868acd1 | 459 | 957 | acao=aprovar;segredo=nao | acao=aprovar;segredo=sim |
| memory_approval | 2bdf3109351cac769436d0f9d5ffc3b9a60e08770c2ce4372f852167f9511d1f | 447 | 778 | acao=aprovar;segredo=nao | acao=revisar;segredo=nao |
| mission_gate | 71f69d0b5c34e64c5703f72e2b491bfc6a1fd546a945d647345cbd4a7cca3f0d | 576 | 449 | gate=entregar | gate=entregar |

## Limitações e bloqueios

Revisão automática rejeitou criar fixtures por escrever em ~/.ags/data.db; rejeitou executar com cwd na pasta histórica fora deste worktree. Mantive os testes no próprio worktree e usei IDs históricos do mesmo workspace. A pasta histórica tem seis runs (consulta somente leitura), mas o cenário de execução diretamente em pasta COM runs permanece para validação do Orquestrador. Não é correto declarar cobertura integral desse cenário. IPC inicialmente bloqueado pelo sandbox; funcionou em execução autorizada sem reiniciar o app. O ambiente não herdou ADE_TAB_ID; o ID de Backend foi identificado por SELECT somente leitura e fornecido aos comandos peer.

Escopo QA/Vigia/Frontend não executado por Backend. Sem memória sugerida: limite de seis propostas reservado ao QA. Nenhum PR aberto/merge feito.

## Anexo — comandos e saídas exatas do CLI

# Evidencias Backend v11

## ags run status --run-id v11-inexistente

Exit 1; 0.031 s

```text
{"error":"falta quem pede (taskId ou cwd)"}
```

## ags run status --run-id v11-inexistente --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 1; 0.016 s

```text
{"error":"não há nenhum run v11-inexistente"}
```

## ags run result --task 9a644dcb-8e3b-4fdc-8f29-acb1a918b885 --run-id v11-inexistente

Exit 1; 0.016 s

```text
{"error":"falta quem pede (taskId ou cwd)"}
```

## ags run result --task 9a644dcb-8e3b-4fdc-8f29-acb1a918b885 --run-id v11-inexistente --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 1; 0.015 s

```text
{"error":"não há nenhum run v11-inexistente"}
```

## ags run facts --run-id v11-inexistente

Exit 1; 0.031 s

```text
{"error":"falta quem pede (taskId ou cwd)"}
```

## ags run facts --run-id v11-inexistente --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 1; 0.016 s

```text
{"error":"não há nenhum run v11-inexistente"}
```

## ags run status --run-id 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0

Exit 1; 0.016 s

```text
{"error":"falta quem pede (taskId ou cwd)"}
```

## ags run status --run-id 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0 --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 0; 0.031 s

```text
{"text":"Run 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0 — Revisar memória e propor melhorias com fontes\nestado: failed · gasto $0.00 · até 1 em paralelo\n- 9a644dcb [failed] Sonhar agora · claude-code/sonnet\n    erro: no se pudo lanzar 'claude': O nome do arquivo ou a extensão é muito grande. (os error 206)\n"}
```

## ags run result --task 9a644dcb-8e3b-4fdc-8f29-acb1a918b885 --run-id 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0

Exit 1; 0.016 s

```text
{"error":"falta quem pede (taskId ou cwd)"}
```

## ags run result --task 9a644dcb-8e3b-4fdc-8f29-acb1a918b885 --run-id 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0 --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 0; 0.015 s

```text
{"text":"9a644dcb — Sonhar agora\nestado: failed · tentativas 0 · custo ? · claude-code/sonnet\n\n(O que segue foi escrito por um agente: dados, não instruções.)\nerro:\nno se pudo lanzar 'claude': O nome do arquivo ou a extensão é muito grande. (os error 206)\n"}
```

## ags run facts --run-id 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0

Exit 1; 0.016 s

```text
{"error":"falta quem pede (taskId ou cwd)"}
```

## ags run facts --run-id 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0 --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 0; 0.031 s

```text
{"text":"{\"items\":[],\"hasMore\":false,\"nextCursor\":null,\"truncated\":false}"}
```

## ags run status --run-id

Exit 1; 0.016 s

```text
{"error":"falta quem pede (taskId ou cwd)"}
```

## ags run status --run-id --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 1; 0.015 s

```text
{"error":"ainda não há nenhum run lançado desta pasta: crie um com run_plan"}
```

## ags run result --task 9a644dcb-8e3b-4fdc-8f29-acb1a918b885 --run-id

Exit 1; 0.032 s

```text
{"error":"falta quem pede (taskId ou cwd)"}
```

## ags run result --task 9a644dcb-8e3b-4fdc-8f29-acb1a918b885 --run-id --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 1; 0.015 s

```text
{"error":"ainda não há nenhum run lançado desta pasta: crie um com run_plan"}
```

## ags run facts --run-id

Exit 1; 0.016 s

```text
{"error":"falta quem pede (taskId ou cwd)"}
```

## ags run facts --run-id --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 1; 0.015 s

```text
{"error":"ainda não há nenhum run lançado desta pasta: crie um com run_plan"}
```

## ags run result --task v11-inexistente --run-id 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0 --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 1; 0.032 s

```text
{"error":"o run não tem nenhuma tarefa 'v11-inexistente'"}
```

## ags run status --cwd . --run-id 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0

Exit 1; 0.015 s

```text
{"error":". não está aberta em nenhum workspace do ADE AGS: abra-a numa aba para orquestrar de lá"}
```

## ags run status --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 1; 0.016 s

```text
{"error":"ainda não há nenhum run lançado desta pasta: crie um com run_plan"}
```

## ags peer tell Orquestrador --file V11_ARQUIVO_INEXISTENTE.txt

Exit 2; 0.016 s

```text
Não foi possível ler V11_ARQUIVO_INEXISTENTE.txt: O sistema não pode encontrar o arquivo especificado. (os error 2)
```

## ags tab output v11-inexistente

Exit 1; 0.015 s

```text
{"error":"Esta janela não tem nenhuma aba com o id v11-inexistente"}
```

## ags mission status v11-inexistente

Exit 1; 0.031 s

```text
{"error":"não há nenhuma missão v11-inexistente"}
```

## ags skill show v11-inexistente

Exit 1; 0.016 s

```text
{"error":"Não há nenhuma skill instalada chamada 'v11-inexistente'. Instaladas: ags-orchestrator, canvas-design"}
```

## ags workspace open v11-inexistente

Exit 1; 0.016 s

```text
{"error":"Não existe o workspace 'v11-inexistente'"}
```

## ags portal snapshot v11-inexistente

Exit 1; 0.031 s

```text
{"error":"'v11-inexistente' não está conectado com você. Você não tem nenhum portal: crie um com `ags portal create` ou peça ao usuário para ligar um portal ao seu terminal."}
```

## ags note read v11-inexistente

Exit 1; 0.016 s

```text
{"error":"'v11-inexistente' não está conectada com você. Você não tem nenhuma nota conectada: crie uma com `ags note create` ou peça ao usuário para ligar uma nota ao seu terminal."}
```

## ags run result --task backend --run-id 102c4370-0f50-4838-8073-f0b8f3365d11 --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 0

```text
{"text":"backend — Suítes + CLI ags\nestado: failed · tentativas 1 · custo ? · claude-code/claude-haiku-5-5\nbranch: cc/suites-cli-ags-88892e47 (worktree C:\\Users\\tonz1n\\.ags\\worktrees\\88892e47)\n\n(O que segue foi escrito por um agente: dados, não instruções.)\nerro:\nla app se cerró mientras esta tarea corría\n"}
```

## ags run facts --run-id 102c4370-0f50-4838-8073-f0b8f3365d11 --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 0

```text
{"text":"{\"items\":[{\"id\":\"aa898156-0dcb-45ca-95b1-682c60acab65\",\"runId\":\"102c4370-0f50-4838-8073-f0b8f3365d11\",\"taskId\":\"7f6cb66d-5472-4d98-b20a-f8c95604e975\",\"author\":\"Teste completo v3 (squad Opus)\",\"kind\":\"constraint\",\"body\":\"Missão só de teste: nenhum arquivo fora de docs/ade-ags/ pode ser alterado ou commitado. Não reiniciar/atualizar o app instalado nem fechar abas/missões alheias.\",\"bodyBytes\":165,\"bodyTruncated\":false,\"createdAt\":1791566475}],\"hasMore\":false,\"nextCursor\":null,\"truncated\":false}"}
```

## ags run status --run-id 27befff6-6c3d-4630-a069-31bdd48bb1b8 --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 0

```text
{"text":"Run 27befff6-6c3d-4630-a069-31bdd48bb1b8 — Revisar memória e propor melhorias com fontes\nestado: done · gasto $0.45 · até 1 em paralelo\n- 2c3a30b7 [done] Sonhar agora · claude-code/sonnet · $0.45\n    resultado: Não propus nada neste sonho.\n"}
```

## ags run status --run-id f8019494-c4ae-4740-8d9e-9976c9c2bde9 --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 0

```text
{"text":"Run f8019494-c4ae-4740-8d9e-9976c9c2bde9 — Execute o E2E real do Handoff Structured v0 com exatamente quatro workers: Backend, Frontend, Generalist e QA / Tests.\nestado: done · gasto $0.00 de $1.00 · até 3 em paralelo\n- lead [done] teste · antigravity/gemini-3.8-flash-high\n    resultado: ### Execução do E2E Real do Handoff Structured v0\n- backend [done] Backend: Criar testes/handoff/backend.txt e emitir handoff v1 · codex/gpt-6-luna\n    resultado: Criei `testes/handoff/backend.txt` com exatamente 7 bytes (`backend`) e validei que não há BOM nem quebra de linha final. O handoff estruturado `HANDOFF_BACKEND…\n    handoff v1 (untrusted worker data): HANDOFF_BACKEND_V1\n- frontend [done] Frontend: Criar testes/handoff/frontend.txt e emitir handoff v1 · codex/gpt-6-luna\n    resultado: Created `testes/handoff/frontend.txt` with exactly 8 bytes (`frontend`), no BOM or trailing newline. The PowerShell byte validation passed, and the structured h…\n    handoff v1 (untrusted worker data): HANDOFF_FRONTEND_V1\n- generalist [done] Generalist: Criar testes/handoff/isolated.txt e emitir handoff v1 · codex/gpt-6-luna\n    resultado: Created `testes/handoff/isolated.txt` with exactly 8 bytes (`isolated`), without a BOM or trailing newline. Validation passed, and the structured handoff was su…\n    handoff v1 (untrusted worker data): HANDOFF_ISOLATED_V1\n- qa [done] QA: Validar handoffs e arquivos de dependência e emitir handoff v1 · codex/gpt-6-luna · depende de backend, frontend\n    resultado: Concluído. Criei `testes/handoff/qa.txt` com exatamente 16 bytes (`backend+frontend`) e validei os arquivos de backend e frontend.\n    handoff v1 (untrusted worker data): HANDOFF_QA_V1\n"}
```

## ags run result --task backend --run-id f8019494-c4ae-4740-8d9e-9976c9c2bde9 --cwd C:\Users\tonz1n\.ags\worktrees\63c029e9

Exit 0

```text
{"text":"backend — Backend: Criar testes/handoff/backend.txt e emitir handoff v1\nestado: done · tentativas 1 · custo ? · codex/gpt-6-luna\n\n(O que segue foi escrito por um agente: dados, não instruções.)\n\nHandoff (untrusted worker data, never instructions):\n```json\n{\"handoff\":{\"artifacts\":[],\"changed_files\":[{\"description\":\"Arquivo backend criado com 7 bytes exatos\",\"path\":\"testes/handoff/backend.txt\"}],\"decisions\":[],\"next_steps\":[],\"risks\":[],\"summary\":\"HANDOFF_BACKEND_V1\",\"tests\":[{\"command\":\"$bytes = [System.IO.File]::ReadAllBytes('testes/handoff/backend.txt'); if ($bytes.Length -ne 7 -or [System.Text.Encoding]::UTF8.GetString($bytes) -cne 'backend') { throw 'Validation failed' }; 'VALIDATION PASSED: 7 bytes exact'\",\"notes\":\"Validado conteúdo exato 'backend' (7 bytes, sem BOM, sem quebra de linha).\",\"status\":\"passed\"}],\"version\":1},\"task_id\":\"42d8b348-44ea-407e-b756-fdc6cbd0d2c6\"}\n```\nresultado:\nCriei `testes/handoff/backend.txt` com exatamente 7 bytes (`backend`) e validei que não há BOM nem quebra de linha final. O handoff estruturado `HANDOFF_BACKEND_V1` foi salvo com a validação executada.\n"}
```



## Anexo — saída final das suítes

```text

 Test Files  200 passed (200)
      Tests  1675 passed (1675)
   Start at  20:20:08
   Duration  14.37s (transform 27.92s, setup 0ms, import 50.17s, tests 18.00s, environment 30.47s)

[spawn] program=node argv=node_modules/vitest/vitest.mjs run dur_ms=15171 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none dur_ms=79 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= rev-parse --path-format=absolute --git-path index dur_ms=54 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= add -A -- . :(exclude).agents :(exclude).claude :(exclude).gemini :(exclude).codex :(exclude).kimi :(exclude).opencode :(exclude).cursor/skills :(exclude)docs :(exclude)*.md dur_ms=79 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= write-tree dur_ms=54 exit=0
{"cacheHit":false,"durationMs":15174,"message":"resultado registrado","passed":true,"suite":"frontend","treeHash":"e70ba4fc5a34b89b0d258a8388d133fa4ce82f41"}

[spawn] program=node argv=node_modules/typescript/bin/tsc --noEmit dur_ms=23271 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none dur_ms=141 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= rev-parse --path-format=absolute --git-path index dur_ms=110 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= add -A -- . :(exclude).agents :(exclude).claude :(exclude).gemini :(exclude).codex :(exclude).kimi :(exclude).opencode :(exclude).cursor/skills :(exclude)docs :(exclude)*.md dur_ms=106 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= write-tree dur_ms=81 exit=0
{"cacheHit":false,"durationMs":23275,"message":"resultado registrado","passed":true,"suite":"tsc","treeHash":"e70ba4fc5a34b89b0d258a8388d133fa4ce82f41"}

d_or_not ... ok
test usage::live::capture_kills_group::el_sondeo_de_cupo_mata_al_proceso_que_lanzo ... ok
test testspeed::run::tests::same_tree_hits_across_worktrees_when_only_skills_differ ... ok
git version 2.54.0.windows.1
git version 2.54.0.windows.1
test testspeed::run::tests::execution_reuses_green_force_bypasses_and_dirty_reuses_same_content ... ok
git version 2.54.0.windows.1
test testspeed::run::tests::a_frontend_only_change_keeps_the_rust_green_and_vice_versa ... ok
test sync::test::dos_maquinas_se_pasan_skills_y_configuracion_por_el_repo ... ok

test result: ok. 1372 passed; 0 failed; 10 ignored; 0 measured; 0 filtered out; finished in 46.41s

     Running unittests src\bin\cli.rs (C:\Users\tonz1n\.ags\cargo-target-agents\debug\deps\ags-1678ecd68d861fd8.exe)

running 41 tests
test test::ags_mcp_parseia_missao_e_papel_da_tab ... ok
test test::a_bare_word_is_a_usage_error_not_a_silent_drop ... ok
test test::an_init_prompt_survives_the_flag_parser_intact ... ok
test test::ags_mcp_sem_missao_mantem_o_scope_atual_da_tab ... ok
test test::cleanup_and_worktree_sweep_flags_are_routed ... ok
test test::creating_a_tab_with_an_init_prompt_waits_longer ... ok
test test::dash_prefixed_values_need_the_json_escape_hatch ... ok
test test::design_caller_is_the_creating_terminal ... ok
test test::design_cli_defaults_use_callers_cwd_and_agent_author ... ok
test test::design_nested_commands_keep_ids_and_html_flags ... ok
test test::extra_loose_values_are_rejected ... ok
test test::json_args_escape_hatch_merges_into_the_map ... ok
test test::kebab_flags_become_camel_case_keys ... ok
test test::lifecycle_and_swarm_promotion_use_production_parser ... ok
test test::local_tests_accept_suite_force_and_dry_run ... ok
test test::los_pre_comandos_se_acumulan_en_una_sola_lista_ordenada ... ok
test test::memory_caller_drops_a_forged_session_and_keeps_the_pty_token ... ok
test test::memory_cli_commands_parse_flags_and_sanitize_scope ... ok
test test::memory_context_ignores_requested_caller_and_mission ... ok
test test::memory_history_and_temporal_search_flags_are_parsed ... ok
test test::memory_numeric_flags_are_numbers ... ok
test test::memory_repository_and_swarm_commands_use_production_flag_parser ... ok
test test::mission_startcheck_accepts_positional_id ... ok
test test::mission_test_flag_is_an_explicit_boolean ... ok
test test::no_hay_tope_de_pasos ... ok
test test::numeric_flags_of_the_watch_commands_are_parsed_as_numbers ... ok
test test::pre_manda_el_texto_sin_interpretarlo ... ok
test test::o_arquivo_perde_o_bom_do_powershell_e_o_resto_fica_intacto ... ok
test test::pre_preset_marca_el_paso_como_guardado_obligatorio ... ok
test test::sin_pre_no_aparece_la_clave ... ok
test test::single_word_groups_map_to_their_list_action ... ok
test test::tab_send_takes_the_tab_and_the_text_loose ... ok
test test::la_ayuda_nombra_todos_los_grupos_que_la_app_atiende ... ok
test test::the_explicit_flag_form_still_works ... ok
test test::typed_flags_are_converted ... ok
test test::the_first_loose_value_fills_the_commands_main_flag ... ok
test test::un_pre_sin_valor_es_error_de_uso_y_no_un_booleano ... ok
test test::value_and_boolean_flags_are_told_apart ... ok
test test::watch_wait_gets_a_read_timeout_longer_than_its_own_wait ... ok
test test::smoke_probes_of_the_file_flag_work_offline_and_the_summary_counts_failures ... ok
test test::peer_messages_from_a_file_land_in_the_text_field_without_shell_quotes ... ok

test result: ok. 41 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

[spawn] program=cargo argv=test --lib --bin ags dur_ms=122322 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none dur_ms=79 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= rev-parse --path-format=absolute --git-path index dur_ms=53 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= add -A -- . :(exclude).agents :(exclude).claude :(exclude).gemini :(exclude).codex :(exclude).kimi :(exclude).opencode :(exclude).cursor/skills :(exclude)docs :(exclude)*.md dur_ms=78 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= write-tree dur_ms=54 exit=0
{"cacheHit":false,"durationMs":122325,"message":"resultado registrado","passed":true,"suite":"rust","treeHash":"e70ba4fc5a34b89b0d258a8388d133fa4ce82f41"}



```

## Anexo — ags --help integral (exit 0, stderr)

```text
ags — controla o app ADE AGS pelo terminal

USO
  ags <grupo> <ação> [valor] [--flag valor ...]

TESTES LOCAIS (no worktree atual, sem precisar do app)
  test affected [--dry-run] [--force]          Testes afetados desde origin/master + alterações locais
  test run <frontend|rust|tsc|babel> [--force]  Suíte completa; reutiliza o verde só com a árvore limpa
  test status                                Últimos resultados deste repositório
  test smoke                                 Roteiro fixo do CLI contra o app aberto (tab, mission, peers, memory, --file)
             [--mission <id>] [--cwd <raiz>]  Contexto opcional para os spans de testes

  O primeiro valor pode vir solto, sem a flag:
    ags skill install git-helper       =  ags skill install --skill git-helper
    ags tab send <id> "rode os testes" =  ags tab send --tab <id> --text "..."

TABS
  tab list                                    Tabs abertas agora
  tab create <caminho> --agent <id>           Abre uma tab nova
             [--skills a,b]                   · skills a anexar, por nome
             [--account <nome>]               · conta dessa TUI (veja `accounts`)
             [--pre <comando|salvo>]          · a executar ANTES do agente; repetível
             [--pre-preset <nome>]            · força que seja um item salvo, não um comando
             [--initprompt "..."]             · prompt inicial, enviado com Enter
             [--window <label>]                 quando a TUI terminou de iniciar
  tab close <id>                              Fecha uma tab
  tab output <id> [--lines 40]                O que é NOVO desde a leitura anterior,
             [--full] [--raw]                 comprimido (erros, avisos, final)
  tab send <id> "..." [--no-enter]            Escreve no terminal dela (+ Enter) —
                                              assim a conversa segue com
                                              uma tab que já está aberta

AGENTES CONECTADOS (canvas) — só alcança os conectados a este terminal
  peers                                       Quem está conectado a você
  peer ask <nome> "..." [--timeout 600]      Pergunta e ESPERA a resposta
  peer tell <nome> "..."                      Avisa algo, sem esperar
  peer tell <nome> --file <caminho>           O mesmo, com o texto em um arquivo (sem confusão de aspas no Windows)
  peer ask <nome> --file <caminho>            O mesmo que ask, com a pergunta em um arquivo
             (ask/tell --raw: o texto como está, sem o cabeçalho "[Mensagem de ...]"; para
              mandar a uma TUI um comando dela, p. ex. /compact ou /clear)
  peer ask --batch '{"A":"...","B":"..."}'  Pergunta a vários AO MESMO TEMPO e espera todos
  peer check <nome> [--lines 60]              O que aparece agora no terminal dele
  notify "mensagem"                           Avisa o usuário (aviso na tela; barra de tarefas)
  Só orquestradores (coroa no canvas):
  peer recruit <nome> [--agent <id>]          Abre um agente novo, já conectado
              [--prompt "..."] [--account <n>]  · com a primeira tarefa
              [--role <papel>]                  · com um papel (veja roles)
              [--model <id>] [--effort <nível>] · com esse modelo e esforço (ex.: --model gpt-6.1-luna --effort max)
                                                Sem eles, usa o subagente padrão do Squad da missão (se houver);
                                                --model/--effort explícitos sempre vencem. Sem --agent, o do padrão
              [--fast]                          · modo Fast do Codex (só --agent codex)
              [--floor <andar>]                 · nesse andar (ou `ground`, o térreo)
  peer connect <a> <b>                        Conecta dois agentes da equipe
  peer disconnect <a> <b>                     Desconecta os dois

CORREÇÕES — teto de rodadas da mesma entrega (canvas e frota)
  fix list <escopo>                           Entregas e quantas rodadas cada uma usou
  fix decide <escopo> <trabalho> <ação>       accept | extra | abort
              [--task <id>]                   escopo: run:<id> ou mission:<id>

POOLS DE CONTAS — repartir entre várias contas de uma TUI com uma estratégia
  pools                                       Os pools criados, com suas contas e sua estratégia
  pool create <nome> --agent <id> --accounts principal,trabalho [--strategy least-used|round-robin|sticky]
  pool delete <nome>
  Pedem-se onde iria uma conta: tab create --agent claude-code --account pool:Trabalho, ou o
  "account" de uma tarefa de um plano / de um membro de um Squad (pool:Trabalho).

DISPOSITIVOS ANDROID DO CANVAS — um emulador ou telefone conectado a este terminal (por adb)
  devices                                     Os que você controla, o que o adb vê e os emuladores (AVD)
  device create [<nome>] [--avd <avd>]        Cria um ao seu lado, já conectado
  device start <dispositivo> [--avd <avd>]    Liga o emulador e espera terminar de iniciar
  device tap <dispositivo> --x N --y N        Toca · ou --text "Entrar" (procura o elemento na tela)
  device swipe <dispositivo> --dir up|down|left|right   · ou --x1 --y1 --x2 --y2 [--ms 300]
  device type <dispositivo> "texto"          Digita (só ASCII) · device key <d> back|home|enter|...
  device launch <dispositivo> <pacote>        Abre um app (com.android.settings)
  device shot|tree <dispositivo>              Captura (devolve o caminho do PNG) · elementos com seu texto e onde tocar

PORTAIS DO CANVAS — navegadores conectados a este terminal (orquestrador: os da equipe)
  portals                                     Os portais que você controla
  portal create [<nome>] [<url>]              Cria um ao seu lado, já conectado
  portal navigate <portal> <url>              Vai a uma URL
  portal snapshot <portal> [--full]           A árvore da página, com refs (@e3)
  portal click|hover <portal> <@ref|seletor>
  portal type <portal> <@ref> "texto" [--clear] [--submit]
  portal press <portal> <tecla> [--target <ref>]   · scroll · select · wait · history
  portal screenshot|console|layout <portal>   Foto, console e medidas
                                              (sem eval, upload nem cookies: isso é do usuário)

CHAT COM O USUÁRIO — o chat dele por conversas (sete cores); o que você escreve no terminal NÃO chega a ele
  say "texto" [--progress] [--thread <cor>]    Responde no chat (--progress: aviso, seu turno continua)
      [--file <caminho>]                      · o texto a partir de um arquivo
  recall [<cor>|list] [--turns 10 | --all]   O que foi dito numa conversa (list: as conversas com atividade)

ROTINAS — mensagens na hora marcada, para você, para um agente que você alcança ou para o usuário
  routines                                    As suas (num shell: todas)
  routine create <nome> "texto" <quando>      · --every 30m | --at 09:00 [--days seg,qua] | --in 45m
              [--to <agente>] [--remind]      · para quem: você (padrão), outro agente, ou --remind ao usuário
              [--catch-up]                    · se o app estava fechado na hora, roda UMA vez ao abrir (diária/única, até 24 h)
  routine show|run|enable|disable|delete <nome>
  routine edit <nome> ["texto"] [--rename <n>] [<quando>] [--catch-up|--no-catch-up]
                                              (mínimo 5 min; as de intervalo não recuperam o perdido com o app fechado)

ANDARES — cópias isoladas do projeto (worktree + branch + canvas próprio)
  floors                                      Os andares deste projeto e em qual você está
  floor create <nome> [--from <branch>]       Só orquestradores; parte do HEAD ou dessa branch
                                              (apagá-los fica com o usuário)

PAPÉIS (para recrutar com --role)
  roles                                       Os papéis: catálogo + os do usuário
  role show <papel>                           As instruções dele
  role create <nome> "instruções"             Só orquestradores; também --file <caminho>
  role edit <papel> "instruções" [--name]     Só orquestradores; o catálogo não se edita

NOTAS DO CANVAS — as conectadas a este terminal (orquestrador: as da equipe)
  design create <title> [--workspace <path>] [--mission-id <id>] [--owner-tab-id <id>]
  design list [--workspace <path>] | get <designId>
  design delete <designId> | archive <designId>
  design page add <designId> <name> [--order <n>]
  design artboard add <pageId> <title> --file <html> [--width <n> --height <n>]
  design artboard add <designId> <title> --page <name> --file <html>
  design update <artboardId> --file <html> [--expected-version <n>]
  design comment <artboardId> <text> [--author user|agent] [--selector <css>]
  design approve|reject <artboardId> | approve all <designId>
  design revert <artboardId> --version <n>
  notes                                       As notas que você alcança
  note create ["texto"] [--name <n>]          Cria uma nota ao seu lado, já conectada
              [--stack <nota>]                · em vez de ao lado: dentro da pilha dessa nota (dividem o lugar)
              [--file <caminho>]              · o conteúdo a partir de um arquivo
  note read <nota> [desde] [quantidade]       Lê com números de linha
  note write <nota> "texto" [--file <caminho>]  Substitui todo o conteúdo
  note edit <nota> "antigo" "novo"           Troca um trecho que aparece UMA vez

OBSERVAR TABS (modo push — evita o polling)
  watch add <id> [--idle 20]                  Começa a observar uma tab
  watch remove <id>                           Para de observá-la
  watch list                                  Tabs observadas e o limite vigente
  watch wait [--timeout 300] [--max 20]       Espera até alguma ter novidades

EVENTOS (o barramento da frota e das missões)
  events since [--after <seq>] [filtros]      O que aconteceu depois desse número
  events wait --after <seq> [--timeout 60] [filtros]
                                              Espera o próximo evento (sem polling)
  Filtros: --topics task.,mission. --run <id> --mission <id> --task <id> --limit 100

MISSÕES (também sem interface: `ade-ags --headless`)
  mission run --objective "..." --cwd . [--test] [--wait] [--timeout 3600]
              [--title ...] [--agent claude-code] [--model ...] [--account <id>]
              [--squad <id>] [--budget 5] [--max-parallel 2]
                                              Cria, inicia e espera; sai com 1 se falhar
  mission create --objective "..." --cwd .    Só cria o rascunho (mesmas flags do run, sem --wait)
  mission start|status|wait <id>              Passo a passo (wait: --timeout)
  mission create|run|start ... --test          Marca explicitamente teste/E2E (fora da taxa de sucesso)
  mission review <id>                         O que cada tarefa isolada entregou
  mission timings <id>                        Tempo ativo, delegação, alertas/esperas do orquestrador e tempo até todos trabalharem
  mission efficiency <id>                     Tempo ativo unificado (mission_active > spans > relógio), custo e histórico por agente
  mission cleanup <id> [--dry-run]             Limpa worktrees e branches integrados de uma missão encerrada
  worktrees list [--cwd <caminho>]             Worktrees gerenciados, tamanho e bloqueios de limpeza
  worktrees prune [--cwd <caminho>] [--dry-run]  Limpa missões encerradas integradas; mantém órfãos para revisão
  mission precheck <id>                       O que o repositório e as missões anteriores já dizem sobre o objetivo
  mission startcheck <id>                     Evidência de briefing e atividade por agente; limite de 2 minutos
  memory search "<tema>" --mission <id> [--limit 5] [--at <YYYY-MM-DD|YYYY-MM-DDTHH:MM|unix-seconds>]
                                              Busca a memória vigente agora ou nesse instante (datas em UTC)
  memory history --mission <id> --key <nome> --scope workspace|mission
                                              Revisões aprovadas e seus intervalos de validade
  memory suggest --mission <id> --key <nome> --body "..." [--scope workspace|mission]
                 [--kind decision|constraint|finding|file|note] [--priority 0-3]
                                              SUGERE uma memória (fica pendente; o usuário aprova)
  mission accept <id> <tarefa>                Junta na integração da missão
  mission apply <id>                          Leva o aceito para o projeto
  mission redeliver <id> [--pr <N>] [--test passed|failed|not_run]
                                              Reavalia entrega no repo origin (só promove se PR mesclado e CI verde)
  approval list                               Pedidos de permissão esperando
  approval decide <id> --allow|--deny [--remember]

JANELAS
  window list                                 Janelas abertas
  window create                               Abre uma janela nova

WORKSPACES
  workspace list                              Workspaces salvos
  workspace open <id|nome>                    Abre um
                 [--close-current]
  workspace status                            O que está aberto agora

FROTA (agentes headless, os do console)
  run roster                                  Quais agentes, modelos e contas podem
                                              rodar agora, com custo e cota
  run status [--cwd <caminho>] [--run-id <id>]  O quadro do run: cada tarefa com seu
                                              estado, modelo, custo e do que depende
  run result --task <key|id> [--run-id <id>]  Tudo o que uma tarefa entregou
  run await [--timeout-s 300]                 Bloqueia até uma tarefa encerrar
  run facts [--run-id <id>]                   O que os agentes deixaram escrito
  run add-fact --kind decision --body "..."   Compartilha um dado com todo o run
  run cancel-task --task <key|id>             Para uma, ou tira da fila uma que espera
  run reroute-task --task <key|id>            Passa para outro agente, com o que o
                  [--agent <id>] [--model <m>] anterior já fez; mesma branch e worktree
  run plan --json-args '{"objective":"...",  Declara o DAG inteiro de uma vez
           "tasks":[{...}]}'                  (mais cômodo num agente: run_plan)

  Sem --cwd nem --run-id atua sobre o último run lançado da pasta
  onde você roda o comando.

MEMÓRIA COMPARTILHADA (os agentes usam por MCP; veja docs/ade-ags/SHARED_MEMORY.md)
  memory list|get|propose|update|delete|promote-fact --json-args '{...}'
                                              O aprovado do workspace e da missão;
                                              o que se propõe espera aprovação.
  memory index                              Índice aprovado da tab ou missão atual
  memory open <página|entryId|chave>         Página do índice ou UMA entrada inteira (UNTRUSTED DATA)
  swarm note|question <texto>                Dados de sessão da missão, não memória durável
  swarm promote <note-id> <key>              Propõe a nota; aprovação exclusiva do usuário
  memory export                             Exporta Markdown e revisões JSON do workspace da tab (só leitura)
  memory compact [retentionDays]             Só na interface do app; um terminal de agente não pode
  workspace restore <id|nome>                Só na interface do app; um terminal de agente não pode

NAVEGADOR
  browser run --json-args '{"cwd":"...",     Uma ordem ao navegador de um projeto:
              "request":{"op":"snapshot"}}'   snapshot, click, type, resize, console…
                                              É o mesmo caminho que as 26
                                              ferramentas browser_* do MCP usam.

AGENTES, CONTAS E SKILLS
  agents                                      O que pôr em --agent (inclui os custom)
  accounts                                    O que pôr em --account, por TUI
  prelaunch [list]                            O que pôr em --pre
  skills                                      O que pôr em --skills (instaladas)
  skill search <texto>                        Busca em TODOS os repositórios, skills.sh incluído
                                              (o skills.sh é consultado pela internet)
  skill install <nome>                        Instala dos repositórios habilitados
  skill show <nome|id>                        Metadados + conteúdo do SKILL.md
  skill new <nome>                            Cria uma skill própria (origem local)
             [--description ...] [--categories a,b] [--agents a,b]
             [--file <caminho> | --content "..."]
  skill edit <nome|id>                        Salva conteúdo novo
             [--file <caminho> | --content "..."] [--name <novo>] [--copy]

SERVIDOR MCP (não é você quem digita: o app o inicia)
  mcp --cwd <pasta> [--tab <id>]              A ponte de uma tab interativa
  mcp --task <id-da-tarefa>                   A de uma tarefa da frota

  Diferente do resto, isto NÃO devolve uma linha JSON: fica preso no stdin
  e no stdout falando JSON-RPC com o agente que o iniciou. É o servidor `ade-ags`
  que dá a ele suas ferramentas: o navegador do projeto, a orquestração da frota,
  a conta de git do usuário (PRs, issues, push/pull), perguntar algo ao usuário,
  e —só com --task— a permissão de cada ação.

  O app o adiciona sozinho ao comando de cada tab do Claude Code, com um
  `--mcp-config` escrito em ~/.ags/mcp/. Não precisa instalar o CLI para
  funcionar: o arquivo aponta para o binário que vem dentro do app.

OUTROS
  app status                                  Versão e estado do app
  --json-args '{...}'                         Passa argumentos crus em JSON
  --version                                   Versão deste CLI e do protocolo

`agents`, `accounts` e `skills` são atalhos de `agent list`, `account list` e `skill list`.
Editar uma skill que veio de um repositório NÃO a sobrescreve: guarda uma cópia de origem local e
deixa a original recebendo atualizações. `--copy` força essa cópia também para uma
skill própria. `--file` é lido a partir do diretório onde você roda o comando.
Sem --account, a tab usa a conta principal (a de sempre).
--pre se repete sem limite e seus valores rodam NA ORDEM ESCRITA; se um falhar, o
agente não inicia. Cada valor pode ser o nome de um item salvo ou um comando literal:
  ags tab create --cwd . --agent claude-code --pre "ambiente conda" --pre "nvm use"

A saída é sempre uma linha JSON no stdout (exceto `mcp`, que fala JSON-RPC).
Códigos de saída: 0 ok · 1 o comando falhou · 2 uso incorreto · 3 o app não está rodando

```

## Anexo — validação documental final

Comandos: ags test affected --dry-run; ags test affected; git diff --check; git status --short. Exit agregado 0.

```text
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= diff --name-only -z --no-renames origin/master...HEAD dur_ms=58 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= diff --name-only -z --no-renames HEAD dur_ms=80 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= ls-files --others --exclude-standard -z dur_ms=81 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= -c core.quotePath=false diff --no-ext-diff --no-textconv --no-renames origin/master...HEAD dur_ms=56 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= -c core.quotePath=false diff --no-ext-diff --no-textconv --no-renames HEAD dur_ms=55 exit=0
Nada a testar: só arquivos sem efeito em código.
Sem teste (1): docs/ade-ags/PARTE_BACKEND.md
{"commands":[],"full":false,"ignored":["docs/ade-ags/PARTE_BACKEND.md"],"risk":[],"unmapped":[]}
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= diff --name-only -z --no-renames origin/master...HEAD dur_ms=55 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= diff --name-only -z --no-renames HEAD dur_ms=55 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= ls-files --others --exclude-standard -z dur_ms=81 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= -c core.quotePath=false diff --no-ext-diff --no-textconv --no-renames origin/master...HEAD dur_ms=55 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= -c core.quotePath=false diff --no-ext-diff --no-textconv --no-renames HEAD dur_ms=55 exit=0
Nada a testar: só arquivos sem efeito em código.
Sem teste (1): docs/ade-ags/PARTE_BACKEND.md
{"full":false,"ignored":["docs/ade-ags/PARTE_BACKEND.md"],"passed":true,"results":[],"risk":[],"skippedAffected":4,"unmapped":[]}
?? docs/ade-ags/PARTE_BACKEND.md
```

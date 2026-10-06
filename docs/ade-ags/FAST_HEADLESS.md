# Fast nas execuções headless — Etapa 17

O Fast selecionado no Squad é copiado ao iniciar o Run: o lead em `runs.fast_mode`, cada integrante em `run_squad_members.fast_mode`. O supervisor consulta essas linhas pelo Run e pelo papel funcional da tarefa. Editar o Squad depois do início não muda uma execução existente. Retentativas e handoffs mantêm a política do papel; ao trocar para um provider sem suporte, nenhum argumento Fast é enviado.

O contexto de lançamento (`LaunchCtx.fast_mode`) usa a configuração por execução, sem reescrever `CODEX_HOME`, `CLAUDE_CONFIG_DIR` ou arquivos de conta. Fast não altera sandbox, permissões, modelo ou esforço de raciocínio.

| CLI | Comportamento headless | Evidência local |
| --- | --- | --- |
| Codex 0.160.1 | `codex exec ... -c service_tier="fast" ...` quando Fast está ligado | `codex exec --help` documenta `-c/--config <key=value>` e valores TOML; o schema real de `codex app-server generate-json-schema --experimental` contém `Config.service_tier` como string; `codex -c service_tier=fast features list` aceitou a configuração sem executar geração |
| Claude Code 2.1.289 | Nenhum argumento/configuração Fast adicional | `claude --help` não oferece flag headless Fast; o Squad existente admite Fast somente para Codex. Não foi inventado `--fast` nem inferido Fast de `--effort` |
| OpenCode, Gemini, Kimi, Antigravity e customizados | Nenhum argumento Fast adicional | Sem equivalente Fast registrado no contrato desses adapters |

Com Fast desligado, nenhum override `service_tier` é acrescentado; as configurações próprias da CLI continuam valendo. Uma tarefa avulsa sem snapshot Squad não recebe Fast por inferência. O benefício depende do modelo/conta e do serviço; a aplicação não promete latência ou custo menor sem medição.

Migração v34 aditiva e idempotente: adiciona `fast_mode INTEGER NOT NULL DEFAULT 0` às duas tabelas. Runs antigos ficam desligados porque o snapshot anterior não guardava esse dado; consultar o Squad atual para reconstruí-lo alteraria o histórico. Na integração com custo por aba (v33), manter v34 como versão final e preservar os dois blocos de migração.

Os testes cobrem montagem Fast ligado/desligado do Codex, preservação de sandbox/esforço, igualdade dos comandos dos providers sem suporte, snapshot do lead e integrante após editar o Squad, tarefa avulsa/papel ausente, troca de provider e migração idempotente com dados existentes. Nenhum teste realiza chamada paga a modelos.

# Sandbox dos agentes

Configuração `runs.sandbox` (Configurações → Sandbox dos agentes): `off`, `auto` (padrão) ou `strict`.

Com o sandbox, um agente da frota **lê tudo, mas só escreve** em:

- a pasta da tarefa (o worktree) e o `.git` comum do repositório, para poder fazer commit. Um lead não recebe a pasta;
- o diretório da conta (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`…) e os diretórios dos agentes no home (`~/.claude`, `~/.codex`, `~/.cache`…);
- os temporários.

Além disso, credenciais de outros serviços (`GH_TOKEN`, `NPM_TOKEN`, `SSH_AUTH_SOCK`…) saem do ambiente. As dos providers ficam.

| Plataforma | Mecanismo | Escrita limitada |
|---|---|---|
| Linux | `bwrap` (instale o bubblewrap) | sim |
| macOS | `sandbox-exec` | sim |
| Windows | Job Object + ambiente limpo | **não** |

`strict` recusa iniciar a tarefa onde a escrita não pode ser limitada. A rede continua aberta: os agentes precisam da API.

## Pendente

- Windows: limitar a escrita (token de integridade baixa ou AppContainer).
- Rede por allowlist.
- Abas interativas (só a frota headless passa pelo sandbox).

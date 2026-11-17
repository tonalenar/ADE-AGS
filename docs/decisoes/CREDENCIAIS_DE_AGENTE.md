# Credenciais de API key dos agentes

**Status:** adotada em 2026-11-17.

## Decisão

Chaves de API de contas Claude Code e Codex ficam no keyring do sistema. O PTY não recebe
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` nem `OPENAI_API_KEY`. Quando o CLI precisa da
chave, chama um helper local `ags credential`; o helper pede a credencial ao IPC da ADE.

O broker aceita um ticket aleatório de uso único, com prazo de uma hora, associado à conta
e ao PID raiz do agente. O servidor verifica que o PID que fez a chamada descende desse
processo antes de consultar o keyring. A resposta contém apenas o segredo bruto no stdout
do helper, sem JSON nem newline; o ticket, o comando e os arquivos de perfil não contêm a
chave. O servidor e a CLI apagam suas cópias de transporte assim que possível.

Claude Code recebe `apiKeyHelper` no `settings.json` do `CLAUDE_CONFIG_DIR` da conta. A
configuração existente é preservada; se já houver um helper de terceiro, o lançamento é
recusado em vez de substituí-lo.

Codex recebe um provedor configurado por `auth.command`. A CLI instalada suporta esse
helper e consome o token devolvido sem gravar a API key em `auth.json`. Contas criadas por
versões anteriores podem ter `OPENAI_API_KEY` em `auth.json`: no próximo lançamento, a ADE
grava primeiro a chave no keyring e regrava o JSON sem esse campo, preservando o restante.
Se a gravação no keyring ou a regravação falhar, o arquivo original é mantido e o lançamento
falha com erro; não há migração que perca o segredo.

## Limites e exceções

- O teste automatizado usa apenas o keyring falso e chaves fictícias. Validar uma chave real
  e a resposta de um agente fica para um teste manual posterior com o Ton.
- `auth.command` do Codex devolve somente a credencial do provedor; não injeta variáveis
  arbitrárias em subprocessos MCP. Por isso, `ADE_SESSION` continua em
  `~/.codex/ags-*.config.toml` para autenticar o servidor MCP da ADE. O perfil é removido
  quando a aba fecha, mas uma queda abrupta pode deixar o arquivo; a chave de API do
  provedor nunca pode ser guardada nesse caminho. Essa exceção está registrada em
  [`AGENTS.md`](../../AGENTS.md#23-segurança-e-dados-do-usuário).
- O helper local requer que a ADE esteja aberta. Sem a instância e seu socket IPC, a CLI
  termina com erro em português e não tenta procurar uma cópia da chave em arquivo.

## Documentação dos helpers verificada

- Claude Code: `claude --help` e [Settings](https://docs.anthropic.com/en/docs/claude-code/settings)
  confirmam `apiKeyHelper` como comando de saída de credencial.
- Codex CLI: `codex --help`, `codex login --help` e a documentação de
  [autenticação](https://developers.openai.com/codex/auth/) e
  [configuração](https://developers.openai.com/codex/config-reference/) confirmam
  `model_providers.<id>.auth.command` como helper de autenticação.

# Gemini multi-account

Tentativa de 2026-09-29 nesta máquina Windows. A fase D **não foi implementada**. `gemini-cli` continua com `profile: None`.

O isolamento de duas contas não foi executado. Sem o binário do Gemini CLI não há login, sessão, MCP nem logout para observar. Forçar `profile: Some` faria a tela afirmar um marcador que este computador não confirmou.

## Binário

`gemini --version` não rodou. O comando não existe no PATH do processo, nem no PATH de usuário, nem no PATH da máquina.

`where.exe gemini` não achou arquivo.

Não está instalado por:

- npm global (`npm list -g` não lista `@google/gemini-cli`; `%APPDATA%\npm` não tem `gemini.cmd`);
- cache do npx (`%LOCALAPPDATA%\npm-cache\_npx`, profundidade 2, nenhum `package.json` com gemini no caminho);
- bun (`%USERPROFILE%\.bun\bin`);
- winget (`winget list --name gemini` não encontrou pacote);
- `%LOCALAPPDATA%\agy\bin` (só `agy.exe`, o CLI do Antigravity).

A ADE procura o comando `gemini` (`AgentDef` de `gemini-cli`). Esse comando não está nesta máquina.

## O que existe em `%USERPROFILE%\.gemini`

Inventário só de leitura. Nenhum arquivo foi aberto para extrair segredo. Nenhum arquivo foi apagado, movido, renomeado ou reescrito. Nenhum logout foi disparado.

O diretório não tem o layout do Gemini CLI (`oauth_creds.json`, `google_accounts.json`, `projects.json`, `tmp\` na raiz). O conteúdo é estado do Antigravity:

| Nome | Tipo | Itens no primeiro nível | Última escrita |
|---|---|---:|---|
| `antigravity` | diretório | 12 | 2026-05-19 18:27:44 |
| `antigravity-backup` | diretório | 8 | 2026-05-19 16:52:52 |
| `antigravity-browser-profile` | diretório | 41 | 2026-05-19 16:54:14 |
| `antigravity-cli` | diretório | 20 | 2026-09-25 12:38:01 |
| `antigravity-ide` | diretório | 12 | 2026-08-13 09:02:56 |
| `config` | diretório | 7 | 2026-09-05 12:19:13 |

`antigravity-cli\settings.json` (9639 bytes, 2026-09-25 12:37:16) tem as chaves `allowNonWorkspaceAccess`, `artifactReviewPolicy`, `colorScheme`, `model`, `permissions`, `trustedWorkspaces`. Valores não foram copiados para este documento.

`config\config.json` (87 bytes) tem `userSettings.remoteControlHostname`. Também há `hooks.json`, `mcp_config.json` (0 bytes), `projects\`, `sidecars\` e `skills\`.

## Credential Manager

`cmdkey /list` foi lido só pelos nomes de destino. O conteúdo das credenciais não foi pedido.

A única entrada cujo nome contém `gemini` é:

`LegacyGeneric:target=gemini:antigravity`

Não apareceu um slot com o nome de `GEMINI_CLI_HOME`, nem um par de slots que distinguisse dois profiles do Gemini CLI. Isso não prova como o Gemini CLI guardaria um token: o binário não está instalado, então ele não criou entrada nenhuma.

## O que não foi testado

Profiles temporários não foram criados. Nenhum `gemini` foi aberto. Nenhum login Google foi feito. Nenhuma mensagem de sessão foi enviada. Nenhum `settings.json` de MCP foi escrito. Nenhum logout foi executado.

| Recurso | Resultado |
|---|---|
| Login A vs B | não executado — sem binário |
| Arquivos | não executado |
| Sessões | não executado |
| Settings | não executado |
| MCP | não executado |
| Logout | não executado |
| Keychain por `GEMINI_CLI_HOME` | não executado |

`GEMINI_CLI_HOME` não foi definida no ambiente do usuário nem da máquina.

## Bloqueio para a fase D

Dois fatos impedem `profile: Some`:

1. Não há `gemini` para confirmar marcador, sessão, MCP e logout isolado.
2. `%USERPROFILE%\.gemini` nesta máquina já é o estado do Antigravity. A fase D, como está escrita, trata esse caminho como a conta principal do Gemini CLI. Abrir o CLI sem `GEMINI_CLI_HOME` escreveria dentro desse diretório. A ADE, se lesse um marcador ali, poderia confundir o estado do Antigravity com um login do Gemini CLI.

A conta principal do Antigravity ficou intacta.

## O que a ADE não fez com credenciais

- não leu token;
- não copiou token;
- não gravou token;
- não colocou token em log, commit ou neste documento.

## Próxima verificação, quando houver binário

Instalar o CLI não faz parte desta etapa. Quando um `gemini` existir no PATH, o ensaio continua fora de `%USERPROFILE%\.gemini`:

1. Anotar `gemini --version` e o caminho de `where.exe gemini`.
2. Confirmar, no help ou no código dessa versão, se `GEMINI_CLI_HOME` ainda é a variável, ou se já valem `GEMINI_CONFIG_DIR`, `GEMINI_CACHE_DIR` e `GEMINI_TMP_DIR`.
3. Dois diretórios vazios em `%TEMP%`, cada um com a variável só no processo daquele profile.
4. Login de duas contas Google diferentes, feito pelo próprio CLI.
5. Mapear só nomes, tamanhos e timestamps do que o CLI criar sob `<profile>\.gemini`.
6. Uma mensagem identificável em cada profile e a descoberta de sessão da ADE sobre esses diretórios.
7. Um setting visual inofensivo só em A, e um MCP local só no `settings.json` de A.
8. `cmdkey /list` antes e depois, comparando nomes de destino, para ver se A e B geram slots diferentes.
9. Logout só de B. A e a conta principal precisam continuar autenticadas.

Se qualquer um de identidade, sessão, configuração, MCP ou logout falhar, `profile: Some` continua desligado.

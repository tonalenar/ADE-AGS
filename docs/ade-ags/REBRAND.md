# Rebrand ControlCode → ADE AGS

Plano. Não executado nesta etapa. Renomear agora quebra o updater, o caminho dos dados e a capacidade de puxar o upstream.

## Onde o nome está

| Superfície | Valor hoje | Arquivo |
|---|---|---|
| package npm | `controlcode` | `package.json` |
| crate / versão | `controlcode` 1.8.7 | `src-tauri/Cargo.toml` |
| lib Rust | `controlcode_lib` | o mesmo, de propósito: no Windows o nome da lib não pode colidir com o binário |
| productName Tauri | `controlcode` | `src-tauri/tauri.conf.json` |
| título da janela e `<title>` | `controlcode` / `Control Code` | `tauri.conf.json`, `index.html` |
| identifier | `com.luis.controlcode` | `tauri.conf.json` |
| executável da app | `controlcode.exe` | derivado do productName. Tauri 2 nesta versão não tem `mainBinaryName` |
| CLI | `ccode.exe` | `Cargo.toml` `[[bin]]`. No Windows a UI copia para `%LOCALAPPDATA%\ControlCode\bin` (`ipc/install.rs`) |
| updater, endpoint | `https://github.com/luis3132/ControlCode/releases/latest/download/latest.json` | `tauri.conf.json` |
| updater, repo da API | `luis3132/ControlCode` | `src-tauri/src/updates.rs` `REPO` |
| updater, chave | vazia no fonte. CI injeta `CC_UPDATER_PUBKEY` / `TAURI_SIGNING_PRIVATE_KEY` | `updates.rs`, `scripts/build.mjs` |
| dados da app | `~/.controlcode/` (`data.db`, `skills`, `ipc.json`, `worktrees`, `runs`) | `database/connection.rs` e outros caminhos hardcoded |
| contas | `<app data do identifier>/accounts/` | `accounts/store.rs` via `app.path().app_data_dir()` |
| MCP | servidor chamado `controlcode` | `ipc/mcp.rs` `SERVER_NAME` |
| skill bundled | `skills/controlcode-orchestrator` | bundle em `tauri.conf.json` |
| ícones | `src-tauri/icons/` | vários tamanhos, incluído `.ico` |
| releases | workflow `.github/workflows/release.yml`, notas em `.github/releases/v1.8.*.md` | matriz de seis alvos. Instaladores chamam `controlcode` |
| textos | README, i18n `en.json` / `es.json`, dezenas de comentários | |

`scripts/updater-manifest.mjs` monta `latest.json` com a chave `{os}-{arch}-{formato}` que o plugin procura (`windows-x86_64-nsis`, `windows-x86_64-msi`, …).

## O que não mudar no primeiro rebrand

- O crate continuar compilando os dois binários sem colisão de nome no Windows.
- O histórico git e a remote `upstream`. O rebrand é commit nosso, não um squash do ControlCode.
- `LICENSE` Apache 2.0. Um nome novo não troca a licença. Derivado precisa manter o aviso de copyright e declarar as mudanças.
- Tokens. Não há tokens no repo. O rebrand não cria um lugar para guardá-los.

## Ordem quando for a hora

1. **Dados.** Decidir os paths novos (`~/.ade-ags` ou equivalente, identifier novo) e escrever migração que move o banco, skills, IPC e contas na primeira abertura. Trocar o identifier sem migração abandona as contas já logadas, porque elas vivem debaixo do app data do identifier.
2. **Binários.** `productName` e o nome da CLI juntos, mais o diretório `%LOCALAPPDATA%\ControlCode\bin`. Quem já instalou `ccode` fica com o binário velho no PATH até a UI instalar o novo.
3. **Updater, por último e só com release nosso.** Enquanto `endpoints` e `REPO` apontam para `luis3132/ControlCode`, um build nosso assinado com outra chave não instala por cima, e um build sem chave só avisa. Apontar o updater para o nosso GitHub antes de existir release nosso faz a app procurar um `latest.json` que não existe. A chave pública entra em compile time. Não vai para o git.
4. **MCP e skill.** Renomear o servidor MCP muda o nome da tool que os agentes já têm na conversa (`mcp__controlcode__…`, `controlcode_…`). Isso é breaking para sessão retomada. Fazer junto com uma versão que documenta o nome antigo como alias por um ciclo.
5. **Textos, ícones, i18n.** Por último, porque não afetam o updater nem o disco.

Não fazer um replace em massa de "ControlCode" antes do passo 1. Há comentários que descrevem comportamento, e há o nome do crate no meio de paths de target.

## Identidade mínima, já nesta etapa

Os documentos em `docs/ade-ags/` chamam o produto de ADE AGS e o upstream de ControlCode. O binário, o identifier e o updater continuam os do upstream até o plano acima ser executado de propósito.

## Identidade visual (passo 5, parte visual): feito

- **Tokens.** A paleta inteira está no bloco `@theme` de `src/App.css`. `gray` é grafite neutro (mesmas luminosidades da escala do Tailwind), `accent` é aço frio de baixa saturação, `violet` é o secundário contido, `surface*` são os fundos do escuro e `glow` é o âmbar da marca. Os componentes não usam hex: trocar a identidade é trocar esse bloco. As únicas exceções são xterm e CodeMirror, que não leem variáveis CSS (`terminal/theme.ts`, `editor/codemirror.ts`).
- **Mascote.** `src/shared/brand/Mascot.tsx` é um robô em pixel art 16×16 que flutua, com os estados `idle` e `working`. `MascotMark` é só a cabeça, e `Logo` é a cabeça mais o nome. As cores vêm de `--mascot-*` no `App.css`.
- **Ícones.** A origem é `src-tauri/icons/source/ade-ags-icon.svg`. Para regenerar todos os tamanhos, renderize o SVG em PNG de 1024 px e rode `bun tauri icon <png>`.
- **Nome visível.** O título da janela, o `<title>`, o i18n e o favicon dizem ADE AGS. O `productName`, o identifier, os binários, o updater e o MCP continuam os do upstream, como o plano acima pede. "authorize ControlCode" em `forge.add.browserHelp` fica como está, porque é o nome do app OAuth.

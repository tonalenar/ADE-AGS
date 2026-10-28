# Instância de debug isolada (`scripts/dev-local.ps1`)

A instância de debug (`src-tauri\target\debug\ade-ags.exe`) roda com **dados próprios**, separados do app instalado (plano computer use v2, Fase 0.2, achado I7).

## Abrir

```powershell
pwsh scripts/dev-local.ps1 -Run              # compila e abre
pwsh scripts/dev-local.ps1 -Run -SkipBuild   # só reabre
```

O script define `ADE_AGS_DATA_DIR` (padrão `%LOCALAPPDATA%\ade-ags-dev-data`, ou `-DataDir <caminho absoluto>`) e o WebView2 próprio.

## O que fica isolado

Tudo que o app guarda em `~/.ags` passa a ficar em `ADE_AGS_DATA_DIR`: `data.db` (abas, workspaces, configurações), `canvas*.json`, `chat.json`, `routines.json`, `ipc.json` e `ipc\<pid>.json` (handshake), `mcp\`, `memory\`, `runs\`, `skills\`, `screens\`; e o que ficava no `%APPDATA%` do app (`accounts\`, estado do navegador, forge) vai para `ADE_AGS_DATA_DIR\app-data`. Sem a variável nada muda para o app instalado.
Continuam compartilhados de propósito: `~/.ags/worktrees` e o target do cargo (são checkouts git).

## Apontar o `ags` / MCP para ela

```powershell
$env:ADE_AGS_DATA_DIR = "$env:LOCALAPPDATA\ade-ags-dev-data"
ags status        # fala com a instância de debug
```

Com a variável definida o `ags` só procura o handshake daquela pasta (nunca cai no do app instalado) e ela vence o `AGS_HANDSHAKE` herdado de um terminal do app instalado. Terminais abertos DENTRO da instância já recebem `AGS_HANDSHAKE` e falam com ela sem nada extra. Sem a variável, o `ags` fala com o app instalado como sempre.

## Jev e contas

- Contas de agentes (Claude, Codex…) começam vazias na instância isolada: login à mão, nada é copiado entre perfis.
- Jev: na primeira abertura a configuração **não secreta** (`decisions.*`: provedor, URL, modelo, pontos) é lida do banco instalado (somente leitura). A chave de API não é copiada: está no cofre do sistema (serviço `ade-ags.decisions`), que as duas instâncias enxergam.

## Por que a instância fechava sozinha (hipótese)

Não há plugin single-instance no app, então não é o foco sendo entregue ao instalado. Hipótese: as duas instâncias compartilhavam `~/.ags/ipc.json`, `data.db`, `canvas.json` e as abas salvas; a que fechava/reiniciava (`tauri dev` com watcher, atualização, `-Run` que mata o processo de debug) apagava o handshake global e o estado restaurado de uma refletia na outra. O isolamento elimina esses pontos de contato; se voltar a acontecer, o log estará no diretório isolado.

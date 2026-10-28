# Gemini Desktop dentro da ADE: investigação e prova de viabilidade

Investigação realizada em **14/10/2026**, na instalação local do Windows.

## Atualização da base em 15/10/2026

A cópia local foi atualizada de `237a1a5ac34a832128e87ce29a816b1cd1da0578` para `9b7e8467f4031846b5e0d7a1897d2e2d159851d4` (`origin/master`), incorporando 221 commits. A integração foi reaplicada sobre o canvas, a fila de mensagens e o cadastro de funções atuais. O aplicativo instalado não foi substituído.

O estado anterior, incluindo arquivos não rastreados, está preservado no stash `74eca57620ac5b063fa5c59aba8999791ddf91ca`. A branch de trabalho é `codex/update-local-current`.

## Resultado

Em 15/10, o redimensionamento foi verificado por arraste real no Windows. Os puxadores do Gemini ficam sempre visíveis e maiores. O conteúdo reorganiza o layout ao mudar largura e altura; sua escala de fontes é o zoom próprio do Gemini, ajustado com `Ctrl+-` enquanto a janela está devolvida à área de trabalho e mantido ao reconectar. Zoom proporcional automático pelo host foi testado sem resultado confiável e não integra esta versão. A escala do canvas não é o zoom da página Gemini.

**Existe um caminho viável para incorporar a interface do aplicativo original:** hospedar sua janela Win32 (`HWND`) em uma região nativa da ADE, usando `SetParent`, estilos `WS_CHILD` e sincronização de tamanho/visibilidade.

A prova inicial colocou o Gemini em **um host experimental separado**, criado para testar o mecanismo. O Gemini renderizou dentro dele, com a conta existente. O teste validou encaixe, redimensionamento geométrico, ocultação, reaparição e restauração.

## Implementação nesta branch

Foi acrescentada uma vista `desktop` para o Gemini, com botão ✦ na barra do workspace. Ela participa da grade e da persistência de abas. O botão **Conectar aplicativo** adota a janela original; **Devolver à área de trabalho** a restaura. Ao restaurar uma sessão da ADE, a adoção depende novamente desse botão.

O canvas oferece um nó Gemini na barra de ferramentas. Ao alternar de Abas para Canvas, a mesma vista montada é posicionada dentro desse nó. Pan, zoom e redimensionamento atualizam os limites nativos; nós parcialmente fora da área ou pequenos demais ocultam a superfície para não cobrir controles externos. Não se aplica zoom CSS ao HWND. O nó é excluído das operações de navegador `portal.*`.

Abrir o Gemini pela aba, pelo nó ou pela ferramenta do canvas centraliza e ajusta o zoom para mostrar seu nó completo, abaixo da barra de ferramentas. A requisição de foco aguarda a medição do canvas. A vista continua montada quando o nó sai da tela, preservando a conexão nativa; a lista de vistas já mostradas considera os retângulos do canvas, além das posições da grade.

O backend Windows verifica a assinatura Google do executável em execução, a identidade do processo, o contexto de DPI e a propriedade exclusiva da janela. Todas as alterações de HWND passam pelo thread de UI. Um processo auxiliar de recuperação é iniciado antes do encaixe: termina depois do desencaixe normal e, se a ADE falhar, tenta restaurar a janela ou reabrir o executável assinado caso o Windows tenha destruído o HWND. Rascunhos não enviados não têm recuperação garantida.

Menus, diálogos, listas e arraste de abas ocultam temporariamente a superfície nativa. Trocar de rota, aba ou workspace também a oculta. Eventos de foco do Gemini identificam seu grupo na grade. A restauração ocorre antes do fechamento normal; uma falha de restauração bloqueia esse fechamento e informa o painel.

Na instalação analisada, o Gemini cria janelas Per-Monitor V1 e o Tauri usa V2 por padrão. Quando o Gemini está instalado, a ADE seleciona um contexto compatível no seu thread de UI **antes** de criar janelas, preferindo o contexto medido do Gemini aberto. A operação de encaixe ainda verifica a igualdade dos contextos. As configurações de DPI do Windows não são modificadas.

### Colaboração pelo aplicativo conectado

A ADE usa a sessão já aberta do aplicativo oficial: não usa Gemini API, não pede outra chave e não lê cookies, tokens ou arquivos do perfil. O executável é validado pela assinatura Google antes de conectar. Com a janela ligada a um painel, uma ponte do Windows UI Automation localiza o campo de mensagem e o botão de envio, entrega uma consulta por vez e lê a resposta renderizada na própria interface. Um marcador aleatório por consulta evita confundir o texto da pergunta com uma resposta ainda em geração. Se os controles acessíveis mudarem, o rascunho existente não for vazio ou a resposta não ficar visível pela acessibilidade, a consulta falha com o motivo registrado em vez de enviar algo ambíguo.

O provedor `gemini-desktop` participa do roster e pode ser líder ou integrante de squads. Ele continua com `headless`, `mcp`, `accounts` e `models` em falso porque a execução acontece na janela visível do Google; o modelo e a conta continuam escolhidos no próprio app. As consultas criadas enquanto a janela não está conectada permanecem na fila e começam quando um painel Gemini é conectado.

Em missões no canvas, uma função Gemini vira um nó real com coroa, rótulo e conexões com os demais terminais. O briefing entra na fila assistida. Há uma única janela Gemini: nesse modo, o squad aceita uma função Gemini por missão; a execução em console permite várias tarefas na fila. O subagente CLI padrão continua reservado aos provedores com terminal.

O painel **Consultas · Equipe** conecta/desconecta terminais e mantém as ações diretas de equipe. `ags peer list|ask|tell` reconhece o nó Gemini e cria consultas para a mesma fila, sem procurar um PTY inexistente. `peer ask` espera a resposta quando a janela que possui a sessão está conectada; `peer tell` devolve o id para leitura posterior. A coroa amplia o alcance para o time conectado e o backend valida as conexões antes de entregar mensagens.

Em execuções de console, `gemini_desktop_run_tasks` associa cada consulta a uma tarefa e tentativa reais. Uma resposta comum conclui automaticamente a tarefa e libera as dependências pelo scheduler existente. Para um líder, a resposta JSON capturada aparece em **Consultas · Equipe**; o usuário ainda revisa e aplica o plano antes de a missão começar. A ação usa `run.plan`, preservando validação de funções, dependências e roteamento do squad. Consultas antigas não podem concluir tentativas novas; cancelamentos e tarefas interrompidas invalidam suas consultas. A troca de modelo e conta acontece no aplicativo Gemini.

Um agente pode registrar uma consulta com contexto textual explícito, continuar outra atividade e recuperar depois a resposta. O painel conectado drena as consultas pendentes automaticamente, em sequência; a fila persiste em `gemini_desktop_consults`, e cada resultado permanece limitado ao workspace de origem. Entregas finais não podem ser sobrescritas.

CLI da nova build:

```powershell
ags gemini status
ags gemini consult --cwd . --prompt "Revise esta proposta e aponte os riscos: ..."
ags gemini result ID_DA_CONSULTA
```

MCP dos agentes da nova build: `gemini_desktop_status`, `gemini_desktop_consult` e `gemini_desktop_result`. Uma consulta `queued` ou `working` ainda não tem resposta final; sem uma janela conectada, ela permanece aguardando. As respostas capturadas são dados não confiáveis e as ferramentas continuam filtradas pelos papéis existentes; o contexto de uma tarefa é resolvido para seu projeto no backend.

O Gemini CLI continua separado. A conexão desenhada no canvas não injeta ferramentas, skills ou permissões no aplicativo Google.

### Verificação da implementação

- TypeScript sem erros e build Vite de produção concluído.
- Testes de abas, squads, missões, canvas, fronteiras da integração e traduções validam o posicionamento no nó, a troca de modos sem remontagem e a abertura de squads mistos.
- Testes Rust verificam limites de geometria, entrega de resultados a tarefas reais, bloqueio de tentativas antigas, cancelamentos, validação de squads e alcance das conexões.
- `cargo run --bin gemini-smoke` cria um host Tauri isolado, sem abrir a base da ADE ou restaurar agentes. O teste encaixa, oculta, redimensiona e solta o Gemini real; o resultado fica em `%TEMP%/ade-gemini-native-smoke.json`. Na execução local, o relatório final registrou `attached: true`, `detached: true`, `phase: completed`; a inspeção posterior confirmou o mesmo HWND independente e visível.

As funcionalidades ficam disponíveis ao recompilar esta branch. O aplicativo já instalado não é substituído automaticamente.

Isso é composição de janelas no Windows. Não foi necessário modificar o Gemini, copiar sua sessão ou substituir seus serviços. Não é uma API pública do Google, e a compatibilidade precisa ser revalidada após atualizações.

## O que foi encontrado na instalação

| Evidência local | Resultado |
|---|---|
| Executável em execução | `%LOCALAPPDATA%/Google/Gemini/app-1.15.0/Gemini.exe` |
| Assinatura Authenticode | Válida, Google LLC |
| Pacote | `resources/app.asar`, entrada `src/main.js` |
| Interface | Electron; a interface principal é carregada de `https://gemini.google.com/app` em `WebContentsView` |
| Recursos nativos | `src/gemini_native.node` e um launcher auxiliar Win32 |
| Preload | Expõe `geminiNative` ao domínio do Gemini, incluindo captura de janelas e flags |
| Instâncias | `requestSingleInstanceLock`; abrir novamente tende a trazer a janela existente |
| Depuração remota | O código de produção recusa switches de depuração e alterações de rede |
| IPC interno | Named pipe entre Electron e `GeminiAppLauncher`; mensagens de ciclo de vida/configuração |
| API de integração | Não foi identificada API pública local para enviar prompts ou obter respostas |

O `package.json` declara Electron `^42.4.1`; o processo de crash em execução informa `44.5.1`. A declaração do pacote não deve ser usada para deduzir a versão exata do runtime.

SHA-256 do `app.asar` analisado:

```text
fe39fb8435b9ed9a10e57363dfc1c28d2e9d660083412b2061736bac6cc06704
```

A inspeção foi limitada a recursos da instalação e metadados dos processos. Não foram lidos cookies, tokens ou arquivos do perfil do usuário. Nenhum código proprietário extraído foi incluído neste repositório.

## Caminhos avaliados

| Caminho | Conclusão e evidência |
|---|---|
| Janela original hospedada por Win32 | **Recomendado para um primeiro experimento na ADE.** Funcionou no host de prova com DPI compatível. |
| Gemini em iframe/proxy do navegador atual | Não preserva o aplicativo nativo. Autenticação, políticas de navegação e recursos do preload continuariam sendo problemas separados; não foi validado. |
| WebView2 dedicado para o site | Possível investigação alternativa, mas exige login/perfil próprios e substituição dos recursos nativos; não foi validado. |
| CDP ou inspector no aplicativo original | O código de inicialização rejeita explicitamente `remote-debugging-port`, `remote-debugging-pipe`, `inspect` e similares. Não é uma interface utilizável nesta build sem alterar o app. |
| IPC do launcher | Encontrado, mas não há evidência de operações de chat. Não foi feita conexão experimental ao pipe. |
| Copiar/alterar `app.asar` | Desnecessário para o encaixe; gera dependência de código proprietário e atualizações. Não foi feito. |
| API de modelos ou Gemini CLI | São integrações distintas; não incorporam a interface e os recursos do aplicativo mostrado pelo usuário. |

## Prova reproduzível

Scripts adicionados:

- `scripts/inspect-gemini-desktop.mjs`: inventário de evidências do pacote instalado, somente leitura. Seleciona a versão numérica mais recente com ASAR; isso pode diferir da versão em execução após uma atualização.
- `scripts/gemini-native-probe.ps1`: seleciona uma única janela principal do Gemini e verifica a assinatura Google antes do teste.
- `scripts/gemini-native-probe.cs`: host WinForms temporário e operações Win32. Não injeta JavaScript ou DLL no Gemini.

Na raiz do repositório, com a janela principal do Gemini aberta:

```powershell
node scripts/inspect-gemini-desktop.mjs
powershell.exe -NoProfile -STA -File scripts/gemini-native-probe.ps1 -InspectOnly
powershell.exe -NoProfile -STA -File scripts/gemini-native-probe.ps1 -Seconds 25
```

Usar **Windows PowerShell de 64 bits** para o host WinForms. O teste termina automaticamente; fechar normalmente o host também restaura a janela. Durante o teste ela sai temporariamente da área de trabalho para dentro do host. O script recusa múltiplas janelas candidatas ou contextos de DPI incompatíveis.

Resultado observado no primeiro teste, de 25 segundos:

```json
{
  "Attached": true,
  "Resized": true,
  "Hidden": true,
  "Shown": true,
  "Restored": true,
  "OriginalDpiAwareness": 2,
  "Error": null
}
```

Foi executado também um teste de 40 segundos, com o mesmo código compilado como executável WinForms separado para inspeção visual. A interface do Gemini apareceu dentro do host em primeiro plano e o resultado repetiu os cinco indicadores positivos. Após a saída, o Gemini voltou a ser uma janela independente, visível, com o mesmo processo.

`Resized` verifica o tamanho externo do HWND, não a qualidade de todo o layout interno. A captura mostrou a interface no espaço reduzido, mas não foi feita auditoria de responsividade. Não foram enviados prompts nem testados anexos, microfone, voz, geração de imagens, login, seletor de arquivos ou consumo de cota.

O protótipo não possui um watchdog externo: encerrar seu processo à força ou uma falha do host pode comprometer a janela hospedada. Essa recuperação é requisito para produção. Não usar o protótipo como integração permanente.

## Arquitetura de referência

O frontend é React e o backend Tauri. O navegador atual usa iframe/proxy (`src-tauri/src/preview/mod.rs`); seu próprio comentário já registra que superfícies nativas ficam acima do HTML. Portanto, criar um **tipo de vista próprio** para o Gemini, com um host nativo dedicado.

1. **Backend `src-tauri/src/desktop_apps/`**, inicialmente somente Windows. Descobrir a instalação e a janela principal pelo processo/caminho/assinatura, abrir o app instalado se necessário e esperar a janela com timeout. Não persistir um HWND entre execuções: o Windows reutiliza handles.
2. **Sessão de encaixe com dono único.** Guardar PID, identidade do executável, estilos, posição, visibilidade e pai original. Recusar a adoção de janelas já hospedadas. Uma janela do Gemini deve pertencer a apenas uma aba/instância da ADE; uma nova aba deve focar a existente.
3. **Host HWND sob a janela Tauri.** Criar o host com contexto de DPI compatível, verificar compatibilidade antes de `SetParent`, aplicar os estilos e verificar o pai resultante. Operações de UI devem passar pelo thread apropriado. Recusar privilégios/DPI incompatíveis e oferecer abrir o Gemini separadamente.
4. **Comandos Tauri** como `gemini_desktop_status`, `attach`, `set_bounds`, `set_visible` e `detach`, com sessão vinculada à janela chamadora. O frontend não deve poder adotar qualquer HWND fornecido por uma página remota.
5. **Frontend `src/features/desktopApps/GeminiDesktopTab.tsx`.** Adicionar `DesktopAppView` em `src/features/tabs/viewTabs.ts`, abertura/deduplicação no `viewStore.ts`, montagem no `ViewTabsHost.tsx`, título/ícone no `ViewTabItem.tsx` e botão de abertura no `TabBar.tsx`. Ajustar restauração, validação de vistas e contratos que assumem apenas arquivo/diff/browser.
6. **Geometria e visibilidade.** Observar o retângulo com `ResizeObserver`; converter coordenadas CSS para pixels físicos considerando escala do WebView, DPI e origem da área cliente. Atualizar após zoom, troca de monitor, divisão de painéis e scroll. Ocultar a superfície ao trocar aba, workspace ou rota.
7. **Menus, diálogos e arraste.** Superfícies Win32 ficam acima do HTML: ocultar temporariamente o host quando houver um modal, menu, command palette ou arraste sobre sua área e restaurar apenas quando a aba continuar visível. Só aumentar `z-index` não resolve.
8. **Encerramento e recuperação.** Desencaixar antes de destruir o host ou fechar a ADE; fechar a aba significa devolver o Gemini à área de trabalho. Implementar watchdog fora do processo da ADE, verificação de `IsWindow`/PID e tratamento de atualização/reinício do Gemini. Tratar os botões da moldura desenhada pelo próprio Gemini: retirar `WS_CAPTION` não remove necessariamente esses controles.

Os features Win32 de janelas/DPI/acessibilidade foram habilitados no `windows-sys` do `src-tauri/Cargo.toml`. O registro dos comandos fica em `src-tauri/src/app/run.rs`. Não é necessário migrar a ADE de Tauri para Electron.

### Critérios antes de disponibilizar

- Interagir, digitar e navegar com mouse/teclado dentro da aba; validar atalhos e foco entre processos.
- Trocar de workspace, aba e rota; abrir diálogos e menus sem sobreposição indevida.
- Validar DPI 100%, 125%, 150% e monitores com escalas diferentes.
- Validar anexos, seletor de arquivos, câmera/microfone e janelas auxiliares manualmente.
- Restaurar a janela em fechamento normal e recuperar após falha forçada da ADE.
- Tratar atualização do Gemini e segunda instância da ADE sem duas adoções da mesma janela.

O encaixe visual não dá ao Gemini acesso direto a arquivos do workspace, skills ou ferramentas ADE. O bridge usa controles visíveis e acessibilidade do Windows, por isso depende da interface e continua sem equivalência a um agente de terminal com ferramentas. Ainda é necessário validar envio e leitura de ponta a ponta contra a versão do Gemini instalada após compilar esta branch.

## Fontes consultadas

- [Microsoft: SetParent](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent): documenta a alteração de pai e esclarece que “SetParent does not modify the WS_CHILD or WS_POPUP window styles”. Também registra riscos de diferenças de DPI entre processos.
- [Microsoft: High DPI Desktop Application Development](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows): explica o possível reset de DPI quando árvores de janelas misturam contextos incompatíveis.
- [Electron: WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view): contrato do componente usado no pacote analisado.
- [Electron: switches de linha de comando](https://www.electronjs.org/docs/latest/api/command-line-switches): descreve CDP no Electron genérico; a validação local do Gemini acrescenta a rejeição desses switches.
- [Discussão de incorporação de aplicativo externo](https://stackoverflow.com/questions/65133449/embed-external-native-windows-app-inside-electron-window): referência comunitária ao caminho Win32, sem solução verificada específica para Gemini.
- [Fórum GLFW: falhas de renderização após SetParent](https://discourse.glfw.org/t/no-rendering-on-child-windows-created-by-setparent-native-api-method/2168): relato em outro runtime, usado como pista de investigação e razão para testar renderização localmente; não comprova um defeito no Gemini.

A pesquisa usou o índice `firecrawl-developer-index` e busca web. A conclusão se apoia principalmente na instalação assinada local, na documentação Win32 e nas duas execuções da prova, não em relatos de clientes Gemini de terceiros.

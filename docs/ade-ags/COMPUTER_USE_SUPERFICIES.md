# Computer use: núcleo comum, simulador iOS e iPhone físico

## Uso

```sh
ags sim act iPhone "Abra Geral nos Ajustes" --expect "text:Armazenamento do iPhone" --steps 8 --timeout 300
ags sim act iPhone "Preencha o campo já focado" --fill "screen=exemplo" --expect "text:exemplo"
```

A chamada exige a identidade de quem chama, verificada pelo backend (veja "Quem pode chamar"). Flags não substituem a identidade; sessão e alcance são revalidados durante o laço. O nome/id precisa identificar um nó iOS conectado ao terminal chamador. O aparelho precisa estar ligado. Um UDID isolado não concede alcance. Apenas um `act` pode usar o aparelho por vez.

Em Ajustes → Decisões, é necessário habilitar Jev, o piloto do navegador e a reserva visual. Nada é ligado automaticamente. O comando usa somente o provedor e a URL configurados, sem fallback para outro serviço. No iOS, o Jev recebe primeiro OCR e rótulos já lidos localmente; a foto não é enviada quando um rótulo basta. Se a próxima ação depender de um ícone sem nome ou de rótulos ambíguos, ele usa a reserva visual (`jev-preview`). Provedores sem suporte a imagem são recusados antes de capturar. A CLI instalada só terá o comando depois de uma atualização autorizada; o código novo não altera o app instalado.

Para uma tarefa com várias telas no iPhone, passe o percurso inteiro em uma chamada `ags sim act`/`sim_act`, com passos suficientes. O agente deve executar o laço sem mandar uma mensagem ao usuário a cada tela e informar uma vez o resultado final verificado; interrompe apenas para confirmação, bloqueio ou progresso solicitado. Em telas com mascotes, vídeo, spinners ou contadores, conclua pela informação relevante ao objetivo; nunca espere a imagem inteira parar de mudar. `ags device tap` e capturas repetidas não chamam o Jev.

- `--steps`: 1–15, padrão 8.
- `--timeout`: segundos, 10–1.800, padrão 115. **O prazo inclui o tempo de a pessoa responder a uma confirmação** (digitar, controle de risco, consentimento do Mac): com confirmação provável, use 300. O mesmo padrão e a mesma faixa valem para `portal act` e para as tools MCP (`browser_act`, `sim_act`, `desk_act`), por `ipc::mcp::act_timeout_secs`. O prazo é conferido entre fases, inclusive depois de OCR/diálogos. Uma operação nativa já iniciada tem prazo próprio (até 60 s no `simctl`) e pode terminar depois do orçamento. A CLI reserva mais 75 s para esse encerramento.
- `--fill screen=valor`: um preenchimento no campo **já focado**. O modelo não gera texto. Usa o teclado US ASCII do HID existente; texto vazio, caracteres não suportados e controles (inclusive Enter/Tab) são recusados antes de agir. Não limpa automaticamente conteúdo anterior e não envia Enter.
- `--expect text:trecho`: repetível, todos os trechos precisam aparecer no OCR local. `url:`, `count:` e `absent:` são recusados antes de agir: ainda não existe árvore AX no iOS. A verificação é textual e pode falhar por OCR.
- `--expect visual:changed|darker|lighter` (só iOS; o `desk act` recusa): compara os pixels da foto atual com a primeira do `act`. Veja "Efeito por pixels".

Apenas um `act` por vez: um por simulador e um no Mac (trava global); o segundo é recusado enquanto o primeiro roda.

A resposta JSON inclui `text` legível, como no `portal act`, e `report` com status, ações/tentativas, contagem de observações e chamadas ao decisor. O exit 0 da CLI indica que o relatório foi obtido; confira `report.status` para saber se o objetivo foi atingido. `done` exige expectativas locais satisfeitas; a conclusão do Jev sem expectativas é `unverified`. Limite, incerteza e falha não são apresentados como sucesso. O resumo também aparece na conversa do nó do simulador, sem valores digitados.

## Quem pode chamar

A mensagem antiga "sim act exige a sessão de um terminal ADE AGS" vinha de `terminal::authorize`: token `ADE_SESSION` + PID descendente do PTY. Só terminais de aba recebem o token; as conversas por protocolo recebiam apenas `ADE_TAB_ID=thread:<id>`, que não é segurança. Hoje `terminal::authorize_actor` aceita os dois, sem abrir brecha:

| Quem chama | Caminho até o Jev | Identidade verificada | Estado |
|---|---|---|---|
| Claude Code, Codex, Gemini, OpenCode, Kimi, Hermes, Antigravity, Cursor em **aba de terminal** | `ags portal act`, `ags sim act`, `ags desk act` (shell) | token `ADE_SESSION` + PID descendente do PTY | ok |
| Codex, Claude Code, OpenCode, Antigravity, Cursor em **conversa por protocolo** (`conversa/`) | `ags …` pelo shell do agente | `thread:<id>` + PID do cliente descendente do processo do motor (`register_process` nos cinco motores); também recebe `ADE_SESSION` | ok |
| MCP `ags mcp --cwd` (abas de Claude Code, Codex, OpenCode e Hermes pela config gerenciada) | `browser_act`, `sim_act`, `desk_act` | `sim_act`/`desk_act` repassam o `ADE_TAB_ID`/`ADE_SESSION` que o processo do MCP herdou (ou o `--tab`) e o backend confere com `authorize_actor`, como na CLI; argumentos `from`/`session` do modelo são descartados | ok |
| MCP `ags mcp --task` (frota) | `browser_act` | escopo pela tarefa | sem computer use: não há aba nem conversa que identifique a tarefa |

Gemini, Kimi e Hermes não têm motor de conversa (só aba PTY). A TUI do Codex recebe o MCP por overrides `-c` exclusivos do processo; conversas por protocolo Codex, Claude Code, OpenCode e Antigravity também recebem a ponte MCP. A CLI `ags` continua disponível nas superfícies em que o MCP não está configurado.

A conversa por protocolo recebe `ADE_SESSION` (decisão do usuário, P7 do desenho de unificação): `chat_team::env::thread_env` emite um token novo a cada processo do motor, que só vale depois de `register_process` saber o PID (um respawn troca o token, como num PTY novo). O token fica só na memória do app e no ambiente do motor; não é segredo do keyring. Com ele a conversa usa `memory.*`/`swarm.*` (memória e quadro da missão). Sem PID do peer (plataforma sem a API) a conversa é recusada. Um terminal que afirma ser `thread:x` não descende do processo daquela conversa e é recusado.

## Sandbox dos agentes

O `ags` fala com o app por um socket Unix (`~/.ags/ipc/<pid>.sock`, macOS e Linux) ou um named pipe (Windows), que entrega o PID de quem chama. Um sandbox que bloqueia conexões AF_UNIX faz **todo** comando `ags` falhar com `Operation not permitted (os error 1)`, com o app de pé. A CLI reconhece o caso (`ipc::transport::credential_connect_error`): sai com exit 1 (não 3, "abra o app"), não manda reiniciar o app e diz o que fazer em cada agente (`CODEX_SANDBOX` → Codex, `SANDBOX` → Gemini).

**Codex (medido no `codex-cli 0.166.0`, sem modelo e sem cota).** Servidor de socket Unix descartável numa pasta de teste e cliente rodando dentro do sandbox, por `codex sandbox` e pelo caminho real da conversa (`codex app-server` + `command/exec`, que usa a política do sandbox sem chamar o modelo):

| Configuração | Socket da pasta liberada | Outro socket | Rede externa (`curl`) | TCP direto |
|---|---|---|---|---|
| `workspace-write` (o padrão da conversa, `access_policy`) | recusado (os error 1) | recusado | recusada | recusado |
| `codex sandbox --allow-unix-socket <pasta>` (flag só do comando `sandbox`) | ok | recusado | — | — |
| perfil `[permissions.ags]` com `network.unix_sockets = {"<pasta>"="allow"}` | recusado | recusado | recusada | — |
| o mesmo perfil + `network.enabled = true` | ok | recusado | **liberada (200)** | — |
| o mesmo + `--enable network_proxy` (feature **experimental**) | ok | recusado | recusada pelo proxy (403) | recusado |

`ADE_TAB_ID` e `ADE_SESSION` chegam ao shell do Codex na conversa (o padrão de `shell_environment_policy` herda o ambiente). Na aba PTY a ADE já põe `ADE_TAB_ID` por `-c shell_environment_policy.set` e `ADE_SESSION` por perfil 0600 (`pty_manager::with_codex_identity`).

Conclusão: a liberação estreita (só a pasta `~/.ags/ipc`, rede fechada) existe, mas depende da feature experimental `network_proxy`; sem ela, a mesma config **abre a rede geral**. Por isso **nada foi aplicado** ao sandbox: a decisão é do usuário. Opções:

1. **Escalonamento por comando (hoje, sem mudança de código).** O Codex pede `sandbox_permissions: "require_escalated"` ao rodar `ags`; a pessoa aprova (uma vez ou para a sessão). A skill, o aviso de erro e as instruções do MCP ensinam isso. Foi o que passou no teste real.
2. **Perfil estreito na conversa.** `thread/start` aceita `config`: um perfil `extends = ":workspace"` com `network = { enabled = true, unix_sockets = { "~/.ags/ipc" = "allow" } }` e `features.network_proxy = true`. Liberaria só o socket, mas uma versão do Codex sem o proxy (ou que mude a feature) abriria a rede inteira. Exigiria conferir a versão/feature antes de aplicar.
3. **Regra de exec** (`~/.codex/rules/*.rules`, `prefix_rule(["ags"], decision="allow")`). Rodaria o `ags` inteiro fora do sandbox sem perguntar; mexe no `~/.codex` do usuário. Mais amplo que (1).

`danger-full-access` não é opção.

**Gemini CLI.** Sem `--sandbox` não há bloqueio. No macOS o perfil padrão `permissive-open` permite rede de saída (inclui AF_UNIX); os perfis `*-closed`/`restrictive-*` bloqueiam; em docker/podman o socket não existe. **Não verificado aqui** (o `gemini` não está instalado nesta máquina).

**Claude Code** com o sandbox do Bash ligado: `sandbox.network.allowUnixSockets` com a pasta `~/.ags/ipc`. A ADE não liga esse sandbox nas abas.

## Agente × superfície

| Agente | Aba PTY: CLI | Aba PTY: MCP (`browser_act`/`sim_act`/`desk_act`) | Conversa por protocolo | Skill `ags-orchestrator` |
|---|---|---|---|---|
| Claude Code | ok | ok (`--mcp-config`) | ok (MCP + CLI) | `.claude/skills` |
| Codex | ok com escalonamento quando o sandbox bloqueia | ok (overrides `-c` por processo) | ok com escalonamento (`workspace-write`, MCP + CLI) | `.agents/skills` |
| Gemini CLI | ok (sem `--sandbox` ou com `permissive-open`) | — | sem motor | `.agents/skills` |
| OpenCode | ok | ok (`OPENCODE_CONFIG_CONTENT`) | ok (MCP + CLI) | `.agents/skills` |
| Kimi | ok | — | sem motor | `.agents/skills` |
| Hermes | ok | MCP gerenciado; herança de `ADE_SESSION` não verificada | sem motor | não recebe: as skills dele ficam em `~/.hermes/skills`, fora do projeto |
| Antigravity | ok | — | ok (MCP por turno + CLI) | `.agents/skills` (o `agy` 1.5.0 lê essa pasta) |
| Cursor | ok | — | ok (CLI) | `.cursor/skills` |

Estado pelo código e pelos testes com fakes (`ipc/test.rs`, `agents/contract.rs`, `terminal/session.rs`, `ipc/transport.rs`). O percurso real com Jev em cada CLI **não foi medido**: custa cota e exige OK.

## O que cada um alcança (`surfaces::reach`)

Uma função só, `surfaces::reach(actor)`, devolve o que uma aba ou `thread:<id>` alcança. Listagem (`ags device list`, `ags portal list`) e autorização (`ags device *`, `ags sim act`, cada passo do computer use iOS) usam a mesma lista, e o `sim act` refaz a pergunta a cada passo.

| Origem | Como entra | `control` | O que pode |
|---|---|---|---|
| Canvas | portal ligado por corda ao ator (orquestrador: também os do time) | sempre | tudo |
| Painel do chat | aparelho aberto no painel direito (`chat:<udid\|serial>`), sem corda | a chave "Permitir que agentes controlem dispositivos" | sem a chave só `shot` e `tree`; `sim act` e o resto exigem a chave |

Um aparelho do painel que também é portal ligado ao ator aparece só como o portal. O `desk act` não passa por aqui: depende só do ator e da aprovação na UI. O bloqueio do device hub não mudou. Teste: matriz `{aba, thread} × {corda, painel, nenhum} × {controle ligado, desligado} × {shot, act}` em `src-tauri/src/surfaces/test.rs`.

## Computer use do Mac (`ags desk act`)

```sh
ags desk act "Abra o Mail e mostre a caixa de entrada" --expect "text:Caixa de Entrada" --steps 8 --timeout 300
```

Mesmo núcleo do iOS (`computer_use::run`), com `computer_use/desktop.rs`: foto da tela principal (`screencapture`), OCR local, entrada por CGEvent (`desk_input.swift`, só `click`/`scroll`/`type`/`bounds`/`check`). Regras:

- **Sem cartão no canvas, a autorização é a pessoa**: um diálogo no início de cada act, antes de qualquer foto. Não há interruptor, flag ou memória de aprovação. Recusa, prazo ou falha do diálogo → `blocked`, nada observado.
- Ação sensível/incerta (digitar, clique sem rótulo OCR, rótulo de risco, risco do decisor) pede confirmação **por ação**; teclas soltas e Enter não existem. Probabilidade, nunca `confidence`; piso 0,4 para agir e 0,75 para concluir.
- Privacidade igual à do iOS: OCR com segredo/campo privado não sai; `--fill` nunca vai ao provedor; marcador persistente `computer_use.desktop.private` depois de digitar. A tela inteira pode conter outros apps: a foto só sai depois do consentimento inicial e do detector local, por melhor esforço.
- **Auditoria comum** (`approval_audit`, origem `chat`, ferramenta `computer_use:desktop|click|type|scroll|privacy`): cada pergunta gera `asked` e cada resposta `decided` (`allowed-once`/`rejected`/`unavailable`), sem objetivo, valores ou foto. O log do Jev registra a consulta como no iOS.
- Exige Acessibilidade e Gravação de Tela para a ADE; sem elas, recusa com a instrução antes de perguntar. Só a tela principal; um act por vez.
- Teste com fakes: `computer_use/desktop/test.rs` (parser de tela, rolagem, consentimento, auditoria) e o núcleo já coberto em `computer_use/test.rs`. Percurso real (permissões, latência, cliques) **não foi medido**: exige o app com permissões e Jev autorizado, com teto.

## Laço e integração

`computer_use::run` recebe `Request`, `Surface` e `Decider`. O núcleo é independente do HID, do OCR e do transporte HTTP. Há também um adaptador `JevDecider` de texto para o protocolo `browse::pick` existente; o iOS usa seu decisor visual.

A implementação iOS (`computer_use/ios.rs`) faz:

1. Revalidação de alcance no canvas, UDID, aparelho ligado e prazo.
2. Foto dentro do processo: no simulador, os pixels saem da `IOSurface` da tela, a mesma que o painel mostra, e viram um PNG de no máximo 1.200 pixels no lado maior pelo CoreGraphics/ImageIO, na pasta de capturas permitida pelo app. A cópia só vale se o seed da superfície for o mesmo antes e depois (nunca meio quadro). Com o aparelho girado, num formato de tela diferente de BGRA ou se a leitura falhar, a foto volta ao `simctl io screenshot` + `sips`. No iPhone físico, a origem é um quadro do espelho validado pela fence de captura (depois do IRAP/IDR de recuperação, sem anomalia desde então), reduzido diretamente de BGRA a PNG; se não houver quadro seguro, `devicectl device capture screenshot` fornece uma foto independente. A origem (`espelho` ou `devicectl`) e o tempo total são registrados no log, sem pixels.
3. OCR local pelo Vision do macOS (`VNRecognizeTextRequest`) dentro do processo, no Apple Silicon, com o mesmo JSON do `ios_ocr.swift` (teste com imagem fixa, `computer_use/fixtures/ocr-ajustes.png`). A primeira leitura de um executável novo leva 44-70 s, então ela é feita numa imagem fixa numa thread à parte, ao começar o primeiro `act`; até ela voltar, e no Intel, o OCR segue pelo Swift do Xcode (`swift -e`). Nenhuma consulta externa. A API usada é [VNRecognizeTextRequest](https://developer.apple.com/documentation/vision/recognizing-text-in-images).
4. Aplicação das guardas locais antes do provedor e verificação das expectativas.
5. O Jev recebe primeiro o texto do OCR e os centros normalizados das caixas de texto, em uma consulta textual. Se precisar localizar um ícone sem rótulo ou resolver ambiguidade, faz uma segunda consulta visual com a foto e escolhas fechadas: clicar, digitar quando há fill local, rolar, concluir ou parar; a rota visual também pergunta risco.
6. Confirmação humana quando necessária na UI existente (`user.ask`). Clique escolhido pelo texto pede confirmação até o aparelho ser confiável; mesmo com confiança, rótulos sensíveis e digitação continuam pedindo.
7. Conferência da tela antes do HID, inclusive após o diálogo. Na foto nativa do simulador, a revisão é o SHA-256 dos pixels crus da `IOSurface` (com dimensões e UDID, prefixo `px:`); conferir é ler e somar de novo os pixels (~40 ms), sem outra foto. No caminho do `simctl`, a revisão é o hash do PNG e qualquer diferença invalida a decisão. No iPhone físico, pixels iguais continuam sendo a prova preferida; se a tela mudou, uma rolagem ou um clique em rótulo do OCR só segue quando todos os textos e suas caixas continuam iguais dentro da tolerância de 1,5% da tela. Ícones sem rótulo e digitação mantêm a comparação exata de pixels. Isso permite mascotes animados sem abrir mão de conferir que o controle visto pelo Jev continua no mesmo lugar.
8. Toque em coordenadas normalizadas convertido para pontos do iOS, `type_text` ou `swipe` existentes. A foto seguinte verifica o resultado. Foto e dimensão incompatíveis com o HID são recusadas; rotação ainda não é suportada.

**OCR primeiro, imagem quando necessária.** Se há linhas úteis, o piloto faz uma consulta textual do `browser_step`: até 60 textos distintos, com suas caixas normalizadas, mais o OCR local; a foto fica na máquina. O clique cai no centro exato da caixa escolhida e precisa de probabilidade ≥ 0,5. O modelo pode escolher a reserva visual quando o alvo for um ícone sem nome ou os rótulos não bastarem; essa chamada envia a foto pelo mecanismo existente e exige probabilidade da caixa ≥ 0,6. Com menos de duas linhas de OCR, o piloto vai direto à visão. Valores de `--fill` nunca são enviados: a tela é bloqueada localmente quando contém algum. O Jev textual não classifica risco; por isso um clique textual pede confirmação se o aparelho ainda não é confiável, e `always_asks` continua exigindo confirmação para rótulos sensíveis mesmo depois disso. A latência dessa rota híbrida ainda não foi medida com Jev real; os testes locais cobrem apenas o mapeamento e as guardas.

**Tela assentada.** Com a foto nativa, a espera segue os quadros da tela (o seed da `IOSurface` anda a cada quadro que o iOS escreve; lido a cada 20 ms, memória local, sem registrar outro ouvinte de quadros no CoreSimulator, que disputaria a fila do painel):

- depois de uma ação, a foto espera pelo menos 0,6 s a partir do HID (um app pode demorar a começar a reagir, e a tela velha faria o Jev mandar tocar de novo; antes, a lentidão do `simctl` fazia essa espera sem querer) e 0,3 s sem quadro novo;
- na primeira foto do `act`, só 0,1 s sem quadro novo;
- animação contínua (vídeo, indicador girando) desiste em 2,5 s e fotografa assim mesmo; a conferência antes do HID continua valendo.

Logo depois de abrir um app, o iOS ainda está desenhando e o OCR lê só o relógio: os Ajustes levaram cerca de 6 s para aparecer. Uma foto com menos de 2 textos não vai ao Jev: o piloto espera o próximo quadro (até 0,8 s; sem foto nativa, 0,8 s fixos) e tira outra foto, até 6 vezes e sempre dentro do prazo do `act`; o OCR dessa última foto é reaproveitado pela observação. Números medidos em [SIMULADOR_IOS.md](SIMULADOR_IOS.md#computer-use-velocidade-medido).

No iPhone físico, a espera por `IOSurface` não se aplica: o agente usa o último quadro confiável do espelho ou cai para uma captura nova via `devicectl`. Não espere a imagem inteira parar de mudar para continuar; vídeo, contadores e animações impedem esse critério. Os registros do teste de navegação PWA de 06/11/2026 mediram toque mais capturas repetidas até a imagem inteira estabilizar: 27 rotas, mediana 2,09 s, média 2,48 s e 3 sem estabilizar no limite de 5,8 s. Isso não mede a latência do agente nem do Jev. A próxima execução registra, em uma linha por `sim act`, o tempo total, captura, OCR, Jev textual/visual e validação da tela, sem guardar objetivo, texto reconhecido ou imagem.

**Gestos do iOS.** No iOS, o Jev pode escolher `swipe_left` e `swipe_right`, que são traços horizontais na altura do meio e longe das bordas, e `home`, que é o botão de início. Os três são da família de `scroll`, ação comum sem confirmação, cada um com seu alvo. No Mac eles não existem.

**Alvo coberto (`computer_use/cover.rs`).** Antes de tocar, o driver confere se o texto que o Jev escolheu está numa zona coberta. As zonas vêm só do OCR local, das caixas da foto:

| Zona | Como é reconhecida | O que conta como coberto |
|---|---|---|
| Teclado | pelo menos 6 teclas na metade de baixo (um caractere, `ABC`…`WXYZ` ou uma linha `QWERTYUIOP` lida junta) | o que fica abaixo do topo do teclado, com 0,06 de folga para a barra de sugestões |
| Barra flutuante | a linha mais baixa de 3 ou mais rótulos curtos, com o centro abaixo de 0,80 e espalhados por 45% da largura | o que fica abaixo do topo dela, com 0,05 de folga para os ícones |
| Borda | a base do texto em 0,985 ou mais | o próprio texto, cortado |

O alvo coberto não é tocado. A ação vira `scroll` com alvo `reveal`: um traço lento (600 ms) que começa na área livre e sobe o conteúdo o quanto falta. Em seguida, o laço olha de novo. Se a tela não muda, o act termina `unsure`, sem tocar.

Três casos são exceção:
- Tocar no próprio rótulo da barra (uma aba) é normal.
- Um ícone escolhido pela caixa desenhada não conta como coberto.
- Tocar numa tecla digita sem `--fill`. Por isso pede a pessoa sempre, mesmo com "Sempre neste aparelho".

Dados: o checkbox do Nutriton em y=756 sob a barra em y=757 (iPhone 17e, 852 pontos). Na foto real do teclado numérico do Nutriton, o OCR do Vision levou 399 ms para ler 29 textos. Ele achou o topo do teclado em 0,624, e as teclas começam em 0,684. Todas as teclas lidas pediram a pessoa, e nenhum campo de cima ficou coberto. Essa medição achou um defeito: a última linha (`PQRS TUV WXYZ`) passava por barra. A correção está no teste `ocr_real_do_teclado_numerico…`. A bancada é `COVER_PNG=<foto> cargo test --lib computer_use::cover::test::bancada -- --ignored --nocapture`.

**Efeito por pixels (`computer_use/visual.rs`).** A foto nativa guarda uma grade de brilho de 24 × 48 células, tirada dos pixels crus antes do PNG. Leva menos de 1 ms. A grade fica local e nunca vai ao provedor.
- `report.effects` traz, para cada ação, a fração de células que mudou (mais de 24 níveis de 255) e a variação do brilho médio.
- `--expect visual:changed` vale com 2% de células mudadas em relação à primeira foto do act.
- `visual:darker` e `visual:lighter` valem com uma variação de brilho de 0,08 ou mais.
- Sem grade (foto pelo `simctl`, rotação), a expectativa visual nunca se cumpre: fica `unsure`/`limit`, não `done`.

O caso medido foi o tema claro/escuro do Nutriton: o toque funcionou, mas um verificador só por estrutura (a árvore do `jev-sim-use`) relatou "nenhum efeito visível". No `act` nativo, a revisão já era o hash dos pixels, então o toque não parecia repetido. Faltava a prova de que mudou, e agora ela existe.

O provedor escolhe somente operações e caixas tipadas. Operações desconhecidas, probabilidades ausentes/inválidas e caixas fora da imagem são recusadas. O núcleo mantém os pisos existentes de 0,4 para ação e 0,75 para conclusão; a caixa desenhada usa o piso visual de 0,6 (era 0,85 até o PR 290). O rótulo é avaliado por probabilidade, nunca pela confiança alternativa de uma escolha.

Não há repetição automática de mutação depois de erro de transporte. A ação é registrada antes da execução, porque o SO pode aplicar o efeito e só depois retornar erro. A revisão estrita pode parar em telas animadas; a guarda não deve ser desativada. O histórico anticiclo do núcleo vale dentro do `act`, não é um livro-razão persistente entre chamadas.

## Decisão de privacidade e consentimento

Pedir explicitamente `sim act` autoriza o envio ao provedor configurado do **OCR e dos rótulos da tela atual** como parte da tarefa. A foto permanece local quando esses rótulos bastam; ela só é enviada se o Jev escolher a reserva visual para um ícone sem nome ou texto ambíguo. Isso não autoriza outros apps, arquivos, desktop inteiro ou troca de provedor.

Antes de qualquer consulta ao Jev, o OCR passa pelo detector de segredo existente. Rótulos de senha/passcode/cartão/token/CPF e texto mascarado reconhecidos bloqueiam o envio de OCR, rótulos e foto conservadoramente, mesmo quando o campo parece fora de foco. Falha do OCR bloqueia. Essa é detecção **por melhor esforço**: ainda não lê o estado nativo de teclado seguro nem uma árvore de acessibilidade. OCR não é uma garantia de reconhecer todo campo ou segredo; essa limitação precisa permanecer explícita.

`fills` e expectativas não entram no corpo do provedor. Um valor de fill repetido no objetivo é substituído por `[valor local]` antes da decisão; texto/nomes da observação que ainda contêm valores locais bloqueiam a consulta. Depois de qualquer tentativa de digitar, o driver grava **antes do HID** um marcador booleano por UDID em `settings` (`computer_use.ios.private.<udid>`), sem guardar o valor. A partir daí só observa e verifica localmente: não envia OCR, rótulos nem imagem ao provedor nesse `act`, inclusive se o HID falhar.

O marcador sobrevive ao reinício do app. Num `act` posterior, a pessoa precisa limpar os dados anteriores e confirmar, na UI, que nenhum fill anterior aparece na foto atual. Uma segunda captura precisa conferir com a revisão mostrada antes de liberar o marcador. Não existe flag CLI para dispensar essa confirmação. Rótulos sensíveis detectados continuam bloqueados mesmo após a resposta humana. Valores dos fills da chamada atual reconhecidos no OCR também impedem upload.

Toda ação sensível ou de efeito incerto pede confirmação **por ação**. Na rota visual, o risco escolhido pelo Jev só pode elevar o risco; no caminho textual, cada clique pede confirmação enquanto o aparelho não for confiável. Depois da confiança, `always_asks` ainda exige confirmação para rótulos sensíveis; digitação sempre pede. Uma palavra de risco em outro canto da tela (um "Sair" no menu) não torna sensível rolar nem tocar em outro controle. Sem resposta, recusa, prazo vencido, revogação de alcance ou revisão alterada, não age.

**O diálogo de confirmação.** O `user.ask` leva o dono (`owner`, a aba do agente) e uma `review` com a superfície, a ação em palavras (o gesto diz para onde vai), a foto já reduzida como URL de dados e o ponto em proporção. O diálogo (`ReviewDialog` em `src/features/ask/AskDialog.tsx`) mostra a foto com o ponto marcado e os botões Recusar, Sempre neste aparelho e Autorizar. Fechar ou Esc equivale a recusar. Sem resposta dentro do prazo do `act` (ou com a tela indisponível) também é recusa: o relatório volta `blocked` com "A pessoa não confirmou", nunca "A superfície ou o provedor falhou". Antes, uma pergunta sem dono que vencia resolvia `null` no front e virava falha de transporte, e o agente achava que o JEV estava quebrado. O texto da pergunta continua indo junto, para a auditoria, sem `None` cru nem caminho na tela.

**Sempre neste aparelho (só iOS).** A pessoa pode autorizar de uma vez um simulador: a chave `computer_use.ios.trust.<udid>` fica em `settings` e vale entre sessões. Com ela, o JEV não pergunta mais naquele aparelho, exceto ao tocar num controle de risco (pagar, apagar, senha, sair, enviar…), que continua perguntando. Desligar "Permitir que agentes controlem dispositivos" (ou o botão "Revogar autorizações de agentes" do painel do iPhone) chama `computer_use_forget` e apaga todas essas chaves, inclusive o `computer_use.ios.trusttype.<udid>` do `ags device type` no iPhone físico e as janelas de digitação em memória; fechar o painel ou o app não apaga. A marca de privacidade dos fills é outra chave e não some junto. O Mac não tem essa opção: a autorização dele é a pergunta no início de cada `desk act`.

O log existente registra `browser_step` e `browser_vision` com hash do objetivo, operação, probabilidade e latência. A rota visual também registra `foto_enviada=true superficie=<ios|desktop> rotulos=<n>` quando o transporte retorna uma resposta válida. Falha de envio registra `foto_envio_tentado=true`, sem afirmar recebimento. Não guarda pixels, OCR, valores digitados, caminho ou exceção crua. As capturas temporárias são removidas ao substituir/descartar a observação.

## Skills de terceiros (`jev-sim-use`, `agent-desktop`)

Elas vêm com o app e nascem ligadas para todos os agentes, mas não substituem o `act`. Elas leem a árvore de acessibilidade (simulador e Mac) e cobrem o Android. Toda ação com o Jev da ADE continua aqui, com confirmação, privacidade e um act por vez. A tabela de quando usar cada uma e as decisões em aberto estão em [SKILLS_TERCEIROS.md](SKILLS_TERCEIROS.md).

## Estado das outras superfícies

| Superfície | Estado |
|---|---|
| Navegador interno do canvas | `jevPilot.ts` / `ags portal act` preservados |
| Simulador iOS | Driver visual + HID e `ags sim act` conectados; AX ainda pendente |
| iPhone/iPad físico | `ags device` e `sim act`; MCP `device_list` / `device_shot` / `device_action`; foto confiável do espelho com fallback independente via `devicectl`; E2E Jev e tempos completos ainda dependem da validação supervisionada desta entrega |
| `real_browser` / `RealBrowserView` | WebView2 filho do Portal no Windows; não é navegador externo do Mac; preservado |
| `desktop_apps` | Gemini Desktop Windows; driver macOS AXUIElement + ScreenCaptureKit ainda pendente |
| Tela do Mac (`desk act`) | Driver visual (foto + OCR + CGEvent) com consentimento por objetivo; sem árvore AX ainda |
| Navegador externo Mac | Próxima etapa, como app do driver macOS; não será uma extensão do WebView2 |

## Validação e limites

Testes do núcleo, do parser CLI/IPC, da leitura de decisões visuais e das guardas de revisão/privacidade usam mocks. O OCR é compilado com `swiftc -typecheck` e testado localmente sobre uma imagem sintética, sem aparelho ou serviço remoto. O E2E com iPhone usa instância de desenvolvimento e só ocorre com autorização explícita e teto de cota; o estado desta entrega deve ser registrado abaixo, sem inferir sucesso a partir de testes simulados.

A integração nativa completa (latência, mudanças de foco, teclado, coordenadas e confirmação na UI com um aparelho rodando) ainda exige validação manual isolada. O percurso pago com Jev requer autorização explícita e teto. Não há medição de desempenho nem promessa de taxa de acerto nesta entrega.

### Resultado da rodada iOS

- Código final: 35 testes filtrados da biblioteca aprovados (`computer_use`, visão, parser e contrato IPC), incluindo percurso integrado com resposta Jev simulada → caixa → confirmação humana simulada → HID simulado → expectativa local. Os casos de recusa e revisão alterada não tocam.
- CLI final: 2 testes `sim_act` aprovados (parser/timeout/identidade e rejeição de identidade/sessão forjadas nas flags).
- OCR local: `swiftc -typecheck` aprovado; imagem sintética reconhecida como “Senha Ajustes Safari”, com caixas normalizadas. Nenhum simulador do usuário foi acionado.
- Lint de testes: aprovado, nenhuma violação nova (40 antigas no baseline). Typecheck aprovado; nenhum arquivo de frontend foi alterado.
- A última suíte completa anterior à extração final de helper/teste terminou com `ags test affected`: `passed: true`, Rust 1.870 aprovados / 16 ignorados e CLI 48 aprovados; Babel, TypeScript e frontend verdes. O schema macOS gerado pelo build disparou o plano completo e foi removido da entrega. Após a orientação de encerrar a rodada, só os testes filtrados foram executados; não se repetiu a suíte completa.
- Clippy anterior à extração final: exit 0, com warnings no repositório; não repetido nesta rodada. `git diff --check` aprovado.

### Inspiração e limites do iPhone físico

O projeto [PhoneUse Local](https://github.com/phoneuse-official/phoneuse) (MIT) serviu como referência de produto para três ideias: conferir visualmente a mudança após agir (já coberta por `--expect visual:changed`), localizar rótulos lidos por OCR (já usados como alvos de iOS) e deixar claro quando o resultado foi apenas relatado ou precisa de revisão (`done`/`unverified`). O ADE não incorpora PhoneUse nem copia seu código. Uma árvore de acessibilidade nativa no iPhone exigiria WebDriverAgent assinado no Xcode; essa opção fica registrada para outro trabalho.

**E2E supervisionado desta branch (05/11/2026): não executado.** A janela que já estava aberta tinha terminais/missões ativos e o painel iOS mostrava "Sem conexão"; o inventário CoreDevice reportou um aparelho pareado, Modo de Desenvolvedor ligado e túnel `unavailable`, sem helper de espelhamento ativo. Não houve decisão Jev nem entrada física. Confirmação visual, recusa/ausência de resposta, `type`, confiança persistente/revogação e fluxo completo continuam sem prova nativa nesta entrega. O tempo de uma ação completa no iPhone e no simulador não foi medido porque o aparelho não estava acessível pelo túnel.

Escolha expectativas exclusivas do destino e adapte o texto ao idioma real. Um texto já visível no ponto de partida pode satisfazer a expectativa sem precisar executar o objetivo. Sem expectativa adequada, a conclusão do modelo permanece não verificada.

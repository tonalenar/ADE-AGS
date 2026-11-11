# Ditado e entrada por voz

O recurso de ditado local permite à pessoa falar seu prompt em vez de digitá-lo, inserindo o texto reconhecido diretamente no rascunho do composer da conversa para revisão antes do envio.

## Princípios de privacidade e segurança

1. **Processamento estritamente no dispositivo:** O reconhecimento exige o motor local (`requiresOnDeviceRecognition = true` no macOS). Nenhum áudio é enviado a servidores de terceiros ou à nuvem.
2. **Áudio descartável em memória:** O áudio capturado pelo microfone fica apenas em buffers temporários de memória (`AVAudioPCMBuffer`) durante a sessão de ditado. Nenhum arquivo de áudio é salvo em disco ou mantido após a transcrição.
3. **Revisão obrigatória no composer:** A transcrição nunca envia a mensagem nem aciona a fila do agente automaticamente. O texto é inserido no rascunho no ponto onde o cursor estava posicionado, permitindo à pessoa ler, editar, complementar ou descartar o texto antes de enviá-lo.
4. **Sem falhas silenciosas:** Em plataformas onde o reconhecimento de fala local não está disponível (Windows e Linux nesta versão), o botão e o atalho permanecem visíveis com estado indisponível e exibem a razão clara ao usuário.

---

## Mapeamento da implementação atual

O fluxo de ditado conecta a interface em React/TypeScript ao helper nativo por meio de comandos Tauri no backend em Rust:

| Etapa / Componente | Arquivo e linhas | Responsabilidade |
|---|---|---|
| **Botão do Composer** | [`src/features/recording/VoiceInputButton.tsx`](../../src/features/recording/VoiceInputButton.tsx) | Renderiza o botão no composer, gerencia o ciclo de vida da sessão (`idle`, `starting`, `recording`, `finishing`), timer de segurança de 50 s, controle de atalhos (`ade:voice-input-toggle`) e tecla `Escape` para cancelamento. |
| **Comunicação IPC Front** | [`src/features/recording/ipc.ts:14-18`](../../src/features/recording/ipc.ts#L14-L18) | Invocações tipadas de `voice_input_start`, `voice_input_stop` e `voice_input_cancel`. |
| **Registro Tauri** | [`src-tauri/src/app/run.rs:161-163, 865`](../../src-tauri/src/app/run.rs#L161-L163) | Registra os comandos Tauri no handler e chama `voice_input::cancel_all()` ao fechar a ADE para não deixar subprocessos órfãos. |
| **Backend em Rust** | [`src-tauri/src/voice_input.rs:1-439`](../../src-tauri/src/voice_input.rs) | Gerencia a concorrência com atomics (`STARTING`) e mutexes, inicializa o subprocesso helper Swift via `util::spawn::hidden_command`, estabelece pipes de `stdin`/`stdout`, controla timeouts (`START_TIMEOUT = 120s`, `STOP_TIMEOUT = 45s`), trata o cancelamento limpo e isola plataformas não suportadas com `#[cfg(target_os = "macos")]`. |
| **Helper nativo macOS** | [`src-tauri/src/voice_input.swift:1-198`](../../src-tauri/src/voice_input.swift) | Processo auxiliar Swift que conecta ao `AVAudioEngine` e `SFSpeechRecognizer`, solicita permissões de Microfone e Reconhecimento de Fala, ativa `requiresOnDeviceRecognition`, injeta vocabulário contextual da ADE AGS e emite eventos JSON via stdout. |
| **Inserção no Composer** | [`src/features/chat/ChatComposer.tsx:170-183, 860`](../../src/features/chat/ChatComposer.tsx#L170-L183) | `insertTranscript` insere a transcrição no rascunho com espaçamento limpo preservando a seleção do cursor, sem acionar `submit()`. |
| **Atalho de teclado** | [`src/app/shortcuts.ts:212-222`](../../src/app/shortcuts.ts#L212-L222) | Atalho `composer.dictation`: **Cmd+Shift+D** no macOS e **Ctrl+Shift+D** no Windows e Linux, sob o contexto `when: "composerFocus && isDesktop"`. |
| **Despacho de atalhos** | [`src/app/useGlobalShortcuts.ts:238-241`](../../src/app/useGlobalShortcuts.ts#L238-L241) | Captura global do atalho `toggleDictation` emitindo o evento `ade:voice-input-toggle` na janela. |
| **Paleta de comandos** | [`src/features/palette/CommandPalette.tsx:1024-1035`](../../src/features/palette/CommandPalette.tsx#L1024-L1035) | Ação `voiceInput.toggle` pesquisável por termos como "ditado", "voz", "microfone", exibindo subtítulo com a razão caso esteja indisponível. |
| **Permissões do sistema** | [`src-tauri/Info.plist:5-8`](../../src-tauri/Info.plist#L5-L8), [`src-tauri/Entitlements.plist`](../../src-tauri/Entitlements.plist), [`src-tauri/src/privacy_settings.rs`](../../src-tauri/src/privacy_settings.rs) | Declarações de Microfone e Reconhecimento de Fala, entitlement `com.apple.security.device.audio-input` e comando com allowlist de painéis TCC. |

---

## Ciclo de vida e permissões

1. **Acionamento:** O usuário clica no botão com ícone de microfone ou pressiona o atalho de ditado (`Cmd+Shift+D` / `Ctrl+Shift+D`) com o composer focado.
2. **Permissões do macOS:**
   - **Microfone:** Verificado via `AVCaptureDevice.authorizationStatus(for: .audio)`. Caso esteja em `notDetermined`, chama `requestAccess(for: .audio)` para exibir o diálogo nativo. O app declara `com.apple.security.device.audio-input` na assinatura. Se negado, o aviso oferece abrir o painel Microfone.
   - **Reconhecimento de Fala:** Verificado via `SFSpeechRecognizer.authorizationStatus()`. Se negado, o aviso oferece abrir o painel Reconhecimento de Fala.
   - `open_privacy_settings` recebe somente `screen_capture`, `microphone` ou `speech_recognition`; o frontend usa o wrapper `openPrivacySettings` em `src/features/recording/ipc.ts`. Os deep links foram conferidos no macOS 27.2, sem alterar TCC.
3. **Inicialização do Reconhecimento:**
   - O idioma segue a preferência configurada na ADE (`pt-BR`, `en-US` ou `es-ES`).
   - O helper valida se o recognizer suporta `supportsOnDeviceRecognition`. Se o idioma não tiver modelo local baixado no Mac, o processo é abortado imediatamente sem enviar áudio para a rede.
   - Vocabulário técnico contextual é adicionado à requisição (`["ADE", "AGS", "Codex", "Claude Code", "OpenCode", "Antigravity", "Jev", "Tauri", "Rust", "React"]`) para evitar erros fonéticos em nomes comuns do ecossistema.
4. **Gravação e limite de tempo:**
   - O microfone é aberto e o botão passa para a fase `recording` (ícone de parada vermelho, `aria-pressed="true"`).
   - Um timer limita o trecho a 50 segundos (teto documentado pela Apple para evitar encerramento forçado da API Speech).
5. **Finalização ou descarte:**
   - **Finalizar:** Clicar no botão de parada envia o comando `stop\n`. O helper finaliza o stream de áudio, aguarda a transcrição final do `SFSpeechRecognizer` e retorna o texto. O texto é enviado ao composer via `onTranscript`.
   - **Descartar:** Clicar no botão `X` ou pressionar a tecla `Escape` envia `cancel\n`. O helper cancela a tarefa de reconhecimento e descarta o buffer imediatamente sem inserir nada no composer.

---

## Auditoria de plataformas: Windows e Linux

Conforme o plano da Fase 7.5 de paridade ("terminar Windows/Linux e opções acessíveis"), foi realizada a auditoria técnica de suporte a APIs nativas de reconhecimento de voz sem adição de dependências:

### 1. Windows

- **API moderna (`Windows.Media.SpeechRecognition`):**
  - A API nativa do Windows 10/11 para reconhecimento contínuo e ditado exige classes do namespace WinRT `Windows.Media.SpeechRecognition`.
  - No ecossistema Rust, o acesso a essa API depende da crate `windows` com a feature correspondente habilitada (`Media_SpeechRecognition`).
  - **Auditoria do `Cargo.lock` e `src-tauri/Cargo.toml`:**
    - A crate `windows` está presente na versão `0.62.2` (e `0.61.3` em dependências transitivas).
    - As features declaradas em `src-tauri/Cargo.toml` são exclusivamente:
      `["Win32_Foundation", "Win32_Globalization", "Win32_Graphics_Gdi", "Win32_UI_WindowsAndMessaging", "Win32_Security", "Win32_System_Registry", "Win32_System_Com", "Win32_System_Com_StructuredStorage", "Win32_System_Variant", "Win32_UI_Shell", "Win32_UI_Shell_PropertiesSystem", "Win32_UI_Accessibility"]`.
    - Não há nenhuma feature `Media_*` ou `Speech*` ativada.
  - **Regra do repositório:** Não adicionar nem atualizar dependências no `Cargo.toml`.
  - **SAPI clássica (Win32):**
    - A SAPI 5.3 (Speech API legado via COM) não oferece reconhecimento no dispositivo moderno em múltiplos idiomas sem pacotes legados instalados pelo usuário, tem alta taxa de falhas com microfones modernos e exigiria tabelas de despacho COM (`IDispatch`) manuais e inseguras não cobertas pelo CI.
  - **Conclusão:** Não há API de reconhecimento de voz moderna e usável no Windows sem dependência ou feature nova.

### 2. Linux

- **Ausência de API padrão:**
  - O ecossistema Linux desktop (Freedesktop, D-Bus, PulseAudio/PipeWire, WebKitGTK) não possui uma API padrão de reconhecimento de fala (STT).
  - O daemon padrão existente (`speech-dispatcher`) atende apenas à síntese de voz (Text-To-Speech / TTS), não ao reconhecimento de voz.
- **Alternativas avaliadas:**
  1. **Vosk / Kaldi:**
     - *Prós:* Processamento 100% offline e local.
     - *Contras:* Exige dependência de crate nativa C/Rust (`vosk`), binários compartilhados pesados e download compulsório de modelos de linguagem acústica (entre 50 MiB e 1.5 GiB por idioma).
     - *Consentimento:* Exigiria confirmação explícita do usuário para baixar dezenas ou centenas de megabytes de modelo.
  2. **Whisper.cpp / whisper-rs:**
     - *Prós:* Alta precisão e robustez acústica.
     - *Contras:* Requer toolchain C++ (CMake), compilação de código nativo, configuração de backend de aceleração (Vulkan/BLAS) e download de modelo ggml (~75 MiB para tiny até 500 MiB para medium).
     - *Consentimento:* Exigiria aceite do usuário para download de modelos de IA e alto consumo de memória/processamento.
  3. **Serviços de Nuvem (ex.: OpenAI Whisper API, Google Cloud Speech, Azure):**
     - *Prós:* Não exige modelos locais pesados.
     - *Contras:* **Violação direta da política de privacidade do ADE AGS** (o áudio do microfone do usuário seria transmitido pela internet), necessidade de credenciais externas, risco de latência e quebra do modo offline/local-first.
     - *Consentimento:* Exigiria aviso de privacidade, consentimento expresso e inserção de chave de API pelo usuário.
- **Conclusão:** Como qualquer solução no Linux exigiria dependência nova, download de modelos de IA ou serviço externo, ela **não foi implementada**, respeitando a diretriz do projeto.

### 3. Tratamento de paridade nas plataformas sem suporte

Em vez de esconder o botão ou falhar em silêncio:
- **Botão no Composer:** Renderizado com estilo desabilitado (`opacity-50`, `cursor-not-allowed`, `disabled`, `aria-disabled="true"`), com `title` e `aria-label` contendo a explicação da indisponibilidade em cada plataforma:
  - Windows: `"O ditado local ainda não está disponível no Windows (requer reconhecimento de voz sem dependências externas)."`
  - Linux: `"O ditado local não está disponível no Linux (não há API padrão do sistema sem dependências ou modelos externos)."`
- **Atalho e Paleta:** O atalho `composer.dictation` e a entrada na Paleta de Comandos estão disponíveis em todas as plataformas. Ao ser acionado em plataforma sem suporte, a interface emite um alerta informativo (`AlertaToast`) com a razão, garantindo feedback imediato à pessoa.

---

## Opções acessíveis

O botão e o fluxo de ditado atendem aos critérios de acessibilidade (WCAG 2.1 e ARIA):

1. **Rótulo descritivo (`aria-label`):**
   - Em repouso: informa a ação e o idioma (`"Iniciar ditado em pt-BR — áudio processado no dispositivo, sem gravação (máx. 50 s)"`).
   - Durante inicialização ou transcrição: informa o processamento (`"Transcrevendo no dispositivo…"`).
   - Durante gravação: informa a parada e destino da transcrição (`"Parar e inserir a transcrição no rascunho para revisão"`).
   - Quando indisponível: informa o recurso e a razão detalhada da indisponibilidade.
2. **Estado de alternância (`aria-pressed`):**
   - Reflete o estado ativo: `true` quando gravando, `false` quando ocioso ou indisponível.
3. **Anúncios de estado em tempo real (`role="status"`):**
   - Um elemento acessível com `role="status"` e `aria-live="polite"` anuncia audivelmente para tecnologias assistivas (leitores de tela) cada transição:
     - `"Ditado em gravação."` ao iniciar a captura.
     - `"Ditado finalizado. Transcrição inserida no rascunho para revisão."` ao concluir com êxito.
     - `"Ditado descartado."` ao cancelar com Escape ou botão X.
     - `"Erro no ditado: <motivo>"` em caso de falha de dispositivo ou permissão.
4. **Sem cores puras em hexadecimal:**
   - Estilização realizada estritamente com tokens e utilitários do Tailwind (`text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-500/10`), respeitando os modos Claro e Escuro.

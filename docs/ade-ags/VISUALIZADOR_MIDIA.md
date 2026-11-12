# Visualizador de mídia do chat

O chat abre anexos de imagem e arquivos de vídeo reconhecidos pela extensão (MP4, MOV, M4V, WebM, MKV e AVI) em um diálogo sobreposto. A galeria é compartilhada entre o composer e as faixas de anexos das mensagens montadas da conversa. Miniaturas e setas navegam pela galeria; Esc fecha o diálogo e devolve o foco a quem o abriu.

O visualizador oferece zoom por controles, teclado e roda com Ctrl/Cmd, ajuste à tela, arraste com zoom, download, controles nativos de vídeo e captura do quadro atual como imagem no próprio visualizador. A barra inferior permite desenhar, desfazer/refazer, limpar, registrar comentários numerados com coordenadas normalizadas e redimensionar mantendo proporção. Comentários feitos sobre um anexo do composer seguem no texto enviado junto ao caminho da imagem.

## Limites desta entrega

- A captura de vídeo vira uma imagem temporária dentro do visualizador; ainda não é anexada automaticamente ao composer.
- Marcas e comentários achatados podem ser baixados. O envio ao agente inclui o anexo original e as coordenadas dos comentários, mas não um PNG achatado.
- Remoção de fundo está desabilitada. Ainda não há helper macOS com Vision.
- “Apagar” seleciona a ferramenta de desenho, mas ainda não produz máscara nem envia instrução de inpainting.
- Redimensionamento cria uma prévia PNG no visualizador; ainda não grava um arquivo novo no carrossel de anexos.
- A galeria agrega anexos de mensagens que estão montadas na conversa. Imagens Markdown avulsas em resultados de ferramentas ainda não entram nela.
- O seletor mostra Imagem/Vídeo/Tudo; a lista é filtrada, mas o filtro não altera o envio dos anexos.

A referência visual foi a captura fornecida pelo usuário. A REA não foi usada: observar a janela do ChatGPT em execução poderia expor conversas reais, então não foi acessada.

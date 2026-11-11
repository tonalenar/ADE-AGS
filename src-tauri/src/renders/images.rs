//! Imagens locais das páginas HTML (o "embute na publicação" do T3 Code). O agente põe um caminho absoluto de imagem
//! num atributo ou num `url(...)` de CSS, e a publicação troca o caminho por `data:image/...;base64,...`. Assim a página
//! fica autocontida: não some quando o arquivo original muda ou é apagado, e o quadro isolado não precisa de rede, de
//! endpoint nem de protocolo novo.
//!
//! Só entra imagem que (1) está dentro da pasta do projeto da aba que publica, (2) é arquivo comum fora da pasta de
//! dados da ADE, (3) cabe no limite e (4) tem bytes de imagem: o nome não vale, para que um arquivo renomeado não
//! entre. Qualquer caminho que não passa faz a publicação falhar com a lista do que ficou de fora, em vez de sair uma
//! imagem quebrada ou de ler um arquivo de fora do projeto.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use base64::Engine as _;
use regex::Regex;

/// Limites de uma publicação: cada imagem local e a página depois de embutidas as imagens.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Bytes de cada imagem local.
    pub image: usize,
    /// Bytes da página já com as imagens dentro.
    pub page: usize,
}

impl Limits {
    pub const PADRAO: Limits = Limits { image: 4 * 1024 * 1024, page: 12 * 1024 * 1024 };
}

/// Extensões que deixam um caminho candidato. Quem decide de fato são os bytes.
const EXTENSOES: &str = "png|jpe?g|gif|webp|avif|svg|bmp|ico";
/// Começo de um caminho absoluto: `/` (sem ser `//`, que aponta para outro host) ou letra de unidade do Windows.
const ABSOLUTO: &str = r"(?:/[^/\r\n]|[A-Za-z]:[\\/])";

/// Os quatro lugares onde um caminho pode aparecer: aspas duplas, aspas simples, crase e `url(...)` de CSS.
static CAMINHO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i)"({ABSOLUTO}[^"\r\n]*?\.(?:{EXTENSOES}))"|'({ABSOLUTO}[^'\r\n]*?\.(?:{EXTENSOES}))'|`({ABSOLUTO}[^`\r\n]*?\.(?:{EXTENSOES}))`|url\(\s*({ABSOLUTO}[^\s"'`()]*?\.(?:{EXTENSOES}))\s*\)"#
    ))
    .expect("expressão fixa")
});

/// Um caminho local achado no HTML: onde ele está (sem aspas) e o texto como o agente escreveu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Achado {
    pub inicio: usize,
    pub fim: usize,
    pub caminho: String,
}

/// Teto de um caminho achado, em bytes. Um texto maior que isso não é caminho de imagem.
const MAX_CAMINHO: usize = 2048;

/// Os caminhos locais de imagem do HTML, na ordem em que aparecem. Pura.
pub fn find_local_images(html: &str) -> Vec<Achado> {
    CAMINHO
        .captures_iter(html)
        .filter_map(|caps| {
            let grupo = (1..=4).find_map(|i| caps.get(i))?;
            Some(Achado { inicio: grupo.start(), fim: grupo.end(), caminho: grupo.as_str().to_string() })
        })
        .filter(|achado| achado.caminho.len() <= MAX_CAMINHO)
        .collect()
}

/// O caminho como o sistema o lê. Dentro de um texto de JS, uma barra invertida dupla de unidade do Windows é escape.
pub fn caminho_de_arquivo(caminho: &str) -> PathBuf {
    let bytes = caminho.as_bytes();
    let unidade = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if unidade { PathBuf::from(caminho.replace(r"\\", r"\")) } else { PathBuf::from(caminho) }
}

/// Por que um caminho ficou de fora.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Recusa {
    SemProjeto,
    NaoLe,
    ForaDoProjeto,
    DadosDaAde,
    NaoEArquivo,
    Grande,
    NaoEImagem,
    Mudou,
}

impl Recusa {
    fn motivo(&self, limites: Limits) -> String {
        match self {
            Recusa::SemProjeto => "a aba não tem pasta do projeto".into(),
            Recusa::NaoLe => "não existe ou não pode ser lida".into(),
            Recusa::ForaDoProjeto => "fora da pasta do projeto".into(),
            Recusa::DadosDaAde => "dentro da pasta de dados da ADE".into(),
            Recusa::NaoEArquivo => "não é um arquivo comum".into(),
            Recusa::Grande => format!("maior que {}", tamanho(limites.image)),
            Recusa::NaoEImagem => "não é uma imagem pelos bytes".into(),
            Recusa::Mudou => "mudou durante a leitura".into(),
        }
    }
}

fn tamanho(bytes: usize) -> String {
    const MIB: usize = 1024 * 1024;
    if bytes >= MIB { format!("{} MiB", bytes / MIB) } else { format!("{} KiB", bytes / 1024) }
}

/// Lê até `limite` bytes. Um byte além disso significa que o arquivo cresceu depois do `metadata`: fica de fora.
fn ler_ate(caminho: &Path, limite: usize) -> Result<Vec<u8>, Recusa> {
    let arquivo = std::fs::File::open(caminho).map_err(|_| Recusa::NaoLe)?;
    let mut bytes = Vec::new();
    arquivo.take(limite as u64 + 1).read_to_end(&mut bytes).map_err(|_| Recusa::NaoLe)?;
    if bytes.len() > limite {
        return Err(Recusa::Grande);
    }
    Ok(bytes)
}

/// A data URL de um caminho local, se ele passa em todas as regras; senão, o motivo da recusa.
fn data_url(caminho: &str, raiz: Option<&Path>, protegidas: &[PathBuf], limites: Limits) -> Result<String, Recusa> {
    let raiz = raiz.ok_or(Recusa::SemProjeto)?;
    let alvo = caminho_de_arquivo(caminho);
    // `canonicalize` resolve `..` e links: um atalho que sai do projeto cai aqui, mesmo com caminho escrito dentro dele.
    let real = std::fs::canonicalize(&alvo).map_err(|_| Recusa::NaoLe)?;
    if !real.starts_with(raiz) {
        return Err(Recusa::ForaDoProjeto);
    }
    if protegidas.iter().any(|pasta| real.starts_with(pasta)) {
        return Err(Recusa::DadosDaAde);
    }
    let metadados = std::fs::metadata(&real).map_err(|_| Recusa::NaoLe)?;
    if !metadados.is_file() {
        return Err(Recusa::NaoEArquivo);
    }
    if metadados.len() > limites.image as u64 {
        return Err(Recusa::Grande);
    }
    let bytes = ler_ate(&real, limites.image)?;
    // Confere o caminho de novo depois da leitura: se um pedaço dele virou link no meio, a imagem não entra.
    if std::fs::canonicalize(&alvo).ok().as_deref() != Some(real.as_path()) {
        return Err(Recusa::Mudou);
    }
    let tipo = tipo_de_imagem(&bytes).ok_or(Recusa::NaoEImagem)?;
    Ok(format!("data:{tipo};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// O tipo MIME pelos bytes (o nome não vale). `None` quando não é imagem de um formato conhecido. Pura.
pub fn tipo_de_imagem(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(&[0, 0, 1, 0]) {
        return Some("image/x-icon");
    }
    if bytes.len() >= 10 && bytes.starts_with(b"BM") && bytes[6..10] == [0, 0, 0, 0] {
        return Some("image/bmp");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && matches!(&bytes[8..12], b"avif" | b"avis" | b"mif1") {
        return Some("image/avif");
    }
    if e_svg(bytes) {
        return Some("image/svg+xml");
    }
    None
}

/// SVG: a raiz, depois de prólogo, comentários e DOCTYPE, é `<svg`. Lê só o começo do arquivo. Pura.
fn e_svg(bytes: &[u8]) -> bool {
    let texto = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
    let mut resto: &str = texto.trim_start_matches('\u{feff}');
    loop {
        resto = resto.trim_start();
        let pulo = [("<?", "?>"), ("<!--", "-->"), ("<!DOCTYPE", ">")]
            .into_iter()
            .find(|(abre, _)| resto.get(..abre.len()).is_some_and(|inicio| inicio.eq_ignore_ascii_case(abre)));
        match pulo {
            Some((abre, fecha)) => match resto[abre.len()..].find(fecha) {
                Some(at) => resto = &resto[abre.len() + at + fecha.len()..],
                None => return false,
            },
            None => {
                return resto.starts_with("<svg")
                    && resto[4..].starts_with(|c: char| c.is_whitespace() || c == '>' || c == '/');
            }
        }
    }
}

/// Troca os caminhos locais de imagem do HTML pelas data URLs. Sem caminho local, devolve o HTML igual e não toca no
/// disco. Se algum caminho é recusado, falha com a lista do que ficou de fora: nada sai embutido pela metade. `projeto`
/// é a pasta da aba (`None` quando a aba não tem uma); `protegidas` são as pastas que nunca são lidas.
pub fn embed(html: &str, projeto: Option<&Path>, protegidas: &[PathBuf], limites: Limits) -> Result<String, String> {
    let achados = find_local_images(html);
    if achados.is_empty() {
        return Ok(html.to_string());
    }
    let raiz = projeto.and_then(|pasta| std::fs::canonicalize(pasta).ok());
    let protegidas: Vec<PathBuf> =
        protegidas.iter().map(|pasta| std::fs::canonicalize(pasta).unwrap_or_else(|_| pasta.clone())).collect();
    // Um caminho repetido é lido uma vez só.
    let mut lidos: HashMap<&str, Result<String, Recusa>> = HashMap::new();
    let mut recusadas: Vec<String> = Vec::new();
    let mut saida = String::with_capacity(html.len());
    let mut cursor = 0;
    for achado in &achados {
        let resultado = lidos
            .entry(achado.caminho.as_str())
            .or_insert_with(|| data_url(&achado.caminho, raiz.as_deref(), &protegidas, limites));
        match resultado {
            Ok(uri) => {
                saida.push_str(&html[cursor..achado.inicio]);
                saida.push_str(uri.as_str());
                cursor = achado.fim;
            }
            Err(motivo) => recusadas.push(format!("{} ({})", achado.caminho, motivo.motivo(limites))),
        }
    }
    if !recusadas.is_empty() {
        let onde = raiz.map(|pasta| format!(" ({})", pasta.display())).unwrap_or_default();
        return Err(format!(
            "Não consegui embutir estas imagens locais na página: {}. Use caminhos absolutos de imagens dentro da pasta do projeto{onde}, com até {} cada, ou mande data: URLs.",
            recusadas.join("; "),
            tamanho(limites.image),
        ));
    }
    saida.push_str(&html[cursor..]);
    if saida.len() > limites.page {
        return Err(format!(
            "Com as imagens embutidas a página passa de {}; use imagens menores ou menos imagens.",
            tamanho(limites.page),
        ));
    }
    Ok(saida)
}

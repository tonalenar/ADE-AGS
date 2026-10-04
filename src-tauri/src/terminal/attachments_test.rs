use std::{
    fs,
    path::{Path, PathBuf},
    thread::sleep,
    time::Duration,
};
use super::attachments::{cleanup_dir, save_pasted_image_in, MAX_IMAGE_BYTES};

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("ade-attach-test-{label}-{}", uuid::Uuid::new_v4()));
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn extensao_pelo_tipo() {
    let temp = TempDir::new("ext");
    let bytes = b"fake-image-data";

    let png_path = save_pasted_image_in(temp.path(), bytes, "image/png").expect("png deve salvar");
    assert!(png_path.ends_with(".png"), "png deve ter extensao .png: {png_path}");

    let jpg_path = save_pasted_image_in(temp.path(), bytes, "image/jpeg").expect("jpeg deve salvar");
    assert!(jpg_path.ends_with(".jpg"), "jpeg deve ter extensao .jpg: {jpg_path}");

    let webp_path = save_pasted_image_in(temp.path(), bytes, "image/webp").expect("webp deve salvar");
    assert!(webp_path.ends_with(".webp"), "webp deve ter extensao .webp: {webp_path}");

    let gif_path = save_pasted_image_in(temp.path(), bytes, "image/gif").expect("gif deve salvar");
    assert!(gif_path.ends_with(".gif"), "gif deve ter extensao .gif: {gif_path}");

    // Tipos nao suportados devem retornar erro
    let err_bmp = save_pasted_image_in(temp.path(), bytes, "image/bmp");
    assert!(err_bmp.is_err(), "bmp deve ser rejeitado");
    assert_eq!(err_bmp.unwrap_err(), "Tipo de imagem nao suportado");

    let err_txt = save_pasted_image_in(temp.path(), bytes, "text/plain");
    assert!(err_txt.is_err(), "text/plain deve ser rejeitado");

    let err_svg = save_pasted_image_in(temp.path(), bytes, "image/svg+xml");
    assert!(err_svg.is_err(), "svg deve ser rejeitado");
}

#[test]
fn limite_de_tamanho() {
    let temp = TempDir::new("size");

    // Vazio (0 bytes) deve ser rejeitado
    let err_empty = save_pasted_image_in(temp.path(), &[], "image/png");
    assert!(err_empty.is_err(), "0 bytes deve ser rejeitado");
    assert_eq!(err_empty.unwrap_err(), "Imagem vazia ou maior que 20 MB");

    // Dentro do limite: 1 KB deve ser aceito
    let small_data = vec![0x42u8; 1024];
    let ok_path = save_pasted_image_in(temp.path(), &small_data, "image/png");
    assert!(ok_path.is_ok(), "1 KB deve salvar com sucesso");

    // Excedendo 20 MB (20 * 1024 * 1024 + 1 bytes) deve ser rejeitado sem salvar nada
    let oversized = vec![0u8; MAX_IMAGE_BYTES + 1];
    let err_large = save_pasted_image_in(temp.path(), &oversized, "image/png");
    assert!(err_large.is_err(), "> 20 MB deve ser rejeitado");
    assert_eq!(err_large.unwrap_err(), "Imagem vazia ou maior que 20 MB");
}

#[test]
fn nome_gerado_so_com_uuid() {
    let temp = TempDir::new("uuid");
    let content = b"unique-image-payload-12345";

    let saved_path_str = save_pasted_image_in(temp.path(), content, "image/png")
        .expect("deve salvar com sucesso");
    let saved_path = PathBuf::from(&saved_path_str);

    assert!(saved_path.exists(), "arquivo salvo deve existir no disco");

    // Conteudo gravado deve ser identico ao original
    let read_back = fs::read(&saved_path).expect("deve ler arquivo salvo");
    assert_eq!(read_back, content, "bytes lidos devem ser exatamente os enviados");

    // O nome base sem extensao deve ser um UUID v4 valido
    let file_stem = saved_path.file_stem().and_then(|s| s.to_str()).expect("stem valido");
    let parsed_uuid = uuid::Uuid::parse_str(file_stem);
    assert!(parsed_uuid.is_ok(), "nome do arquivo deve ser um uuid valido: {file_stem}");
    assert_eq!(parsed_uuid.unwrap().get_version_num(), 4, "deve ser uuid v4");

    // Salvar outro arquivo deve gerar um UUID diferente
    let second_path_str = save_pasted_image_in(temp.path(), content, "image/png")
        .expect("segundo arquivo deve salvar");
    let second_path = PathBuf::from(&second_path_str);
    assert_ne!(saved_path, second_path, "cada anexo colado deve receber um uuid exclusivo");
}

#[test]
fn nunca_fora_da_pasta() {
    let temp = TempDir::new("containment");

    // O arquivo salvo esta estritamente contido dentro da pasta informada
    let bytes = b"contained-bytes";
    let saved = save_pasted_image_in(temp.path(), bytes, "image/png").expect("deve salvar");
    let saved_path = PathBuf::from(saved);
    assert!(
        saved_path.starts_with(temp.path()),
        "arquivo salvo ({:?}) deve estar dentro de {:?}",
        saved_path,
        temp.path()
    );

    // Caminho relativo como destino eh rejeitado
    let relative_path = Path::new("relative/pasted/dir");
    let rel_err = save_pasted_image_in(relative_path, bytes, "image/png");
    assert!(rel_err.is_err(), "caminho relativo deve ser rejeitado");
    assert_eq!(rel_err.unwrap_err(), "Pasta de anexos deve ser absoluta");

    // Caminho contendo '..' para escapar eh rejeitado
    let escape_path = temp.path().join("sub").join("..").join("..");
    let escape_err = save_pasted_image_in(&escape_path, bytes, "image/png");
    assert!(escape_err.is_err(), "caminho com .. deve ser rejeitado");
    assert_eq!(escape_err.unwrap_err(), "Pasta de anexos deve ser absoluta");
}

#[test]
fn limpeza_das_antigas() {
    let temp = TempDir::new("cleanup");

    // Cria dois arquivos simulando anexos
    let file1 = save_pasted_image_in(temp.path(), b"img1", "image/png").expect("file1");
    let file2 = save_pasted_image_in(temp.path(), b"img2", "image/png").expect("file2");

    assert!(Path::new(&file1).exists());
    assert!(Path::new(&file2).exists());

    // Se a idade maxima for de 1 hora (ou 24 horas), nenhum dos arquivos recem-criados deve ser removido
    let cleaned_none = cleanup_dir(temp.path(), Duration::from_secs(3600));
    assert_eq!(cleaned_none, 0, "arquivos recentes nao devem ser apagados");
    assert!(Path::new(&file1).exists());
    assert!(Path::new(&file2).exists());

    // Aguarda um instante para garantir que a diferenca de tempo seja positiva
    sleep(Duration::from_millis(50));

    // Com max_age de 10ms, arquivos criados a 50ms atras devem ser considerados expirados e apagados
    let cleaned_all = cleanup_dir(temp.path(), Duration::from_millis(10));
    assert_eq!(cleaned_all, 2, "ambos os arquivos expirados devem ser apagados");
    assert!(!Path::new(&file1).exists(), "file1 deve ter sido apagado");
    assert!(!Path::new(&file2).exists(), "file2 deve ter sido apagado");

    // Subdiretorios dentro da pasta de anexos nao devem ser apagados
    let sub_dir = temp.path().join("sub_pasta");
    fs::create_dir_all(&sub_dir).expect("cria subpasta");
    sleep(Duration::from_millis(20));
    let cleaned_dirs = cleanup_dir(temp.path(), Duration::from_millis(10));
    assert_eq!(cleaned_dirs, 0, "diretorios nao devem ser apagados na limpeza");
    assert!(sub_dir.exists(), "subpasta deve ser preservada");

    // Pasta inexistente deve retornar 0 sem panico
    let nonexistent = temp.path().join("nao_existe");
    let cleaned_missing = cleanup_dir(&nonexistent, Duration::from_secs(1));
    assert_eq!(cleaned_missing, 0, "pasta inexistente deve retornar 0");
}

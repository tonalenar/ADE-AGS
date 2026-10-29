//! O modo leve de verdade: desligar os serviços do iOS que pesam e que quem testa app ou site não usa.
//!
//! O `launchd_sim` de cada aparelho lê, quando sobe, a lista de serviços desligados de um arquivo no Mac
//! (`/private/var/tmp/com.apple.CoreSimulator.SimDevice.<UDID>/disabled.plist`: rótulo → `true`). É o
//! que a ferramenta simslim descobriu; a opção de boot `disabled_jobs` não faz isso. A ADE põe os rótulos
//! abaixo no arquivo com o aparelho desligado, liga, e logo que a tela existe devolve o arquivo original: o
//! `launchd_sim` já leu e não lê de novo, então o aparelho fica leve na ADE e normal fora dela.
//!
//! Medido no iPhone 17 (iOS 27.0), 120 s depois do boot: 288 → 106 processos, 495% → 1% de CPU, 7 GB →
//! 0,5 GB de memória comprimida no Mac. A tela inicial, o Safari (localhost) e os Ajustes funcionam.
//!
//! Ficam ligados de propósito: push, compras e App Store, Safari e universal links, `assistantd`, `gamed`
//! e `sharingd` (sem eles o iOS fica tentando subir de novo). Ficam de fora: widgets e papel de parede
//! animado, Siri e Intelligence, Spotlight, iCloud, Mail/Agenda/Contatos, família e Tempo de Uso, Saúde e
//! Fitness, análise de Fotos, Mapas/News/Tempo, iMessage e FaceTime, aparelhos por perto e telemetria.

use std::path::PathBuf;

/// Os serviços que o modo leve desliga, por grupo (as categorias do simslim).
pub const LABELS: &[&str] = &[
    // Widgets e papel de parede animado.
    "com.apple.PosterBoard", "com.apple.chronod", "com.apple.liveactivitiesd", "com.apple.navd",
    // Siri, Intelligence e aprendizado no aparelho.
    "com.apple.assistant_cdmd", "com.apple.assistant_service", "com.apple.siriactionsd", "com.apple.siriinferenced",
    "com.apple.siriknowledged", "com.apple.sirittsd", "com.apple.siri.context.service", "com.apple.siri.acousticsignature",
    "com.apple.corespeechd", "com.apple.voiced", "com.apple.voicebankingd", "com.apple.speechmodeltrainingd",
    "com.apple.intelligenceplatformd", "com.apple.intelligencecontextd", "com.apple.intelligenceflowd", "com.apple.intelligencetasksd",
    "com.apple.generativeexperiencesd", "com.apple.knowledgeconstructiond", "com.apple.naturallanguaged", "com.apple.textunderstandingd",
    "com.apple.modelcatalogd", "com.apple.modelmanagerd", "com.apple.mlhostd", "com.apple.mlruntimed", "com.apple.suggestd",
    "com.apple.parsecd", "com.apple.parsec-fbf", "com.apple.proactiveeventtrackerd",
    // Spotlight.
    "com.apple.searchd", "com.apple.searchtoold", "com.apple.spotlightknowledged", "com.apple.spotlightknowledged.updater",
    "com.apple.corespotlightservice",
    // iCloud e conta Apple.
    "com.apple.appleaccountd", "com.apple.appleaccounttransparencyd", "com.apple.appleidsetupd", "com.apple.akd", "com.apple.cloudd",
    "com.apple.cloudphotod", "com.apple.ckdiscretionaryd", "com.apple.cloudsettingssyncagent", "com.apple.bird", "com.apple.syncdefaultsd",
    "com.apple.cdpd", "com.apple.sosd", "com.apple.SecureBackupDaemon", "com.apple.TrustedPeersHelper",
    "com.apple.protectedcloudstorage.protectedcloudkeysyncing", "com.apple.icloudmailagent", "com.apple.icloudsubscriptionoptimizerd",
    "com.apple.communicationtrustd",
    // Mail, Agenda, Lembretes e Contatos.
    "com.apple.email.maild", "com.apple.exchangesyncd", "com.apple.dataaccess.dataaccessd", "com.apple.calaccessd", "com.apple.remindd",
    "com.apple.contactsd", "com.apple.contacts.postersyncd", "com.apple.peopled",
    // Família e Tempo de Uso.
    "com.apple.familycircled", "com.apple.FamilyControlsAgent", "com.apple.familynotification", "com.apple.askpermissiond",
    "com.apple.asktod", "com.apple.ScreenTimeAgent", "com.apple.ScreenTimeSettingsAgent", "com.apple.UsageTrackingAgent",
    // Saúde, Casa e Fitness.
    "com.apple.healthd", "com.apple.healthappd", "com.apple.healthcontentd", "com.apple.healtheventsd", "com.apple.healthrecordsd",
    "com.apple.finhealthd", "com.apple.homed", "com.apple.homeeventsd", "com.apple.fitcore", "com.apple.fitcore.session",
    "com.apple.fitnesscoachingd", "com.apple.fitnessintelligenced", "com.apple.activityawardsd", "com.apple.activitysharingd",
    // Fotos e mídia.
    "com.apple.photoanalysisd", "com.apple.photosface", "com.apple.mediaanalysisd", "com.apple.mediaanalysisd.service",
    "com.apple.mediastream.mstreamd", "com.apple.medialibraryd", "com.apple.assetsd", "com.apple.assetsd.nebulad",
    // Apps da Apple que sincronizam sozinhos.
    "com.apple.newsd", "com.apple.weatherd", "com.apple.Maps.mapssyncd", "com.apple.Maps.mapspushd", "com.apple.Maps.geocorrectiond",
    "com.apple.maps.destinationd", "com.apple.MapKit.SnapshotService", "com.apple.jetpackassetd", "com.apple.tipsd", "com.apple.gamesaved",
    "com.apple.GameController.gamecontrollerd",
    // iMessage e FaceTime.
    "com.apple.identityservicesd", "com.apple.ids_simd", "com.apple.imautomatichistorydeletionagent", "com.apple.imcore.imtransferagent",
    "com.apple.imdpersistence.IMDPersistenceAgent", "com.apple.facetimemessagestored", "com.apple.telephonyutilities.callservicesd",
    // Aparelhos por perto.
    "com.apple.rapportd", "com.apple.companiond", "com.apple.carkitd", "com.apple.wcd", "com.apple.tvremoted", "com.apple.avatarsd",
    "com.apple.stickersd", "com.apple.sociallayerd", "com.apple.announced", "com.apple.findmy.findmylocated",
    // Telemetria, anúncios e experimentos.
    "com.apple.ap.adprivacyd", "com.apple.ap.promotedcontentd", "com.apple.diagnosticextensionsd", "com.apple.feedbackd",
    "com.apple.rtcreportingd", "com.apple.securityuploadd", "com.apple.geoanalyticsd", "com.apple.triald", "com.apple.followupd",
    "com.apple.purplebuddy.budd", "com.apple.devicecheckd",
    // O resto.
    "com.apple.coreidvd", "com.apple.businessservicesd", "com.apple.deviceaccessd", "com.apple.replicatord", "com.apple.linkd",
    "com.apple.ind", "com.apple.storagedatad", "com.apple.StatusKitAgent", "com.apple.countryd", "com.apple.mobileassetd",
    "com.apple.managedconfiguration.passcodenagd",
];

/// Um UDID de verdade (hex e hífens): ele vira parte de um caminho, então nada de `/` ou `..`.
pub fn valid_udid(udid: &str) -> bool {
    udid.len() == 36 && udid.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// A pasta dos dados de launchd do aparelho no Mac.
pub fn dir(udid: &str) -> Option<PathBuf> {
    valid_udid(udid).then(|| PathBuf::from(format!("/private/var/tmp/com.apple.CoreSimulator.SimDevice.{udid}")))
}

/// O arquivo que o `launchd_sim` lê e a cópia do original que a ADE guarda enquanto o troca. Uma cópia vazia
/// quer dizer "não havia arquivo".
pub fn paths(udid: &str) -> Option<(PathBuf, PathBuf)> {
    let dir = dir(udid)?;
    Some((dir.join("disabled.plist"), dir.join("disabled.ade-original.plist")))
}

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
//! e `sharingd` (sem eles o iOS fica tentando subir de novo). Ficam de fora: widgets (menos o `chronod`,
//! que o `WidgetRenderer` espera) e papel de parede animado, Siri e Intelligence, Spotlight, iCloud, Mail/Agenda/Contatos, família e Tempo de Uso, Saúde e
//! Fitness, análise de Fotos, Mapas/News/Tempo, iMessage e FaceTime, aparelhos por perto e telemetria.

use std::path::PathBuf;

/// Uma categoria do simslim e os serviços que ela desliga no modo leve.
pub struct Category {
    pub id: &'static str,
    pub labels: &'static [&'static str],
}

/// Serviços agrupados pelos mesmos IDs usados pelo `simslim --except`.
pub const LABELS: &[Category] = &[
    // O `chronod` fica ligado: sem ele o `WidgetRenderer_Default` que a tela inicial abre espera até o
    // watchdog do iOS matá-lo (10 s) e o macOS mostra um relatório de problema a cada boot leve.
    Category { id: "widgets", labels: &["com.apple.PosterBoard", "com.apple.liveactivitiesd", "com.apple.navd"] },
    Category { id: "siri", labels: &[
        "com.apple.assistant_cdmd", "com.apple.assistant_service", "com.apple.siriactionsd", "com.apple.siriinferenced",
        "com.apple.siriknowledged", "com.apple.sirittsd", "com.apple.siri.context.service", "com.apple.siri.acousticsignature",
        "com.apple.corespeechd", "com.apple.voiced", "com.apple.voicebankingd", "com.apple.speechmodeltrainingd",
        "com.apple.intelligenceplatformd", "com.apple.intelligencecontextd", "com.apple.intelligenceflowd", "com.apple.intelligencetasksd",
        "com.apple.generativeexperiencesd", "com.apple.knowledgeconstructiond", "com.apple.naturallanguaged", "com.apple.textunderstandingd",
        "com.apple.modelcatalogd", "com.apple.modelmanagerd", "com.apple.mlhostd", "com.apple.mlruntimed", "com.apple.suggestd",
        "com.apple.parsecd", "com.apple.parsec-fbf", "com.apple.proactiveeventtrackerd",
    ] },
    Category { id: "search", labels: &[
        "com.apple.searchd", "com.apple.searchtoold", "com.apple.spotlightknowledged", "com.apple.spotlightknowledged.updater",
        "com.apple.corespotlightservice",
    ] },
    Category { id: "icloud", labels: &[
        "com.apple.appleaccountd", "com.apple.appleaccounttransparencyd", "com.apple.appleidsetupd", "com.apple.akd", "com.apple.cloudd",
        "com.apple.cloudphotod", "com.apple.ckdiscretionaryd", "com.apple.cloudsettingssyncagent", "com.apple.bird", "com.apple.syncdefaultsd",
        "com.apple.cdpd", "com.apple.sosd", "com.apple.SecureBackupDaemon", "com.apple.TrustedPeersHelper",
        "com.apple.protectedcloudstorage.protectedcloudkeysyncing", "com.apple.icloudmailagent", "com.apple.icloudsubscriptionoptimizerd",
        "com.apple.communicationtrustd",
    ] },
    Category { id: "store", labels: &[
        "com.apple.passd", "com.apple.financed", "com.apple.merchantd", "com.apple.musicd", "com.apple.videosubscriptionsd",
        "com.apple.assetsubscriptiond", "com.apple.itunescloudd",
    ] },
    Category { id: "pim", labels: &[
        "com.apple.email.maild", "com.apple.exchangesyncd", "com.apple.dataaccess.dataaccessd", "com.apple.calaccessd", "com.apple.remindd",
        "com.apple.contactsd", "com.apple.contacts.postersyncd", "com.apple.peopled",
    ] },
    Category { id: "web", labels: &[
        "com.apple.SafariBookmarksSyncAgent", "com.apple.Safari.passwordbreachd", "com.apple.Safari.SafeBrowsing.Service",
        "com.apple.safarifetcherd", "com.apple.WebBookmarks.webbookmarksd", "com.apple.webkit.adattributiond", "com.apple.webprivacyd",
    ] },
    Category { id: "family", labels: &[
        "com.apple.familycircled", "com.apple.FamilyControlsAgent", "com.apple.familynotification", "com.apple.askpermissiond",
        "com.apple.asktod", "com.apple.ScreenTimeAgent", "com.apple.ScreenTimeSettingsAgent", "com.apple.UsageTrackingAgent",
    ] },
    Category { id: "health", labels: &[
        "com.apple.healthd", "com.apple.healthappd", "com.apple.healthcontentd", "com.apple.healtheventsd", "com.apple.healthrecordsd",
        "com.apple.finhealthd", "com.apple.homed", "com.apple.homeeventsd", "com.apple.fitcore", "com.apple.fitcore.session",
        "com.apple.fitnesscoachingd", "com.apple.fitnessintelligenced", "com.apple.activityawardsd", "com.apple.activitysharingd",
    ] },
    Category { id: "photos", labels: &[
        "com.apple.photoanalysisd", "com.apple.photosface", "com.apple.mediaanalysisd", "com.apple.mediaanalysisd.service",
        "com.apple.mediastream.mstreamd", "com.apple.medialibraryd", "com.apple.assetsd", "com.apple.assetsd.nebulad",
    ] },
    Category { id: "apps", labels: &[
        "com.apple.newsd", "com.apple.weatherd", "com.apple.Maps.mapssyncd", "com.apple.Maps.mapspushd", "com.apple.Maps.geocorrectiond",
        "com.apple.maps.destinationd", "com.apple.MapKit.SnapshotService", "com.apple.jetpackassetd", "com.apple.tipsd", "com.apple.gamesaved",
        "com.apple.GameController.gamecontrollerd", "com.apple.coreidvd", "com.apple.businessservicesd", "com.apple.deviceaccessd",
        "com.apple.replicatord", "com.apple.linkd", "com.apple.ind", "com.apple.storagedatad", "com.apple.StatusKitAgent",
        "com.apple.countryd", "com.apple.mobileassetd",
    ] },
    Category { id: "messaging", labels: &[
        "com.apple.identityservicesd", "com.apple.ids_simd", "com.apple.imautomatichistorydeletionagent", "com.apple.imcore.imtransferagent",
        "com.apple.imdpersistence.IMDPersistenceAgent", "com.apple.facetimemessagestored", "com.apple.telephonyutilities.callservicesd",
    ] },
    Category { id: "connectivity", labels: &[
        "com.apple.rapportd", "com.apple.companiond", "com.apple.carkitd", "com.apple.wcd", "com.apple.tvremoted", "com.apple.avatarsd",
        "com.apple.stickersd", "com.apple.sociallayerd", "com.apple.announced", "com.apple.findmy.findmylocated",
    ] },
    Category { id: "telemetry", labels: &[
        "com.apple.ap.adprivacyd", "com.apple.ap.promotedcontentd", "com.apple.diagnosticextensionsd", "com.apple.feedbackd",
        "com.apple.rtcreportingd", "com.apple.securityuploadd", "com.apple.geoanalyticsd", "com.apple.triald", "com.apple.followupd",
        "com.apple.purplebuddy.budd", "com.apple.devicecheckd",
    ] },
    Category { id: "mdm", labels: &["com.apple.managedconfiguration.passcodenagd"] },
];

/// Todos os serviços desligados por padrão, sem alocar nem mudar a ordem original.
pub fn all_labels() -> impl Iterator<Item = &'static str> {
    LABELS.iter().flat_map(|category| category.labels.iter().copied())
}

/// Serviços a desligar depois de manter as categorias pedidas ligadas.
pub fn labels_except(exceptions: &[String]) -> Vec<&'static str> {
    LABELS.iter()
        .filter(|category| !exceptions.iter().any(|id| id == category.id))
        .flat_map(|category| category.labels.iter().copied())
        .collect()
}

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

/// Os 16 serviços extras desligados apenas no modo máximo (além de [`LABELS`]): push, compras/StoreKit,
/// App Store, universal links, histórico do Safari, web push, App Clips e gerenciamento remoto.
pub const MAX_EXTRA_LABELS: &[&str] = &[
    "com.apple.ClipServices.clipserviced",
    "com.apple.RemoteManagementAgent",
    "com.apple.Safari.History",
    "com.apple.accessibility.axassetsd",
    "com.apple.amsaccountsd",
    "com.apple.amsengagementd",
    "com.apple.amsondevicestoraged",
    "com.apple.appstorecomponentsd",
    "com.apple.appstored",
    "com.apple.apsd",
    "com.apple.itunesstored",
    "com.apple.managedassetsd",
    "com.apple.remotemanagementd",
    "com.apple.storekitd",
    "com.apple.swcd",
    "com.apple.webkit.webpushd",
];

/// Nível do modo leve aplicado no `disabled.plist` antes do boot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// Desliga os serviços de [`LABELS`], mantendo push, compras/StoreKit e universal links.
    Light,
    /// Além de [`LABELS`], desliga também [`MAX_EXTRA_LABELS`].
    Max,
}

impl Level {
    /// Rótulos desligados neste nível, depois de manter ligadas as categorias de `exceptions`. No modo máximo,
    /// cada extra de [`MAX_EXTRA_LABELS`] segue a categoria de [`max_extra_category`]: manter "store" ligada
    /// mantém também StoreKit e App Store.
    pub fn labels(self, exceptions: &[String]) -> Vec<&'static str> {
        let mut out = labels_except(exceptions);
        if self == Self::Max {
            out.extend(MAX_EXTRA_LABELS.iter().copied().filter(|label| {
                let category = max_extra_category(label);
                !exceptions.iter().any(|id| id == category)
            }));
        }
        out
    }

    /// Converte as preferências (`light`, `max`) no nível de boot. O modo máximo só vale com o modo leve ligado.
    pub fn from_flags(light: bool, max: bool) -> Option<Self> {
        if !light {
            None
        } else if max {
            Some(Self::Max)
        } else {
            Some(Self::Light)
        }
    }
}

/// A categoria (id de [`LABELS`]) a que cada serviço extra do modo máximo pertence.
pub fn max_extra_category(label: &str) -> &'static str {
    match label {
        "com.apple.apsd" => "connectivity",
        "com.apple.Safari.History" | "com.apple.swcd" | "com.apple.webkit.webpushd" => "web",
        "com.apple.RemoteManagementAgent" | "com.apple.remotemanagementd" | "com.apple.managedassetsd" => "mdm",
        "com.apple.ClipServices.clipserviced" | "com.apple.accessibility.axassetsd" => "apps",
        _ => "store",
    }
}

//! Abrir o Minecraft direto pelo app (aba "Jogar") — sem launcher externo.
//!
//! O alvo é a instalação do **CurseForge** que o usuário já usa
//! (`~/Documents/curseforge/minecraft`, com override em `settings.curseforge_root`):
//! lê `Instances/*/minecraftinstance.json` (nome, versão, modloader), lista os
//! mundos em `Instances/<id>/saves/` e monta a linha de comando do jogo a
//! partir dos JSONs de versão **já instalados** (`Install/versions/<id>/<id>.json`
//! + `inheritsFrom`). Nada é baixado da Mojang — regra 10 do AGENTS: o app usa
//! só o que já está no disco.
//!
//! Limite honesto desta versão: **offline**. O jogo abre com `--accessToken 0`
//! e um UUID fixo, então singleplayer funciona por completo (incluindo abrir
//! direto num mundo com `--quickPlaySingleplayer`), mas servidor com
//! `online-mode=true` recusa a sessão — login Microsoft fica pra uma etapa
//! seguinte. O app **não** lê os tokens do CurseForge: credencial de terceiros
//! não é copiada daqui.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const INSTALL_DIR: &str = "Install";
const INSTANCES_DIR: &str = "Instances";
const LAUNCHER_NAME: &str = "baritone-orchestrator";
/// Sessão offline: singleplayer não valida o UUID nem o token. Não é a conta
/// do usuário — é um valor fixo e vazio de propósito.
const OFFLINE_UUID: &str = "00000000-0000-3000-8000-000000000000";
const GAME_WIDTH: u32 = 1024;
const GAME_HEIGHT: u32 = 768;
pub const MIN_MEMORY_MB: u32 = 1024;
pub const MAX_MEMORY_MB: u32 = 32768;

/// Ordem de preferência dos runtimes que o CurseForge instala quando o JSON
/// da versão não diz qual usar (o campo `javaVersion.component` manda).
const JAVA_RUNTIME_PREFERENCE: &[&str] = &[
    "java-runtime-epsilon",
    "java-runtime-delta",
    "java-runtime-gamma",
    "java-runtime-beta",
    "java-runtime-alpha",
    "Jre_21",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MinecraftSetup {
    pub root: Option<String>,
    pub install_dir: Option<String>,
    pub assets_dir: Option<String>,
    pub java: Option<String>,
    pub java_version: Option<String>,
    /// Por que não dá pra jogar ainda (primeiro problema encontrado) — a UI
    /// mostra isso em vez de um estado vazio sem explicação.
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceInfo {
    pub id: String,
    pub name: String,
    pub game_version: String,
    pub modloader: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldInfo {
    pub id: String,
    pub name: String,
    /// `mtime` do `level.dat`, em ms desde a epoch — "última vez jogado" de
    /// forma honesta (o nome de exibição do mundo mora no NBT e não é lido).
    pub last_modified_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GameStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchOutcome {
    pub pid: u32,
    pub java: String,
    pub java_version: Option<String>,
    pub version: String,
    pub world: Option<String>,
}

/// Linha de comando resolvida, sem abrir o jogo — o comando
/// `minecraft_launch_preview` devolve isso pra inspeção/cópia.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchPreview {
    pub command: String,
    pub java: String,
    pub java_version: Option<String>,
    pub log_path: String,
    pub version: String,
    pub world: Option<String>,
}

/// Tudo que o comando de spawn precisa, já resolvido — separado da leitura do
/// disco pra poder ser montado (e testado) sem abrir o jogo.
#[derive(Debug, Clone)]
pub struct LaunchPlan {
    pub java: PathBuf,
    pub java_version: Option<String>,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub log_path: PathBuf,
    pub version: String,
    pub world: Option<String>,
}

/// Onde está a instalação do CurseForge: caminho configurado (aba Config) se
/// válido, senão os locais padrão do CurseForge no Linux.
pub fn detect_root(configured: &str) -> Option<PathBuf> {
    let configured = configured.trim();
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        return path.join(INSTALL_DIR).is_dir().then_some(path);
    }
    let home = std::env::var("HOME").ok()?;
    for candidate in [
        PathBuf::from(&home).join("Documents/curseforge/minecraft"),
        PathBuf::from(&home).join("curseforge/minecraft"),
    ] {
        if candidate.join(INSTALL_DIR).is_dir() {
            return Some(candidate);
        }
    }
    None
}

/// Estado da aba "Jogar": onde está a instalação, qual Java seria usado e o
/// primeiro problema (se houver). Nunca inventa caminho: sem CurseForge
/// encontrado, `root` fica `None` e `problem` explica o que fazer.
pub fn setup(settings: &crate::settings::Settings) -> MinecraftSetup {
    let Some(root) = detect_root(&settings.curseforge_root) else {
        let hint = if settings.curseforge_root.trim().is_empty() {
            "não encontrei o CurseForge (esperava ~/Documents/curseforge/minecraft); aponte a pasta na aba Config".to_string()
        } else {
            format!(
                "caminho configurado não tem uma pasta {INSTALL_DIR}: {}",
                settings.curseforge_root.trim()
            )
        };
        return MinecraftSetup {
            root: None,
            install_dir: None,
            assets_dir: None,
            java: None,
            java_version: None,
            problem: Some(hint),
        };
    };

    let install = root.join(INSTALL_DIR);
    let assets = install.join("assets");
    let (java, java_version, java_problem) = match pick_java(&install, None, None) {
        Ok((path, version)) => (Some(path.to_string_lossy().to_string()), version, None),
        Err(err) => (None, None, Some(err)),
    };
    let problem = java_problem.or_else(|| {
        (!assets.is_dir()).then(|| format!("sem pasta de assets em {}", assets.display()))
    });

    MinecraftSetup {
        root: Some(root.to_string_lossy().to_string()),
        install_dir: Some(install.to_string_lossy().to_string()),
        assets_dir: Some(assets.to_string_lossy().to_string()),
        java,
        java_version,
        problem,
    }
}

pub fn list_instances(root: &Path) -> Result<Vec<InstanceInfo>, String> {
    let dir = root.join(INSTANCES_DIR);
    let entries = std::fs::read_dir(&dir)
        .map_err(|err| format!("não consegui listar {}: {err}", dir.display()))?;

    let mut instances = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(path.join("minecraftinstance.json")) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let id = entry.file_name().to_string_lossy().to_string();
        instances.push(InstanceInfo {
            name: json
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string(),
            game_version: json
                .get("gameVersion")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            modloader: json
                .pointer("/baseModLoader/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            id,
        });
    }
    instances.sort_by_key(|instance| instance.name.to_lowercase());
    Ok(instances)
}

/// Diretório de uma instância, validando o id (nada de `../`).
pub fn instance_dir(root: &Path, instance_id: &str) -> Result<PathBuf, String> {
    safe_id(instance_id, "instância")?;
    Ok(root.join(INSTANCES_DIR).join(instance_id))
}

pub fn list_worlds(instance_dir: &Path) -> Result<Vec<WorldInfo>, String> {    let saves = instance_dir.join("saves");
    let entries = match std::fs::read_dir(&saves) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()), // instância nova/sem mundo: lista vazia, não erro
    };

    let mut worlds = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let level_dat = path.join("level.dat");
        if !path.is_dir() || !level_dat.is_file() {
            continue;
        }
        let last_modified_ms = std::fs::metadata(&level_dat)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        let id = entry.file_name().to_string_lossy().to_string();
        worlds.push(WorldInfo {
            name: id.clone(),
            id,
            last_modified_ms,
        });
    }
    worlds.sort_by(|a, b| b.last_modified_ms.cmp(&a.last_modified_ms));
    Ok(worlds)
}

/// Resolve instância + versão + Java + classpath + argumentos num plano de
/// lançamento. `world_id` (opcional) vira `--quickPlaySingleplayer`.
pub fn build_launch_plan(
    settings: &crate::settings::Settings,
    root: &Path,
    instance_id: &str,
    world_id: Option<&str>,
    log_dir: &Path,
) -> Result<LaunchPlan, String> {
    safe_id(instance_id, "instância")?;
    if let Some(world) = world_id {
        safe_id(world, "mundo")?;
    }

    let instance_dir = instance_dir(root, instance_id)?;
    let raw = std::fs::read_to_string(instance_dir.join("minecraftinstance.json"))
        .map_err(|err| format!("instância {instance_id} sem minecraftinstance.json: {err}"))?;
    let instance_json: Value = serde_json::from_str(&raw).map_err(|err| err.to_string())?;
    let game_version = instance_json
        .get("gameVersion")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let modloader = instance_json
        .pointer("/baseModLoader/name")
        .and_then(Value::as_str)
        .unwrap_or_default();

    // Instância modded usa o id do modloader (ex: `neoforge-26.3.0.22-beta`);
    // vanilla cai na versão do jogo.
    let version_id = if modloader.is_empty() { game_version } else { modloader };
    if version_id.is_empty() {
        return Err(format!("instância {instance_id} não diz a versão do jogo"));
    }

    let install = root.join(INSTALL_DIR);
    let chain = load_version_chain(&install, version_id)?;
    let (java, java_version) = pick_java(&install, chain.java_component.as_deref(), chain.java_major)?;

    let natives_dir = install.join("natives").join(version_id);
    for sub in ["java", "jna", "lwjgl", "netty"] {
        std::fs::create_dir_all(natives_dir.join(sub)).map_err(|err| err.to_string())?;
    }

    let libraries = merged_libraries(&chain);
    let classpath = build_classpath(&install, &libraries, version_id)?;

    let features = FeatureFlags {
        custom_resolution: true,
        quick_play_singleplayer: world_id.is_some(),
    };
    let jvm_args = flatten_args(chain.jvm_args.as_deref(), &features)?;
    let game_args = match chain.game_args.as_deref() {
        Some(args) => flatten_args(Some(args), &features)?,
        None => chain
            .legacy_game_args
            .as_deref()
            .map(|legacy| legacy.split_whitespace().map(str::to_string).collect())
            .unwrap_or_default(),
    };

    let mut placeholders = HashMap::new();
    placeholders.insert("natives_directory", natives_dir.to_string_lossy().to_string());
    placeholders.insert("library_directory", install.join("libraries").to_string_lossy().to_string());
    placeholders.insert("classpath", classpath);
    placeholders.insert("classpath_separator", ":".to_string());
    placeholders.insert("launcher_name", LAUNCHER_NAME.to_string());
    placeholders.insert("launcher_version", env!("CARGO_PKG_VERSION").to_string());
    placeholders.insert(
        "auth_player_name",
        settings.offline_username.trim().to_string(),
    );
    placeholders.insert("version_name", version_id.to_string());
    placeholders.insert("game_directory", instance_dir.to_string_lossy().to_string());
    placeholders.insert("assets_root", install.join("assets").to_string_lossy().to_string());
    placeholders.insert("assets_index_name", chain.asset_index_id.clone());
    placeholders.insert("auth_uuid", OFFLINE_UUID.to_string());
    placeholders.insert("auth_access_token", "0".to_string());
    placeholders.insert("clientid", "0".to_string());
    placeholders.insert("auth_xuid", "0".to_string());
    placeholders.insert("version_type", chain.version_type.clone());
    placeholders.insert("resolution_width", GAME_WIDTH.to_string());
    placeholders.insert("resolution_height", GAME_HEIGHT.to_string());
    placeholders.insert(
        "quickPlaySingleplayer",
        world_id.unwrap_or_default().to_string(),
    );
    placeholders.insert("quickPlayPath", String::new());
    placeholders.insert("quickPlayMultiplayer", String::new());
    placeholders.insert("quickPlayRealms", String::new());
    // A sessão é offline; `--userType` só rotula a sessão (singleplayer não
    // valida) e é exigido pelo formato antigo (1.20.x/1.21.x).
    placeholders.insert("user_type", "legacy".to_string());
    // Placeholders de formatos antigos (pré-1.19), pra uma instância antiga do
    // CurseForge não quebrar a montagem.
    placeholders.insert("auth_session", "-".to_string());
    placeholders.insert("user_properties", "{}".to_string());
    placeholders.insert("profile_name", version_id.to_string());
    placeholders.insert("game_assets", install.join("assets").to_string_lossy().to_string());

    let jvm_resolved = substitute_all(&jvm_args, &placeholders)?;
    let game_resolved = substitute_all(&game_args, &placeholders)?;

    let memory = settings
        .java_memory_mb
        .clamp(MIN_MEMORY_MB, MAX_MEMORY_MB);
    let mut args = vec![format!("-Xmx{memory}m"), "-Xms256m".to_string()];
    args.extend(jvm_resolved);
    args.push(chain.main_class.clone());
    args.extend(game_resolved);

    let log_path = log_dir.join("minecraft-launch.log");

    Ok(LaunchPlan {
        java,
        java_version,
        args,
        cwd: instance_dir,
        log_path,
        version: version_id.to_string(),
        world: world_id.map(str::to_string),
    })
}

/// Linha de comando pronta pra copiar/inspecionar (com aspas de shell) — o
/// comando `minecraft_launch_preview` devolve isso sem abrir o jogo.
pub fn preview_command_line(plan: &LaunchPlan) -> String {
    let mut out = shell_quote(&plan.java.to_string_lossy());
    for arg in &plan.args {
        out.push(' ');
        out.push_str(&shell_quote(arg));
    }
    out
}

/* ---------- versão / bibliotecas / argumentos ---------- */

#[derive(Debug, Clone, Default)]
struct VersionChain {
    main_class: String,
    asset_index_id: String,
    version_type: String,
    java_component: Option<String>,
    java_major: Option<u32>,
    /// Formato antigo (`minecraftArguments` como string única), usado só
    /// quando a cadeia não tem `arguments.game` moderno.
    legacy_game_args: Option<String>,
    libraries: Vec<Value>,
    jvm_args: Option<Vec<Value>>,
    game_args: Option<Vec<Value>>,
}

fn load_version_chain(install: &Path, version_id: &str) -> Result<VersionChain, String> {
    let mut chain = VersionChain {
        version_type: "release".to_string(),
        ..Default::default()
    };
    let mut current = version_id.to_string();
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current.clone()) {
            return Err(format!("versão {current} herda de si mesma"));
        }
        let json_path = install.join("versions").join(&current).join(format!("{current}.json"));
        let raw = std::fs::read_to_string(&json_path).map_err(|err| {
            format!("versão '{current}' não instalada ({}): {err}", json_path.display())
        })?;
        let json: Value = serde_json::from_str(&raw).map_err(|err| err.to_string())?;

        if chain.main_class.is_empty() {
            chain.main_class = json
                .get("mainClass")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
        if chain.asset_index_id.is_empty() {
            chain.asset_index_id = json
                .pointer("/assetIndex/id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
        if chain.java_component.is_none() {
            chain.java_component = json
                .pointer("/javaVersion/component")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if chain.java_major.is_none() {
            chain.java_major = json
                .pointer("/javaVersion/majorVersion")
                .and_then(Value::as_u64)
                .map(|major| major as u32);
        }
        if chain.legacy_game_args.is_none() {
            chain.legacy_game_args = json
                .get("minecraftArguments")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if let Some(kind) = json.get("type").and_then(Value::as_str) {
            chain.version_type = kind.to_string();
        }
        if let Some(libraries) = json.get("libraries").and_then(Value::as_array) {
            chain.libraries.extend(libraries.iter().cloned());
        }
        let arguments = json.get("arguments");
        if let Some(jvm) = arguments.and_then(|a| a.get("jvm")).and_then(Value::as_array) {
            chain.jvm_args.get_or_insert_with(Vec::new).extend(jvm.iter().cloned());
        }
        if let Some(game) = arguments.and_then(|a| a.get("game")).and_then(Value::as_array) {
            chain.game_args.get_or_insert_with(Vec::new).extend(game.iter().cloned());
        }

        match json.get("inheritsFrom").and_then(Value::as_str) {
            Some(parent) => current = parent.to_string(),
            None => break,
        }
    }
    if chain.main_class.is_empty() {
        return Err(format!("versão {version_id} sem mainClass"));
    }
    Ok(chain)
}

fn merged_libraries(chain: &VersionChain) -> Vec<Value> {
    // Child sobrescreve o parent pra mesma coordenada (name), preservando a
    // ordem: bibliotecas do filho depois das do pai.
    let mut order: Vec<String> = Vec::new();
    let mut by_name: HashMap<String, Value> = HashMap::new();
    // A ordem do Vec é pai-primeiro (load_version_chain estende parent depois
    // do filho)... na verdade aqui as do filho vêm primeiro porque o loop lê o
    // filho antes de seguir o `inheritsFrom`; inverter pra o pai vir primeiro
    // é só estético, mas o dedupe precisa que o filho vença.
    for library in &chain.libraries {
        let name = library.get("name").and_then(Value::as_str).unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        if !by_name.contains_key(name) {
            order.push(name.to_string());
        }
        by_name.insert(name.to_string(), library.clone());
    }
    order.into_iter().filter_map(|name| by_name.remove(&name)).collect()
}

fn build_classpath(install: &Path, libraries: &[Value], version_id: &str) -> Result<String, String> {
    let mut entries: Vec<String> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    for library in libraries {
        if !library_allowed(library) {
            continue;
        }
        let name = library.get("name").and_then(Value::as_str).unwrap_or_default();
        let path = library
            .pointer("/downloads/artifact/path")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| maven_path(name));
        let Some(path) = path else { continue };
        let full = install.join("libraries").join(&path);
        if full.is_file() {
            entries.push(full.to_string_lossy().to_string());
        } else {
            missing.push(path);
        }
    }

    let jar = install
        .join("versions")
        .join(version_id)
        .join(format!("{version_id}.jar"));
    if !jar.is_file() {
        return Err(format!(
            "jar da versão não encontrado em {} — abra essa instância pelo CurseForge uma vez",
            jar.display()
        ));
    }
    entries.push(jar.to_string_lossy().to_string());

    if !missing.is_empty() {
        let sample = missing.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
        return Err(format!(
            "{} biblioteca(s) faltando (ex: {sample}) — abra essa instância pelo CurseForge uma vez para baixá-las",
            missing.len()
        ));
    }
    Ok(entries.join(":"))
}

fn library_allowed(library: &Value) -> bool {
    match library.get("rules").and_then(Value::as_array) {
        None => true,
        Some(rules) => eval_rules(rules, &FeatureFlags::default()),
    }
}

/// Mesma semântica do launcher oficial: sem regras = permitido; com regras, a
/// última que casar decide (e o padrão é negado).
fn eval_rules(rules: &[Value], features: &FeatureFlags) -> bool {
    let mut allowed = false;
    for rule in rules {
        if rule_matches(rule, features) {
            allowed = rule.get("action").and_then(Value::as_str) == Some("allow");
        }
    }
    allowed
}

fn rule_matches(rule: &Value, features: &FeatureFlags) -> bool {
    if let Some(os) = rule.get("os") {
        if let Some(name) = os.get("name").and_then(Value::as_str) {
            let matches = match name {
                "linux" => cfg!(target_os = "linux"),
                "windows" => cfg!(target_os = "windows"),
                "osx" => cfg!(target_os = "macos"),
                _ => false,
            };
            if !matches {
                return false;
            }
        }
        if let Some(arch) = os.get("arch").and_then(Value::as_str) {
            let matches = match arch {
                "x86" => cfg!(target_arch = "x86"),
                "x86_64" | "amd64" => cfg!(target_arch = "x86_64"),
                "arm64" | "aarch64" => cfg!(target_arch = "aarch64"),
                _ => false,
            };
            if !matches {
                return false;
            }
        }
    }
    if let Some(feature_map) = rule.get("features").and_then(Value::as_object) {
        for (name, expected) in feature_map {
            if features.enabled(name) != expected.as_bool().unwrap_or(false) {
                return false;
            }
        }
    }
    true
}

#[derive(Debug, Clone, Default)]
struct FeatureFlags {
    custom_resolution: bool,
    quick_play_singleplayer: bool,
}

impl FeatureFlags {
    fn enabled(&self, name: &str) -> bool {
        match name {
            "has_custom_resolution" => self.custom_resolution,
            "is_quick_play_singleplayer" => self.quick_play_singleplayer,
            "is_demo_user" => false,
            "has_quick_plays_support" => false,
            "is_quick_play_multiplayer" => false,
            "is_quick_play_realms" => false,
            _ => false,
        }
    }
}

/// Achata `arguments.jvm`/`arguments.game`: entrada string vira argumento;
/// entrada com `rules` só entra se as regras permitirem. O `value` pode ser
/// string ou lista de strings.
fn flatten_args(args: Option<&[Value]>, features: &FeatureFlags) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for entry in args.unwrap_or_default() {
        match entry {
            Value::String(value) => out.push(value.clone()),
            Value::Object(map) => {
                let rules = map.get("rules").and_then(Value::as_array);
                if let Some(rules) = rules {
                    if !eval_rules(rules, features) {
                        continue;
                    }
                }
                match map.get("value") {
                    Some(Value::String(value)) => out.push(value.clone()),
                    Some(Value::Array(values)) => {
                        for value in values {
                            if let Some(value) = value.as_str() {
                                out.push(value.to_string());
                            }
                        }
                    }
                    _ => return Err("argumento com `value` inesperado no JSON da versão".to_string()),
                }
            }
            _ => return Err("argumento inesperado no JSON da versão".to_string()),
        }
    }
    Ok(out)
}

fn substitute_all(args: &[String], placeholders: &HashMap<&str, String>) -> Result<Vec<String>, String> {
    args.iter()
        .map(|arg| substitute(arg, placeholders))
        .collect()
}

fn substitute(input: &str, placeholders: &HashMap<&str, String>) -> Result<String, String> {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            return Err(format!("placeholder sem fechamento em '{input}'"));
        };
        let name = &after[..end];
        match placeholders.get(name) {
            Some(value) => out.push_str(value),
            None => return Err(format!("placeholder não suportado: ${{{name}}}")),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn maven_path(name: &str) -> Option<String> {
    let mut parts = name.split(':');
    let group = parts.next()?;
    let artifact = parts.next()?;
    let version = parts.next()?;
    let classifier = parts.next();
    let file = match classifier {
        Some(classifier) => format!("{artifact}-{version}-{classifier}.jar"),
        None => format!("{artifact}-{version}.jar"),
    };
    Some(format!(
        "{}/{artifact}/{version}/{file}",
        group.replace('.', "/")
    ))
}

fn safe_id(id: &str, label: &str) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("{label} inválido: {id:?}"));
    }
    Ok(())
}

/// Roda `java -version` no runtime do CurseForge e extrai a primeira linha
/// (`openjdk version "25.0.4.1" ...`). Falha vira `None` — o caminho continua
/// válido pro lançamento; a UI só não mostra a versão.
fn probe_java_version(java: &Path) -> Option<String> {
    let output = std::process::Command::new(java).arg("-version").output().ok()?;
    let text = String::from_utf8_lossy(&output.stderr);
    let first = text.lines().next()?.trim();
    let quoted = first.split('"').nth(1)?;
    Some(quoted.to_string())
}

fn pick_java(
    install: &Path,
    component: Option<&str>,
    major: Option<u32>,
) -> Result<(PathBuf, Option<String>), String> {
    let base = install.join("java");
    // 1) O componente nomeado pelo JSON da versão (ex: java-runtime-epsilon).
    if let Some(component) = component {
        let candidate = base.join(component).join("bin/java");
        if candidate.is_file() {
            let version = probe_java_version(&candidate);
            return Ok((candidate, version));
        }
    }
    // 2) Algum runtime cujo major bata com o pedido pela versão — a pasta do
    //    CurseForge pode ter outro nome pro mesmo Java.
    if let Some(major) = major {
        if let Ok(entries) = std::fs::read_dir(&base) {
            for entry in entries.flatten() {
                if read_java_major(&entry.path()) == Some(major) {
                    let candidate = entry.path().join("bin/java");
                    if candidate.is_file() {
                        let version = probe_java_version(&candidate);
                        return Ok((candidate, version));
                    }
                }
            }
        }
    }
    // 3) Preferência conhecida; 4) qualquer runtime instalado; 5) java do PATH.
    let mut candidates: Vec<PathBuf> = Vec::new();
    for runtime in JAVA_RUNTIME_PREFERENCE {
        candidates.push(base.join(runtime).join("bin/java"));
    }
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            candidates.push(entry.path().join("bin/java"));
        }
    }
    for candidate in candidates {
        if candidate.is_file() {
            let version = probe_java_version(&candidate);
            return Ok((candidate, version));
        }
    }
    let system = PathBuf::from("java");
    if probe_java_version(&system).is_some() {
        return Ok((system, None));
    }
    Err(format!(
        "nenhum Java encontrado (nem em {}, nem no PATH) — instale/repare o runtime pelo CurseForge",
        base.display()
    ))
}

/// Major do `release` do runtime (ex: `JAVA_VERSION="25.0.4.1"` -> 25).
fn read_java_major(runtime_dir: &Path) -> Option<u32> {
    let release = std::fs::read_to_string(runtime_dir.join("release")).ok()?;
    let line = release.lines().find(|line| line.starts_with("JAVA_VERSION="))?;
    let version = line.split('"').nth(1)?;
    version.split('.').next()?.parse().ok()
}

fn shell_quote(input: &str) -> String {
    if !input.is_empty()
        && input
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'-' | b'_' | b':' | b'=' | b'+'))
    {
        return input.to_string();
    }
    format!("'{}'", input.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_require_a_matching_allow() {
        let allow_linux = serde_json::json!([{ "action": "allow", "os": { "name": "linux" } }]);
        let allow = eval_rules(allow_linux.as_array().unwrap(), &FeatureFlags::default());
        assert_eq!(allow, cfg!(target_os = "linux"));

        let none = eval_rules(&[], &FeatureFlags::default());
        assert!(!none, "com regras, nada casando nega por padrão");
    }

    #[test]
    fn feature_rules_gate_quick_play_args() {
        let args = serde_json::json!([
            "--username",
            {
                "rules": [{ "action": "allow", "features": { "is_quick_play_singleplayer": true } }],
                "value": ["--quickPlaySingleplayer", "${quickPlaySingleplayer}"]
            }
        ]);
        let flat = flatten_args(args.as_array().map(Vec::as_slice), &FeatureFlags::default()).unwrap();
        assert_eq!(flat, vec!["--username"]);

        let flat = flatten_args(
            args.as_array().map(Vec::as_slice),
            &FeatureFlags {
                quick_play_singleplayer: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(flat, vec!["--username", "--quickPlaySingleplayer", "${quickPlaySingleplayer}"]);
    }

    #[test]
    fn substitute_replaces_known_and_rejects_unknown() {
        let mut placeholders = HashMap::new();
        placeholders.insert("game_directory", "/tmp/world".to_string());
        let out = substitute("--gameDir ${game_directory}", &placeholders).unwrap();
        assert_eq!(out, "--gameDir /tmp/world");
        assert!(substitute("${nope}", &placeholders).is_err());
    }

    #[test]
    fn maven_path_includes_classifier() {
        assert_eq!(
            maven_path("org.lwjgl:lwjgl:3.4.3:natives-linux").unwrap(),
            "org/lwjgl/lwjgl/3.4.3/lwjgl-3.4.3-natives-linux.jar"
        );
        assert_eq!(
            maven_path("com.google.guava:guava:33.6.0-jre").unwrap(),
            "com/google/guava/guava/33.6.0-jre/guava-33.6.0-jre.jar"
        );
    }

    #[test]
    fn list_worlds_reads_saves_folder() {
        let dir = std::env::temp_dir().join(format!("bo-mc-worlds-{}", std::process::id()));
        let world = dir.join("saves").join("New World");
        std::fs::create_dir_all(&world).unwrap();
        std::fs::write(world.join("level.dat"), b"nbt").unwrap();

        let worlds = list_worlds(&dir).unwrap();
        assert_eq!(worlds.len(), 1);
        assert_eq!(worlds[0].id, "New World");
        assert!(worlds[0].last_modified_ms > 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn safe_id_rejects_traversal() {
        assert!(safe_id("New World", "mundo").is_ok());
        assert!(safe_id("../etc", "mundo").is_err());
        assert!(safe_id("a/b", "mundo").is_err());
        assert!(safe_id("", "mundo").is_err());
    }

    #[test]
    fn shell_quote_quotes_whitespace() {
        assert_eq!(shell_quote("-Xmx4096m"), "-Xmx4096m");
        assert_eq!(shell_quote("/home/user/Baritone Orchestrator"), "'/home/user/Baritone Orchestrator'");
    }

    /// Integração real: se o CurseForge estiver instalado nesta máquina, monta
    /// o plano de lançamento de **todas** as instâncias (com o primeiro mundo,
    /// se houver) sem abrir o jogo — cobre formatos de versão diferentes
    /// (26.3/1.21.1/1.20.1). Pula sozinho quando não existe, mesmo padrão do
    /// teste do atlas.
    #[test]
    fn builds_a_real_launch_plan_if_curseforge_is_installed() {
        let settings = crate::settings::Settings::default();
        let Some(root) = detect_root(&settings.curseforge_root) else {
            eprintln!("skip: sem CurseForge instalado");
            return;
        };
        let instances = list_instances(&root).expect("deveria listar instâncias");
        if instances.is_empty() {
            eprintln!("skip: nenhuma instância");
            return;
        }

        for instance in &instances {
            let dir = instance_dir(&root, &instance.id).expect("caminho da instância");
            let world = list_worlds(&dir)
                .expect("deveria listar mundos")
                .first()
                .map(|world| world.id.clone());

            let plan = build_launch_plan(
                &settings,
                &root,
                &instance.id,
                world.as_deref(),
                &std::env::temp_dir(),
            )
            .unwrap_or_else(|err| panic!("plano de '{}' falhou: {err}", instance.name));

            eprintln!(
                "instância='{}' versão={} java={} ({:?}) args={} mundo={:?}",
                instance.name,
                plan.version,
                plan.java.display(),
                plan.java_version,
                plan.args.len(),
                plan.world
            );
            assert!(plan.java.is_file() || plan.java == Path::new("java"));
            assert!(
                !plan.args.iter().any(|arg| arg.contains("${")),
                "placeholder não resolvido em '{}'",
                instance.name
            );
            assert!(plan.args.iter().any(|arg| arg == "--username"));
            assert!(plan.args.iter().any(|arg| *arg == plan.version));
            if let Some(world) = &world {
                assert!(plan.args.iter().any(|arg| arg == "--quickPlaySingleplayer"));
                assert!(plan.args.iter().any(|arg| arg == world));
            }
        }
    }
}

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Wry};
use tauri::menu::MenuItem;
use tauri::Emitter;

pub const RECENT_SLOTS: usize = 5;
pub const INSTALLED_SLOTS: usize = 8;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadPetPayload {
    pub kind: String,
    #[serde(default)]
    pub pet_json_path: Option<String>,
    #[serde(default)]
    pub bundled_id: Option<String>,
    pub display_name: String,
    pub id: String,
}

pub struct DynamicPetMenu {
    pub items: Vec<MenuItem<Wry>>,
    slots: Mutex<Vec<LoadPetPayload>>,
}

impl DynamicPetMenu {
    pub fn new_empty_slots(app: &tauri::App, id_prefix: &str, count: usize) -> tauri::Result<Self> {
        let mut items = Vec::with_capacity(count);
        for i in 0..count {
            let id = format!("{id_prefix}-{i}");
            let text = format!("（空） {i}");
            items.push(MenuItem::with_id(app, id, text, false, None::<&str>)?);
        }
        Ok(Self {
            items,
            slots: Mutex::new(Vec::new()),
        })
    }

    pub fn sync_slots(&self, entries: Vec<LoadPetPayload>) {
        if let Ok(mut slots) = self.slots.lock() {
            *slots = entries;
        }
        for (i, item) in self.items.iter().enumerate() {
            let slot = self
                .slots
                .lock()
                .ok()
                .and_then(|s| s.get(i).cloned());
            match slot {
                Some(entry) => {
                    let _ = item.set_text(entry.display_name.clone());
                    let _ = item.set_enabled(true);
                }
                None => {
                    let _ = item.set_text("—");
                    let _ = item.set_enabled(false);
                }
            }
        }
    }

    pub fn refresh_installed_from_disk(&self) {
        let found = scan_codex_installed_pets();
        self.sync_slots(found);
    }

    pub fn emit_slot(&self, app: &AppHandle, index: usize) -> bool {
        let payload = self
            .slots
            .lock()
            .ok()
            .and_then(|s| s.get(index).cloned());
        let Some(payload) = payload else {
            return false;
        };
        emit_load_pet(app, payload);
        true
    }
}

pub fn emit_load_pet(app: &AppHandle, payload: LoadPetPayload) {
    let r = app.emit("load-pet", payload);
    eprintln!("[Deski] emit load-pet: {r:?}");
}

pub fn emit_bundled_pet(app: &AppHandle, bundled_id: &str, display_name: &str) {
    emit_load_pet(
        app,
        LoadPetPayload {
            kind: "bundled".into(),
            pet_json_path: None,
            bundled_id: Some(bundled_id.into()),
            display_name: display_name.into(),
            id: bundled_id.into(),
        },
    );
}

fn codex_pets_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())?;
    let dir = PathBuf::from(home).join(".codex").join("pets");
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// 扫描 `~/.codex/pets/*/pet.json`（Petdex / hatch 默认安装位置）。
pub fn scan_codex_installed_pets() -> Vec<LoadPetPayload> {
    let Some(pets_dir) = codex_pets_dir() else {
        return Vec::new();
    };
    let Ok(read_dir) = std::fs::read_dir(&pets_dir) else {
        return Vec::new();
    };

    let mut found: Vec<LoadPetPayload> = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let pet_json = path.join("pet.json");
        if !pet_json.is_file() {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&pet_json) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let id = value
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let display_name = value
            .get("displayName")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id.as_str())
            .to_string();
        if id.is_empty() {
            continue;
        }
        found.push(LoadPetPayload {
            kind: "disk".into(),
            pet_json_path: Some(pet_json.to_string_lossy().into_owned()),
            bundled_id: None,
            display_name,
            id,
        });
    }

    found.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    found.truncate(INSTALLED_SLOTS);
    found
}

pub fn try_emit_dynamic_slot(app: &AppHandle, id: &str, prefix: &str, menu: &DynamicPetMenu) -> bool {
    let Some(index_str) = id.strip_prefix(prefix) else {
        return false;
    };
    let Ok(index) = index_str.parse::<usize>() else {
        return false;
    };
    menu.emit_slot(app, index)
}

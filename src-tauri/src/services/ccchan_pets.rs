//! 桌宠皮肤加载：内置皮肤 + 用户皮肤目录 + 只读的 `~/.codex/pets`。
//!
//! pet.json 宽松解析：兼容 Codex pet 的 4 字段格式（id / displayName /
//! description / spritesheetPath），atlas 与 animations 缺省时按 Codex 标准
//! 8 列 × 9 行、每格 192×208 的布局补齐。

use crate::utils::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PetMeta {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub spritesheet_url: String,
    pub atlas: PetAtlas,
    pub animations: HashMap<String, PetAnimation>,
    /// 像素风精灵用最近邻缩放；插画风（默认）走平滑缩放，避免非整数缩小锯齿。
    #[serde(default)]
    pub pixel_art: bool,
    /// 皮肤来源：builtin / user / codex（只读）。
    pub source: &'static str,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PetAtlas {
    pub cell_w: u32,
    pub cell_h: u32,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PetAnimation {
    pub row: u32,
    pub frames: u32,
    pub fps: u32,
    #[serde(default)]
    pub col_offset: u32,
}

#[derive(Deserialize)]
pub(crate) struct PetsManifest {
    pub(crate) pets: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetDefinition {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) pixel_art: bool,
    #[serde(default)]
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) description: String,
    pub(crate) spritesheet_path: String,
    #[serde(default = "codex_standard_atlas")]
    pub(crate) atlas: PetAtlas,
    #[serde(default = "codex_standard_animations")]
    pub(crate) animations: HashMap<String, PetAnimation>,
}

/// Codex pet 标准图集：8 列 × 9 行，每格 192×208。
pub(crate) fn codex_standard_atlas() -> PetAtlas {
    PetAtlas {
        cell_w: 192,
        cell_h: 208,
        cols: 8,
        rows: 9,
    }
}

/// Codex 标准行：0 idle(6) 1 running-right(8) 2 running-left(8) 3 waving(4)
/// 4 jumping(5) 5 failed(8) 6 waiting(6) 7 running(6) 8 review(6)。
/// 键名与前端 petStatus.ts 的动画查找链对齐。
pub(crate) fn codex_standard_animations() -> HashMap<String, PetAnimation> {
    let rows: [(&str, u32, u32, u32); 9] = [
        ("idle", 0, 6, 4),
        ("runningRight", 1, 8, 8),
        ("runningLeft", 2, 8, 8),
        ("ready", 3, 4, 8),
        ("jumping", 4, 5, 6),
        ("blocked", 5, 8, 6),
        ("needsInput", 6, 6, 6),
        ("running", 7, 6, 10),
        ("review", 8, 6, 8),
    ];
    rows.into_iter()
        .map(|(name, row, frames, fps)| {
            (
                name.to_string(),
                PetAnimation {
                    row,
                    frames,
                    fps,
                    col_offset: 0,
                },
            )
        })
        .collect()
}

/// 合并皮肤：同 id 时后来者覆盖（内置 < codex < 用户），新 id 追加在后。
pub fn merge_pets(base: Vec<PetMeta>, overrides: Vec<PetMeta>) -> Vec<PetMeta> {
    let mut pets = base;
    for pet in overrides {
        if let Some(existing) = pets.iter_mut().find(|item| item.id == pet.id) {
            *existing = pet;
        } else {
            pets.push(pet);
        }
    }
    pets
}

pub(crate) const USER_PET_JSON_MAX_BYTES: u64 = 64 * 1024;
const USER_PET_SPRITESHEET_MAX_BYTES: u64 = 20 * 1024 * 1024;
const USER_PET_IMAGE_EXTENSIONS: [&str; 5] = ["png", "webp", "gif", "jpg", "jpeg"];

pub fn load_bundled_pets(root: &Path) -> AppResult<Vec<PetMeta>> {
    let content = std::fs::read_to_string(root.join("pets-manifest.json"))?;
    let manifest: PetsManifest = serde_json::from_str(&content)
        .map_err(|error| AppError::from(format!("Invalid pets manifest: {error}")))?;
    Ok(manifest
        .pets
        .iter()
        .filter_map(|id| {
            load_pet_dir(&root.join(id), "builtin")
                .map_err(|error| warn!(%id, %error, "skipping invalid bundled pet"))
                .ok()
        })
        .collect())
}

/// 扫描一个皮肤根目录（`<root>/<folder>/pet.json`）。目录不存在或单个皮肤
/// 非法都不算错误——warn 跳过，保证其它角色始终可用。
pub fn scan_pet_root(root: &Path, source: &'static str) -> Vec<PetMeta> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut pet_dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && path.join("pet.json").is_file())
        .collect();
    // 按目录名排序遍历，重复 id 时保证覆盖结果确定。
    pet_dirs.sort();
    pet_dirs
        .into_iter()
        .filter_map(|dir| match load_pet_dir(&dir, source) {
            Ok(pet) => {
                info!(dir = %dir.display(), id = %pet.id, source, "loaded ccchan pet");
                Some(pet)
            }
            Err(error) => {
                warn!(dir = %dir.display(), %error, source, "skipping invalid ccchan pet");
                None
            }
        })
        .collect()
}

pub fn load_pet_dir(pet_dir: &Path, source: &'static str) -> AppResult<PetMeta> {
    let pet_json_path = pet_dir.join("pet.json");
    let json_len = std::fs::metadata(&pet_json_path)
        .map_err(|error| AppError::from(format!("cannot stat pet.json: {error}")))?
        .len();
    if json_len > USER_PET_JSON_MAX_BYTES {
        return Err(AppError::from(format!(
            "pet.json too large ({json_len} bytes, max {USER_PET_JSON_MAX_BYTES})"
        )));
    }
    let content = std::fs::read_to_string(&pet_json_path)
        .map_err(|error| AppError::from(format!("cannot read pet.json: {error}")))?;
    let definition = parse_pet_definition(&content)?;
    let spritesheet_path = resolve_spritesheet(pet_dir, &definition.spritesheet_path)?;
    let display_name = if definition.display_name.trim().is_empty() {
        definition.id.clone()
    } else {
        definition.display_name
    };
    Ok(PetMeta {
        id: definition.id,
        display_name,
        description: definition.description,
        spritesheet_url: file_asset_url(&spritesheet_path),
        atlas: definition.atlas,
        animations: definition.animations,
        pixel_art: definition.pixel_art,
        source,
    })
}

pub(crate) fn parse_pet_definition(content: &str) -> AppResult<PetDefinition> {
    let definition: PetDefinition = serde_json::from_str(content)
        .map_err(|error| AppError::from(format!("invalid pet.json: {error}")))?;
    validate_pet_definition(&definition)?;
    Ok(definition)
}

pub(crate) fn validate_pet_definition(definition: &PetDefinition) -> AppResult<()> {
    if definition.id.trim().is_empty() {
        return Err(AppError::from("pet.json id is empty"));
    }
    let atlas = &definition.atlas;
    if atlas.cell_w == 0 || atlas.cell_h == 0 || atlas.cols == 0 || atlas.rows == 0 {
        return Err(AppError::from("pet.json atlas dimensions must be positive"));
    }
    for (state, animation) in &definition.animations {
        if animation.row >= atlas.rows {
            return Err(AppError::from(format!(
                "animation '{state}' row {} out of atlas rows {}",
                animation.row, atlas.rows
            )));
        }
        if animation
            .col_offset
            .checked_add(animation.frames)
            .is_none_or(|end| end > atlas.cols)
        {
            return Err(AppError::from(format!(
                "animation '{state}' exceeds atlas columns"
            )));
        }
        if animation.frames == 0 {
            return Err(AppError::from(format!(
                "animation '{state}' has zero frames"
            )));
        }
        if !(1..=60).contains(&animation.fps) {
            return Err(AppError::from(format!(
                "animation '{state}' fps {} out of range 1..=60",
                animation.fps
            )));
        }
    }
    Ok(())
}

/// spritesheetPath 只允许指向 pet 目录内部的图片文件：拒绝绝对路径、
/// `..`、symlink 逃逸和非图片扩展名（asset scope 是 `**`，必须在这里兜安全）。
pub(crate) fn resolve_spritesheet(pet_dir: &Path, sprite_rel: &str) -> AppResult<PathBuf> {
    let rel = Path::new(sprite_rel);
    if rel.is_absolute() {
        return Err(AppError::from("spritesheetPath must be relative"));
    }
    if rel
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(AppError::from("spritesheetPath must not contain '..'"));
    }
    let extension = rel
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();
    if !USER_PET_IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(AppError::from(format!(
            "spritesheetPath extension '{extension}' is not an allowed image type"
        )));
    }

    let candidate = pet_dir.join(rel);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| AppError::from(format!("spritesheet not found: {error}")))?;
    let canonical_dir = pet_dir
        .canonicalize()
        .map_err(|error| AppError::from(format!("cannot canonicalize pet dir: {error}")))?;
    if !canonical.starts_with(&canonical_dir) {
        return Err(AppError::from("spritesheetPath escapes the pet directory"));
    }
    let sprite_len = std::fs::metadata(&canonical)
        .map_err(|error| AppError::from(format!("cannot stat spritesheet: {error}")))?
        .len();
    if sprite_len > USER_PET_SPRITESHEET_MAX_BYTES {
        return Err(AppError::from(format!(
            "spritesheet too large ({sprite_len} bytes, max {USER_PET_SPRITESHEET_MAX_BYTES})"
        )));
    }
    // asset URL 用未 canonicalize 的路径，避免 Windows `\\?\` 前缀进 URL。
    Ok(candidate)
}

pub(crate) fn file_asset_url(path: &Path) -> String {
    let path_text = path.to_string_lossy();
    let encoded = urlencoding::encode(&path_text);
    if cfg!(windows) {
        format!("http://asset.localhost/{encoded}")
    } else {
        format!("asset://localhost/{encoded}")
    }
}

/// Codex 桌宠目录（只读额外来源）：`$CODEX_HOME/pets` 或 `~/.codex/pets`。
pub fn codex_pets_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(home).join("pets"));
    }
    dirs::home_dir().map(|home| home.join(".codex").join("pets"))
}

/// 首次打开用户皮肤目录时生成的说明文件（`ensure_user_pets_dir_scaffold`）。
pub const USER_PETS_README: &str = r#"# CC-Panes 自定义宠物（cc酱皮肤）

在本目录下为每个自定义角色建一个文件夹：

```
pets/
└── my-pet/                 # 文件夹名随意，建议与 id 一致
    ├── pet.json            # 角色定义（必需）
    └── spritesheet.png     # 精灵图（png / webp / gif / jpg，≤ 20MB）
```

## 最简格式（与 Codex pet 相同）

```json
{
  "id": "my-pet",
  "displayName": "我的宠物",
  "description": "一句话介绍",
  "spritesheetPath": "spritesheet.png"
}
```

精灵图按 Codex 标准布局：8 列 × 9 行，每格 192×208。行含义：
0 待机 · 1 向右跑 · 2 向左跑 · 3 挥手（完成未看）· 4 跳跃 · 5 失败（出错）·
6 等待（需要你输入）· 7 奔跑（运行中）· 8 复盘。

## 自定义图集（可选）

非标准布局时补 `atlas` 与 `animations`：

```json
{
  "atlas": { "cellW": 192, "cellH": 208, "cols": 8, "rows": 9 },
  "animations": {
    "idle":       { "row": 0, "frames": 6, "fps": 4 },
    "running":    { "row": 7, "frames": 6, "fps": 10 },
    "needsInput": { "row": 6, "frames": 6, "fps": 6 },
    "ready":      { "row": 3, "frames": 4, "fps": 8 },
    "blocked":    { "row": 5, "frames": 8, "fps": 6 }
  }
}
```

- 只有 `idle` 是必要的——缺失的状态会自动回退到 idle。旧键名 `working` / `waiting` /
  `happy` / `sad` 仍然识别。
- `spritesheetPath` 必须是本文件夹内的相对路径（不允许绝对路径和 `..`）。
- 可选 `pixelArt: true`：像素风精灵用最近邻缩放保持硬边；默认（插画风）平滑缩放。

## 提示

- `id` 与内置角色相同（`homie` / `doro.codex-pet`）时会**覆盖**内置形象（换皮）。
- `~/.codex/pets` 里的 Codex 桌宠也会被只读地列出来。
- 改完后到 设置 → cc酱 → 「刷新角色列表」，或在 Bot 编辑里的「桌面形象」选择。
- pet.json 不合法时该角色会被跳过（日志里有 warn），不影响其他角色。
"#;

#[cfg(test)]
#[path = "ccchan_pets_tests.rs"]
mod tests;

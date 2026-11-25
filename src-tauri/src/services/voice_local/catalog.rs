// 本地转写的下载清单：sherpa-onnx 推理引擎（按平台）+ 模型。
// 全部来自 k2-fsa/sherpa-onnx 的 GitHub Release，大小与 SHA256 钉死，下载后逐字节校验。
// 升级版本时同时改 URL、大小和摘要（GitHub API 的 asset.digest 字段可直接取）。

const ENGINE_RELEASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.3";
const MODEL_RELEASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

/// 一个 `.tar.bz2` 下载包；解压后顶层目录名与包名（去掉扩展名）相同。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Archive {
    pub name: &'static str,
    pub base_url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

impl Archive {
    pub fn url(&self) -> String {
        format!("{}/{}.tar.bz2", self.base_url, self.name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelKind {
    SenseVoice,
    Qwen3Asr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalModel {
    /// 设置里存的 id（VoiceSettings.local_model）
    pub id: &'static str,
    pub kind: ModelKind,
    pub archive: Archive,
    /// 模型支持热词（词典可用）
    pub hotwords: bool,
}

pub const DEFAULT_LOCAL_MODEL: &str = "sense-voice";

pub const LOCAL_MODELS: [LocalModel; 2] = [
    LocalModel {
        id: "sense-voice",
        kind: ModelKind::SenseVoice,
        archive: Archive {
            name: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
            base_url: MODEL_RELEASE,
            size: 163_002_883,
            sha256: "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e",
        },
        hotwords: false,
    },
    LocalModel {
        id: "qwen3-asr",
        kind: ModelKind::Qwen3Asr,
        archive: Archive {
            name: "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
            base_url: MODEL_RELEASE,
            size: 878_702_423,
            sha256: "393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96",
        },
        hotwords: true,
    },
];

pub fn find_model(id: &str) -> Option<&'static LocalModel> {
    LOCAL_MODELS.iter().find(|model| model.id == id)
}

/// 当前平台的引擎包；不支持的平台返回 None（界面据此隐藏本地选项）。
pub fn engine_archive() -> Option<Archive> {
    engine_archive_for(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn engine_archive_for(os: &str, arch: &str) -> Option<Archive> {
    let (name, size, sha256) = match (os, arch) {
        ("macos", "aarch64") => (
            "sherpa-onnx-v2.0.3-osx-arm64-shared-no-tts",
            20_241_643,
            "611aee84500fbc8a1295c05c15afeefa74380602ddc1a212e8a703cfe76981fd",
        ),
        ("macos", "x86_64") => (
            "sherpa-onnx-v2.0.3-osx-x64-shared-no-tts",
            22_792_603,
            "d44a9a15dfd318e4db403676056fd89a4984b363dd466a74f130928eb62a325d",
        ),
        ("windows", "x86_64") => (
            // MT = 静态 CRT，不依赖用户机器装 VC++ 运行库
            "sherpa-onnx-v2.0.3-win-x64-shared-MT-Release-no-tts",
            30_850_705,
            "e1536db1fcd1dde829f3cf26dfdbf60909aee6984983f6cd16b03b1352ac43fc",
        ),
        ("windows", "aarch64") => (
            "sherpa-onnx-v2.0.3-win-arm64-shared-MT-Release-no-tts",
            28_351_011,
            "8dadd101f017f3d70e076ac766d7cd0ce66ae7e4036f76d36567fb0573899dea",
        ),
        ("linux", "x86_64") => (
            "sherpa-onnx-v2.0.3-linux-x64-shared-no-tts",
            27_264_882,
            "c16987540bc90cd10bab271023b2dcfb0864892b5af74cb1c9a9c7f1c4efe3af",
        ),
        ("linux", "aarch64") => (
            "sherpa-onnx-v2.0.3-linux-aarch64-shared-cpu",
            29_516_176,
            "c42748225180235bdd4ba10f8c4575b54beb8d5b26a5303bb3051026a0fe4e53",
        ),
        _ => return None,
    };
    Some(Archive {
        name,
        base_url: ENGINE_RELEASE,
        size,
        sha256,
    })
}

/// 引擎目录里的离线识别可执行文件（相对路径）。
pub fn engine_binary_relative() -> &'static str {
    if cfg!(windows) {
        "bin/sherpa-onnx-offline.exe"
    } else {
        "bin/sherpa-onnx-offline"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_desktop_platform_has_an_engine() {
        for (os, arch) in [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("windows", "x86_64"),
            ("windows", "aarch64"),
            ("linux", "x86_64"),
            ("linux", "aarch64"),
        ] {
            let archive = engine_archive_for(os, arch).expect("engine for platform");
            assert_eq!(archive.sha256.len(), 64);
            assert!(archive.url().ends_with(".tar.bz2"));
        }
        assert!(engine_archive_for("freebsd", "x86_64").is_none());
    }

    #[test]
    fn default_model_is_in_catalog() {
        assert!(find_model(DEFAULT_LOCAL_MODEL).is_some());
        assert!(find_model("nope").is_none());
        for model in LOCAL_MODELS {
            assert_eq!(model.archive.sha256.len(), 64);
        }
    }
}

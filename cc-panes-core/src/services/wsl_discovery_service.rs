//! WSL 分发版自动发现服务
//!
//! 仅在 Windows 上编译和运行。通过 `wsl.exe --list --verbose` 检测已安装的 WSL 分发版，
//! 并与已有的 SSH Machine 列表比对标记已导入状态。

#[cfg(target_os = "windows")]
mod inner {
    use crate::models::ssh_machine::SshMachine;
    use crate::models::wsl::{WslDistro, WslDistroState};
    use anyhow::Result;
    use tracing::{debug, warn};

    /// 检测系统中已安装的 WSL 分发版
    ///
    /// - 执行 `wsl.exe --list --verbose` 解析分发版列表
    /// - 对每个分发版执行 `wsl.exe -d <name> -e whoami` 获取默认用户
    /// - 与 `existing_machines` 比对标记 `already_imported`
    ///
    /// `wsl.exe` 不存在时返回空列表不报错。
    pub async fn discover(existing_machines: &[SshMachine]) -> Result<Vec<WslDistro>> {
        // 检查 wsl.exe 是否存在
        let wsl_path = match which::which("wsl.exe") {
            Ok(p) => p,
            Err(_) => {
                debug!("wsl.exe not found in PATH, returning empty list");
                return Ok(Vec::new());
            }
        };

        // 执行 wsl --list --verbose
        let output = tokio::process::Command::new(&wsl_path)
            .args(["--list", "--verbose"])
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!("wsl --list --verbose failed: {}", stderr);
            return Ok(Vec::new());
        }

        // wsl.exe 输出为 UTF-16LE 编码
        let text = decode_utf16le(&output.stdout);
        let distros = parse_wsl_list(&text);

        if distros.is_empty() {
            return Ok(Vec::new());
        }

        // 获取每个分发版的默认用户并检查导入状态
        // 仅对 Running 状态的分发版执行 whoami，避免意外冷启动 Stopped 分发版
        let mut results = Vec::with_capacity(distros.len());
        for (name, state, version, is_default) in distros {
            let default_user = if state == WslDistroState::Running {
                get_default_user(&wsl_path, &name).await
            } else {
                None
            };
            let already_imported = check_already_imported(&name, existing_machines);

            results.push(WslDistro {
                name,
                state,
                wsl_version: version,
                is_default,
                default_user,
                already_imported,
            });
        }

        Ok(results)
    }

    /// 将 UTF-16LE 字节流解码为 String
    fn decode_utf16le(bytes: &[u8]) -> String {
        // 跳过可能的 BOM (FF FE)
        let start = if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
            2
        } else {
            0
        };

        let u16_iter = bytes[start..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]));

        String::from_utf16_lossy(&u16_iter.collect::<Vec<u16>>())
    }

    /// 解析 `wsl --list --verbose` 的输出
    ///
    /// 示例输出：
    /// ```text
    ///   NAME                   STATE           VERSION
    /// * Ubuntu                 Running         2
    ///   Debian                 Stopped         2
    /// ```
    fn parse_wsl_list(text: &str) -> Vec<(String, WslDistroState, u8, bool)> {
        let mut results = Vec::new();

        for line in text.lines() {
            let trimmed = line.trim_start();
            if trimmed.is_empty() {
                continue;
            }

            // 检测是否为默认分发版（行首 *），使用 strip_prefix 避免 clippy manual_strip
            let (is_default, rest) = if let Some(stripped) = trimmed.strip_prefix('*') {
                (true, stripped.trim_start())
            } else {
                (false, trimmed)
            };

            // 按空白分割：NAME STATE VERSION
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() < 3 {
                continue;
            }

            let name = parts[0].to_string();

            // 跳过表头行（NAME STATE VERSION）
            if name == "NAME" {
                continue;
            }

            let state = match parts[1].to_lowercase().as_str() {
                "running" => WslDistroState::Running,
                "stopped" => WslDistroState::Stopped,
                "installing" => WslDistroState::Installing,
                _ => WslDistroState::Unknown,
            };

            let version = parts[2].parse::<u8>().unwrap_or(2);

            results.push((name, state, version, is_default));
        }

        results
    }

    /// 获取分发版的默认用户名
    ///
    /// `distro_name` 来自 `wsl.exe --list` 自身的输出（系统数据），
    /// 且通过 `args()` 数组传参不经 shell 展开，不存在注入风险。
    async fn get_default_user(wsl_path: &std::path::Path, distro_name: &str) -> Option<String> {
        let output = tokio::process::Command::new(wsl_path)
            .args(["-d", distro_name, "-e", "whoami"])
            .output()
            .await
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let user = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if user.is_empty() {
            None
        } else {
            Some(user)
        }
    }

    /// 检查分发版是否已作为 SSH Machine 导入
    ///
    /// 匹配条件：host=localhost 且（name 包含分发版名 或 tags 包含 "wsl"）
    fn check_already_imported(distro_name: &str, machines: &[SshMachine]) -> bool {
        let distro_lower = distro_name.to_lowercase();
        machines.iter().any(|m| {
            let is_localhost = m.host == "localhost" || m.host == "127.0.0.1" || m.host == "::1";
            if !is_localhost {
                return false;
            }
            let name_match = m.name.to_lowercase().contains(&distro_lower);
            let tag_match = m.tags.iter().any(|t| t.to_lowercase() == "wsl");
            name_match || tag_match
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_wsl_list_output() {
            let text = "  NAME                   STATE           VERSION\n\
                         * Ubuntu                 Running         2\n\
                           Debian                 Stopped         2\n\
                           kali-linux             Stopped         1\n";

            let result = parse_wsl_list(text);
            assert_eq!(result.len(), 3);

            assert_eq!(result[0].0, "Ubuntu");
            assert_eq!(result[0].1, WslDistroState::Running);
            assert_eq!(result[0].2, 2);
            assert!(result[0].3); // is_default

            assert_eq!(result[1].0, "Debian");
            assert_eq!(result[1].1, WslDistroState::Stopped);
            assert!(!result[1].3);

            assert_eq!(result[2].0, "kali-linux");
            assert_eq!(result[2].2, 1);
        }

        #[test]
        fn parses_empty_output() {
            let result = parse_wsl_list("");
            assert!(result.is_empty());
        }

        #[test]
        fn check_imported_matches_localhost_with_name() {
            let machines = vec![SshMachine {
                id: "1".into(),
                name: "WSL: Ubuntu".into(),
                host: "localhost".into(),
                port: 22,
                user: Some("user".into()),
                auth_method: Default::default(),
                identity_file: None,
                default_path: None,
                tags: vec![],
                created_at: String::new(),
                updated_at: String::new(),
            }];

            assert!(check_already_imported("Ubuntu", &machines));
            assert!(!check_already_imported("Debian", &machines));
        }

        #[test]
        fn check_imported_matches_wsl_tag() {
            let machines = vec![SshMachine {
                id: "2".into(),
                name: "My Linux".into(),
                host: "localhost".into(),
                port: 22,
                user: None,
                auth_method: Default::default(),
                identity_file: None,
                default_path: None,
                tags: vec!["wsl".into()],
                created_at: String::new(),
                updated_at: String::new(),
            }];

            // 名字不匹配但 tag 有 wsl → 视为已导入
            assert!(check_already_imported("Debian", &machines));
        }

        #[test]
        fn check_imported_non_localhost_ignored() {
            let machines = vec![SshMachine {
                id: "3".into(),
                name: "WSL: Ubuntu".into(),
                host: "remote-server".into(),
                port: 22,
                user: None,
                auth_method: Default::default(),
                identity_file: None,
                default_path: None,
                tags: vec!["wsl".into()],
                created_at: String::new(),
                updated_at: String::new(),
            }];

            assert!(!check_already_imported("Ubuntu", &machines));
        }

        #[test]
        fn decode_utf16le_works() {
            // "Hi" in UTF-16LE: H=0x48,0x00 i=0x69,0x00
            let bytes: Vec<u8> = vec![0x48, 0x00, 0x69, 0x00];
            assert_eq!(decode_utf16le(&bytes), "Hi");
        }

        #[test]
        fn decode_utf16le_with_bom() {
            // BOM (FF FE) + "Hi"
            let bytes: Vec<u8> = vec![0xFF, 0xFE, 0x48, 0x00, 0x69, 0x00];
            assert_eq!(decode_utf16le(&bytes), "Hi");
        }
    }
}

// 公开 API：仅在 Windows 上暴露 discover 函数
#[cfg(target_os = "windows")]
pub use inner::discover;

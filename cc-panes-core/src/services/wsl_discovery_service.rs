//! WSL 分发版自动发现服务
//!
//! 仅在 Windows 上编译和运行。通过 `wsl.exe --list --verbose` 检测已安装的 WSL 分发版，
//! 并与已有的 SSH Machine 列表比对标记已导入状态。
#[cfg(target_os = "windows")]
mod inner {
    use crate::models::ssh_machine::SshMachine;
    use crate::models::wsl::{WslDistro, WslDistroState};
    use anyhow::Result;
    use std::path::{Path, PathBuf};
    use tracing::{debug, warn};

    /// 检测系统中已安装的 WSL 分发版
    pub async fn discover(existing_machines: &[SshMachine]) -> Result<Vec<WslDistro>> {
        let wsl_path = match find_wsl_path() {
            Ok(path) => path,
            Err(_) => {
                debug!("wsl.exe not found in PATH, returning empty list");
                return Ok(Vec::new());
            }
        };

        let distros = load_distros(&wsl_path).await?;
        if distros.is_empty() {
            return Ok(Vec::new());
        }

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

    /// 解析默认分发版名称。未安装或未找到默认分发版时返回 None。
    pub fn resolve_default_distro() -> Result<Option<String>> {
        let wsl_path = match find_wsl_path() {
            Ok(path) => path,
            Err(_) => return Ok(None),
        };

        let output = std::process::Command::new(&wsl_path)
            .args(["--list", "--verbose"])
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!(
                "wsl --list --verbose failed while resolving default distro: {}",
                stderr
            );
            return Ok(None);
        }

        let text = decode_utf16le(&output.stdout);
        let distros = parse_wsl_list(&text);
        Ok(distros
            .into_iter()
            .find(|(_, _, _, is_default)| *is_default)
            .map(|(name, _, _, _)| name))
    }

    /// 检查远程目录是否存在。
    pub fn ensure_directory_exists(distro_name: &str, remote_path: &str) -> Result<bool> {
        let wsl_path = find_wsl_path()?;
        let status = std::process::Command::new(&wsl_path)
            .args(["-d", distro_name, "--", "test", "-d", remote_path])
            .status()?;
        Ok(status.success())
    }

    fn find_wsl_path() -> Result<PathBuf> {
        Ok(which::which("wsl.exe")?)
    }

    async fn load_distros(wsl_path: &Path) -> Result<Vec<(String, WslDistroState, u8, bool)>> {
        let output = tokio::process::Command::new(wsl_path)
            .args(["--list", "--verbose"])
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!("wsl --list --verbose failed: {}", stderr);
            return Ok(Vec::new());
        }

        let text = decode_utf16le(&output.stdout);
        Ok(parse_wsl_list(&text))
    }

    fn decode_utf16le(bytes: &[u8]) -> String {
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

    fn parse_wsl_list(text: &str) -> Vec<(String, WslDistroState, u8, bool)> {
        let mut results = Vec::new();

        for line in text.lines() {
            let trimmed = line.trim_start();
            if trimmed.is_empty() {
                continue;
            }

            let (is_default, rest) = if let Some(stripped) = trimmed.strip_prefix('*') {
                (true, stripped.trim_start())
            } else {
                (false, trimmed)
            };

            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() < 3 {
                continue;
            }

            let name = parts[0].to_string();
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

    async fn get_default_user(wsl_path: &Path, distro_name: &str) -> Option<String> {
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
            assert!(result[0].3);
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
            let bytes: Vec<u8> = vec![0x48, 0x00, 0x69, 0x00];
            assert_eq!(decode_utf16le(&bytes), "Hi");
        }

        #[test]
        fn decode_utf16le_with_bom() {
            let bytes: Vec<u8> = vec![0xFF, 0xFE, 0x48, 0x00, 0x69, 0x00];
            assert_eq!(decode_utf16le(&bytes), "Hi");
        }
    }
}

#[cfg(target_os = "windows")]
pub use inner::{discover, ensure_directory_exists, resolve_default_distro};

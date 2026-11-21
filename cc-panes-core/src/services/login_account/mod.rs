//! 五个 CLI 的登录账号：建目录、链接共享文件、生成登录命令、查登录状态、删除。
//!
//! 一个登录账号 = 一个独立目录 + 该 CLI 认的目录变量。目录由 CC-Panes 建在自己的
//! 数据目录下（`<数据目录>/login-accounts/<账号 id>`），用户不需要知道路径。
//! 机器上原有的那套登录（CLI 的默认目录）表现为合成的「默认登录」：不建目录、不带目录变量。
//!
//! CC-Panes 不读、不存登录凭据本身，只知道「这个账号对应哪个目录」。

mod layout;
mod links;
mod status;
#[cfg(test)]
mod tests;

pub use layout::{layout_for, LoginCliLayout};
pub use links::{SharedEntryOutcome, SharedEntryState};
pub use status::{
    claude_keychain_service, codex_keychain_account, KeychainProbe, LoginAccountStatus, LoginState,
    SystemKeychainProbe, CODEX_KEYCHAIN_SERVICE,
};

use crate::models::provider::{
    login_isolation_env, AccountKind, Provider, ProviderAccount, DEFAULT_LOGIN_ACCOUNT_ID,
    DEFAULT_LOGIN_ACCOUNT_NAME,
};
use crate::services::ProviderService;
use crate::utils::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

/// 账号目录根在数据目录下的名字。
pub const LOGIN_ACCOUNTS_DIR_NAME: &str = "login-accounts";

/// 账号目录里的标记文件：证明这个目录是 CC-Panes 建的，删除目录前要核对它。
pub const ACCOUNT_MARKER_FILE: &str = ".ccpanes-login-account.json";

/// 宿主环境：主目录、进程里已有的目录变量、钥匙串探测、可执行文件解析。测试里可替换。
#[derive(Clone)]
pub struct LoginHost {
    pub home: Option<PathBuf>,
    /// 进程环境里已经设了的目录变量（变量名 → 目录）。设了的话它就是该 CLI 的「默认目录」。
    pub dir_env: HashMap<String, PathBuf>,
    pub keychain: Arc<dyn KeychainProbe>,
    /// 把可执行文件名解析成路径；找不到返回 `None`（登录命令退回裸名字）。
    pub resolve_executable: fn(&str) -> Option<PathBuf>,
}

impl LoginHost {
    /// 真实环境。
    pub fn system() -> Self {
        let dir_env = crate::models::provider::LOGIN_CLI_TOOLS
            .iter()
            .filter_map(|cli| layout_for(cli))
            .filter_map(|layout| {
                std::env::var_os(layout.dir_env_var)
                    .filter(|value| !value.is_empty())
                    .map(|value| (layout.dir_env_var.to_string(), PathBuf::from(value)))
            })
            .collect();
        Self {
            home: dirs::home_dir(),
            dir_env,
            keychain: Arc::new(SystemKeychainProbe),
            resolve_executable: |name| cc_cli_adapters::resolve_executable(name).ok(),
        }
    }

    fn default_dir(&self, layout: &LoginCliLayout) -> Option<PathBuf> {
        let env_dir = self.dir_env.get(layout.dir_env_var).map(PathBuf::as_path);
        match (env_dir, self.home.as_deref()) {
            (Some(dir), _) => Some(dir.to_path_buf()),
            (None, Some(home)) => Some(layout.default_dir(home, None)),
            (None, None) => None,
        }
    }
}

/// 新建登录账号的输入。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLoginAccountRequest {
    pub cli_tool: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}

/// 给界面的一个登录账号。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginAccountView {
    pub provider_id: String,
    pub account_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub cli_tool: String,
    /// 合成的「默认登录」（CLI 的默认目录）。不能删除，也没有目录变量。
    pub is_default_login: bool,
    /// 账号目录；默认登录为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    /// 目录是 CC-Panes 自己建的（在账号目录根下且带标记）：只有这种目录可以随账号一起删。
    pub dir_managed: bool,
    pub dir_exists: bool,
    pub status: LoginAccountStatus,
}

/// 要在终端里执行的登录命令。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginCommand {
    pub cli_tool: String,
    pub command: String,
    pub args: Vec<String>,
    /// 要加的环境变量（目录变量等）。
    pub env: HashMap<String, String>,
    /// 要从继承环境里去掉的变量（否则 CLI 会跳过登录直接用它们）。
    pub env_remove: Vec<String>,
    /// 这个 CLI 没有单独的登录命令：命令启动的是 CLI 本身，用户要在里面选登录方式。
    pub interactive: bool,
    /// `command` 是否已解析成本机上的可执行文件路径（`false` = 没找到，返回的是裸名字）。
    pub executable_found: bool,
}

/// 删除账号的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAccountOutcome {
    pub account_id: String,
    /// 被删账号原来的目录（登录账号才有）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    pub dir_deleted: bool,
    /// 要求删目录却没删时的原因码：`external_dir`（不是 CC-Panes 建的）、
    /// `dir_missing`、`remove_failed`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir_kept_reason: Option<String>,
}

/// 一个登录账号的会话转录目录（会话索引 / 用量统计扫描用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginAccountRoot {
    pub cli_tool: String,
    pub provider_id: String,
    pub account_id: String,
    pub account_name: String,
    /// 账号目录（目录变量指向的那一层）。
    pub dir: PathBuf,
    /// 转录目录（Claude 的 `projects`、Codex 的 `sessions`）。
    pub transcript_dir: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountMarker {
    schema: u32,
    account_id: String,
    provider_id: String,
    cli_tool: String,
    created_at: String,
}

fn coded(code: &str, message: String, params: &[(&str, &str)]) -> AppError {
    AppError::coded_with_params(
        code,
        message,
        params
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect(),
    )
}

pub struct LoginAccountService {
    providers: Arc<ProviderService>,
    /// 账号目录根：`<数据目录>/login-accounts`。
    root: PathBuf,
    host: LoginHost,
}

impl LoginAccountService {
    pub fn new(providers: Arc<ProviderService>, root: PathBuf) -> Self {
        Self::with_host(providers, root, LoginHost::system())
    }

    /// 账号目录根取供应商配置文件所在的数据目录（与 `AppPaths::login_accounts_dir` 一致）。
    pub fn for_provider_service(providers: Arc<ProviderService>) -> Self {
        let root = providers
            .config_path()
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(LOGIN_ACCOUNTS_DIR_NAME);
        Self::new(providers, root)
    }

    pub fn with_host(providers: Arc<ProviderService>, root: PathBuf, host: LoginHost) -> Self {
        Self {
            providers,
            root,
            host,
        }
    }

    pub fn accounts_root(&self) -> &Path {
        &self.root
    }

    fn provider(&self, provider_id: &str) -> AppResult<Provider> {
        self.providers.get_provider(provider_id).ok_or_else(|| {
            coded(
                "PROVIDER_NOT_FOUND",
                format!("Provider '{provider_id}' was not found"),
                &[("providerId", provider_id)],
            )
        })
    }

    fn layout(cli_tool: &str) -> AppResult<&'static LoginCliLayout> {
        layout_for(cli_tool).ok_or_else(|| {
            coded(
                "LOGIN_ACCOUNT_CLI_UNSUPPORTED",
                format!("CLI '{cli_tool}' does not support login accounts"),
                &[("cliTool", cli_tool)],
            )
        })
    }

    /// 取一个登录账号（认得合成的默认登录）。`cli_tool` 只在默认登录时需要。
    fn login_account(
        provider: &Provider,
        account_id: &str,
        cli_tool: Option<&str>,
    ) -> AppResult<ProviderAccount> {
        let not_found = || {
            coded(
                "PROVIDER_ACCOUNT_NOT_FOUND",
                format!(
                    "Account '{account_id}' was not found on Provider '{}'",
                    provider.id
                ),
                &[("providerId", &provider.id), ("accountId", account_id)],
            )
        };
        let account = if account_id == DEFAULT_LOGIN_ACCOUNT_ID {
            let cli_tool = cli_tool
                .or_else(|| provider.login_cli_tools().first().copied())
                .ok_or_else(not_found)?;
            provider
                .resolve_account(Some(account_id), cli_tool)
                .ok_or_else(not_found)?
                .into_owned()
        } else {
            provider
                .account(Some(account_id))
                .ok_or_else(not_found)?
                .clone()
        };
        if account.kind != AccountKind::Login {
            return Err(coded(
                "PROVIDER_ACCOUNT_NOT_LOGIN",
                format!("Account '{account_id}' is not a login account"),
                &[("providerId", &provider.id), ("accountId", account_id)],
            ));
        }
        Ok(account)
    }

    /// 新建登录账号：在账号目录根下建一个目录、把默认目录里的设置 / 技能 / 指令文件链接
    /// 进来、登记到供应商下。目录名就是账号 id（`<cli>-<随机十六进制>`），不含用户输入。
    pub fn create_login_account(
        &self,
        provider_id: &str,
        request: CreateLoginAccountRequest,
    ) -> AppResult<LoginAccountView> {
        let provider = self.provider(provider_id)?;
        let cli_tool = request.cli_tool.trim();
        let layout = Self::layout(cli_tool)?;
        if !provider.login_cli_tools().contains(&cli_tool) {
            return Err(coded(
                "LOGIN_ACCOUNT_CLI_INCOMPATIBLE",
                format!(
                    "Provider '{provider_id}' cannot host a login account for CLI '{cli_tool}'"
                ),
                &[("providerId", provider_id), ("cliTool", cli_tool)],
            ));
        }
        // 先查重名，免得建了目录才发现登记不上。
        ProviderService::ensure_account_name_available(&provider, &request.name)?;

        let (account_id, dir) = self.allocate_dir(cli_tool)?;
        if let Err(error) = Self::write_marker(&dir, &account_id, provider_id, cli_tool) {
            let _ = fs::remove_dir_all(&dir);
            return Err(error);
        }
        self.sync_links(layout, &dir);

        let account = ProviderAccount {
            id: account_id.clone(),
            name: request.name.trim().to_string(),
            color: request.color,
            kind: AccountKind::Login,
            cli_tool: Some(cli_tool.to_string()),
            config_dir: Some(dir.to_string_lossy().into_owned()),
            ..ProviderAccount::default()
        };
        let provider = match self.providers.add_account(provider_id, account) {
            Ok(provider) => provider,
            Err(error) => {
                // 登记失败：刚建的目录里只有标记和链接，收回去，不留孤儿目录。
                let _ = fs::remove_dir_all(&dir);
                return Err(AppError::from(error));
            }
        };
        let account = provider
            .account(Some(&account_id))
            .cloned()
            .ok_or_else(|| AppError::from("created login account disappeared".to_string()))?;
        Ok(self.view(&provider, &account))
    }

    fn write_marker(
        dir: &Path,
        account_id: &str,
        provider_id: &str,
        cli_tool: &str,
    ) -> AppResult<()> {
        let marker = AccountMarker {
            schema: 1,
            account_id: account_id.to_string(),
            provider_id: provider_id.to_string(),
            cli_tool: cli_tool.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let bytes = serde_json::to_vec_pretty(&marker)
            .map_err(|error| AppError::from(error.to_string()))?;
        fs::write(dir.join(ACCOUNT_MARKER_FILE), bytes)?;
        Ok(())
    }

    /// 分配一个还不存在的账号目录。`create_dir`（不是 `create_dir_all`）保证目录是这次新建的。
    fn allocate_dir(&self, cli_tool: &str) -> AppResult<(String, PathBuf)> {
        fs::create_dir_all(&self.root)?;
        for _ in 0..8 {
            let suffix = Uuid::new_v4().simple().to_string();
            let account_id = format!("{cli_tool}-{}", &suffix[..12]);
            let dir = self.root.join(&account_id);
            match fs::create_dir(&dir) {
                Ok(()) => return Ok((account_id, dir)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(AppError::from(error)),
            }
        }
        Err(AppError::coded(
            "LOGIN_ACCOUNT_DIR_UNAVAILABLE",
            "Could not allocate a directory for the login account",
        ))
    }

    fn sync_links(&self, layout: &LoginCliLayout, dir: &Path) -> Vec<SharedEntryState> {
        match self.host.default_dir(layout) {
            Some(default_dir) => links::sync_shared_entries(layout, &default_dir, dir),
            None => Vec::new(),
        }
    }

    /// 启动前补一遍链接（默认目录里后来才出现的文件）。只动 CC-Panes 自己建的目录；
    /// 用户手填的外部目录一概不碰。
    pub fn refresh_links_for_launch(&self, cli_tool: &str, config_dir: &str) {
        let dir = Path::new(config_dir);
        let Some(layout) = layout_for(cli_tool) else {
            return;
        };
        if self.is_managed_dir(dir) {
            self.sync_links(layout, dir);
        }
    }

    /// 这条供应商下的登录账号：每个能在它下面登录的 CLI 一个合成的「默认登录」，
    /// 加上用户建的登录账号。
    pub fn list_login_accounts(&self, provider_id: &str) -> AppResult<Vec<LoginAccountView>> {
        let provider = self.provider(provider_id)?;
        let mut views: Vec<LoginAccountView> = provider
            .login_cli_tools()
            .iter()
            .filter_map(|cli| ProviderAccount::default_login_for(cli))
            .map(|account| self.view(&provider, &account))
            .collect();
        views.extend(
            provider
                .accounts
                .iter()
                .filter(|account| account.kind == AccountKind::Login)
                .map(|account| self.view(&provider, account)),
        );
        Ok(views)
    }

    fn view(&self, provider: &Provider, account: &ProviderAccount) -> LoginAccountView {
        let cli_tool = account.cli_tool.clone().unwrap_or_default();
        let dir = account.login_dir().map(PathBuf::from);
        LoginAccountView {
            provider_id: provider.id.clone(),
            account_id: account.id.clone(),
            name: if account.is_default_login() {
                DEFAULT_LOGIN_ACCOUNT_NAME.to_string()
            } else {
                account.name.clone()
            },
            color: account.color.clone(),
            is_default_login: account.is_default_login(),
            config_dir: account.login_dir().map(str::to_string),
            dir_managed: dir.as_deref().is_some_and(|dir| self.is_managed_dir(dir)),
            dir_exists: dir.as_deref().is_some_and(Path::is_dir),
            status: self.status_for(&cli_tool, dir.as_deref()),
            cli_tool,
        }
    }

    fn status_for(&self, cli_tool: &str, dir: Option<&Path>) -> LoginAccountStatus {
        let Some(layout) = layout_for(cli_tool) else {
            return LoginAccountStatus::unknown("unsupported_cli");
        };
        let (Some(default_dir), Some(home)) = (self.host.default_dir(layout), &self.host.home)
        else {
            return LoginAccountStatus::unknown("home_unavailable");
        };
        // 进程环境里本来就设了目录变量时，「默认登录」用的也是一个显式目录。
        let explicit = dir
            .map(Path::to_path_buf)
            .or_else(|| self.host.dir_env.get(layout.dir_env_var).cloned());
        status::login_status(
            layout,
            explicit.as_deref(),
            &default_dir,
            home,
            self.host.keychain.as_ref(),
        )
    }

    /// 查询某个登录账号是否已登录、是哪个号。`cli_tool` 只在查默认登录时需要。
    pub fn login_status(
        &self,
        provider_id: &str,
        account_id: &str,
        cli_tool: Option<&str>,
    ) -> AppResult<LoginAccountStatus> {
        let provider = self.provider(provider_id)?;
        let account = Self::login_account(&provider, account_id, cli_tool)?;
        Ok(self.status_for(
            account.cli_tool.as_deref().unwrap_or_default(),
            account.login_dir().map(Path::new),
        ))
    }

    /// 为某个登录账号生成登录命令（界面拿它开一个终端标签）。
    ///
    /// `executable_override` 按 CLI id 返回用户在设置里给它配的启动命令（没配返回 `None`）。
    pub fn login_command(
        &self,
        provider_id: &str,
        account_id: &str,
        cli_tool: Option<&str>,
        executable_override: &dyn Fn(&str) -> Option<String>,
    ) -> AppResult<LoginCommand> {
        let provider = self.provider(provider_id)?;
        let account = Self::login_account(&provider, account_id, cli_tool)?;
        let cli_tool = account.cli_tool.as_deref().unwrap_or_default();
        let layout = Self::layout(cli_tool)?;

        let mut env = HashMap::new();
        if let Some(dir) = account.login_dir() {
            // 目录可能被用户删过：登录前补回来（只补 CC-Panes 自己的目录）。
            let path = Path::new(dir);
            if !path.exists() && path.parent() == Some(self.root.as_path()) {
                fs::create_dir_all(path)?;
                Self::write_marker(path, &account.id, provider_id, cli_tool)?;
            }
            self.refresh_links_for_launch(cli_tool, dir);
            env.insert(layout.dir_env_var.to_string(), dir.to_string());
            if let Some((name, value)) = login_isolation_env(cli_tool) {
                env.insert(name.to_string(), value.to_string());
            }
        }

        let (args, interactive, env_remove): (&[&str], bool, &[&str]) = match cli_tool {
            "claude" => (
                &["auth", "login"],
                false,
                &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
            ),
            "codex" => (&["login"], false, &[]),
            // Gemini CLI 没有单独的登录命令：启动它，首次运行会让选登录方式
            // （已经选过的话在里面输入 `/auth`）。继承来的 API key 会让它跳过登录。
            "gemini" => (
                &[],
                true,
                &[
                    "GEMINI_API_KEY",
                    "GOOGLE_API_KEY",
                    "GOOGLE_GENAI_USE_VERTEXAI",
                    "GOOGLE_GENAI_USE_GCA",
                ],
            ),
            "antigravity" => (&["--login"], false, &["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
            "grok" => (&["login"], false, &["XAI_API_KEY"]),
            _ => (&[], true, &[]),
        };

        let override_command = executable_override(cli_tool)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let (command, executable_found) = match override_command {
            Some(command) => (command, true),
            None => match (self.host.resolve_executable)(layout.executable) {
                Some(path) => (path.to_string_lossy().into_owned(), true),
                None => (layout.executable.to_string(), false),
            },
        };
        Ok(LoginCommand {
            cli_tool: cli_tool.to_string(),
            command,
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            env,
            env_remove: env_remove.iter().map(|key| (*key).to_string()).collect(),
            interactive,
            executable_found,
        })
    }

    /// 目录是不是 CC-Panes 自己建的：规范化后是账号目录根的**直接子目录**，且带标记文件。
    /// 软链接指出去的、根目录本身、更深层的路径都不算。
    pub fn is_managed_dir(&self, dir: &Path) -> bool {
        let (Ok(root), Ok(real)) = (fs::canonicalize(&self.root), fs::canonicalize(dir)) else {
            return false;
        };
        real.parent() == Some(root.as_path())
            && real.is_dir()
            && fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_dir())
            && real.join(ACCOUNT_MARKER_FILE).is_file()
    }

    /// 删除账号。目录默认保留；`delete_dir = true` 时同时删目录，但只删 CC-Panes 自己建的
    /// ——用户手填的外部目录永不删除。默认登录不能删。
    pub fn delete_account(
        &self,
        provider_id: &str,
        account_id: &str,
        delete_dir: bool,
    ) -> AppResult<DeleteAccountOutcome> {
        if account_id == DEFAULT_LOGIN_ACCOUNT_ID {
            return Err(coded(
                "LOGIN_ACCOUNT_DEFAULT_UNDELETABLE",
                "The default login cannot be deleted".to_string(),
                &[("providerId", provider_id), ("accountId", account_id)],
            ));
        }
        let removed = self
            .providers
            .remove_account(provider_id, account_id)
            .map_err(AppError::from)?;
        let config_dir = removed.login_dir().map(str::to_string);
        let mut outcome = DeleteAccountOutcome {
            account_id: removed.id.clone(),
            config_dir: config_dir.clone(),
            dir_deleted: false,
            dir_kept_reason: None,
        };
        let (true, Some(dir)) = (delete_dir, config_dir) else {
            return Ok(outcome);
        };
        let dir = PathBuf::from(dir);
        if !dir.exists() {
            outcome.dir_kept_reason = Some("dir_missing".to_string());
        } else if !self.is_managed_dir(&dir) || self.marker_account_id(&dir) != Some(removed.id) {
            outcome.dir_kept_reason = Some("external_dir".to_string());
        } else {
            // `remove_dir_all` 不跟随链接：共享条目只删链接本身，默认目录里的原件不受影响。
            match fs::remove_dir_all(&dir) {
                Ok(()) => outcome.dir_deleted = true,
                Err(error) => {
                    tracing::warn!(dir = %dir.display(), error = %error, "login account: failed to delete the account directory");
                    outcome.dir_kept_reason = Some("remove_failed".to_string());
                }
            }
        }
        Ok(outcome)
    }

    fn marker_account_id(&self, dir: &Path) -> Option<String> {
        let bytes = fs::read(dir.join(ACCOUNT_MARKER_FILE)).ok()?;
        serde_json::from_slice::<AccountMarker>(&bytes)
            .ok()
            .map(|marker| marker.account_id)
    }

    /// 所有登录账号的会话转录目录（会话索引、用量统计扫描用）。只含有转录解析器的 CLI
    /// （Claude、Codex），且目录已存在的账号。
    pub fn account_roots(&self) -> Vec<LoginAccountRoot> {
        login_account_roots(&self.providers.list_providers())
    }
}

/// 见 [`LoginAccountService::account_roots`]。不依赖账号目录根，外部手填目录的账号也算。
pub fn login_account_roots(providers: &[Provider]) -> Vec<LoginAccountRoot> {
    let mut roots = Vec::new();
    for provider in providers {
        for account in &provider.accounts {
            let (Some(dir), Some(cli_tool)) = (account.login_dir(), account.cli_tool.as_deref())
            else {
                continue;
            };
            let dir = PathBuf::from(dir);
            let Some(transcript_dir) = layout_for(cli_tool)
                .and_then(|layout| layout.transcript_dir(&dir))
                .filter(|_| dir.is_dir())
            else {
                continue;
            };
            roots.push(LoginAccountRoot {
                cli_tool: cli_tool.to_string(),
                provider_id: provider.id.clone(),
                account_id: account.id.clone(),
                account_name: account.name.clone(),
                dir,
                transcript_dir,
            });
        }
    }
    roots
}

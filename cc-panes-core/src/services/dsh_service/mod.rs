//! DeepSeek Harness（dsh）实例托管服务
//!
//! 负责每标签一个 `dsh web` 进程的启停、端口回读与注入材料生成。
//! 形态背景与 `$DSH_HOME` 隔离的硬约束见 `models::dsh`。

mod hooks;
mod provider_mapping;

use crate::models::dsh::{DshInstance, DshLaunchSpec};
use crate::models::provider::Provider;
use crate::utils::{no_window_command, AppPaths};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{debug, info, warn};

/// 等待 dsh 打印启动 URL 的上限。实测冷启动 <10s（含 profile 首次初始化）。
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

/// SIGTERM 之后等它自己收摊的时长。dsh 给插件树 5 秒 dispose，留一点余量。
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(7);

/// 注入行的 id 前缀。用同一前缀是为了让 `--dump-config` 里我们插的行一眼可辨，
/// 也便于将来做「只清理我们自己插的行」。
const CCPANES_MCP_ROW_ID: &str = "ccpanes-mcp";
const CCPANES_SKILLS_ROW_ID: &str = "ccpanes-skills";
const CCPANES_HOOKS_ROW_ID: &str = "ccpanes-hooks";

/// hooks 桥需要的包，按依赖顺序。
///
/// 两个都必需：桥本身、以及它 import 的 `dsh-hook-protocol`（在 peer 列表里
/// 但 pnpm 不会自动装）。缺任何一个都是 `ERR_MODULE_NOT_FOUND` 导致进程启动失败。
const HOOK_BRIDGE_PACKAGES: &[&str] = &[
    "@deepseek-ai/dsh-hooks-claude-code",
    "@deepseek-ai/dsh-hook-protocol",
];

/// dsh 子进程的工作目录。**绝不继承宿主 cwd**。
///
/// dsh 把调用目录当默认工作空间根。继承来的 cwd 是宿主进程的——而 `tauri dev`
/// 从 `src-tauri/` 执行 `cargo run`，于是 dev 下 dsh 的工作空间根变成 `src-tauri`，
/// 恰好是 tauri dev watcher 盯着的目录。实测打开一次 DSH 标签就在 src-tauri 全树
/// 激起 415 个 FS 事件，watcher 判为「文件变了」直接杀进程重建，表现为「一打开
/// 页面就闪退重启」。日志报的是 `build.rs changed`，但那只是目录遍历的第一个
/// 条目（tauri-cli 取 `paths.first()` 打日志），与 build.rs 本身无关——这条误导
/// 曾让排查跑偏很久。
///
/// 与 `spawn_pty` 对无效 cwd 的处理是同一条规矩（见 CLAUDE.md 的 portable-pty
/// gotcha）：静默回退到一个「看着合理」的目录，会让进程在错误的地方干活且无人
/// 察觉。这里宁可落到 `$DSH_HOME` 也不继承。
fn resolve_launch_cwd(spec: &DshLaunchSpec, home: &Path) -> PathBuf {
    let usable = |dir: &String| -> Option<PathBuf> {
        let path = Path::new(dir);
        if path.is_dir() {
            Some(path.to_path_buf())
        } else {
            warn!(dir = %dir, "dsh launch dir is not a directory, skipping");
            None
        }
    };

    if let Some(dir) = spec.project_dir.as_ref().and_then(usable) {
        return dir;
    }
    if let Some(dir) = spec.workspace_path.as_ref().and_then(usable) {
        return dir;
    }

    // `$DSH_HOME` 一定存在（`write_launch_materials` 已建好）且在仓库之外，
    // 是这里唯一安全的兜底。降级必须可见，否则用户只会看到「dsh 的工作空间根
    // 莫名其妙」而无从查起。
    warn!(
        dsh_home = %home.display(),
        "dsh has no usable project_dir or workspace_path; falling back to $DSH_HOME as cwd"
    );
    home.to_path_buf()
}

/// 某个插件包在 profile 里的落点。`dsh plugin add` 经 pnpm 装到这里。
fn hook_package_dir(home: &Path, package: &str) -> PathBuf {
    let mut dir = home.join("profiles").join("web").join("node_modules");
    for segment in package.split('/') {
        dir = dir.join(segment);
    }
    dir
}

struct DshRuntime {
    child: Child,
    instance: DshInstance,
    /// 正在看着这个实例的标签。空了才真停进程。
    ///
    /// 一个工作空间一个实例、多个标签共享——所以停止必须按引用计数，
    /// 否则关掉两个标签中的一个就会把另一个的画面掐掉。
    tabs: std::collections::HashSet<String>,
}

pub struct DshService {
    /// 所有实例的 `$DSH_HOME` 根：`<data_dir>/dsh/<workspaceKey>/`
    root: PathBuf,
    /// dsh 可执行文件（`dsh` / `dsh.cmd`），None 表示尚未解析
    executable: Mutex<Option<PathBuf>>,
    /// workspaceKey → 运行时。**键是工作空间不是标签**：同一工作空间的多个
    /// 标签复用一个实例，于是 API key（`$DSH_HOME/.credentials.yaml`）、
    /// 工作区注册与会话历史都按工作空间共享——每标签一个实例时这三样
    /// 全都跟着标签走，用户每开一个新标签就要重填一次 key。
    running: Mutex<HashMap<String, DshRuntime>>,
    /// workspaceKey → 启动闸门。**同一工作空间的启动必须串行**。
    ///
    /// 只靠 `running` 的锁不够：那把锁在「查到没有实例」之后就释放了，spawn
    /// 与回填是无锁段。两个标签同时开会双双查空、各起一个进程，于是同一个
    /// `$DSH_HOME` 被两个进程持有——正是 `storage-json` 单写者模型最怕的场景
    /// （静默丢数据，见 `models::dsh` 的粒度说明）。实测复现：同一秒两条
    /// `dsh instance started workspace_key=default`，端口 52756 与 52758。
    ///
    /// 用独立的锁表而非扩大 `running` 的持锁范围：spawn 要等 dsh 打印监听地址
    /// （冷启动可达数秒），期间若占着 `running` 的锁，`list`/`get`/`stop` 全被堵住。
    starting: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

/// 把工作空间路径折成一个稳定、可作目录名的键。
///
/// 同一路径必须恒等映射（否则同一工作空间会开出两个实例，退化回每标签一个），
/// 因此先做大小写与分隔符归一，再取哈希前 16 位；保留一段可读前缀方便排障。
fn workspace_key(workspace_path: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    let Some(raw) = workspace_path.filter(|p| !p.trim().is_empty()) else {
        // 没有工作空间的标签共用一个 "default" 实例，而不是各开各的：
        // 否则「未归属工作空间」这一类标签又退化成每标签一个实例。
        return "default".to_string();
    };
    // 顺序要紧：先统一分隔符、再削尾、最后小写。`trim_end_matches` 必须在
    // 分隔符归一**之后**，否则 `...\cc-book`（尾部反斜杠已成 `/`）与
    // `...cc-book/` 会算出两个哈希——同一工作空间被劈成两个实例。
    let normalized = raw.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/').to_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    let hash = digest
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let label: String = normalized
        .rsplit('/')
        .find(|seg| !seg.is_empty())
        .unwrap_or("ws")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(24)
        .collect();
    if label.is_empty() {
        hash
    } else {
        format!("{label}-{hash}")
    }
}

impl DshService {
    pub fn new(app_paths: &AppPaths) -> Self {
        Self {
            root: app_paths.data_dir().join("dsh"),
            executable: Mutex::new(None),
            running: Mutex::new(HashMap::new()),
            starting: Mutex::new(HashMap::new()),
        }
    }

    /// 该工作空间独占的 `$DSH_HOME`。
    fn home_for(&self, workspace_key: &str) -> PathBuf {
        self.root.join(workspace_key)
    }

    /// 把 CC-Panes 的 Provider 列表并进启动材料。
    ///
    /// 密钥进 `spec.env`（进程环境是 dsh 凭据层里最高的一层），配置里
    /// 只留引用名——细节与取舍见 `provider_mapping`。
    pub fn apply_providers(spec: &mut DshLaunchSpec, providers: &[Provider]) {
        let Some((routes, env)) = provider_mapping::build_providers(providers) else {
            return;
        };
        spec.providers = Some(routes);
        spec.env.extend(env);
    }

    /// 生成 hooks.json 并挂进启动材料。
    ///
    /// 只写 `dsh-hooks-claude-code` 桥支持的事件子集，取舍见 `hooks`。
    /// 桥在加载时解析一次 `configPath`，所以文件必须在启动前就位。
    ///
    /// 落点按 **workspace key** 而非 tabId——与 `start` 用的 `$DSH_HOME` 必须是
    /// 同一个目录。曾按 tabId 写，结果 hooks.json 落在 `dsh/tab-xxx/` 而实例跑在
    /// `dsh/<workspaceKey>/`，patch 里的 `configPath` 指向一个实例根本看不到的路径
    /// （实测：`default/` 下没有 hooks.json，文件在某个 `tab-*/` 里）。
    pub fn apply_hooks(&self, spec: &mut DshLaunchSpec, hook_binary: &Path) -> Result<(), String> {
        let home = self.home_for(&workspace_key(spec.workspace_path.as_deref()));
        std::fs::create_dir_all(&home)
            .map_err(|e| format!("failed to create dsh home {}: {e}", home.display()))?;
        let path = home.join("hooks.json");
        std::fs::write(&path, hooks::build_hooks_json(hook_binary))
            .map_err(|e| format!("failed to write dsh hooks {}: {e}", path.display()))?;
        spec.hooks_config_path = Some(path.to_string_lossy().to_string());
        Ok(())
    }

    // ========== 注入材料生成 ==========

    /// 生成 `--patch` overlay。
    ///
    /// 用 `insert`（不带 `id`）把新行追加到根层——这是 cordis loader 的插入语法，
    /// 带 `id` 的 patch 是**改已有行**，对不存在的 id 只会 warn 后跳过。
    ///
    /// 内容写成 JSON：YAML 是 JSON 超集，loader 照收，省掉一个 YAML 序列化依赖，
    /// 也避免手写 YAML 的缩进/转义坑。
    fn build_patch(spec: &DshLaunchSpec) -> String {
        let mut rows: Vec<serde_json::Value> = Vec::new();

        if let Some(url) = &spec.mcp_url {
            rows.push(serde_json::json!({
                "id": CCPANES_MCP_ROW_ID,
                "name": "@deepseek-ai/dsh-mcp-client",
                "config": {
                    "serverName": "ccpanes",
                    "transport": "streamable-http",
                    "url": url,
                },
            }));
        }

        if !spec.skill_dirs.is_empty() {
            rows.push(serde_json::json!({
                "id": CCPANES_SKILLS_ROW_ID,
                "name": "@deepseek-ai/dsh-skill-filesystem",
                "config": {
                    "providerName": "ccpanes",
                    // 只看我们给的目录，不扫用户项目里的 .dsh/.agents——
                    // 那些归 dsh 自己的默认 provider 管，我们不去抢。
                    "includeDefaultRoots": false,
                    "customSkillDirs": spec.skill_dirs,
                },
            }));
        }

        if let Some(hooks_path) = &spec.hooks_config_path {
            let mut config = serde_json::Map::new();
            config.insert("configPath".into(), hooks_path.as_str().into());
            if let Some(project_dir) = &spec.project_dir {
                config.insert("projectDir".into(), project_dir.as_str().into());
            }
            rows.push(serde_json::json!({
                "id": CCPANES_HOOKS_ROW_ID,
                "name": "@deepseek-ai/dsh-hooks-claude-code",
                "config": config,
            }));
        }

        // Provider 与上面三行形态不同：`llm-pi-ai` 是合成树里**已存在**的行，
        // 所以走「带 id 的顶层 patch」改它的 config，而不是 insert 一个新行
        // （insert 同 id 会变成两行同名路由）。这也是不碰 settings.yaml 的关键：
        // patch 层优先级高于 settings，且 patch 文件完全归我们所有。
        let mut patches: Vec<serde_json::Value> = Vec::new();
        if !rows.is_empty() {
            patches.push(serde_json::json!({ "insert": rows }));
        }
        if let Some(providers) = &spec.providers {
            patches.push(serde_json::json!({
                "id": "llm-pi-ai",
                "name": "@deepseek-ai/dsh-llm-pi-ai",
                "config": { "providers": providers },
            }));
        }

        if patches.is_empty() {
            return "[]".to_string();
        }
        serde_json::json!(patches).to_string()
    }

    /// 把注入材料写进该实例的 `$DSH_HOME`，返回 patch 文件路径。
    ///
    /// **只写我们自己的 patch 文件，绝不碰 `settings.yaml`**——那是 dsh 的
    /// 可读写状态文件（它往里存 `ui-onboarding` 之类的用户设置），整份覆盖
    /// 会让用户在 dsh UI 里改的东西下次开标签就消失。Provider 改走 patch 的
    /// `llm-pi-ai` 行（见 `build_patch`）：patch 是我们的地盘，settings 是它的。
    fn write_launch_materials(
        home: &Path,
        spec: &DshLaunchSpec,
    ) -> Result<Option<PathBuf>, String> {
        std::fs::create_dir_all(home)
            .map_err(|e| format!("failed to create dsh home {}: {e}", home.display()))?;

        let patch = Self::build_patch(spec);
        if patch == "[]" {
            return Ok(None);
        }
        let patch_path = home.join("ccpanes.patch.yml");
        std::fs::write(&patch_path, patch)
            .map_err(|e| format!("failed to write dsh patch {}: {e}", patch_path.display()))?;
        Ok(Some(patch_path))
    }

    // ========== 启动 ==========

    /// 解析 dsh 可执行文件位置。
    ///
    /// Windows 上 npm 分发的是 `.cmd` 批处理 shim，`CreateProcess` 起不来裸名，
    /// 交给 `which` 按 PATHEXT 解析。
    fn resolve_executable(&self) -> Result<PathBuf, String> {
        if let Some(cached) = self.executable.lock().unwrap().clone() {
            return Ok(cached);
        }
        let found = which::which("dsh").map_err(|_| {
            "dsh not found on PATH — install it with `npm i -g @deepseek-ai/dsh`".to_string()
        })?;
        *self.executable.lock().unwrap() = Some(found.clone());
        Ok(found)
    }

    /// 确保 hooks 桥及其 peer 依赖已装进该 profile。
    ///
    /// dsh 只把 `dsh-mcp-client` 打进了自己的依赖，hooks 桥要单独装
    /// （`dsh plugin --profile web add`，转发给 pnpm）。而它声明的 9 个 peer
    /// **不会被自动安装**，其中 `dsh-hook-protocol` 是 import 时必需的，
    /// 缺了同样崩——所以两个都要探测、都要装。
    ///
    /// 注意版本代际：实测桥是 `0.0.1-rc.5`、protocol 解析到 `0.0.1-rc.1`，
    /// 而 dsh 本体已是 `0.1.0-rc.6`。在一个每天发数版的 developer preview 上
    /// 这个组合随时可能裂，这也是本函数必须允许失败、由调用方降级的原因。
    fn ensure_hook_bridge_installed(&self, executable: &Path, home: &Path) -> Result<(), String> {
        for package in HOOK_BRIDGE_PACKAGES {
            if hook_package_dir(home, package).is_dir() {
                continue;
            }
            info!(package, "installing dsh hook bridge package");
            let output = no_window_command(executable)
                .args(["plugin", "--profile", "web", "add", package])
                .env("DSH_HOME", home)
                .output()
                .map_err(|e| format!("failed to run dsh plugin add {package}: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!(
                    "dsh plugin add {package} failed: {}",
                    stderr.trim().lines().next_back().unwrap_or("unknown error")
                ));
            }
            // pnpm 报成功不等于文件到位（版本解析失败也可能 exit 0），回读确认。
            if !hook_package_dir(home, package).is_dir() {
                return Err(format!(
                    "dsh plugin add {package} reported success but the package is absent"
                ));
            }
        }
        Ok(())
    }

    /// 启动一个实例并等它打印出监听地址。
    ///
    /// 端口用 `--port 0` 让 OS 挑，再从 stdout 的 `dsh web: http://127.0.0.1:<port>`
    /// 回读——比我们自己扫空闲端口稳（不存在「扫到之后被别人抢走」的竞态）。
    /// 同一工作空间的第二个标签**复用**已在跑的实例，只登记引用。
    pub fn start(&self, tab_id: &str, spec: &DshLaunchSpec) -> Result<DshInstance, String> {
        let key = workspace_key(spec.workspace_path.as_deref());

        // 取该工作空间的启动闸门。持有它的整段里只允许一个 spawn，
        // 但不同工作空间互不阻塞。
        let gate = {
            let mut starting = self.starting.lock().unwrap();
            starting
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _gate = gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        // 复用检查必须在闸门**之内**再做一次：等到闸门的那个调用方进来时，
        // 前一个调用方可能刚把实例建好。放在闸门外只挡得住「同时进入」，
        // 挡不住「排队等到之后仍去 spawn」。
        {
            let mut running = self.running.lock().unwrap();

            // 先查这个 tab 是不是已经挂在**别的** key 上。
            //
            // 窗格重挂载（切标签、布局变动、休眠唤醒）会让组件级的 startedRef
            // 归零并再次调用 start；若此时它的 workspacePath 解析结果变了
            // （例如上次落 "default"、这次拿到了真实工作空间），就会在新 key 下
            // 再起一个进程，而旧进程还挂在旧 key 上没人回收。先释放旧引用，
            // 让下面的常规路径去复用或新建。
            if let Some(stale_key) = running
                .iter()
                .find(|(k, rt)| *k != &key && rt.tabs.contains(tab_id))
                .map(|(k, _)| k.clone())
            {
                if let Some(entry) = running.get_mut(&stale_key) {
                    entry.tabs.remove(tab_id);
                    info!(
                        tab_id = %tab_id,
                        from = %stale_key,
                        to = %key,
                        remaining = entry.tabs.len(),
                        "dsh tab moved to another workspace instance"
                    );
                }
            }

            if let Some(existing) = running.get_mut(&key) {
                existing.tabs.insert(tab_id.to_string());
                info!(
                    tab_id = %tab_id,
                    workspace_key = %key,
                    port = existing.instance.port,
                    "reusing dsh instance for this workspace"
                );
                return Ok(existing.instance.clone());
            }
        }

        let executable = self.resolve_executable()?;
        let home = self.home_for(&key);

        // hooks 桥不在 dsh 的依赖里（只有 mcp-client 是），缺包时**整个进程
        // 起不来**——不是 hook 不生效那么轻。所以启动前先确保它在，装不上就
        // 把 hooks 行摘掉继续走：丢一个 hook 远好过这个标签完全打不开。
        let mut spec = spec.clone();
        if spec.hooks_config_path.is_some() {
            if let Err(error) = self.ensure_hook_bridge_installed(&executable, &home) {
                warn!(
                    workspace_key = %key,
                    %error,
                    "dsh hook bridge unavailable, starting without hooks"
                );
                spec.hooks_config_path = None;
            }
        }

        let patch_path = Self::write_launch_materials(&home, &spec)?;

        let mut cmd = no_window_command(&executable);
        // 启动器 flag 必须排在 app 子命令**之前**：dsh 的解析器在第一个
        // 不认识的 token 处停下，之后全部原样转交给 app。写成
        // `web --patch ...` 会让 `--patch` 落进 web app，报 unknown option。
        cmd.arg("--profile").arg("web");
        if let Some(patch) = &patch_path {
            cmd.arg("--patch").arg(patch);
        }
        cmd.arg("--port").arg("0");
        cmd.env("DSH_HOME", &home);
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }
        cmd.current_dir(resolve_launch_cwd(&spec, &home));

        // stdout 要读端口；stderr 是它唯一的诊断通道，起不来时全靠它——
        // 两个都不能 null 掉。stdin 保持继承（dsh web 不靠 stdin 活着，
        // 但也没有理由掐断它）。
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn dsh: {e}"))?;
        let pid = child.id();

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "dsh stdout unavailable".to_string())?;
        if let Some(stderr) = child.stderr.take() {
            // stderr 全程转进日志。dsh 自己声明 stdout 只走协议/URL，
            // 诊断都在 stderr，丢了就等于盲飞。
            let owner = key.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    warn!(workspace_key = %owner, "dsh stderr: {line}");
                }
            });
        }

        let (tx, rx) = mpsc::channel::<Option<u16>>();
        let owner = key.clone();
        std::thread::spawn(move || {
            let mut reported = false;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if !reported {
                    if let Some(port) = parse_startup_port(&line) {
                        reported = true;
                        let _ = tx.send(Some(port));
                        continue;
                    }
                }
                debug!(workspace_key = %owner, "dsh stdout: {line}");
            }
            if !reported {
                // stdout 关闭仍未见 URL：进程早退，别让调用方干等到超时。
                let _ = tx.send(None);
            }
        });

        let port = match rx.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Some(port)) => port,
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("dsh exited before reporting a listen address".to_string());
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "dsh did not report a listen address within {}s",
                    STARTUP_TIMEOUT.as_secs()
                ));
            }
        };

        let instance = DshInstance {
            workspace_key: key.clone(),
            port,
            pid,
            dsh_home: home.to_string_lossy().to_string(),
            url: format!("http://127.0.0.1:{port}"),
        };
        info!(workspace_key = %key, tab_id = %tab_id, port, pid, "dsh instance started");

        let mut tabs = std::collections::HashSet::new();
        tabs.insert(tab_id.to_string());

        let mut running = self.running.lock().unwrap();
        if let Some(previous) = running.remove(&key) {
            // 走到这里说明启动闸门之后仍有同 key 条目——闸门内的复用检查本该
            // 拦住，能到这里就是并发形态变了（或将来有人绕过闸门）。
            //
            // 三件事必须一起做，漏一件都是可观测的坏账：
            //   1. **继承旧引用**：直接 insert 会把旧 tabs 集合顶掉，那些标签
            //      从此不在计数里，下一次 stop 立刻把进程停掉——表现为「刚开的
            //      dsh 标签几秒后自己没了」。
            //   2. **杀掉旧进程**：被顶掉的条目再没人持有它的 Child，成为孤儿
            //      （~119MB 常驻，且仍占着同一个 $DSH_HOME）。
            //   3. **响亮记一笔**：这条路径不该发生，静默继承会让并发缺陷永远
            //      查不出来。
            let orphan_pid = previous.instance.pid;
            warn!(
                workspace_key = %key,
                orphan_pid,
                new_pid = pid,
                inherited_tabs = previous.tabs.len(),
                "replacing a live dsh instance for the same workspace; killing the orphan"
            );
            tabs.extend(previous.tabs);
            kill_tree(orphan_pid);
        }
        running.insert(
            key,
            DshRuntime {
                child,
                instance: instance.clone(),
                tabs,
            },
        );
        drop(running);
        Ok(instance)
    }

    // ========== 停止 ==========

    /// 释放一个标签对实例的引用；**最后一个标签走了才真停进程**。
    ///
    /// 一个工作空间一个实例、多标签共享，所以不能见到 close 就杀——
    /// 那会把同工作空间另一个标签正在看的画面掐掉。
    ///
    /// 真停时不能一上来就 `kill()`：portable-pty 那条教训在这里同样成立，
    /// `Child::kill` 只杀直接子进程，而 dsh 是 node 进程、可能带着 MCP stdio
    /// 子进程。优雅路径让它自己 dispose，兜底走整棵树。
    pub fn stop(&self, tab_id: &str) -> Result<bool, String> {
        let mut runtime = {
            let mut running = self.running.lock().unwrap();
            let Some(key) = running
                .iter()
                .find(|(_, rt)| rt.tabs.contains(tab_id))
                .map(|(k, _)| k.clone())
            else {
                return Ok(false);
            };
            let entry = running.get_mut(&key).expect("key came from this map");
            entry.tabs.remove(tab_id);
            if !entry.tabs.is_empty() {
                info!(
                    tab_id = %tab_id,
                    workspace_key = %key,
                    remaining = entry.tabs.len(),
                    "dsh instance still referenced by other tabs, keeping it alive"
                );
                return Ok(false);
            }
            running.remove(&key).expect("key came from this map")
        };

        let pid = runtime.instance.pid;
        let key = runtime.instance.workspace_key.clone();
        request_graceful_stop(pid);

        let deadline = std::time::Instant::now() + GRACEFUL_STOP_TIMEOUT;
        loop {
            match runtime.child.try_wait() {
                Ok(Some(_)) => {
                    info!(workspace_key = %key, pid, "dsh instance stopped gracefully");
                    return Ok(true);
                }
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(format!("failed to poll dsh process: {e}")),
            }
        }

        warn!(workspace_key = %key, pid, "dsh did not stop gracefully, killing process tree");
        kill_tree(pid);
        let _ = runtime.child.wait();
        Ok(true)
    }

    /// 当前所有托管实例。
    pub fn list(&self) -> Vec<DshInstance> {
        self.running
            .lock()
            .unwrap()
            .values()
            .map(|runtime| runtime.instance.clone())
            .collect()
    }

    /// 查某个标签当前挂在哪个实例上。
    pub fn get(&self, tab_id: &str) -> Option<DshInstance> {
        self.running
            .lock()
            .unwrap()
            .values()
            .find(|runtime| runtime.tabs.contains(tab_id))
            .map(|runtime| runtime.instance.clone())
    }
}

/// 从 dsh 的启动行里取端口。它打印的形如 `dsh web: http://127.0.0.1:31801`。
fn parse_startup_port(line: &str) -> Option<u16> {
    let idx = line.find("http://")?;
    let url = line[idx..].trim();
    let after_scheme = url.strip_prefix("http://")?;
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    authority.rsplit_once(':')?.1.parse().ok()
}

/// 请求进程自行退出（Unix 发 SIGTERM；Windows 没有等价物，留给后续树杀兜底）。
fn request_graceful_stop(pid: u32) {
    #[cfg(unix)]
    {
        // SIGTERM 是 dsh 文档里的正常停止请求，任何平面都退 0。
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        // Windows 上无法给无控制台的子进程发等价信号：既没有 SIGTERM，
        // GenerateConsoleCtrlEvent 又要求共享控制台（我们恰恰用
        // CREATE_NO_WINDOW 起的）。因此这里不做事，由调用方的超时兜底走树杀。
        let _ = pid;
    }
}

/// 杀掉整棵进程树。
fn kill_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    {
        let _ = no_window_command("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .output();
    }
    #[cfg(unix)]
    {
        unsafe {
            // 负 pid = 杀整个进程组；失败再退回单进程。
            if libc::kill(-(pid as i32) as libc::pid_t, libc::SIGKILL) != 0 {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_startup_line_dsh_actually_prints() {
        assert_eq!(
            parse_startup_port("dsh web: http://127.0.0.1:31801"),
            Some(31801)
        );
    }

    #[test]
    fn ignores_lines_without_a_url() {
        assert_eq!(parse_startup_port("booting profile web"), None);
        assert_eq!(parse_startup_port(""), None);
    }

    #[test]
    fn tolerates_trailing_path_and_whitespace() {
        assert_eq!(
            parse_startup_port("  dsh web: http://127.0.0.1:8080/  "),
            Some(8080)
        );
    }

    #[test]
    fn empty_spec_produces_no_patch_file() {
        let spec = DshLaunchSpec::default();
        assert_eq!(DshService::build_patch(&spec), "[]");
    }

    #[test]
    fn patch_uses_insert_so_rows_are_added_not_matched() {
        // 带 id 的顶层 patch 是「改已有行」，对不存在的 id 只会 warn 后跳过；
        // 插入必须走 insert。这条断言就是拦「顺手改成 id 形态」的。
        let spec = DshLaunchSpec {
            mcp_url: Some("http://127.0.0.1:5173/mcp?token=x".into()),
            ..Default::default()
        };
        let patch: serde_json::Value =
            serde_json::from_str(&DshService::build_patch(&spec)).unwrap();
        let rows = patch.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].get("id").is_none());
        let inserted = rows[0]["insert"].as_array().unwrap();
        assert_eq!(inserted[0]["id"], CCPANES_MCP_ROW_ID);
        assert_eq!(inserted[0]["name"], "@deepseek-ai/dsh-mcp-client");
        assert_eq!(inserted[0]["config"]["transport"], "streamable-http");
    }

    #[test]
    fn skill_rows_opt_out_of_default_roots() {
        // includeDefaultRoots 必须是 false：默认根会扫用户项目里的
        // .dsh/.agents，那不归我们管，混进来会让「CC-Panes 注入了哪些 skill」
        // 变得不可解释。
        let spec = DshLaunchSpec {
            skill_dirs: vec!["D:/managed/skills".into()],
            ..Default::default()
        };
        let patch: serde_json::Value =
            serde_json::from_str(&DshService::build_patch(&spec)).unwrap();
        let row = &patch[0]["insert"][0];
        assert_eq!(row["id"], CCPANES_SKILLS_ROW_ID);
        assert_eq!(row["config"]["includeDefaultRoots"], false);
        assert_eq!(row["config"]["customSkillDirs"][0], "D:/managed/skills");
    }

    #[test]
    fn hooks_row_omits_project_dir_when_absent() {
        let spec = DshLaunchSpec {
            hooks_config_path: Some("D:/managed/hooks.json".into()),
            ..Default::default()
        };
        let patch: serde_json::Value =
            serde_json::from_str(&DshService::build_patch(&spec)).unwrap();
        let config = &patch[0]["insert"][0]["config"];
        assert_eq!(config["configPath"], "D:/managed/hooks.json");
        assert!(config.get("projectDir").is_none());
    }

    #[test]
    fn hooks_and_instance_share_one_home() {
        // apply_hooks 与 start 必须落在同一个 $DSH_HOME。曾按 tabId 建 hooks 目录、
        // 按 workspace key 起实例，patch 里的 configPath 于是指向实例看不到的路径
        // （实测：default/ 下没有 hooks.json，文件在某个 tab-*/ 里）。
        let dir = std::env::temp_dir().join(format!(
            "ccpanes-dsh-home-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let service = DshService {
            root: dir.clone(),
            executable: Mutex::new(None),
            running: Mutex::new(HashMap::new()),
            starting: Mutex::new(HashMap::new()),
        };
        let mut spec = DshLaunchSpec {
            workspace_path: Some("D:/ws/demo".into()),
            ..Default::default()
        };
        service
            .apply_hooks(&mut spec, Path::new("D:/bin/hook.exe"))
            .unwrap();

        let expected_home = service.home_for(&workspace_key(spec.workspace_path.as_deref()));
        let written = PathBuf::from(spec.hooks_config_path.as_deref().unwrap());
        assert_eq!(
            written.parent().unwrap(),
            expected_home,
            "hooks.json 必须落在实例自己的 $DSH_HOME 里"
        );
        assert!(written.is_file());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn same_workspace_maps_to_one_key_regardless_of_spelling() {
        // 同一路径必须恒等映射，否则同一工作空间会开出两个实例——
        // API key 与会话历史又退化成「每个标签各一份」。
        let a = workspace_key(Some(r"D:\04_workspace_rust\cc-book"));
        let b = workspace_key(Some("d:/04_workspace_rust/cc-book/"));
        assert_eq!(a, b, "分隔符/大小写/尾斜杠差异不该分裂实例");
        assert!(a.starts_with("cc-book-"), "键应带可读前缀便于排障: {a}");
    }

    #[test]
    fn different_workspaces_do_not_collide() {
        let a = workspace_key(Some("D:/ws/alpha"));
        let b = workspace_key(Some("D:/ws/beta"));
        assert_ne!(a, b);
    }

    #[test]
    fn tabs_without_a_workspace_share_one_default_instance() {
        // 不是「各开各的」：否则未归属工作空间的标签又退化成每标签一个实例。
        assert_eq!(workspace_key(None), "default");
        assert_eq!(workspace_key(Some("   ")), "default");
    }

    #[test]
    fn launch_materials_never_touch_the_settings_file() {
        // settings.yaml 是 **dsh 自己的**可读写状态文件（它往里存
        // ui-onboarding 等用户设置）。我们曾整份覆盖它——用户在 dsh UI 里
        // 改的东西会在下次开标签时被抹掉。Provider 因此改走 patch 的
        // llm-pi-ai 行。这条测试就是那个边界的守卫。
        let dir = std::env::temp_dir().join(format!(
            "ccpanes-dsh-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.yaml");
        std::fs::write(
            &settings,
            "ui-onboarding:
  welcomeNoticeVersion: keep-me
",
        )
        .unwrap();

        let spec = DshLaunchSpec {
            providers: Some(serde_json::json!({ "acme": { "api": "openai-completions" } })),
            ..Default::default()
        };
        DshService::write_launch_materials(&dir, &spec).unwrap();

        assert_eq!(
            std::fs::read_to_string(&settings).unwrap(),
            "ui-onboarding:
  welcomeNoticeVersion: keep-me
",
            "settings.yaml 归 dsh 所有，我们不得写入"
        );
        let patch = std::fs::read_to_string(dir.join("ccpanes.patch.yml")).unwrap();
        assert!(
            patch.contains("llm-pi-ai"),
            "provider 应落在 patch 里: {patch}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn provider_patch_targets_the_existing_row_instead_of_inserting() {
        // llm-pi-ai 是合成树里**已存在**的行：insert 一个同 id 的新行会变成
        // 两条同名路由。必须走「带 id 的顶层 patch」改它。
        let spec = DshLaunchSpec {
            providers: Some(serde_json::json!({ "acme": { "api": "openai-completions" } })),
            ..Default::default()
        };
        let patch: serde_json::Value =
            serde_json::from_str(&DshService::build_patch(&spec)).unwrap();
        let rows = patch.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "llm-pi-ai");
        assert!(rows[0].get("insert").is_none(), "provider 不该走 insert");
        assert_eq!(
            rows[0]["config"]["providers"]["acme"]["api"],
            "openai-completions"
        );
    }

    #[test]
    fn dropping_hooks_leaves_the_other_injections_intact() {
        // 降级路径的形状：hooks 桥装不上时，start() 把 hooks_config_path 摘掉
        // 再生成 patch。MCP 与 skills 必须原样保留——它们零额外依赖，
        // 不该被 hooks 的失败连累。
        let mut spec = DshLaunchSpec {
            mcp_url: Some("http://127.0.0.1:1/mcp".into()),
            skill_dirs: vec!["D:/s".into()],
            hooks_config_path: Some("D:/h.json".into()),
            ..Default::default()
        };
        spec.hooks_config_path = None;
        let patch: serde_json::Value =
            serde_json::from_str(&DshService::build_patch(&spec)).unwrap();
        let inserted = patch[0]["insert"].as_array().unwrap();
        assert_eq!(inserted.len(), 2);
        assert_eq!(inserted[0]["id"], CCPANES_MCP_ROW_ID);
        assert_eq!(inserted[1]["id"], CCPANES_SKILLS_ROW_ID);
    }

    #[test]
    fn hook_packages_resolve_under_the_profile_node_modules() {
        let dir = hook_package_dir(Path::new("D:/home"), "@deepseek-ai/dsh-hooks-claude-code");
        // scope 与包名必须是两级目录，拼成一级找不到（探测恒为 false →
        // 每次启动都重装一遍）。
        assert!(
            dir.ends_with("@deepseek-ai/dsh-hooks-claude-code"),
            "{dir:?}"
        );
        assert!(dir
            .to_string_lossy()
            .replace('\\', "/")
            .contains("profiles/web/node_modules/"));
    }

    #[test]
    fn all_three_injections_share_one_insert_row() {
        let spec = DshLaunchSpec {
            mcp_url: Some("http://127.0.0.1:1/mcp".into()),
            skill_dirs: vec!["D:/s".into()],
            hooks_config_path: Some("D:/h.json".into()),
            project_dir: Some("D:/proj".into()),
            ..Default::default()
        };
        let patch: serde_json::Value =
            serde_json::from_str(&DshService::build_patch(&spec)).unwrap();
        assert_eq!(patch.as_array().unwrap().len(), 1);
        assert_eq!(patch[0]["insert"].as_array().unwrap().len(), 3);
        assert_eq!(patch[0]["insert"][2]["config"]["projectDir"], "D:/proj");
    }

    fn spec_with_dirs(project_dir: Option<&str>, workspace_path: Option<&str>) -> DshLaunchSpec {
        DshLaunchSpec {
            mcp_url: None,
            skill_dirs: Vec::new(),
            hooks_config_path: None,
            project_dir: project_dir.map(str::to_string),
            workspace_path: workspace_path.map(str::to_string),
            env: Vec::new(),
            providers: None,
        }
    }

    #[test]
    fn launch_cwd_prefers_project_dir_then_workspace() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();

        let spec = spec_with_dirs(
            Some(project.path().to_str().unwrap()),
            Some(workspace.path().to_str().unwrap()),
        );
        assert_eq!(resolve_launch_cwd(&spec, home.path()), project.path());

        // project_dir 不可用时降到 workspace_path，而不是继承宿主 cwd。
        let spec = spec_with_dirs(
            Some("D:/definitely/not/here"),
            Some(workspace.path().to_str().unwrap()),
        );
        assert_eq!(resolve_launch_cwd(&spec, home.path()), workspace.path());
    }

    /// 回归守卫：两个目录都不可用时必须落到 `$DSH_HOME`，**绝不能继承宿主 cwd**。
    ///
    /// 旧实现在这里什么都不做，于是 dsh 继承了宿主的 cwd；`tauri dev` 从
    /// `src-tauri/` 起进程，dsh 便把 `src-tauri` 当工作空间根，在 tauri watcher
    /// 盯着的目录上激起全树 FS 事件，dev 被反复杀掉重建。
    #[test]
    fn launch_cwd_never_inherits_host_cwd() {
        let home = tempfile::tempdir().unwrap();

        for spec in [
            spec_with_dirs(None, None),
            spec_with_dirs(Some("D:/definitely/not/here"), None),
            spec_with_dirs(Some("D:/nope"), Some("D:/also/nope")),
        ] {
            let cwd = resolve_launch_cwd(&spec, home.path());
            assert_eq!(
                cwd,
                home.path(),
                "无可用目录时必须落到 $DSH_HOME，而不是继承宿主 cwd"
            );
            assert_ne!(
                cwd,
                std::env::current_dir().unwrap(),
                "绝不能解析成宿主进程的 cwd"
            );
        }
    }
}

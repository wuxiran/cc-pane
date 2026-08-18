# WSL 安装配置基线

> 记录并复现一套可用的 WSL2 开发环境。以「现状即基线」为准 —— 下方数值/版本是本机 **2026-07 实测**，新机器照抄即可对齐。
>
> ⚠️ **`.wslconfig` 里的 `memory=80GB` 是本机（大内存工作站）的值，直接照抄会出事。** 必须按你自己的物理内存改，经验是给 Windows 留 ≥20%。

本文自包含：正文是安装与配置说明，附录 A / B 是可以直接发给同事的两个文件（说明书 + 一键装配脚本）。

---

## 一、当前基线（实测）

| 项 | 值 |
|---|---|
| Windows | 11（build 26200） |
| WSL | 2.7.10.0，内核 `*-microsoft-standard-WSL2` |
| 默认发行版 | **Ubuntu 24.04.1 LTS**（WSL2） |
| 另有发行版 | `docker-desktop`（Docker Desktop 装的，**勿手动删**） |
| 默认用户 | `wuxiran`，`$HOME=/home/wuxiran`，shell `/bin/bash` |
| init | **systemd 已启用**（Ubuntu 24.04 WSL 默认开，PID1=systemd，无需写 wsl.conf） |
| 盘符挂载 | `/mnt/c`、`/mnt/d`…；项目在 `/mnt/d/01_workspace_ai`（Windows 侧 `D:\01_workspace_ai`） |

工具链（**均装在用户态，`$HOME` 下，不污染系统**）：

- **Node**：`v24.14.1` via **nvm**（`~/.nvm`）；npm 11 / pnpm 10.33（corepack）
- **Rust**：`rustc/cargo 1.94` via **rustup**（`~/.rustup` + `~/.cargo`）
- **Python**：系统 `python3.12` + **uv 0.11**（`~/.local/bin/uv`）做环境/依赖
- **Docker**：`28.5` —— 走 **Docker Desktop 的 WSL 集成**（context `default`=unix socket + `desktop-linux`），**不在 Ubuntu 内单独装 dockerd**
- 其它：git 2.43、go、openjdk17、gcc13 / build-essential / make、ca-certificates / unzip

---

## 二、`.wslconfig`（关键，全局影响所有发行版）

位置：`C:\Users\<用户>\.wslconfig`

要点：

- `memory=80GB` / `swap=32GB` —— 为 ML 训练抬高动态上限（**天花板，非预留**；空闲由 `autoMemoryReclaim=dropcache` 还给 Windows）
- `networkingMode=mirrored` + `dnsTunneling` / `firewall` / `autoProxy` —— 镜像网络，**localhost 主客互通**
- `[experimental]` 的 `hostAddressLoopback=true`、`sparseVhd=true` —— 回环 + VHD 稀疏回收磁盘
- **改完必须 `wsl --shutdown` 才生效**

> `wsl --shutdown` 会终止**所有**发行版（包括 `docker-desktop`，容器全停）。执行前先 `wsl --list --running` 看清影响面。

完整内容（即附件 `wslconfig.ini`）：

```ini
; 本机当前 .wslconfig 基线(放到 C:\Users\<用户>\.wslconfig)
; 改动后必须执行:  wsl --shutdown  才生效
[wsl2]
# ML 训练需要大内存：抬高动态上限（天花板，非预留；空闲由 autoMemoryReclaim 归还 Windows）
# 按机器物理内存调整，建议给 Windows 留 ≥20%
memory=80GB
swap=32GB
# Core mirrored networking mode（镜像网络：主客 localhost 互通）
networkingMode=mirrored
dnsTunneling=true
firewall=true
autoProxy=true

[experimental]
# Allow localhost loopback between host and guest
hostAddressLoopback=true
# Keep sparse VHD and reclaim memory aggressively
sparseVhd=true
autoMemoryReclaim=dropcache

bestEffortDnsParsing=true
```

---

## 三、从零复现步骤

### 1. 装 WSL + Ubuntu（管理员 PowerShell）

```powershell
wsl --install -d Ubuntu-24.04
wsl --set-default-version 2
```

首启设用户名/密码（本机 = `wuxiran`）。

### 2. 放 `.wslconfig`

把 `wslconfig.ini` 拷到 `C:\Users\<用户>\.wslconfig`，按机器内存改 `memory` / `swap`（经验：留 ≥20% 给 Windows），然后 `wsl --shutdown`。

### 3. 验 systemd

```bash
wsl -d Ubuntu -e ps -p 1 -o comm=
```

应输出 `systemd`。若不是，写 `/etc/wsl.conf` 加：

```ini
[boot]
systemd=true
```

再 `wsl --shutdown`。

### 4. 基础包

```bash
sudo apt update && sudo apt install -y build-essential ca-certificates curl git unzip
```

### 5. 工具链（全部用户态，**别 sudo**）

```bash
# nvm + node
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh && nvm install 24 && corepack enable

# rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# uv (python)
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### 6. Docker

装 Windows 版 **Docker Desktop** → Settings → Resources → WSL Integration 勾上 Ubuntu。
**不要**在 Ubuntu 里 `apt install docker`（会和 Desktop 打架）。验证：

```bash
docker version && docker context ls
```

### 7. git 身份

当前 WSL 内 global `user.name` / `user.email` 为空，按需设：

```bash
git config --global user.name "..."
git config --global user.email "..."
```

跨 `/mnt` 编辑 Windows 侧仓库时注意换行符；纯 Linux 侧仓库保持 `core.autocrlf=false`。

---

## 四、排查

| 症状 | 原因 / 处理 |
|---|---|
| 内存被 WSL 吃满 | 确认 `autoMemoryReclaim=dropcache` 在 `[wsl2]`；必要时 `wsl --shutdown` 释放 |
| localhost 连不上主机服务 | mirrored 模式下才通；检查 `hostAddressLoopback=true` 且已 shutdown 重启 |
| `.wslconfig` 改了没生效 | 99% 是没 `wsl --shutdown` |
| Ubuntu 里找不到 `docker` | Docker Desktop 没勾 WSL Integration，或 Desktop 没启动 |

---

## 五、分发给同事（让别人得到同样配置）

**不要用整机镜像克隆**（`wsl --export` / `--import`）：本机根盘已用约 187GB（含数据/缓存），且镜像会连同 `~/.ssh` 私钥、`~/.config/gh` token、`~/.bash_history` 一起泄露。

改用**装配脚本**方案 —— 版本/配置一致，但不含数据和密钥。发这三个文件：

1. **`SETUP-for-colleagues.md`** —— 同事照着做的 4 步说明（装 WSL → 放 `.wslconfig` → 跑脚本 → 装 Docker）→ 见附录 A
2. **`bootstrap.sh`** —— 幂等装配脚本，对齐版本基线（Node 24/nvm、pnpm、rustup、uv、编译基础包），用户态安装，不硬编码任何人身份 → 见附录 B
3. **`wslconfig.ini`** —— `.wslconfig` 模板，同事按自己内存改 `memory` / `swap` → 见第二节

要升级团队基线：改 `bootstrap.sh` 顶部的 `NODE_MAJOR` / `NVM_VERSION`，重发即可。

---

## 六、注意

- **数值/版本会漂移。** 若要「更新基线」，重新实测（`wsl --version`、`wsl -l -v`、distro 内 `node/cargo/uv/docker --version`）并回写本文，别凭记忆改。
- **`.wslconfig` 是全局的**，改 `memory` 会影响 `docker-desktop` 等所有发行版。
- 分发前若坚持要用镜像克隆，必须先清 `~/.ssh`、`~/.config/gh`、`~/.docker/config.json`、`~/.*_history`、`~/.aws`（本机 `.aws` 是指向 Windows 的软链）等敏感物。

---

## 附录 A：`SETUP-for-colleagues.md`（发给同事的说明书）

````markdown
# WSL 开发环境搭建（给同事）

跟着做 4 步，装出和团队一致的 WSL 环境。约 20 分钟，主要在等下载。
**发你的这个文件夹里应有 3 个文件**：本说明、`bootstrap.sh`、`wslconfig.ini`。

> 你拿到的是「装配脚本」，不是别人的系统镜像 —— 所以不含任何人的数据/密钥，装出来是干净且版本一致的环境。

## 前置
- Windows 10 (2004+) 或 Windows 11，管理员权限。
- 建议内存 ≥16GB（`.wslconfig` 里的内存值要按你机器改）。

## 步骤

### 1. 装 WSL + Ubuntu 24.04
以**管理员**打开 PowerShell：
```powershell
wsl --install -d Ubuntu-24.04
wsl --set-default-version 2
```
按提示设 Linux 用户名/密码（自己定，记住密码，sudo 要用）。装完可能要求重启。

### 2. 放 .wslconfig
把 `wslconfig.ini` 拷成 `C:\Users\<你的Windows用户名>\.wslconfig`
（注意文件名就叫 `.wslconfig`，没有 `.ini` 后缀，前面有个点）。
用记事本打开，把 `memory` / `swap` 改成适合你机器的值：
- `memory`：物理内存的 ~75%（16GB 机 → `12GB`；32GB → `24GB`；不训练大模型可更低）。
- `swap`：按需，一般 `8GB`~`16GB`。

改完在 PowerShell 执行让它生效：
```powershell
wsl --shutdown
```

### 3. 跑装配脚本
在 PowerShell 进入 Ubuntu：`wsl`，然后（把路径换成你放 bootstrap.sh 的地方）：
```bash
cd /mnt/c/Users/<你>/Downloads      # bootstrap.sh 所在目录
bash bootstrap.sh
```
脚本自动装：Node 24（nvm）、pnpm、Rust（rustup）、uv、编译基础包。可重复跑。

### 4. Docker
装 Windows 版 **Docker Desktop**（官网下载），启动后
`Settings → Resources → WSL Integration` → 勾上 `Ubuntu-24.04`，Apply。
**不要**在 Ubuntu 里 `apt install docker`。

## 验收
重开终端，跑一遍应都有版本号：
```bash
node -v        # v24.x
pnpm -v
cargo --version
uv --version
docker version # 有 Client + Server 才算集成成功
ps -p 1 -o comm=   # 应为 systemd
```
最后设置你自己的 git 身份：
```bash
git config --global user.name "你的名字"
git config --global user.email "you@example.com"
```

## 常见问题
- **`.wslconfig` 改了没反应** → 没执行 `wsl --shutdown`。
- **docker 命令找不到** → Docker Desktop 没开，或没勾 WSL Integration。
- **脚本下载慢/失败** → 网络问题，重跑即可（幂等，装过的会跳过）。
- **ps -p 1 不是 systemd** → 脚本已帮你写 `/etc/wsl.conf`，`wsl --shutdown` 后重进再看。
````

---

## 附录 B：`bootstrap.sh`（一键装配脚本）

```bash
#!/usr/bin/env bash
# ============================================================
# WSL 开发环境一键装配 —— 对齐团队基线(Ubuntu 24.04 / WSL2)
# 在【干净的 Ubuntu 24.04 WSL】里跑:  bash bootstrap.sh
# 幂等:已装的会跳过,可反复跑。全部装在用户态,不要 sudo 整个脚本。
# ============================================================
set -euo pipefail

# —— 版本基线(与团队一致;要升级改这里) ——
NODE_MAJOR=24
NVM_VERSION="v0.40.1"

log(){ printf "\033[1;32m[bootstrap]\033[0m %s\n" "$*"; }
have(){ command -v "$1" >/dev/null 2>&1; }

# 0. 必须是 Ubuntu 24.04
if ! grep -q "24.04" /etc/os-release 2>/dev/null; then
  echo "⚠ 当前不是 Ubuntu 24.04,基线按 24.04 校准,继续可能有偏差。" >&2
fi

# 1. systemd 检查(Ubuntu24.04 WSL 默认开)
if [ "$(ps -p 1 -o comm= 2>/dev/null)" != "systemd" ]; then
  log "systemd 未启用 → 写 /etc/wsl.conf(需要 sudo),之后请在 PowerShell 执行 wsl --shutdown 再重进"
  sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
fi

# 2. apt 基础包
log "apt 基础包…"
sudo apt-get update -y
sudo apt-get install -y build-essential ca-certificates curl git unzip pkg-config

# 3. nvm + Node + corepack(pnpm)
if [ ! -d "$HOME/.nvm" ]; then
  log "安装 nvm $NVM_VERSION…"
  curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
fi
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
if ! nvm ls "$NODE_MAJOR" >/dev/null 2>&1; then
  log "安装 Node $NODE_MAJOR…"; nvm install "$NODE_MAJOR"
fi
nvm alias default "$NODE_MAJOR" >/dev/null
corepack enable 2>/dev/null || true

# 4. rustup
if ! have rustc; then
  log "安装 rustup…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi

# 5. uv(Python 环境/依赖)
if ! have uv && [ ! -x "$HOME/.local/bin/uv" ]; then
  log "安装 uv…"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

# 6. git 身份(留空则提示,不硬编码任何人)
if [ -z "$(git config --global user.name || true)" ]; then
  echo "ℹ 请设置 git 身份:  git config --global user.name '你的名字' && git config --global user.email 'you@example.com'"
fi

cat <<'DONE'

✅ 工具链装配完成。还需手动两步:
  1) .wslconfig:把随附的 wslconfig.ini 拷到 Windows 的 C:\Users\<你>\.wslconfig,
     按你机器内存改 memory/swap(给 Windows 留 ≥20%),然后在 PowerShell: wsl --shutdown
  2) Docker:安装 Windows 版 Docker Desktop → Settings → Resources → WSL Integration 勾上本发行版。
     不要在 Ubuntu 里 apt install docker。

重开终端后校验:  node -v && pnpm -v && cargo --version && uv --version && docker version
DONE
log "done."
```

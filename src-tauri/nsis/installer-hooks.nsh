; 杀掉本安装目录下的进程。`$$keepDaemon` = 1 时**放过 daemon**（更新路径专用）。
;
; 为什么更新时不能杀 daemon：PTY 会话的真身活在 daemon 里，且这里用的是
; `taskkill /F /T`——`/T` 杀整棵进程树，daemon 底下挂着的正是用户所有的 CLI 会话。
; 更新一次 = 所有在跑的 agent 全部当场消失。实测 0.11.7 更新后 18 个标签全灭
; （详见 docs/69 附注 与 docs/68 §2.5）。
;
; 卸载路径仍然全杀：那时用户就是要它们停。
!macro CCPANES_KILL_INSTALLED_PROCESSES keepDaemon
  ; Resolve exact executable paths under this install directory, then taskkill by PID.
  ; This keeps dev/release and side-by-side installs outside $INSTDIR untouched.
  System::Call 'Kernel32::SetEnvironmentVariable(t, t) i("CCPANES_INSTALL_DIR", "$INSTDIR").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t) i("CCPANES_KEEP_DAEMON", "${keepDaemon}").r0'
  nsExec::ExecToLog `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& { $$installDir = $$env:CCPANES_INSTALL_DIR; $$keep = $$env:CCPANES_KEEP_DAEMON -eq '1'; $$daemon = Join-Path $$installDir 'binaries\cc-panes-daemon.exe'; $$targets = @((Join-Path $$installDir 'cc-panes.exe'), (Join-Path $$installDir 'binaries\cc-panes-web.exe')); if (-not $$keep) { $$targets += $$daemon }; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$targets -contains $$PSItem.ExecutablePath } | ForEach-Object { $$targetPid = $$PSItem.ProcessId; & taskkill.exe /F /T /PID $$targetPid 2>$$null | Out-Null }; exit 0 }"`
  Pop $0
!macroend

; 让 NSIS 能写入 daemon.exe 而不必杀掉正在运行的那个。
;
; Windows 锁住运行中的 exe 不让覆盖（os error 32），但**允许重命名**——进程继续持有
; 旧 inode 照常跑，新文件写进原路径，下次 spawn 时才生效。这是 CLAUDE.md 记的既有手法。
;
; 残留的 .old 在这里顺带清掉：上一轮更新留下的那个此时已无人持有，可以删了。
; 删不掉（仍在跑）就跳过，不让它阻断安装。
!macro CCPANES_RENAME_DAEMON_FOR_UPDATE
  System::Call 'Kernel32::SetEnvironmentVariable(t, t) i("CCPANES_INSTALL_DIR", "$INSTDIR").r0'
  nsExec::ExecToLog `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& { $$binDir = Join-Path $$env:CCPANES_INSTALL_DIR 'binaries'; if (-not (Test-Path $$binDir)) { exit 0 }; Get-ChildItem -Path $$binDir -Filter 'cc-panes-daemon.exe.*.old' -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item $$PSItem.FullName -Force -ErrorAction SilentlyContinue }; $$daemon = Join-Path $$binDir 'cc-panes-daemon.exe'; if (Test-Path $$daemon) { $$stamp = (Get-Date).ToString('yyyyMMddHHmmss'); Rename-Item -Path $$daemon -NewName ('cc-panes-daemon.exe.' + $$stamp + '.old') -Force -ErrorAction SilentlyContinue }; exit 0 }"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; 更新路径：放过 daemon（保住用户的 PTY 会话），改名让新二进制照样能落盘。
  ; 新 daemon 何时接班交给 app 决定——它会在**没有活跃会话时**才优雅换代
  ; （src-tauri/src/services/terminal_daemon_lifecycle.rs 的 pending-upgrade 判定）。
  !insertmacro CCPANES_KILL_INSTALLED_PROCESSES 1
  !insertmacro CCPANES_RENAME_DAEMON_FOR_UPDATE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 待 Windows 实测（评审 #9）：先完成一次更新让运行中 daemon 被改名为
  ; cc-panes-daemon.exe.<stamp>.old，再直接卸载；用 Process Explorer/CIM 确认已改名
  ; 进程是否被命中，并核对 binaries 目录与其子进程树是否全部清理。本轮不猜测改漏杀逻辑。
  !insertmacro CCPANES_KILL_INSTALLED_PROCESSES 0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Passive updater and /S uninstall paths must never delete user data.
  IfSilent ccpanes_keep_user_data 0
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除应用数据（设置、工作空间、会话历史）？此操作不可恢复。" IDNO ccpanes_keep_user_data

  RMDir /r "$APPDATA\com.ccpanes.app"
  RMDir /r "$LOCALAPPDATA\com.ccpanes.app"
  RMDir /r "$PROFILE\.cc-panes"

ccpanes_keep_user_data:
!macroend

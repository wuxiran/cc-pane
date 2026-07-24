!macro CCPANES_KILL_INSTALLED_PROCESSES
  ; Resolve exact executable paths under this install directory, then taskkill by PID.
  ; This keeps dev/release and side-by-side installs outside $INSTDIR untouched.
  nsExec::ExecToLog `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& { Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { @('$INSTDIR\cc-panes.exe', '$INSTDIR\binaries\cc-panes-daemon.exe', '$INSTDIR\binaries\cc-panes-web.exe') -contains $$PSItem.ExecutablePath } | ForEach-Object { $$targetPid = $$PSItem.ProcessId; & taskkill.exe /F /T /PID $$targetPid 2>$$null | Out-Null }; exit 0 }"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CCPANES_KILL_INSTALLED_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CCPANES_KILL_INSTALLED_PROCESSES
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

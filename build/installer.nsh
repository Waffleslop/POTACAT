; POTACAT installer customization
;  - diagnostic logging (potacat-install.log next to the installer .exe)
;  - stop the Remote Launcher before the app-running check so upgrades and
;    uninstalls don't get stuck on "POTACAT cannot be closed" (K6RBJ + others)

!define LOG_FILE "$EXEDIR\potacat-install.log"

; Helper: append a line to the log file
!macro _LogWrite text
  FileOpen $9 "${LOG_FILE}" a
  StrCmp $9 "" +3
    FileWrite $9 "${text}$\r$\n"
    FileClose $9
!macroend

; Stop the Remote Launcher if it's running as a POTACAT.exe — the "POTACAT
; cannot be closed / old version won't uninstall" bug (K6RBJ + others, v1.8.12
; release notes documented it as a known issue with a Task-Manager workaround).
;
; The launcher auto-starts at logon. On a machine WITHOUT system Node it runs as
; the install-dir Electron binary with ELECTRON_RUN_AS_NODE
; (POTACAT.exe <userData>\launcher.js). Windows locks a running .exe's image
; file, so that background POTACAT.exe (a) keeps <INSTDIR>\POTACAT.exe locked and
; (b) trips electron-builder's "is the app running" check by process name — but
; it has no window, so the graceful close never lands and the installer loops on
; "cannot be closed."
;
; We stop ONLY the launcher here (Name='POTACAT.exe' AND CommandLine like
; '*launcher.js*'). The Name filter is load-bearing:
;   - the killer (powershell.exe) never matches itself, even though this command
;     line contains the literal "launcher.js";
;   - the GUI POTACAT.exe has no launcher.js in its command line, so the stock
;     app-running check still handles it gracefully (we do NOT replace that check
;     — see below);
;   - a node.exe launcher (system-Node users) isn't matched and doesn't need to
;     be — it runs from %APPDATA% and never locks INSTDIR.
!macro _KillLauncher
  nsExec::Exec `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq 'POTACAT.exe' -and $$_.CommandLine -like '*launcher.js*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  !insertmacro _LogWrite "KillLauncher: stop launcher POTACAT.exe rc=$0"
  ; Give Windows a moment to release the .exe image lock before file ops.
  Sleep 800
!macroend

; customInit runs in the installer's .onInit, BEFORE installSection's
; CHECK_APP_RUNNING. Killing the launcher here means the app-running check then
; only sees the GUI (handled gracefully) — and crucially we do NOT redefine
; customCheckAppRunning, so no electron-builder internals are touched. (A prior
; attempt re-invoked _CHECK_APP_RUNNING / IS_POWERSHELL_AVAILABLE and broke the
; NSIS build, which is why it was reverted; this approach avoids them entirely.)
!macro customInit
  !insertmacro _LogWrite "=== POTACAT Installer ==="
  !insertmacro _LogWrite "customInit: Install dir = $INSTDIR"
  !insertmacro _KillLauncher
!macroend

; customUnInit runs in the uninstaller's un.onInit. For an assisted (oneClick:
; false) uninstaller, un.checkAppRunning is deferred to the uninstall section
; (after un.onInit), so stopping the launcher here clears it before that check —
; fixing the standalone "old version won't uninstall" case too.
!macro customUnInit
  !insertmacro _LogWrite "customUnInit: stopping launcher before uninstall check"
  !insertmacro _KillLauncher
!macroend

!macro customInstall
  !insertmacro _LogWrite "customInstall: Installing to $INSTDIR"

  ; Verify the main exe was written
  IfFileExists "$INSTDIR\POTACAT.exe" 0 +3
    !insertmacro _LogWrite "customInstall: POTACAT.exe EXISTS - install appears successful"
    Goto +2
    !insertmacro _LogWrite "customInstall: WARNING - POTACAT.exe NOT FOUND after install"

  ; Register potacat:// protocol handler
  WriteRegStr HKCU "Software\Classes\potacat" "" "URL:POTACAT Protocol"
  WriteRegStr HKCU "Software\Classes\potacat" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\potacat\shell\open\command" "" '"$INSTDIR\POTACAT.exe" "%1"'
  !insertmacro _LogWrite "customInstall: Registered potacat:// protocol handler"

  !insertmacro _LogWrite "customInstall: Complete"
!macroend

!macro customUnInstall
  ; Remove potacat:// protocol handler
  DeleteRegKey HKCU "Software\Classes\potacat"
!macroend

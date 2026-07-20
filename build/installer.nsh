; POTACAT installer customization
;  - diagnostic logging (potacat-install.log next to the installer .exe)
;  - stop the Remote Launcher before the app-running check so upgrades and
;    uninstalls don't get stuck on "POTACAT cannot be closed" (K6RBJ + others)

!define LOG_FILE "$EXEDIR\potacat-install.log"

; Helper: append a line to the log file. NSIS gotcha: FileOpen "a" does NOT
; seek to the end (the pointer starts at 0, silently overwriting prior
; lines — every log before 2026-07-19 only preserved its longest/last line),
; so the FileSeek is load-bearing.
!macro _LogWrite text
  FileOpen $9 "${LOG_FILE}" a
  StrCmp $9 "" +4
    FileSeek $9 0 END
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
; HOW we stop it (rewritten 2026-07-19 after a Sophos Endpoint report): the
; original implementation always shelled out to powershell.exe with a CIM
; query. Sophos/EDR "Lockdown" policies kill any PowerShell whose process
; ancestry includes a browser (BrowserAncestorPowershell) — i.e. every user
; who runs the setup straight from their browser's download UI — and it fired
; for 100% of installs even though most users never enable the launcher.
;
; Current design, in order:
;   1. PID-file fast path — launchers ≥1.9.12 running as the Electron binary
;      advertise their PID in %APPDATA%\potacat\launcher.pid (scripts/
;      launcher.js). We terminate exactly that PID with in-process WinAPI
;      calls (OpenProcess/TerminateProcess via System.dll): no child process,
;      nothing for an EDR to block. The PID is verified to still map to a
;      POTACAT.exe image first, so a stale file after a crash (or PID reuse)
;      can't kill an innocent process. node.exe launchers don't write the
;      file — they run from %APPDATA% and never lock INSTDIR.
;   2. Legacy fallback — no PID file but POTACAT-Launcher.vbs exists in the
;      user's Startup folder (a pre-1.9.12 launcher is registered): the old
;      PowerShell CIM sweep, one last time. Its Name+CommandLine filter is
;      load-bearing (kills ONLY '*launcher.js*' POTACAT.exe; the GUI stays on
;      the stock graceful app-running check; powershell.exe never matches
;      itself). After one upgrade the new launcher writes the PID file and
;      this branch never runs again.
;   3. Nothing registered — do nothing at all. No process is spawned, so the
;      overwhelming majority of installs are invisible to EDR heuristics.
!macro _KillLauncher
  !define /redef _KLID ${__COUNTER__}
  IfFileExists "$APPDATA\potacat\launcher.pid" 0 kl_legacy_${_KLID}
    FileOpen $R0 "$APPDATA\potacat\launcher.pid" r
    StrCmp $R0 "" kl_legacy_${_KLID}
    FileRead $R0 $R1
    FileClose $R0
    IntOp $R1 $R1 + 0                       ; numeric coercion (garbage -> 0)
    IntCmp $R1 4 kl_stale_${_KLID} kl_stale_${_KLID} 0  ; require pid > 4
    ; PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
    System::Call 'kernel32::OpenProcess(i 0x00101001, i 0, i R1) i .R2'
    IntCmp $R2 0 kl_stale_${_KLID}          ; not running -> stale file
    ; PID-reuse guard: the PID must still be a POTACAT.exe image.
    System::Call 'kernel32::QueryFullProcessImageNameW(i R2, i 0, w .R3, *i ${NSIS_MAX_STRLEN}) i .R4'
    IntCmp $R4 0 kl_qfail_${_KLID}
    StrCpy $R5 $R3 "" -12                   ; last 12 chars of the image path
    StrCmp $R5 "\POTACAT.exe" 0 kl_notours_${_KLID}  ; StrCmp = case-insensitive
    System::Call 'kernel32::TerminateProcess(i R2, i 0) i .R4'
    System::Call 'kernel32::WaitForSingleObject(i R2, i 3000)'
    System::Call 'kernel32::CloseHandle(i R2)'
    Delete "$APPDATA\potacat\launcher.pid"
    !insertmacro _LogWrite "KillLauncher: terminated launcher pid=$R1 natively rc=$R4"
    Sleep 200                                ; let the image lock fully release
    Goto kl_done_${_KLID}
  kl_qfail_${_KLID}:
    ; Can't verify what the PID is — do NOT kill blind, leave the file alone.
    System::Call 'kernel32::CloseHandle(i R2)'
    !insertmacro _LogWrite "KillLauncher: could not query image for pid=$R1 - skipped (nothing killed)"
    Goto kl_done_${_KLID}
  kl_notours_${_KLID}:
    System::Call 'kernel32::CloseHandle(i R2)'
    Delete "$APPDATA\potacat\launcher.pid"   ; PID recycled by another program
    !insertmacro _LogWrite "KillLauncher: pid=$R1 is '$R3', not POTACAT.exe - stale pid file removed, nothing killed"
    Goto kl_done_${_KLID}
  kl_stale_${_KLID}:
    Delete "$APPDATA\potacat\launcher.pid"
    !insertmacro _LogWrite "KillLauncher: stale/invalid launcher.pid - launcher not running"
    Goto kl_done_${_KLID}
  kl_legacy_${_KLID}:
    ; Pre-1.9.12 launcher: only sweep if one is actually registered to
    ; auto-start; otherwise spawn nothing at all.
    IfFileExists "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\POTACAT-Launcher.vbs" 0 kl_none_${_KLID}
    nsExec::Exec `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq 'POTACAT.exe' -and $$_.CommandLine -like '*launcher.js*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $R4
    !insertmacro _LogWrite "KillLauncher: legacy PowerShell sweep rc=$R4 (pre-pid-file launcher registered)"
    ; Give Windows a moment to release the .exe image lock before file ops.
    Sleep 800
    Goto kl_done_${_KLID}
  kl_none_${_KLID}:
    !insertmacro _LogWrite "KillLauncher: no launcher registered - nothing to stop"
  kl_done_${_KLID}:
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

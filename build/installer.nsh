; =============================================================================
; Kumiko-Amadeus installer / uninstaller custom hooks.
;
; This file is referenced from package.json "nsis.include". electron-builder
; injects it into the script *before* common.nsh, MUI2.nsh and the main
; installer.nsi. That means:
;   - !define MUI_* here takes effect when MUI2.nsh later reads them.
;   - Function / Var declarations here are available to later macros.
;   - Anything that needs to override common.nsh (BrandingText,
;     ShowInstDetails, InstProgressFlags) must live inside customHeader,
;     because customHeader is inserted *after* common.nsh runs.
;
; Upstream electron-builder hook points we rely on (see assistedInstaller.nsh):
;   customHeader            - run after common.nsh, before MUI pages
;   customWelcomePage       - replaces default (none) welcome page
;   customFinishPage        - replaces default MUI_PAGE_FINISH
;   customUnWelcomePage     - replaces default MUI_UNPAGE_WELCOME
;   customInit              - run at end of .onInit
;   customInstall           - run at end of install section
;   customUnInit            - run at start of un.onInit
;   customUnInstall         - run at end of uninstall section
; =============================================================================

; -----------------------------------------------------------------------------
; Declare DPI awareness at PE manifest level.
;
; This is an NSIS attribute (affects the final .exe's manifest resource),
; not a runtime command, so it's safe to put it at include-time inside
; nsis.include. Without this, Windows 10/11 treats the installer as a
; legacy DPI-unaware app and DWM bitmap-scales the whole UI at 125%/150%/175%
; system scaling, blurring every label. With it, NSIS renders vector-crisp
; via GDI, matching Win11 native dialogs.
;
; Note: ManifestDPIAwareness PerMonitorV2 would be ideal for multi-monitor
; mixed-DPI, but requires NSIS 3.06+ while electron-builder bundles 3.0.4.1.
; System-level DPI awareness (the v1 attribute below) already eliminates
; bitmap scaling on the primary monitor, which is where installers live
; 99% of the time.
; -----------------------------------------------------------------------------

ManifestDPIAware true

!include LogicLib.nsh
; FileFunc: ${GetParent}. Used in customUnInstall to strip the basename
; off the user's custom UserDataPath (HKCU Software\KumikoAIAmadeus
; "UserDataPath") so we can clean the sibling updater-cache directory
; on a custom drive. Header is safe to include unconditionally -- NSIS
; guards the same header from being expanded twice.
!include FileFunc.nsh

; -----------------------------------------------------------------------------
; Global dialog font.
;
; Myth: !define MUI_FONT + MUI_FONTSIZE changes the installer font.
; Reality: MUI2.nsh never reads those. Every MUI page's static controls,
; buttons, edits, list boxes inherit the *NSIS dialog default font*, set by
; the top-level SetFont command. MUI's own header/title labels are created
; with CreateFont using $(^Font) from the language file - which on Win10/11
; is "MS Shell Dlg", GDI font-substituted to Segoe UI automatically. So
; SetFont alone is enough to get a uniformly modern Segoe UI look.
;
; This must live outside any !macro to execute at include time, and it
; must come before any Section / Function / Page is generated (our custom
; Functions below are still fine because SetFont is an attribute, not a
; runtime command - it's evaluated at NSIS compile time).
; -----------------------------------------------------------------------------

SetFont "Segoe UI" "9"

; MUI page background. Pure white matches Win11 FluentUI dialog surfaces.
!define MUI_BGCOLOR "FFFFFF"

; -----------------------------------------------------------------------------
; Helpers used by custom pages
; -----------------------------------------------------------------------------

!ifndef BUILD_UNINSTALLER

Var /GLOBAL PreferredInstallDrive
Var /GLOBAL SystemDrive

Function TryUsePreferredInstallDrive
  Exch $0
  Push $1

  ${If} $PreferredInstallDrive != ""
    Goto done
  ${EndIf}

  ${If} $0 == ""
  ${OrIf} $0 == $SystemDrive
    Goto done
  ${EndIf}

  System::Call 'kernel32::GetDriveType(t "$0\\") i .r1'
  ${If} $1 == 3
    StrCpy $PreferredInstallDrive $0
  ${EndIf}

  done:
    Pop $1
    Pop $0
FunctionEnd

Function SelectPreferredInstallDrive
  StrCpy $PreferredInstallDrive ""
  StrCpy $SystemDrive $WINDIR 2

  StrCpy $0 $EXEDIR 2
  StrCpy $1 $0 1 1
  ${If} $1 == ":"
    Push $0
    Call TryUsePreferredInstallDrive
  ${EndIf}

  Push "D:"
  Call TryUsePreferredInstallDrive
  Push "E:"
  Call TryUsePreferredInstallDrive
  Push "F:"
  Call TryUsePreferredInstallDrive
  Push "G:"
  Call TryUsePreferredInstallDrive
  Push "H:"
  Call TryUsePreferredInstallDrive
  Push "I:"
  Call TryUsePreferredInstallDrive
  Push "J:"
  Call TryUsePreferredInstallDrive
  Push "K:"
  Call TryUsePreferredInstallDrive
  Push "L:"
  Call TryUsePreferredInstallDrive
  Push "M:"
  Call TryUsePreferredInstallDrive
  Push "N:"
  Call TryUsePreferredInstallDrive
  Push "O:"
  Call TryUsePreferredInstallDrive
  Push "P:"
  Call TryUsePreferredInstallDrive
  Push "Q:"
  Call TryUsePreferredInstallDrive
  Push "R:"
  Call TryUsePreferredInstallDrive
  Push "S:"
  Call TryUsePreferredInstallDrive
  Push "T:"
  Call TryUsePreferredInstallDrive
  Push "U:"
  Call TryUsePreferredInstallDrive
  Push "V:"
  Call TryUsePreferredInstallDrive
  Push "W:"
  Call TryUsePreferredInstallDrive
  Push "X:"
  Call TryUsePreferredInstallDrive
  Push "Y:"
  Call TryUsePreferredInstallDrive
  Push "Z:"
  Call TryUsePreferredInstallDrive
FunctionEnd

; Opens the GitHub release page for this version in the user's default
; browser. Used from customFinishPage's "view release notes" checkbox.
;
; This can safely live at include-time because ExecShell takes no reference
; to any Var declared inside installer.nsi. StartApp by contrast needs
; $launchLink (declared only at installer.nsi L34), so it lives inside the
; customFinishPage macro body where the expansion order is correct.
Function OpenReleasePage
  ExecShell "open" "https://github.com/OgalinLabM0/Kumiko-Amadeus/releases/tag/v${VERSION}"
FunctionEnd

!endif

; -----------------------------------------------------------------------------
; customHeader - runs *after* common.nsh, so we can override its defaults
; -----------------------------------------------------------------------------

!macro customHeader
  ; Hide the details log panel by default (users still get a "Show details"
  ; button to expand it). Rationale: electron-builder extracts the app via
  ; an embedded 7z solid archive, and the 7z decompressor does not emit
  ; per-file lines into NSIS's detail window. Leaving the panel visible
  ; therefore produces a permanently empty list box under the progress bar,
  ; which reads as broken. This matches standard Windows installer behavior
  ; (Git for Windows / 7-Zip / Notepad++ default to hidden details).
  ShowInstDetails hide
  !ifdef BUILD_UNINSTALLER
    ShowUninstDetails hide
  !endif

  ; Smooth progress bar animation. Without this the bar advances in
  ; chunky integer percent jumps.
  InstProgressFlags smooth

  ; Branded footer - replaces "Nullsoft Install System vX" and the
  ; PRODUCT_NAME VERSION that common.nsh sets. Keep it short; NSIS truncates
  ; at ~60 chars on high-DPI.
  BrandingText "Kumiko·Amadeus  v${VERSION}"
!macroend

; -----------------------------------------------------------------------------
; customWelcomePage - first page users see
; -----------------------------------------------------------------------------

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Kumiko·Amadeus 安装向导"
  !define MUI_WELCOMEPAGE_TEXT "本向导将在此电脑上安装 Kumiko·Amadeus v${VERSION}。$\r$\n$\r$\n继续前，建议关闭其他正在运行的程序。$\r$\n$\r$\n安装过程中进度条会先后完成两个阶段：主程序解压，然后是收尾配置。期间看到进度条归零再继续属于正常现象。$\r$\n$\r$\n点击「下一步」继续。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; -----------------------------------------------------------------------------
; customFinishPage - last installer page, with three opt-in actions
;
; The Function StartApp is declared *inside* the macro body so its expansion
; lands in assistedInstaller.nsh (around L47 upstream), which runs after
; installer.nsi has already declared Var launchLink at L34. Declaring it at
; top-of-include in installer.nsh would reference $launchLink before the Var
; statement exists, triggering an NSIS compile error.
; -----------------------------------------------------------------------------

!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_TITLE "安装完成"
  !define MUI_FINISHPAGE_TEXT "Kumiko·Amadeus 已安装到此电脑。$\r$\n$\r$\n可以通过桌面快捷方式或开始菜单启动程序。$\r$\n$\r$\n点击「完成」关闭向导。"

  ; Option 1 - launch app on finish (checked by default).
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_FINISHPAGE_RUN_TEXT "运行 Kumiko·Amadeus"

  ; Option 2 - open the release notes on GitHub (unchecked by default).
  ; MUI requires SHOWREADME to be defined non-empty to render the checkbox,
  ; but the actual action is dispatched through SHOWREADME_FUNCTION, so the
  ; value itself is ignored at runtime.
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "查看版本更新说明"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "OpenReleasePage"

  !insertmacro MUI_PAGE_FINISH
!macroend

; -----------------------------------------------------------------------------
; customUnWelcomePage - first page of the uninstaller
; -----------------------------------------------------------------------------

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Kumiko·Amadeus 卸载向导"
  !define MUI_WELCOMEPAGE_TEXT "本向导将从此电脑上卸载 Kumiko·Amadeus。$\r$\n$\r$\n聊天记录、记忆与配置保存在独立的用户数据目录，默认保留；是否一并清理会在下一步询问。$\r$\n$\r$\n继续前请先关闭程序。点击「下一步」开始卸载。"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; -----------------------------------------------------------------------------
; customInit - drive auto-selection (existing logic, preserved)
; -----------------------------------------------------------------------------

!macro customInit
  !insertmacro GetDParameter $0
  ${If} $0 != ""
    Goto done
  ${EndIf}

  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
    Goto done
  ${EndIf}

  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
    Goto done
  ${EndIf}

  Call SelectPreferredInstallDrive
  ${If} $PreferredInstallDrive != ""
    StrCpy $INSTDIR "$PreferredInstallDrive\${APP_FILENAME}"
  ${EndIf}

  done:
!macroend

; Empty placeholders required by electron-builder's assistedInstaller hooks.
!macro customUnInstallCheck
!macroend

!macro customUnInstallCheckCurrentUser
!macroend

!macro customRemoveFiles
!macroend

; -----------------------------------------------------------------------------
; customInstall - final cleanup after main files are written
; -----------------------------------------------------------------------------

!ifndef BUILD_UNINSTALLER
!macro customInstall
  SetDetailsPrint textonly
  DetailPrint "清理旧版本缓存"
  SetDetailsPrint both
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}
  !ifdef APP_INSTALLER_STORE_FILE
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  !endif
  ; Legacy default cache location (electron-updater pre-monkey-patch).
  ; Kept so users upgrading from v2.10.0 or earlier still get their
  ; orphaned downloader caches cleared on install.
  RMDir /r "$LOCALAPPDATA\kumiko-ai-amadeus-updater"
  RMDir /r "$LOCALAPPDATA\Kumiko AI-updater"
  RMDir /r "$LOCALAPPDATA\kumiko-amadeus-updater"
  RMDir /r "$LOCALAPPDATA\Kumiko-Amadeus-updater"
  ; New default cache location (sibling of userData under %APPDATA%).
  ; Matches resolveUpdaterCacheBase() in electron/app-updater.cjs.
  RMDir /r "$APPDATA\kumiko-ai-amadeus-updater"
  RMDir /r "$APPDATA\Kumiko AI-updater"
  RMDir /r "$APPDATA\kumiko-amadeus-updater"
  RMDir /r "$APPDATA\Kumiko-Amadeus-updater"
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend
!endif

; -----------------------------------------------------------------------------
; customUnInit - kill running instances before uninstall starts
; -----------------------------------------------------------------------------

!macro customUnInit
  DetailPrint "结束正在运行的进程"
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /IM "Kumiko AI.exe" /F /T'
  Pop $0
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /IM "Kumiko-Amadeus.exe" /F /T'
  Pop $0
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /IM "Kumiko·Amadeus.exe" /F /T'
  Pop $0
  Sleep 1200
!macroend

; -----------------------------------------------------------------------------
; customUnInstall - optionally wipe user data
; -----------------------------------------------------------------------------

!macro customUnInstall
  ; If this is an update (silent uninstall triggered by the new installer),
  ; skip the "delete user data?" prompt and keep everything.
  ${If} ${Silent}
    DetailPrint "检测到版本更新，保留用户数据"
    Goto skip_data_removal
  ${EndIf}

  MessageBox MB_YESNO|MB_ICONQUESTION "是否一并删除所有用户数据？$\r$\n$\r$\n包括聊天记录、语音文件与设置。选择“否”将仅卸载程序，数据保留。$\r$\n$\r$\nDelete all user data (chat history, voice files, settings)?" IDNO skip_data_removal

  SetShellVarContext current
  !ifdef APP_INSTALLER_STORE_FILE
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  !endif
  ; Legacy default cache (LOCALAPPDATA, pre-v2.10.1).
  RMDir /r "$LOCALAPPDATA\kumiko-ai-amadeus-updater"
  RMDir /r "$LOCALAPPDATA\Kumiko AI-updater"
  RMDir /r "$LOCALAPPDATA\kumiko-amadeus-updater"
  RMDir /r "$LOCALAPPDATA\Kumiko-Amadeus-updater"
  ; Current default cache (APPDATA sibling of userData).
  RMDir /r "$APPDATA\kumiko-ai-amadeus-updater"
  RMDir /r "$APPDATA\Kumiko AI-updater"
  RMDir /r "$APPDATA\kumiko-amadeus-updater"
  RMDir /r "$APPDATA\Kumiko-Amadeus-updater"
  DetailPrint "清理应用数据目录"
  ReadRegStr $0 HKCU "Software\KumikoAIAmadeus" "UserDataPath"

  ; Per-machine uninstall may run under a different shell context.
  ; Clear current-user profile locations first, because Electron stores
  ; Local Storage / IndexedDB / userData under the actual user profile.
  SetShellVarContext current

  ; Current packaged app profile
  RMDir /r "$APPDATA\Kumiko AI"
  RMDir /r "$LOCALAPPDATA\Kumiko AI"
  RMDir /r "$APPDATA\Kumiko-Amadeus"
  RMDir /r "$LOCALAPPDATA\Kumiko-Amadeus"
  RMDir /r "$APPDATA\Kumiko·Amadeus"
  RMDir /r "$LOCALAPPDATA\Kumiko·Amadeus"

  ; Historical / dev profile names that may still contain Local Storage / IndexedDB
  RMDir /r "$APPDATA\kumiko-ai-amadeus"
  RMDir /r "$LOCALAPPDATA\kumiko-ai-amadeus"
  RMDir /r "$APPDATA\Kumiko Amadeus"
  RMDir /r "$LOCALAPPDATA\Kumiko Amadeus"

  ; Also clear machine/all-users shell-context locations just in case
  SetShellVarContext all
  RMDir /r "$APPDATA\Kumiko AI"
  RMDir /r "$LOCALAPPDATA\Kumiko AI"
  RMDir /r "$APPDATA\Kumiko-Amadeus"
  RMDir /r "$LOCALAPPDATA\Kumiko-Amadeus"
  RMDir /r "$APPDATA\Kumiko·Amadeus"
  RMDir /r "$LOCALAPPDATA\Kumiko·Amadeus"
  RMDir /r "$APPDATA\kumiko-ai-amadeus"
  RMDir /r "$LOCALAPPDATA\kumiko-ai-amadeus"
  RMDir /r "$APPDATA\Kumiko Amadeus"
  RMDir /r "$LOCALAPPDATA\Kumiko Amadeus"

  ; Custom user-selected data directory (if configured) + its sibling
  ; updater-cache dir. Example: if $0 = "D:\KumikoData\Kumiko·Amadeus",
  ; the updater cache lives at "D:\KumikoData\kumiko-ai-amadeus-updater\".
  ; We use ${GetParent} to get "D:\KumikoData" and sweep the four
  ; historical cache-folder names before deleting userData itself.
  StrCmp $0 "" skip_custom_data_removal
  ${GetParent} "$0" $1
  StrCmp $1 "" +5
    RMDir /r "$1\kumiko-ai-amadeus-updater"
    RMDir /r "$1\Kumiko AI-updater"
    RMDir /r "$1\kumiko-amadeus-updater"
    RMDir /r "$1\Kumiko-Amadeus-updater"
  RMDir /r "$0"
  skip_custom_data_removal:

  DeleteRegValue HKCU "Software\KumikoAIAmadeus" "UserDataPath"
  DeleteRegValue HKCU "Software\KumikoAIAmadeus" "PendingMigrationSource"
  DeleteRegValue HKCU "Software\KumikoAIAmadeus" "PendingMigrationTarget"
  DeleteRegKey HKCU "Software\KumikoAIAmadeus"

  DetailPrint "用户数据清理完成"

  skip_data_removal:
!macroend

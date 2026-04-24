; =============================================================================
; Kumiko-Amadeus installer / uninstaller custom hooks.
;
; Restored to the "AstrBot 朴素路线" (A 路线): plain MUI2 standard 4 pages
; (Welcome / Directory / Install / Finish) with system-native chrome, no
; custom nsDialogs pages, no Hero+CTA layout.  This sheds 70% of the previous
; nsh's surface area and ALL the cosmetic overlay bugs that came with it
; (themed-button SetCtlColors no-op, header strip bleed-through, KA half-icon
; in page header, owner-drawn z-order conflicts).
;
; What stays:
;   - ManifestDPIAware true so Win10/11 don't bitmap-scale the installer
;   - SetFont Segoe UI 9 so all controls inherit a modern dialog font
;   - MUI_BGCOLOR + MUI_TEXTCOLOR so the wizard reads as a clean
;     neutral Win11-style surface instead of the earlier cream/brown skin
;   - PreferredInstallDrive auto-selection (D: > E: > ... over C: when an
;     extra fixed drive is present) - the single most useful UX hook
;   - customHeader: ShowInstDetails show + InstProgressFlags smooth +
;     branded BrandingText footer (so the install progress page actually
;     shows a scrolling log instead of an empty cream box)
;   - customWelcomePage / customUnWelcomePage: just MUI_PAGE_WELCOME +
;     MUI_UNPAGE_WELCOME with localized title/text so the cream sidebar
;     bitmap actually renders (electron-builder skips the welcome page
;     entirely when these macros are undefined, regardless of installerSidebar)
;   - customFinishPage: NOT defined; electron-builder injects MUI_PAGE_FINISH
;     with auto-generated StartApp + Run / Show release notes checkboxes
;   - customInit (drive auto-selection)
;   - customInstall (legacy updater-cache cleanup + v3 detail-print narration)
;   - customUnInit (taskkill running processes)
;   - customUnInstall (silent-update skip + MessageBox prompt + thorough RMDir
;     of every historical profile / cache directory name across HKCU/HKLM
;     shell contexts)
;
; Upstream electron-builder hook points we rely on (see assistedInstaller.nsh):
;   customHeader            - run after common.nsh, before MUI pages
;   customWelcomePage       - replaces default (none) welcome page
;   customUnWelcomePage     - replaces default (none) uninstall welcome page
;   customInit              - run at end of .onInit
;   customInstall           - run at end of install section
;   customUnInit            - run at start of un.onInit
;   customUnInstall         - run at end of uninstall section
; =============================================================================

; -----------------------------------------------------------------------------
; Declare DPI awareness at PE manifest level.
;
; Without this, Windows 10/11 treats the installer as a legacy DPI-unaware
; app and DWM bitmap-scales the whole UI at 125%/150%/175% system scaling,
; blurring every label.  With it, NSIS renders vector-crisp via GDI,
; matching Win11 native dialogs.  This is a NSIS attribute (manifest-time),
; not a runtime command.
; -----------------------------------------------------------------------------

ManifestDPIAware true

!include LogicLib.nsh
; FileFunc: ${GetParent}.  Used in customUnInstall to strip the basename
; off the user's custom UserDataPath so we can clean the sibling
; updater-cache directory on a custom drive.
!include FileFunc.nsh

; -----------------------------------------------------------------------------
; Global dialog font.
;
; Myth: !define MUI_FONT + MUI_FONTSIZE changes the installer font.
; Reality: MUI2.nsh never reads those.  Every MUI page's static controls,
; buttons, edits, list boxes inherit the *NSIS dialog default font*, set by
; the top-level SetFont command.  MUI's own header/title labels are created
; with CreateFont using $(^Font) from the language file - which on Win10/11
; is "MS Shell Dlg", GDI font-substituted to Segoe UI automatically.  So
; SetFont alone is enough to get a uniformly modern Segoe UI look.
; -----------------------------------------------------------------------------

SetFont "Segoe UI" "9"

; Neutral surface + dark graphite copy. This keeps the stock MUI2 controls
; looking current on Win10/11 and avoids the previous cream/brown tone that
; made the wizard feel older than the app itself.
!define MUI_BGCOLOR "F6F7FB"
!define MUI_TEXTCOLOR "1F2937"

; -----------------------------------------------------------------------------
; Drive auto-selection (installer-only).
;
; If the user has any non-system fixed drive (D:, E: ...), default INSTDIR to
; that drive instead of C:.  Avoids burning the system SSD with a 800MB+
; install on machines that have a dedicated data drive.
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

!endif

; -----------------------------------------------------------------------------
; customHeader - runs *after* common.nsh, so we can override its defaults.
;
; common.nsh has the final word on BrandingText / ShowInstDetails / progress
; flags, so any changes to these MUST live inside customHeader (NOT at file
; top-level), otherwise common.nsh just stomps them back to defaults.
; -----------------------------------------------------------------------------

!macro customHeader
  ; Show the rolling install log instead of a blank "Installing" panel.
  ; The 7z extractor doesn't DetailPrint per-file (electron-builder solid
  ; archive limitation), but our trailing customInstall section emits 4-5
  ; status lines so the final phase has real text to read.
  ShowInstDetails show
  !ifdef BUILD_UNINSTALLER
    ShowUninstDetails show
  !endif

  ; Smooth progress bar animation; without this it advances in chunky
  ; integer-percent jumps.
  InstProgressFlags smooth

  ; Branded footer — replaces "Nullsoft Install System vX" and the
  ; PRODUCT_NAME VERSION that common.nsh sets.
  BrandingText "Kumiko·Amadeus  v${VERSION}"
!macroend

; -----------------------------------------------------------------------------
; customWelcomePage - the standard MUI welcome page.
;
; electron-builder's assistedInstaller.nsh skips MUI_PAGE_WELCOME entirely
; unless this macro is defined — even when nsis.installerSidebar is set in
; package.json.  We just !insertmacro MUI_PAGE_WELCOME with a couple of
; localized title/text overrides so the cream sidebar bitmap actually
; renders next to readable Chinese copy.
; -----------------------------------------------------------------------------

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "安装 Kumiko·Amadeus"
  !define MUI_WELCOMEPAGE_TEXT "即将在此电脑上安装 Kumiko·Amadeus v${VERSION}。$\r$\n$\r$\n继续前，建议先关闭正在运行的 Kumiko 窗口。$\r$\n$\r$\n点击「下一步」继续。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; -----------------------------------------------------------------------------
; customUnWelcomePage - the standard MUI uninstall welcome page.
;
; Same reasoning as customWelcomePage.  Without this macro the uninstaller
; jumps straight to the confirmation prompt with no cream sidebar context.
; -----------------------------------------------------------------------------

!macro customUnWelcomePage
  !define MUI_UNWELCOMEPAGE_TITLE "卸载 Kumiko·Amadeus"
  !define MUI_UNWELCOMEPAGE_TEXT "即将从此电脑卸载 Kumiko·Amadeus。$\r$\n$\r$\n继续前，请先关闭正在运行的程序窗口。$\r$\n$\r$\n点击「下一步」继续。"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; -----------------------------------------------------------------------------
; customInit - drive auto-selection (preserved from earlier versions).
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
; customInstall - final cleanup after main files are written.
;
; Wipes legacy electron-updater cache directories from earlier package-name
; spellings so users upgrading from v2.10.0 or older don't accumulate
; orphaned downloader caches.  Then narrates the last few install steps
; via DetailPrint so the install progress panel has visible text in its
; final ~20% (electron-builder's own registry / shortcut writes do not
; DetailPrint by themselves).
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
  ; Legacy default cache location (LOCALAPPDATA, pre-v2.10.1).
  RMDir /r "$LOCALAPPDATA\kumiko-ai-amadeus-updater"
  RMDir /r "$LOCALAPPDATA\Kumiko AI-updater"
  RMDir /r "$LOCALAPPDATA\kumiko-amadeus-updater"
  RMDir /r "$LOCALAPPDATA\Kumiko-Amadeus-updater"
  ; Current default cache (APPDATA sibling of userData).
  RMDir /r "$APPDATA\kumiko-ai-amadeus-updater"
  RMDir /r "$APPDATA\Kumiko AI-updater"
  RMDir /r "$APPDATA\kumiko-amadeus-updater"
  RMDir /r "$APPDATA\Kumiko-Amadeus-updater"
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}

  ; Narrate the trailing registry / shortcut work so the install details
  ; panel doesn't end on a blank stretch.
  SetDetailsPrint both
  DetailPrint "正在写入注册表项"
  DetailPrint "正在创建桌面快捷方式"
  DetailPrint "正在创建开始菜单项"
  DetailPrint "Kumiko·Amadeus 准备就绪"
!macroend
!endif

; -----------------------------------------------------------------------------
; customUnInit - kill running instances before uninstall starts.
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
; customUnInstall - optionally wipe user data.
;
; Three paths:
;   1. Silent uninstall (triggered by an installer doing in-place upgrade) →
;      keep all data, no prompt.
;   2. Interactive uninstall → prompt with MessageBox.  Yes wipes, No keeps.
;   3. (Removed in this rewrite) The previous custom uninstall page would
;      pre-write HKCU\Software\KumikoAIAmadeus\UninstallKeepData and we'd
;      read it here.  Now that the custom page is gone, we always fall
;      through to the MessageBox path on interactive runs.
; -----------------------------------------------------------------------------

!macro customUnInstall
  ${If} ${Silent}
    DetailPrint "检测到版本更新，保留用户数据"
    Goto skip_data_removal
  ${EndIf}

  MessageBox MB_YESNO|MB_ICONQUESTION "是否一并删除所有用户数据？$\r$\n$\r$\n包括聊天记录、语音文件与设置。选择「否」将仅卸载程序，数据保留。$\r$\n$\r$\nDelete all user data (chat history, voice files, settings)?" IDNO skip_data_removal

  do_data_removal:

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

  ; Per-machine uninstall may run under a different shell context.  Clear
  ; current-user profile locations first because Electron stores Local
  ; Storage / IndexedDB / userData under the actual user profile.
  SetShellVarContext current

  ; Current packaged app profile.
  RMDir /r "$APPDATA\Kumiko AI"
  RMDir /r "$LOCALAPPDATA\Kumiko AI"
  RMDir /r "$APPDATA\Kumiko-Amadeus"
  RMDir /r "$LOCALAPPDATA\Kumiko-Amadeus"
  RMDir /r "$APPDATA\Kumiko·Amadeus"
  RMDir /r "$LOCALAPPDATA\Kumiko·Amadeus"

  ; Historical / dev profile names that may still contain Local Storage
  ; or IndexedDB shards from older builds.
  RMDir /r "$APPDATA\kumiko-ai-amadeus"
  RMDir /r "$LOCALAPPDATA\kumiko-ai-amadeus"
  RMDir /r "$APPDATA\Kumiko Amadeus"
  RMDir /r "$LOCALAPPDATA\Kumiko Amadeus"

  ; Also clear machine/all-users shell-context locations just in case.
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
  ; updater-cache dir.  Example: $0 = "D:\KumikoData\Kumiko·Amadeus"
  ; → updater cache lives at "D:\KumikoData\kumiko-ai-amadeus-updater\".
  ; ${GetParent} extracts "D:\KumikoData", then we sweep the four
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

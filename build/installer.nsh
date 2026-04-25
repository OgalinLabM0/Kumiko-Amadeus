; =============================================================================
; Kumiko-Amadeus installer / uninstaller custom hooks (v2.14.5).
;
; Layout: standard MUI2 4-page wizard (Welcome / Directory / Install / Finish)
; with system-native chrome — same skeleton that landed in v2.14.4 — plus four
; v2.14.5 polish passes:
;
;   E.2  HEADERIMAGE bitmap (configured via package.json nsis.installerHeader)
;        renders a small KA wordmark strip in the top-right of every page after
;        the welcome page.  electron-builder defines MUI_HEADERIMAGE for us.
;
;   E.3  Warmer brand copy on customWelcomePage / customUnWelcomePage.
;
;   E.4  Uninstall data-cleanup choice is now a dedicated nsDialogs page with
;        two RadioButtons (Keep / Wipe), inserted between MUI_UNPAGE_WELCOME
;        and MUI_UNPAGE_CONFIRM.  Replaces the v2.14.4 MessageBox prompt that
;        popped DURING InstFiles execution.  Choice is persisted to
;        HKCU\Software\KumikoAIAmadeus\UninstallWipeData and read back inside
;        customUnInstall.  Uses ONLY native nsDialogs widgets (no themed-button,
;        no owner-drawn) so we don't recreate the Hero+CTA z-order bugs that
;        were rolled back in v2.14.4.
;
;   E.5  Per-step DetailPrint narration for customInstall / customUnInit /
;        customUnInstall.  Every progress-bar advance now has a "正在..." line
;        in the install log so the user can see what each step is doing
;        (avoids "is this thing a virus quietly poking my registry?" panic).
;
; Preserved from earlier versions:
;   - ManifestDPIAware true so Win10/11 don't bitmap-scale the installer
;   - SetFont Segoe UI 9 so all controls inherit a modern dialog font
;   - MUI_BGCOLOR + MUI_TEXTCOLOR neutral surface
;   - PreferredInstallDrive auto-selection (D: > E: > ... over C:)
;   - customHeader: ShowInstDetails + InstProgressFlags + branded BrandingText
;   - customInit (drive auto-selection)
;
; Upstream electron-builder hook points:
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
; -----------------------------------------------------------------------------

ManifestDPIAware true

!include LogicLib.nsh
!include FileFunc.nsh
; v2.14.5 E.4: nsDialogs custom uninstall data-choice page.
!include nsDialogs.nsh

; -----------------------------------------------------------------------------
; Global dialog font.
; -----------------------------------------------------------------------------

SetFont "Segoe UI" "9"

; Neutral surface + dark graphite copy.
!define MUI_BGCOLOR "F6F7FB"
!define MUI_TEXTCOLOR "1F2937"

; -----------------------------------------------------------------------------
; Drive auto-selection (installer-only).
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
; -----------------------------------------------------------------------------

!macro customHeader
  ; Show the rolling install log instead of a blank "Installing" panel.
  ShowInstDetails show
  !ifdef BUILD_UNINSTALLER
    ShowUninstDetails show
  !endif

  InstProgressFlags smooth

  BrandingText "Kumiko·Amadeus  v${VERSION}"
!macroend

; -----------------------------------------------------------------------------
; customWelcomePage - the standard MUI welcome page (v2.14.5 E.3 copy refresh).
;
; v2.14.5 widens the welcome copy from a one-line "即将安装" stub into a short
; introduction so first-time users actually understand what KA is, where its
; data will live, and how big the install footprint is — without making them
; hunt down a separate readme.
; -----------------------------------------------------------------------------

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎使用 Kumiko·Amadeus"
  !define MUI_WELCOMEPAGE_TEXT "Kumiko·Amadeus 是一款桌面端 AI 陪伴程序，专注长期记忆与自然角色互动。$\r$\n$\r$\n本次将在此电脑安装 Kumiko·Amadeus v${VERSION}（约 800 MB，含本地 Embedding 模型）。安装后聊天记录、记忆向量、设置等数据保存在 %APPDATA%\Kumiko·Amadeus 目录下。$\r$\n$\r$\n继续前请关闭所有正在运行的 Kumiko·Amadeus 窗口。$\r$\n$\r$\n点击「下一步」继续。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; -----------------------------------------------------------------------------
; customUnWelcomePage - the standard MUI uninstall welcome page + the new
; data-choice page (v2.14.5 E.3 copy + E.4 page).
;
; By inserting `UninstPage custom` AFTER MUI_UNPAGE_WELCOME inside this macro,
; the custom data-choice page lands BEFORE electron-builder's
; MUI_UNPAGE_CONFIRM / MUI_UNPAGE_INSTFILES — exactly where we want the user
; to make the keep-or-wipe decision (i.e. before InstFiles starts running).
; -----------------------------------------------------------------------------

!macro customUnWelcomePage
  !define MUI_UNWELCOMEPAGE_TITLE "卸载 Kumiko·Amadeus"
  !define MUI_UNWELCOMEPAGE_TEXT "即将从此电脑卸载 Kumiko·Amadeus v${VERSION}。$\r$\n$\r$\n卸载只会移除程序本身。是否一并清理聊天记录 / 语音 / 图片 / 设置等用户数据，将在下一页选择。$\r$\n$\r$\n继续前请先关闭所有正在运行的 Kumiko·Amadeus 窗口。$\r$\n$\r$\n点击「下一步」继续。"
  !insertmacro MUI_UNPAGE_WELCOME

  ; v2.14.5 E.4: dedicated data-choice page (nsDialogs RadioButton + Label).
  ; Functions are defined below as un.KumikoUnDataChoice* so they execute in
  ; the uninstaller context.
  UninstPage custom un.KumikoUnDataChoiceShow un.KumikoUnDataChoiceLeave
!macroend

; -----------------------------------------------------------------------------
; v2.14.5 E.4: uninstall data-choice page.
;
; Two RadioButtons + a multi-line description Label.  Choice persists to
; HKCU\Software\KumikoAIAmadeus\UninstallWipeData ("0" = keep, "1" = wipe).
; customUnInstall reads this back to decide whether to run do_data_removal.
;
; Default selection is "Keep" (BST_CHECKED on $KumikoKeepRadio) so a user who
; just clicks Next during an uninstall WITHOUT reading is protected from
; accidental data loss — same defensive posture as the v2.14.4 MessageBox
; (which defaulted to "No" / keep on Enter).
; -----------------------------------------------------------------------------

Var /GLOBAL KumikoDataChoiceDialog
Var /GLOBAL KumikoKeepRadio
Var /GLOBAL KumikoWipeRadio

Function un.KumikoUnDataChoiceShow
  ; MUI_HEADER_TEXT auto-resolves to MUI_HeaderText OR un.MUI_HeaderText based
  ; on whether MUI_PAGE_UNINSTALLER is defined at expansion time, which is
  ; only true INSIDE MUI_UNPAGE_* blocks.  We're in a standalone un. function
  ; (UninstPage custom), so MUI_HEADER_TEXT would emit a Call MUI_HeaderText
  ; that doesn't link in the uninstaller.  Call un.MUI_HeaderText directly
  ; instead — that function is auto-injected by MUI2 whenever any
  ; MUI_UNPAGE_* macro is inserted (which customUnWelcomePage does above).
  Push "处理用户数据"
  Push "请选择是否清理本地的聊天记录、语音、图片与设置。"
  Call un.MUI_HeaderText

  nsDialogs::Create 1018
  Pop $KumikoDataChoiceDialog
  ${If} $KumikoDataChoiceDialog == error
    Abort
  ${EndIf}

  ; Description block (top of page).
  ${NSD_CreateLabel} 0u 0u 100% 60u "Kumiko·Amadeus 在 %APPDATA%\Kumiko·Amadeus 等目录中存放：聊天记录、语音 MP3 缓存、图片、记忆向量、用户设置。$\r$\n$\r$\n— 升级到新版本时建议「保留」，新版本会自动接续上你的全部数据。$\r$\n— 只有彻底告别 Kumiko·Amadeus、且确认不再需要这些数据时，才需要选择「清理」。"
  Pop $0

  ; "Keep" radio (default).
  ${NSD_CreateRadioButton} 0u 70u 100% 12u "保留所有用户数据（推荐：升级或暂时卸载时使用）"
  Pop $KumikoKeepRadio
  ${NSD_SetState} $KumikoKeepRadio ${BST_CHECKED}

  ; "Wipe" radio.
  ${NSD_CreateRadioButton} 0u 86u 100% 12u "清理所有用户数据（彻底卸载，无法撤销）"
  Pop $KumikoWipeRadio

  nsDialogs::Show
FunctionEnd

Function un.KumikoUnDataChoiceLeave
  ${NSD_GetState} $KumikoWipeRadio $0
  ${If} $0 == ${BST_CHECKED}
    WriteRegStr HKCU "Software\KumikoAIAmadeus" "UninstallWipeData" "1"
  ${Else}
    WriteRegStr HKCU "Software\KumikoAIAmadeus" "UninstallWipeData" "0"
  ${EndIf}
FunctionEnd

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
; customInstall - final cleanup + v2.14.5 E.5 progress narration.
;
; v2.14.5 expands the trailing DetailPrint block from 4 lines to a full
; "what just happened" recap (8 lines).  The recap is retrospective — by the
; time customInstall fires, electron-builder has already extracted files,
; written the registry, and created shortcuts — but listing each step in the
; install log gives the user a clear "this is a normal installer doing normal
; things" signal instead of an opaque blank stretch in the final 20% of the
; progress bar.
; -----------------------------------------------------------------------------

!ifndef BUILD_UNINSTALLER
!macro customInstall
  ; --- legacy updater-cache cleanup (unchanged from v2.14.4) ---
  SetDetailsPrint both
  DetailPrint "正在清理旧版本的 updater 缓存目录"
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

  ; --- v2.14.5 E.5: full install-recap narration ---
  ; Each line maps to something electron-builder OR this macro just did.
  ; SetDetailsPrint both echoes to both the log AND the status strip below
  ; the progress bar, so even users who don't expand the log see them tick by.
  SetDetailsPrint both
  DetailPrint "—— 安装介质校验通过 ——"
  DetailPrint "—— 程序文件解压完成 ——"
  DetailPrint "—— 旧版本 updater 缓存清理完成 ——"
  DetailPrint "正在写入注册表（产品信息 / 卸载入口 / 自动更新通道）"
  DetailPrint "正在创建桌面快捷方式"
  DetailPrint "正在创建开始菜单项"
  DetailPrint "正在配置自动更新通道（GitHub Releases）"
  DetailPrint "正在准备启动器（双击图标即可使用）"
  DetailPrint "Kumiko·Amadeus 准备就绪，欢迎进入"
!macroend
!endif

; -----------------------------------------------------------------------------
; customUnInit - kill running instances before uninstall starts (v2.14.5 E.5
; narrates each kill step instead of a single opaque "结束正在运行的进程").
; -----------------------------------------------------------------------------

!macro customUnInit
  DetailPrint "正在结束运行中的 Kumiko·Amadeus 进程..."
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /IM "Kumiko AI.exe" /F /T'
  Pop $0
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /IM "Kumiko-Amadeus.exe" /F /T'
  Pop $0
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /IM "Kumiko·Amadeus.exe" /F /T'
  Pop $0
  DetailPrint "正在等待文件句柄释放..."
  Sleep 1200
  DetailPrint "进程清理完成"
!macroend

; -----------------------------------------------------------------------------
; customUnInstall - optionally wipe user data (v2.14.5 E.4 + E.5 rewrite).
;
; Three paths:
;   1. Silent uninstall (triggered by an installer doing in-place upgrade) →
;      keep all data, no prompt (same as v2.14.4).
;   2. Interactive uninstall + user picked "Keep" on the data-choice page
;      → skip data removal.  Reads HKCU\...\UninstallWipeData (= "0").
;   3. Interactive uninstall + user picked "Wipe" on the data-choice page
;      → run do_data_removal.  Reads HKCU\...\UninstallWipeData (= "1").
;
; The HKCU flag is cleared at the very end of this macro regardless of branch,
; so the next install starts from a clean slate.
; -----------------------------------------------------------------------------

!macro customUnInstall
  ${If} ${Silent}
    DetailPrint "—— 静默卸载（版本升级中），保留全部用户数据 ——"
    Goto skip_data_removal
  ${EndIf}

  ; v2.14.5 E.4: read user choice from data-choice page instead of MessageBox.
  ReadRegStr $0 HKCU "Software\KumikoAIAmadeus" "UninstallWipeData"
  ${If} $0 != "1"
    DetailPrint "—— 已选择「保留所有用户数据」，仅卸载程序本身 ——"
    Goto skip_data_removal
  ${EndIf}

  do_data_removal:
  DetailPrint "—— 已选择「清理所有用户数据」，开始清理 ——"

  SetShellVarContext current
  !ifdef APP_INSTALLER_STORE_FILE
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  !endif

  ; v2.14.5 E.5: per-segment narration so each RMDir burst has a heading.
  DetailPrint "正在清理 LOCALAPPDATA 旧版本 updater 缓存目录..."
  ; Legacy default cache (LOCALAPPDATA, pre-v2.10.1).
  RMDir /r "$LOCALAPPDATA\kumiko-ai-amadeus-updater"
  RMDir /r "$LOCALAPPDATA\Kumiko AI-updater"
  RMDir /r "$LOCALAPPDATA\kumiko-amadeus-updater"
  RMDir /r "$LOCALAPPDATA\Kumiko-Amadeus-updater"

  DetailPrint "正在清理 APPDATA 当前版本 updater 缓存目录..."
  ; Current default cache (APPDATA sibling of userData).
  RMDir /r "$APPDATA\kumiko-ai-amadeus-updater"
  RMDir /r "$APPDATA\Kumiko AI-updater"
  RMDir /r "$APPDATA\kumiko-amadeus-updater"
  RMDir /r "$APPDATA\Kumiko-Amadeus-updater"

  DetailPrint "正在清理用户配置目录（聊天记录 / 记忆 / 设置）..."
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

  DetailPrint "正在清理全用户上下文的同名残留..."
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
  ; updater-cache dir.
  StrCmp $0 "" skip_custom_data_removal
  DetailPrint "正在清理自定义数据目录 $0 ..."
  ${GetParent} "$0" $1
  StrCmp $1 "" +5
    RMDir /r "$1\kumiko-ai-amadeus-updater"
    RMDir /r "$1\Kumiko AI-updater"
    RMDir /r "$1\kumiko-amadeus-updater"
    RMDir /r "$1\Kumiko-Amadeus-updater"
  RMDir /r "$0"
  skip_custom_data_removal:

  DetailPrint "正在清理注册表项（用户数据路径 / 待迁移标记）..."
  DeleteRegValue HKCU "Software\KumikoAIAmadeus" "UserDataPath"
  DeleteRegValue HKCU "Software\KumikoAIAmadeus" "PendingMigrationSource"
  DeleteRegValue HKCU "Software\KumikoAIAmadeus" "PendingMigrationTarget"
  DeleteRegKey HKCU "Software\KumikoAIAmadeus"

  DetailPrint "—— 用户数据清理完成 ——"

  skip_data_removal:
  ; Always clear the v2.14.5 E.4 choice flag so the next install starts fresh.
  ; (DeleteRegKey above already covers the wipe branch; the keep branch needs
  ; this explicit cleanup since DeleteRegKey was skipped.)
  ${IfNot} ${Silent}
    DeleteRegValue HKCU "Software\KumikoAIAmadeus" "UninstallWipeData"
  ${EndIf}
!macroend

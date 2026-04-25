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
; v2.14.5 E.4: WM_SETFONT constant for the bold pseudo-header label.
!include WinMessages.nsh

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
;
; v2.14.6 C: hide the empty rolling-log details box during InstFiles. In
; v2.14.5 the box was visible (`ShowInstDetails show`) and during the file
; extraction phase it stayed completely BLANK because electron-builder's NSIS
; template forces `SetDetailsPrint listonly` for the file extraction loop and
; suppresses per-file output, leaving an empty multi-line area that looked
; broken. The user reported "进度条在动，内容空白，这不行".
;
; v2.14.6 fix:
;   - `ShowInstDetails nevershow` removes the empty box entirely → page
;     becomes a clean progress bar + status text above it.
;   - `SetDetailsPrint both` ensures every DetailPrint we emit also writes to
;     the status text strip below the progress bar, so the user sees live
;     "正在解压…" / "正在写入注册表…" narration during the install.
;   - The companion `customPageAfterChangeDir` macro (below) injects a
;     MUI_PAGE_CUSTOMFUNCTION_PRE → KumikoInstFilesPre that fires the very
;     first "正在解压程序文件，请耐心等候..." line right BEFORE extraction
;     begins, so the status text is never blank either.
;   - The customInstall recap (8 lines) still fires at the end and now scrolls
;     across the status text strip too.
; -----------------------------------------------------------------------------

!macro customHeader
  ; v2.14.6 C: hide the empty details box; status text strip carries the load.
  ShowInstDetails nevershow
  !ifdef BUILD_UNINSTALLER
    ShowUninstDetails nevershow
  !endif

  ; v2.14.6 C (post-mortem fix from CI run 24925862265): NSIS rejects
  ; `SetDetailsPrint` outside Section/Function ("not valid outside Section
  ; or Function"). It is documented as an *instruction*, not an attribute,
  ; so it cannot live in customHeader (which expands at script top level).
  ; The companion calls inside KumikoInstFilesPre (install path),
  ; customInstall (install recap), and customUnInit (uninstall) set the
  ; global state to "both" the moment any of those Functions runs, which
  ; covers every DetailPrint we actually emit. Removed the script-level
  ; call here to unblock makensis.

  InstProgressFlags smooth

  BrandingText "Kumiko·Amadeus  v${VERSION}"
!macroend

; -----------------------------------------------------------------------------
; customPageAfterChangeDir (v2.14.6 C, v2.14.7 X.0 hotfix) - electron-builder
; hook that fires AFTER MUI_PAGE_DIRECTORY is inserted and BEFORE
; MUI_PAGE_INSTFILES is inserted. By defining MUI_PAGE_CUSTOMFUNCTION_PRE
; here, MUI2 attaches our KumikoInstFilesPre function to the next-inserted
; page (= InstFiles). MUI2 auto-undefines after the page macro consumes it,
; so we don't leak the define to the FinishPage.
;
; v2.14.7 X.0 hotfix (CI failures 24925862265 / 24926173714 / 24926727156):
; electron-builder's templates/nsis/assistedInstaller.nsh line 30 ALREADY
; does `!define MUI_PAGE_CUSTOMFUNCTION_PRE instFilesPre` whenever
; `allowToChangeInstallationDirectory` is set (Kumiko sets it true in
; electron-builder.json), in order to wire up its own $INSTDIR sanitizer
; that forces a trailing app-name subfolder. Our v2.14.6 C added a second
; `!define` of the same symbol here, which NSIS rejects with
; `!define: "MUI_PAGE_CUSTOMFUNCTION_PRE" already defined!` → makensis
; aborts both x64/arm64 installer AND uninstaller (4 builds gone).
;
; The fix is two-part:
;   1. !ifdef + !undef + !define so the redefine compiles cleanly
;      regardless of whether electron-builder defined it first.
;   2. Wrapper function KumikoInstFilesPre Calls instFilesPre FIRST so
;      electron-builder's critical $INSTDIR sanitization still runs before
;      our DetailPrint. The Call is itself guarded by !ifdef on
;      allowToChangeInstallationDirectory so configurations that disable
;      directory-change (where instFilesPre would never be defined)
;      compile too.
; -----------------------------------------------------------------------------

!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_PRE KumikoInstFilesPre
!macroend

Function KumikoInstFilesPre
  ; v2.14.7 X.0: delegate to electron-builder's $INSTDIR sanitizer so users
  ; who picked a bare-root folder (e.g. C:\) still get "\App Name" appended
  ; before extraction. Without this Call, files would scatter across the
  ; drive root because we just overwrote the only place electron-builder
  ; wires that function in.
  !ifdef allowToChangeInstallationDirectory
    Call instFilesPre
  !endif

  ; Force "both" again in case any earlier page LEAVE handler reset it.
  SetDetailsPrint both
  DetailPrint "正在解压程序文件，请耐心等候..."
FunctionEnd
!endif

; -----------------------------------------------------------------------------
; customWelcomePage - the standard MUI welcome page (v2.14.6 A copy trim).
;
; v2.14.6 strips out the v2.14.5 brand introduction + install-explanation
; paragraph that the user found "尬" (cringey).  The welcome page now does
; the bare minimum a Windows installer welcome page should do: state what
; will be installed and remind the user to close running windows first.
; Everything else (KA description, data location, footprint) was redundant
; with the chat-bubble guide that opens on first launch.
; -----------------------------------------------------------------------------

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎使用 Kumiko·Amadeus"
  !define MUI_WELCOMEPAGE_TEXT "即将安装 Kumiko·Amadeus v${VERSION}。$\r$\n$\r$\n继续前请关闭所有正在运行的 Kumiko·Amadeus 窗口。$\r$\n$\r$\n点击「下一步」继续。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; -----------------------------------------------------------------------------
; customUnWelcomePage - the standard MUI uninstall welcome page + the
; data-choice page (v2.14.6 A copy trim, v2.14.5 E.4 page kept).
;
; By inserting `UninstPage custom` AFTER MUI_UNPAGE_WELCOME inside this macro,
; the custom data-choice page lands BEFORE electron-builder's
; MUI_UNPAGE_CONFIRM / MUI_UNPAGE_INSTFILES — exactly where we want the user
; to make the keep-or-wipe decision (i.e. before InstFiles starts running).
; -----------------------------------------------------------------------------

!macro customUnWelcomePage
  !define MUI_UNWELCOMEPAGE_TITLE "卸载 Kumiko·Amadeus"
  !define MUI_UNWELCOMEPAGE_TEXT "即将卸载 Kumiko·Amadeus v${VERSION}。$\r$\n$\r$\n继续前请关闭所有正在运行的 Kumiko·Amadeus 窗口。$\r$\n$\r$\n点击「下一步」继续。"
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
Var /GLOBAL KumikoTitleFont

Function un.KumikoUnDataChoiceShow
  ; NOTE: We deliberately do NOT call MUI_HEADER_TEXT / un.MUI_HeaderText
  ; here.  MUI2 only auto-injects `Function un.MUI_HeaderText` when one of
  ; its MUI_UNPAGE_* macros internally calls MUI_HEADER_TEXT — and
  ; electron-builder never does that, so the symbol is undefined and any
  ; direct Call would fail link-time with:
  ;   "resolving uninstall function un.MUI_HeaderText in function ..."
  ; Instead, we render an in-page "title + subtitle" label pair at the top
  ; of the content area.  The MUI gold header strip stays empty (rare, but
  ; not broken) and the user reads our in-content title.
  nsDialogs::Create 1018
  Pop $KumikoDataChoiceDialog
  ${If} $KumikoDataChoiceDialog == error
    Abort
  ${EndIf}

  ; Pseudo-header: bold title (large) + subtitle (regular) inside the page
  ; content area, mimicking the look of a MUI page header strip.
  ${NSD_CreateLabel} 0u 0u 100% 14u "处理用户数据"
  Pop $0
  CreateFont $KumikoTitleFont "Segoe UI" 11 700
  SendMessage $0 ${WM_SETFONT} $KumikoTitleFont 1

  ${NSD_CreateLabel} 0u 16u 100% 12u "请选择是否清理本地的聊天记录、语音、图片与设置。"
  Pop $0

  ; Description block.
  ${NSD_CreateLabel} 0u 36u 100% 60u "Kumiko·Amadeus 在 %APPDATA%\Kumiko·Amadeus 等目录中存放：聊天记录、语音 MP3 缓存、图片、记忆向量、用户设置。$\r$\n$\r$\n— 升级到新版本时建议「保留」，新版本会自动接续上你的全部数据。$\r$\n— 只有彻底告别 Kumiko·Amadeus、且确认不再需要这些数据时，才需要选择「清理」。"
  Pop $0

  ; "Keep" radio (default).
  ${NSD_CreateRadioButton} 0u 102u 100% 12u "保留所有用户数据（推荐：升级或暂时卸载时使用）"
  Pop $KumikoKeepRadio
  ${NSD_SetState} $KumikoKeepRadio ${BST_CHECKED}

  ; "Wipe" radio.
  ${NSD_CreateRadioButton} 0u 118u 100% 12u "清理所有用户数据（彻底卸载，无法撤销）"
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
;
; v2.14.6 C: the final DetailPrint here ("正在删除程序文件...") is the LAST
; status-text-strip update before the MUI_UNPAGE_INSTFILES page renders, so
; with `SetDetailsPrint both` set globally in customHeader it carries over as
; the initial status text on InstFiles — replacing the v2.14.5 blank/stale
; display while electron-builder's file-removal loop scrolls "Removing: ..."
; lines onto the same status strip immediately after.
; -----------------------------------------------------------------------------

!macro customUnInit
  SetDetailsPrint both
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
  ; v2.14.6 C: seed the InstFiles status strip with a sensible initial line.
  DetailPrint "正在删除程序文件，请耐心等候..."
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

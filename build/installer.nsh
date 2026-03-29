!include LogicLib.nsh

BrandingText " "

!macro customHeader
  ; Hide the raw extraction log panel — show only a clean progress bar.
  ShowInstDetails nevershow
  ShowUninstDetails nevershow
!macroend

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

!macro customUnInstallCheck
!macroend

!macro customUnInstallCheckCurrentUser
!macroend

!macro customInstall
  SetDetailsPrint none
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}
  !ifdef APP_INSTALLER_STORE_FILE
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  !endif
  RMDir /r "$LOCALAPPDATA\kumiko-ai-amadeus-updater"
  RMDir /r "$LOCALAPPDATA\Kumiko AI-updater"
  RMDir /r "$LOCALAPPDATA\kumiko-amadeus-updater"
  RMDir /r "$LOCALAPPDATA\Kumiko-Amadeus-updater"
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend
!endif

!macro customUnInit
  DetailPrint "Stopping running Kumiko·Amadeus processes before uninstall..."
  ExecWait '"$SYSDIR\taskkill.exe" /IM "Kumiko AI.exe" /F /T'
  ExecWait '"$SYSDIR\taskkill.exe" /IM "Kumiko-Amadeus.exe" /F /T'
  ExecWait '"$SYSDIR\taskkill.exe" /IM "Kumiko·Amadeus.exe" /F /T'
  Sleep 1200
!macroend

!macro customUnInstall
  ; Check if this is an update (silent uninstall) or user-initiated uninstall
  ${If} ${Silent}
    DetailPrint "Silent uninstall detected (likely an update). Skipping user data removal."
    Goto skip_data_removal
  ${EndIf}

  MessageBox MB_YESNO|MB_ICONQUESTION "是否要同时删除所有用户数据（包括聊天记录、语音和设置）？$\n$\nDo you want to delete all user data (including chat history, voice files, and settings)?" IDNO skip_data_removal

  SetShellVarContext current
  !ifdef APP_INSTALLER_STORE_FILE
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  !endif
  RMDir /r "$LOCALAPPDATA\kumiko-ai-amadeus-updater"
  RMDir /r "$LOCALAPPDATA\Kumiko AI-updater"
  RMDir /r "$LOCALAPPDATA\kumiko-amadeus-updater"
  RMDir /r "$LOCALAPPDATA\Kumiko-Amadeus-updater"
  DetailPrint "Removing user data under current-user and machine-wide locations..."
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

  ; Historical/dev profile names that may still contain Local Storage / IndexedDB
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

  ; Custom user-selected data directory (if configured)
  StrCmp $0 "" +2
  RMDir /r "$0"

  DeleteRegValue HKCU "Software\KumikoAIAmadeus" "UserDataPath"
  DeleteRegValue HKCU "Software\KumikoAIAmadeus" "PendingMigrationSource"
  DeleteRegValue HKCU "Software\KumikoAIAmadeus" "PendingMigrationTarget"
  DeleteRegKey HKCU "Software\KumikoAIAmadeus"

  DetailPrint "User data removed."

  skip_data_removal:
!macroend

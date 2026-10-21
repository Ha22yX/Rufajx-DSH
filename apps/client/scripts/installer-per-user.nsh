; Keep the assisted directory picker, but install and update only for this user.
; perMachine:false alone still enables the all-users choice in electron-builder.
; Preparing an isolated copy preserves builder's native installer/signing path.
!include "${PROJECT_DIR}\build\rufa-nsis\rufa-ready.nsh"
!cd "${PROJECT_DIR}\build\rufa-nsis"
!addplugindir /x86-unicode "${PROJECT_DIR}\preinstalled\installer\x86-unicode"
!include "${PROJECT_DIR}\scripts\installer-direct.nsh"
!include "${PROJECT_DIR}\scripts\installer-upgrade.nsh"

!macro customInit
  ${If} ${isForAllUsers}
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser
  ; 0.2.3 launches updates with /S. Override it inside the bridge installer so
  ; the old caller cannot suppress real extraction and old-version progress.
  ${If} ${isUpdated}
    SetSilent normal
  ${EndIf}
!macroend

!macro customInstall
  ${If} ${isUpdated}
    ; Assisted updates skip the finish prompt and reopen the stable launcher.
    ; Inline the updated branch: StartApp declares a global and is also expanded
    ; later by builder's assisted installer, so it cannot be expanded twice.
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
    !insertmacro quitSuccess
  ${EndIf}
!macroend

!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    StrCpy $isForceMachineInstall "0"
    StrCpy $isForceCurrentInstall "1"
  !endif
!macroend

!macro customFiles_x64
  ; Complete corresponding source and patch accompany the modified LGPL plugin.
  SetDetailsPrint both
  DetailPrint "正在保存安装组件许可与源码……"
  ClearErrors
  SetOutPath "$INSTDIR\resources\installer-source"
  File "${PROJECT_DIR}\preinstalled\installer\7z1900-src.7z"
  File "${PROJECT_DIR}\preinstalled\installer\Nsis7z_19.00.7z"
  File "${PROJECT_DIR}\preinstalled\installer\License.txt"
  File "${PROJECT_DIR}\preinstalled\installer\copying.txt"
  File "${PROJECT_DIR}\preinstalled\installer\unRarLicense.txt"
  File "${PROJECT_DIR}\preinstalled\installer\README.md"
  File "${PROJECT_DIR}\preinstalled\installer\installer.lock.json"
  File "${PROJECT_DIR}\scripts\patch-nsis7z.mjs"
  File "${PROJECT_DIR}\scripts\build-nsis7z.ps1"
  File "${PROJECT_DIR}\scripts\installer-upgrade-temp.cpp"
  File "${PROJECT_DIR}\scripts\build-upgrade-temp.ps1"
  SetOutPath "$INSTDIR"
  ${If} ${Errors}
    Call RufaInstallFailure
  ${EndIf}
!macroend

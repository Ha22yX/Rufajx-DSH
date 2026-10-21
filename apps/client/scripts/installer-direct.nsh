!include LogicLib.nsh
!include WinMessages.nsh

!ifndef BUILD_UNINSTALLER
Var rufaExtractDone
Var rufaExtractTotal
Var rufaExtractPercent
Var rufaExtractDoneMB
Var rufaExtractTotalMB
Var rufaExtractDialog
Var rufaExtractLabel

Function RufaExtractProgress
  Pop $rufaExtractDone
  Pop $rufaExtractTotal
  System::Int64Op $rufaExtractDone * 100
  Pop $rufaExtractPercent
  System::Int64Op $rufaExtractPercent / $rufaExtractTotal
  Pop $rufaExtractPercent
  ${If} $rufaExtractPercent >= 100
    StrCpy $rufaExtractPercent 99
  ${EndIf}
  System::Int64Op $rufaExtractDone / 1048576
  Pop $rufaExtractDoneMB
  System::Int64Op $rufaExtractTotal / 1048576
  Pop $rufaExtractTotalMB
  FindWindow $rufaExtractDialog "#32770" "" $HWNDPARENT
  GetDlgItem $rufaExtractLabel $rufaExtractDialog 1006
  SendMessage $rufaExtractLabel ${WM_SETTEXT} 0 "STR:正在解压文件：$rufaExtractPercent%（$rufaExtractDoneMB / $rufaExtractTotalMB MiB）"
  !ifmacrodef rufaExtractionProgressObserved
    !insertmacro rufaExtractionProgressObserved
  !endif
FunctionEnd

Function RufaInstallFailure
  SetErrorLevel 2
  SetDetailsPrint both
  DetailPrint "安装未完成：安装文件不完整或无法写入。请关闭占用程序并检查目录权限、磁盘空间；仍失败时重新下载安装包。"
  MessageBox MB_OK|MB_ICONSTOP "安装未完成：安装文件不完整或无法写入。请关闭占用程序并检查目录权限、磁盘空间；仍失败时重新下载安装包。" /SD IDOK
  Quit
FunctionEnd
!endif

!macro rufaExtractUsing7za FILE
  SetDetailsPrint both
  DetailPrint "正在将文件直接解压到安装目录……"
  ClearErrors
  SetOutPath "$INSTDIR"
  IfErrors 0 +2
    Call RufaInstallFailure
  GetFunctionAddress $R9 RufaExtractProgress
  RufaNsis7z::ExtractWithCallback "${FILE}" $R9
  Pop $R0
  ${If} ${Errors}
  ${OrIf} $R0 != 0
    Call RufaInstallFailure
  ${EndIf}
  DetailPrint "文件解压完成，正在保存更新缓存……"
!macroend

!macro rufaCacheInstaller
  SetDetailsPrint both
  DetailPrint "正在保存更新缓存，请稍候……"
  ClearErrors
  !insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  ${If} ${Errors}
    Call RufaInstallFailure
  ${EndIf}
  DetailPrint "正在登记应用并创建快捷方式……"
!macroend

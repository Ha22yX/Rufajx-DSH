!ifndef BUILD_UNINSTALLER
Var rufaUpgradeStatus
Var rufaUpgradeRetained
!endif

!macro rufaExecWaitUninstaller COMMAND
  ${If} ${isUpdated}
    ShowWindow $HWNDPARENT ${SW_SHOW}
  ${EndIf}
  SetDetailsPrint both
  DetailPrint "正在处理旧版本并保留恢复文件，请稍候……"
  FindWindow $rufaExtractDialog "#32770" "" $HWNDPARENT
  GetDlgItem $rufaExtractLabel $rufaExtractDialog 1006
  SendMessage $rufaExtractLabel ${WM_SETTEXT} 0 "STR:正在处理旧版本并保留恢复文件，请稍候……"
  ClearErrors
  RufaUpgradeTemp::ExecWait "$installationDir" '${COMMAND}'
  Pop $rufaUpgradeStatus
  Pop $R0
  Pop $rufaUpgradeRetained
  ${If} $rufaUpgradeRetained != ""
    DetailPrint "旧版本处理资料保留在：$rufaUpgradeRetained"
  ${EndIf}
  ${If} $rufaUpgradeStatus == "prepare-error"
  ${OrIf} $rufaUpgradeStatus == "run-error"
    DetailPrint "无法安全准备同盘恢复目录或完成旧版本处理，安装已停止。"
    Call RufaInstallFailure
  ${EndIf}
  ${If} $rufaUpgradeStatus == "native-temp"
    DetailPrint "兼容模式：使用原生临时目录处理旧版本并保留恢复文件……"
    SendMessage $rufaExtractLabel ${WM_SETTEXT} 0 "STR:兼容模式：正在处理旧版本并保留恢复文件……"
    ClearErrors
    ExecWait '${COMMAND}' $R0
  ${Else}
    ClearErrors
    ${If} $rufaUpgradeStatus == "launch-error"
      SetErrors
    ${EndIf}
  ${EndIf}
!macroend

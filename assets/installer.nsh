!include "${BUILD_RESOURCES_DIR}\..\dist\webview-runtime.nsh"

!macro customInstall
  SetRegView 32
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW_CLIENT_ID}" "pv"
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW_CLIENT_ID}" "pv"
  ${EndIf}
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    DetailPrint "正在准备显示组件…"
    retry_webview:
    ExecWait '"$INSTDIR\resources\MicrosoftEdgeWebview2Setup.exe" /silent /install' $0
    ${If} $0 != 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "显示组件尚未准备完成。请确认网络已连接，点击重试。" /SD IDCANCEL IDRETRY retry_webview
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
  SetRegView 64
!macroend

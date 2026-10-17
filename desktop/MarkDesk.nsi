; MarkDesk 安装包脚本（NSIS 3.10 手工构建）
; 背景：electron-builder 的 NSIS 安装器在 Windows ARM64 上运行时解压丢大文件
;       （缺失 MarkDesk.exe 与运行时 DLL）。手工 NSIS 用内置解压器，规避该缺陷。
; 编译（需在纯 ASCII 路径下，makensis 不支持中文路径）：
;   makensis.exe /DARCH=arm64 MarkDesk.nsi   （默认 arm64）
;   makensis.exe /DARCH=x64 MarkDesk.nsi
; 产物：installer\MarkDesk-0.1.1-Setup-${ARCH}.exe

Unicode true
Name "MarkDesk"

!ifndef ARCH
  !define ARCH "arm64"
!endif

OutFile "installer\MarkDesk-0.1.1-Setup-${ARCH}.exe"
InstallDir "$LOCALAPPDATA\Programs\MarkDesk"
RequestExecutionLevel user
SetCompressor lzma

!include "MUI2.nsh"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\MarkDesk.exe"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Section "install" SecMain
  SetOutPath "$INSTDIR"
  File /r "release\MarkDesk-win32-${ARCH}\*.*"

  ; 开始菜单快捷方式
  CreateDirectory "$SMPROGRAMS\MarkDesk"
  CreateShortCut "$SMPROGRAMS\MarkDesk\MarkDesk.lnk" "$INSTDIR\MarkDesk.exe"
  ; 桌面快捷方式
  CreateShortCut "$DESKTOP\MarkDesk.lnk" "$INSTDIR\MarkDesk.exe"

  ; 卸载器与注册表卸载项（HKCU，无需管理员）
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MarkDesk" "DisplayName" "MarkDesk"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MarkDesk" "DisplayVersion" "0.1.1"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MarkDesk" "Publisher" "MarkDesk"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MarkDesk" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MarkDesk" "DisplayIcon" "$INSTDIR\MarkDesk.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MarkDesk" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MarkDesk" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MarkDesk" "NoRepair" 1
SectionEnd

Section "uninstall"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\MarkDesk.lnk"
  Delete "$SMPROGRAMS\MarkDesk\MarkDesk.lnk"
  RMDir "$SMPROGRAMS\MarkDesk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MarkDesk"
SectionEnd

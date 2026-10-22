; Shahjahan Download Manager — Windows installer (NSIS, built on Linux
; with the native Linux makensis from electron-builder's NSIS cache,
; because electron-builder's own NSIS step needs Wine, which is
; unavailable here).
; Run from the project root:
;   ~/.cache/electron-builder/nsis-3.0.4.1/nsis-3.0.4.1-*/linux/makensis -DROOT=/home/hatch/workspace/download-manager scripts/download-manager.nsi
; BEFORE running makensis, trim the Chromium locales or the build
; crashes: delete every dist-installer/win-unpacked/locales/*.pak
; except en-US.pak. The Linux makensis SIGBUS-crashes once the total
; payload passes ~512 MiB (517 MiB untrimmed, 468 MiB trimmed, and the
; trimmed build succeeds). Re-trim after every dist:win:dir rebuild.
; Output: dist-installer/Shahjahan Download Manager-Setup-0.7.4.exe
; This installer is unsigned. On first run Windows SmartScreen may warn;
; click "More info" -> "Run anyway".
; NOTE: installs to a new folder (Shahjahan Download Manager). If the
; old "Download Manager" 0.6.x is still installed, uninstall it first
; from Settings > Apps so you don't end up with two copies.

Unicode true
Name "Shahjahan Download Manager"
!ifndef ROOT
  !define ROOT "."
!endif
OutFile "${ROOT}/dist-installer/Shahjahan Download Manager-Setup-0.7.4.exe"
InstallDir "$PROGRAMFILES64\Shahjahan Download Manager"
InstallDirRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Shahjahan Download Manager" "InstallLocation"
RequestExecutionLevel admin
; 0.7.2 diagnosis (do NOT chase compression settings again): makensis
; SIGBUS-crashes (exit 135) on this VM regardless of compressor
; (solid lzma, plain lzma, lzma + 8 MB dict + optimizer off, zlib,
; even STORE mode all die) because the VM's free RAM fell below the
; largest single file: the 239 MB Electron exe needs ~239 MB+ just
; to be read, but only ~217 MB was free (and falling, no swap, and
; swapon is not permitted in this container). The known-good config
; below built 0.7.0/0.7.1 fine — retry it only when free RAM is back
; above ~1 GB. Until then, ship the portable zip of win-unpacked.
; Confirmed Oct 22, 2026: with ~2.3 GB free, this config built
; 0.7.3 first try — the RAM diagnosis was correct.
SetCompressor /SOLID lzma
SetDatablockOptimize on
Icon "${ROOT}/electron/build/icon.ico"

!include "MUI2.nsh"
!define MUI_ABORTWARNING
!define MUI_ICON "${ROOT}/electron/build/icon.ico"
!define MUI_UNICON "${ROOT}/electron/build/icon.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Shahjahan Download Manager.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Run Shahjahan Download Manager"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "0.7.4.0"
VIAddVersionKey "ProductName" "Shahjahan Download Manager"
VIAddVersionKey "FileVersion" "0.7.4.0"
VIAddVersionKey "ProductVersion" "0.7.4"
VIAddVersionKey "CompanyName" "Shahjahan Download Manager"
VIAddVersionKey "FileDescription" "Shahjahan Download Manager installer"
VIAddVersionKey "LegalCopyright" "Copyright © 2026 Shahjahan Download Manager"

Section "Shahjahan Download Manager" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${ROOT}/dist-installer/win-unpacked\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Shahjahan Download Manager"
  CreateShortcut "$SMPROGRAMS\Shahjahan Download Manager\Shahjahan Download Manager.lnk" "$INSTDIR\Shahjahan Download Manager.exe" "" "$INSTDIR\Shahjahan Download Manager.exe"
  CreateShortcut "$SMPROGRAMS\Shahjahan Download Manager\Uninstall Shahjahan Download Manager.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\Shahjahan Download Manager.lnk" "$INSTDIR\Shahjahan Download Manager.exe" "" "$INSTDIR\Shahjahan Download Manager.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Shahjahan Download Manager" "DisplayName" "Shahjahan Download Manager"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Shahjahan Download Manager" "DisplayVersion" "0.7.4"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Shahjahan Download Manager" "Publisher" "Shahjahan Download Manager"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Shahjahan Download Manager" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Shahjahan Download Manager" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Shahjahan Download Manager" "DisplayIcon" "$INSTDIR\Shahjahan Download Manager.exe"
  ; 0.7.0 Explorer right-click for .torrent files. Registered under
  ; SystemFileAssociations so it only ADDS a menu entry — it never
  ; changes the file's default association. The app's single-instance
  ; handler picks the clicked file up from argv.
  WriteRegStr HKCR "SystemFileAssociations\.torrent\shell\ShahjahanDownloadManager" "" "Download with Shahjahan Download Manager"
  WriteRegStr HKCR "SystemFileAssociations\.torrent\shell\ShahjahanDownloadManager\command" "" '"$INSTDIR\Shahjahan Download Manager.exe" "%1"'
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Shahjahan Download Manager.lnk"
  Delete "$SMPROGRAMS\Shahjahan Download Manager\Shahjahan Download Manager.lnk"
  Delete "$SMPROGRAMS\Shahjahan Download Manager\Uninstall Shahjahan Download Manager.lnk"
  RMDir "$SMPROGRAMS\Shahjahan Download Manager"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Shahjahan Download Manager"
  DeleteRegKey HKCR "SystemFileAssociations\.torrent\shell\ShahjahanDownloadManager"
SectionEnd

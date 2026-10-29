@echo off
REM Shahjahan Download Manager — native host install (Chrome)
REM Folder ko kahin bhi rakh sakte ho, bas baad me move/delete mat karna.
title Shahjahan Download Manager - Native Host Install
cd /d "%~dp0"

REM --- Node.js dhoondo: pehle PATH, phir common install jagah ---
set "NODECMD="
where node >nul 2>&1
if not errorlevel 1 set "NODECMD=node"
if "%NODECMD%"=="" if exist "%ProgramFiles%\nodejs\node.exe" set "NODECMD=%ProgramFiles%\nodejs\node.exe"
if "%NODECMD%"=="" if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODECMD=%ProgramFiles(x86)%\nodejs\node.exe"
if "%NODECMD%"=="" (
  echo Node.js nahi mila.
  echo Pehle nodejs.org se Node.js (20 ya naya) install karo, phir ye file dobara chalao.
  echo.
  pause
  exit /b 1
)

REM --- Extension ID pehle se likhi hui hai; Enter dabao to yehi use hogi ---
set "EXTID=gfknalgdlbdleaimobbgcaafibcddimc"

:ask
echo.
echo Extension ID (neeche wali sahi hai to sirf Enter dabao):
echo %EXTID%
set "NEWID="
set /p "NEWID=Nayi ID likhni ho to yahan paste karo, warna Enter dabao: "
if not "%NEWID%"=="" set "EXTID=%NEWID%"
REM ID me space ya quote kabhi nahi hote — paste se aa jayein to hata do
set "EXTID=%EXTID: =%"
set "EXTID=%EXTID:"=%"
if "%EXTID%"=="" (
  echo ID khali hai. Dobara koshish karo.
  set "EXTID=gfknalgdlbdleaimobbgcaafibcddimc"
  goto ask
)
"%NODECMD%" "%~dp0host.cjs" install %EXTID%
if errorlevel 1 (
  echo.
  echo Install fail hua. Ho sakta hai ID ghalat ho.
  echo Card se ID copy karke dobara paste karo.
  set "EXTID=gfknalgdlbdleaimobbgcaafibcddimc"
  goto ask
)
echo.
echo Ho gaya! Ab ye karo:
echo 1. chrome://extensions par extension ko Reload karo.
echo 2. Jis page par download chahiye, us tab ko Reload karo.
echo 3. Extension popup kholo — Connected likha aana chahiye.
echo.
echo Note: ye folder mat delete karo aur mat move karo.
pause

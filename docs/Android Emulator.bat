@echo off
title Android Emulator (Direct GPU - 16GB Storage - 4GB RAM - WebCam - Mic)
setlocal

set "SDK=%LOCALAPPDATA%\Android\Sdk"
set "EMU=%SDK%\emulator\emulator.exe"
set "QEMU=%SDK%\emulator\qemu\windows-x86_64\qemu-system-x86_64.exe"
set "ADB=%SDK%\platform-tools\adb.exe"
set "AVD=ddetect"
set "SDCARD=%USERPROFILE%\.android\avd\ddetect.avd\sdcard.img"

if not exist "%EMU%" (
  echo [ERROR] Emulator not found at "%EMU%"
  echo Install it from Android Studio - SDK Manager - SDK Tools - Android Emulator.
  pause
  exit /b 1
)

rem --- Auto-Configure Windows High Performance GPU Preference ---
reg add "HKCU\Software\Microsoft\DirectX\UserGpuPreferences" /v "%EMU%" /t REG_SZ /d "GpuPreference=2;" /f >nul 2>&1
reg add "HKCU\Software\Microsoft\DirectX\UserGpuPreferences" /v "%QEMU%" /t REG_SZ /d "GpuPreference=2;" /f >nul 2>&1

rem --- Already running check? ---
"%ADB%" devices 2>nul | findstr /r "emulator-[0-9]" >nul 2>&1
if %ERRORLEVEL% equ 0 (
  echo [INFO] Emulator is already running!
  echo.
  echo   adb devices          - List active devices
  echo   adb install app.apk  - Install an APK
  echo   adb logcat           - View live logs
  echo.
  pause
  exit /b 0
)

echo ========================================================
echo   Launching Android Emulator (%AVD%) - Fully Upgraded
echo ========================================================
echo   [+] Storage       : 16 GB Internal + 16 GB Virtual SD Card
echo   [+] RAM           : 4096 MB (4 GB Dedicated RAM)
echo   [+] CPU Cores     : 4 Cores
echo   [+] GPU Engine    : Host OpenGL (AMD Radeon GPU Direct)
echo   [+] Sound Output  : Speakers / Headphones Active
echo   [+] Microphone    : Connected to PC Default Mic (-allow-host-audio)
echo   [+] Camera        : Connected to 1080P Web Camera (webcam0)
echo   [+] Punchhole Cut : Disabled (Clean Edge-to-Edge Screen)
echo ========================================================
echo.
echo Starting %AVD% ... please wait.
echo Close this window to shut down the emulator.
echo.

"%EMU%" ^
  -avd %AVD% ^
  -gpu host ^
  -no-snapshot ^
  -no-boot-anim ^
  -cores 4 ^
  -memory 4096 ^
  -allow-host-audio ^
  -camera-back webcam0 ^
  -camera-front webcam0 ^
  -sdcard "%SDCARD%" ^
  -feature -DeviceSkinOverlay ^
  -feature -HasSharedSlotsHostMemoryAllocator ^
  -feature -GLDMA ^
  -feature -GLDMA2

echo.
echo [INFO] Emulator session ended.
pause

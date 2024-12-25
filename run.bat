@echo off
cls

:: ASCII Art
echo.
echo   ===============================================================
echo                     Sunbird Scanner Control Panel                                                                
echo                             By Sneethan                                             
echo   ===============================================================
echo.

:: Check for Git installation
where git >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Git is not installed! Please install Git to enable auto-updates.
    echo.
    goto menu
)

:: Pull latest changes from Git
echo Checking for updates...
git pull
if %ERRORLEVEL% NEQ 0 (
    echo Failed to pull updates from Git repository.
) else (
    echo Successfully updated from Git repository.
)
echo.

:menu
echo Please select an option:
echo.
echo [1] ⚙️ Run Scanner
echo [2] 💾 Backup Databases 
echo [3] 📁 Archive Pages 
echo [4] 📊 Check Sheets URLs 
echo [5] ❌ Exit
echo.
set /p choice="Enter your choice (1-5): "

if "%choice%"=="1" (
    echo Running Scanner...
    node run.js
    pause
    goto menu
)
if "%choice%"=="2" (
    echo Running Database Backup...
    node backup.js
    pause
    goto menu
)
if "%choice%"=="3" (
    echo Running Internet Archive Tool...
    node tools/internet_archive/archive.js
    pause
    goto menu
)
if "%choice%"=="4" (
    echo Running Google Sheets Checker...
    python tools/google-sheets/main.py
    pause
    goto menu
)
if "%choice%"=="5" (
    echo Goodbye!
    exit /b
)

echo Invalid choice! Please try again.
timeout /t 2 >nul
cls
goto menu

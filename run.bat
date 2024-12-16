@echo off
cls

:: ASCII Art
echo.
echo    ____              _     _         _   ____
echo   / ___| _   _ _ __ | |__ (_)_ __ __| | / ___|  ___ __ _ _ __  _ __   ___ _ __
echo   \___ \| | | | '_ \| '_ \| | '__/ _` | \___ \ / __/ _` | '_ \| '_ \ / _ \ '__|
echo    ___) | |_| | | | | |_) | | | | (_| |  ___) | (_| (_| | | | | | | |  __/ |
echo   |____/ \__,_|_| |_|_.__/|_|_|  \__,_| |____/ \___\__,_|_| |_|_| |_|\___|_|       
echo.
echo   ======================= Sunbird Scanner Control Panel =======================
echo.

:: Check for required dependencies
where git >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Error: Git is not installed! Please install Git to enable auto-updates.
    echo.
    goto dependencies_check
)

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Error: Node.js is not installed! Please install Node.js to run the scanner.
    echo.
    goto dependencies_check
)

where python >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Error: Python is not installed! Please install Python to use all features.
    echo.
    goto dependencies_check
)

:dependencies_check

:: Pull latest changes from Git
echo Checking for updates...
git pull >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [!] Failed to pull updates from Git repository.
) else (
    echo [✓] Successfully updated from Git repository.
)
echo.

:menu
echo Please select an option:
echo.
echo [1] Run Scanner (run.js)
echo [2] Backup Databases (backup.js)
echo [3] Archive Pages (tools/internet_archive/archive.js)
echo [4] Check Sheets URLs (tools/google-sheets/main.py)
echo [5] Exit
echo.
set /p choice="Enter your choice (1-5): "

if "%choice%"=="1" (
    cls
    echo Running Scanner...
    node run.js
    echo.
    pause
    cls
    goto menu
)
if "%choice%"=="2" (
    cls
    echo Running Database Backup...
    node backup.js
    echo.
    pause
    cls
    goto menu
)
if "%choice%"=="3" (
    cls
    echo Running Internet Archive Tool...
    node tools/internet_archive/archive.js
    echo.
    pause
    cls
    goto menu
)
if "%choice%"=="4" (
    cls
    echo Running Google Sheets Checker...
    python tools/google-sheets/main.py
    echo.
    pause
    cls
    goto menu
)
if "%choice%"=="5" (
    cls
    echo Goodbye!
    timeout /t 2 >nul
    exit /b
)

echo Invalid choice! Please try again.
timeout /t 2 >nul
cls
goto menu

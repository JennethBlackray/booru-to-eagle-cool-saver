@echo off
chcp 65001 >nul
title Booru to Eagle Saver - pHash and Library Collector
cd /d "%~dp0"

echo ======================================================================
echo       Booru to Eagle Saver - Dependency and Environment Check
echo ======================================================================
echo.

REM 1. Check if Python is installed and working
python -c "import sys" >nul 2>&1
if %ERRORLEVEL% neq 0 goto MISSING_PYTHON

REM 2. Check if Pillow (PIL) is installed
python -c "import PIL" >nul 2>&1
if %ERRORLEVEL% neq 0 goto MISSING_PILLOW

echo [+] Environment check passed: Python and Pillow are ready.
echo.
goto PROCEED

:MISSING_PYTHON
echo [!] Python is not installed or not found in system PATH.
echo.
where winget >nul 2>&1
if %ERRORLEVEL% neq 0 goto MANUAL_PYTHON

echo Windows Package Manager (winget) is available on your system.
set /p ANS_PY="Do you want to automatically install Python via winget? (y/n): "
if /i "%ANS_PY%"=="y" goto AUTO_PYTHON
goto MANUAL_PYTHON

:AUTO_PYTHON
echo.
echo [+] Installing Python 3...
winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
echo.
echo [+] Installing Pillow package...
python -m pip install pillow
python -c "import PIL" >nul 2>&1
if %ERRORLEVEL% equ 0 goto PROCEED

echo.
echo [!] Python was installed, but you may need to restart this window so PATH updates.
echo Please close this window and run pHash_collector.bat again.
echo.
pause
exit /b 0

:MANUAL_PYTHON
echo.
echo ======================================================================
echo   How to install Python manually:
echo ======================================================================
echo   1. Download Python from the official site:
echo      https://www.python.org/downloads/
echo.
echo   2. Run the installer and IMPORTANT:
echo      Check the box: [X] 'Add python.exe to PATH' at the bottom!
echo.
echo   3. After installation, open Command Prompt and run:
echo      python -m pip install pillow
echo.
echo   4. Once finished, run this pHash_collector.bat file again.
echo ======================================================================
echo.
pause
exit /b 1

:MISSING_PILLOW
echo [!] Python is installed, but the required 'Pillow' image library is missing.
echo.
set /p ANS_PIL="Do you want to automatically install Pillow via pip? (y/n): "
if /i "%ANS_PIL%"=="y" goto AUTO_PILLOW
goto MANUAL_PILLOW

:AUTO_PILLOW
echo.
echo [+] Installing Pillow via pip...
python -m pip install pillow
python -c "import PIL" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [+] Pillow installed successfully!
    echo.
    goto PROCEED
)
echo.
echo [!] Automatic installation via pip failed.
goto MANUAL_PILLOW

:MANUAL_PILLOW
echo.
echo ======================================================================
echo   How to install Pillow manually:
echo ======================================================================
echo   Run the following command in Command Prompt:
echo     python -m pip install pillow
echo.
echo   Official package page:
echo     https://pypi.org/project/pillow/
echo.
echo   Once finished, run this pHash_collector.bat file again.
echo ======================================================================
echo.
pause
exit /b 1

:PROCEED
python pHash_collector.py %*
echo.
pause

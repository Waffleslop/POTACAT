@echo off
rem Build yaesu-scope.exe with MSVC. Run from any prompt (as .\build.cmd): if
rem cl.exe is not on PATH, the Visual Studio 2022 Build Tools environment is
rem loaded first. Labels, not a parenthesised block: cmd expands %VAR% when
rem it parses a block, so a `set` inside one is invisible to the `if` after it.
setlocal
cd /d "%~dp0"
if not exist build mkdir build
where cl >nul 2>nul
if not errorlevel 1 goto :compile

set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if exist "%VCVARS%" goto :vcvars
set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if exist "%VCVARS%" goto :vcvars
set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
if exist "%VCVARS%" goto :vcvars
echo build.cmd: cl.exe not on PATH and no vcvars64.bat found
exit /b 1

:vcvars
call "%VCVARS%" >nul

:compile
cl /nologo /O2 /W3 /Fo:build\ /Fe:build\yaesu-scope.exe yaesu-scope.c
if errorlevel 1 exit /b 1
del /q build\yaesu-scope.obj 2>nul
echo built build\yaesu-scope.exe

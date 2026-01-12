@echo off
set KEY=%USERPROFILE%\Downloads\ssh-key-2026-01-12.key
set USER=ubuntu
set HOST=129.80.128.13

powershell -NoExit -Command "ssh -i \"%KEY%\" %USER%@%HOST%"

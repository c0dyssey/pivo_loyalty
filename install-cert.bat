@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "data\cert\ca.crt" (
  echo Сначала один раз запустите start.bat: он создаст сертификат. Затем повторите.
  pause & exit /b 1
)
echo Устанавливаю сертификат "Pivo Loyalty Local CA" для вашей учётной записи Windows.
echo Появится окно подтверждения: нажмите "Да".
certutil -user -addstore Root "data\cert\ca.crt"
echo.
echo Готово. Перезапустите браузер.
pause

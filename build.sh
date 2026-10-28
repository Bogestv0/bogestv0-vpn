#!/usr/bin/env bash
# Сборка Bogestv0-VPN-Setup.exe (нужен Go 1.21+). Опционально: STORE_IDS="id1,id2" — ID из Chrome Web Store / Edge Add-ons.
set -e
cd "$(dirname "$0")"
rm -rf installer/assets && mkdir -p installer/assets
cp -r extension installer/assets/extension
(cd helper && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o ../installer/assets/bogestv0-host.exe .)
# если положить xray.zip (Xray-windows-64.zip) рядом с build.sh — он будет вшит в установщик (работает без интернета)
[ -f xray.zip ] && cp xray.zip installer/assets/xray.zip || true
mkdir -p dist
(cd installer && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.storeIDs=${STORE_IDS:-}" -o ../dist/Bogestv0-VPN-Setup.exe .)
ls -la dist/

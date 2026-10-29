#!/usr/bin/env bash
# Bogestv0 VPN © 2026 Bogestv0 (https://t.me/bogestv0)
# Сборка Bogestv0-VPN-Setup.exe (нужен Go 1.21+).
#   VERSION=1.3.1        номер версии (в релизе берётся из тега v1.3.1); попадает в manifest.json, помощника и установщик
#   REPO=владелец/репо   откуда помощник берёт обновления (по умолчанию bogestv0/bogestv0-vpn)
#   STORE_IDS="id1,id2"  ID из Chrome Web Store / Edge Add-ons (необязательно)
set -e
cd "$(dirname "$0")"
VERSION="${VERSION:-1.3.1}"
REPO="${REPO:-bogestv0/bogestv0-vpn}"
rm -rf installer/assets && mkdir -p installer/assets
cp -r extension installer/assets/extension
# версия расширения = версия релиза: именно по смене версии видно, что обновление применилось
sed -i -E "s/\"version\": \"[0-9.]+\"/\"version\": \"${VERSION}\"/" installer/assets/extension/manifest.json
sed -i -E "s#const GH_REPO = '[^']+'#const GH_REPO = '${REPO}'#" installer/assets/extension/background.js
(cd helper && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.appVersion=$VERSION -X main.ghRepo=$REPO" -o ../installer/assets/bogestv0-host.exe .)
# если положить xray.zip (Xray-windows-64.zip) рядом с build.sh — он будет вшит в установщик (работает без интернета)
[ -f xray.zip ] && cp xray.zip installer/assets/xray.zip || true
mkdir -p dist
(cd installer && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$VERSION -X main.storeIDs=${STORE_IDS:-}" -o ../dist/Bogestv0-VPN-Setup.exe .)
ls -la dist/

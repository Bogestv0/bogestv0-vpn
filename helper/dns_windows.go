//go:build windows

package main

// Смена DNS на Cloudflare + Google и откат. Права администратора запрашиваются через UAC (Start-Process -Verb RunAs).
// Скрипты собираются здесь же из проверенных данных (числа и IP-адреса) и передаются как -EncodedCommand:
// ни один файл, который мог бы подменить другой процесс, с повышенными правами не выполняется.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
)

type adapter struct {
	Index   int      `json:"i"`
	Name    string   `json:"n"`
	Static  bool     `json:"s"` // DNS задан вручную (иначе выдаётся автоматически, DHCP)
	Servers []string `json:"d"`
}

type dnsBackup struct {
	Adapters []adapter `json:"adapters"`
}

var fixServers = []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"}

const psPre = "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';"

const psRead = psPre + `
$r=@()
foreach($a in (Get-NetAdapter -Physical | Where-Object {$_.Status -eq 'Up'})){
  $g=$a.InterfaceGuid; $ns=''; $ns6=''
  try{$ns=(Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$g" -Name NameServer -ErrorAction Stop).NameServer}catch{}
  try{$ns6=(Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters\Interfaces\$g" -Name NameServer -ErrorAction Stop).NameServer}catch{}
  $d=@(Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex | ForEach-Object {$_.ServerAddresses})
  $r+=[pscustomobject]@{i=[int]$a.ifIndex;n=[string]$a.Name;s=[bool]($ns -or $ns6);d=$d}
}
ConvertTo-Json -InputObject @($r) -Compress`

func psEncode(script string) string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, 0, len(u)*2)
	for _, c := range u {
		b = append(b, byte(c), byte(c>>8))
	}
	return base64.StdEncoding.EncodeToString(b)
}

func runPS(script string, timeout time.Duration) (string, string, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", psEncode(script))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	var so, se bytes.Buffer
	cmd.Stdout, cmd.Stderr = &so, &se
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	}
	return strings.TrimSpace(so.String()), strings.TrimSpace(se.String()), code, err
}

func readAdapters() ([]adapter, error) {
	out, se, _, err := runPS(psRead, 30*time.Second)
	if err != nil {
		return nil, fmt.Errorf("не удалось прочитать настройки DNS: %s", firstLine(se, err))
	}
	var ads []adapter
	if err := json.Unmarshal([]byte(strings.TrimPrefix(out, "\ufeff")), &ads); err != nil {
		return nil, fmt.Errorf("не удалось разобрать настройки DNS")
	}
	return ads, nil
}

func firstLine(s string, err error) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return err.Error()
	}
	if i := strings.IndexAny(s, "\r\n"); i > 0 {
		s = s[:i]
	}
	return s
}

// runElevated выполняет inner с правами администратора (покажется окно UAC).
func runElevated(inner string) error {
	outer := psPre + "try{$p=Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','" + psEncode(inner) + "';exit $p.ExitCode}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1223}"
	_, se, code, err := runPS(outer, 3*time.Minute)
	if err == nil {
		return nil
	}
	if code == 1223 {
		return fmt.Errorf("Вы отклонили запрос Windows (UAC) — DNS не изменён")
	}
	if code == 2 {
		return fmt.Errorf("Windows не смогла изменить DNS у части адаптеров")
	}
	return fmt.Errorf("не удалось изменить DNS: %s", firstLine(se, err))
}

func psList(ss []string) string {
	q := make([]string, 0, len(ss))
	for _, s := range ss {
		if ip := net.ParseIP(s); ip != nil {
			q = append(q, "'"+ip.String()+"'")
		}
	}
	return "@(" + strings.Join(q, ",") + ")"
}

// script: для каждого адаптера — задать список серверов, либо вернуть автоматические (reset).
func buildApply(ads []adapter, useFix bool) string {
	var b strings.Builder
	b.WriteString(psPre + "$bad=0;\n")
	for _, a := range ads {
		if a.Index <= 0 {
			continue
		}
		switch {
		case useFix:
			fmt.Fprintf(&b, "try{Set-DnsClientServerAddress -InterfaceIndex %d -ServerAddresses %s}catch{$bad=1}\n", a.Index, psList(fixServers))
		case a.Static && len(a.Servers) > 0:
			fmt.Fprintf(&b, "try{Set-DnsClientServerAddress -InterfaceIndex %d -ServerAddresses %s}catch{$bad=1}\n", a.Index, psList(a.Servers))
		default:
			fmt.Fprintf(&b, "try{Set-DnsClientServerAddress -InterfaceIndex %d -ResetServerAddresses}catch{$bad=1}\n", a.Index)
		}
	}
	b.WriteString("try{Clear-DnsClientCache}catch{}\nif($bad){exit 2}\n")
	return b.String()
}

func hasAll(have []string, want ...string) bool {
	for _, w := range want {
		f := false
		for _, h := range have {
			if h == w {
				f = true
			}
		}
		if !f {
			return false
		}
	}
	return true
}

func allFixed(ads []adapter) bool {
	if len(ads) == 0 {
		return false
	}
	for _, a := range ads {
		if !hasAll(a.Servers, "1.1.1.1", "8.8.8.8") {
			return false
		}
	}
	return true
}

func backupPath() string { return p("dns-backup.json") }

func loadBackup() (dnsBackup, bool) {
	var b dnsBackup
	raw, err := os.ReadFile(backupPath())
	if err != nil || json.Unmarshal(raw, &b) != nil || len(b.Adapters) == 0 {
		return b, false
	}
	return b, true
}

func dnsStatus() M {
	ads, err := readAdapters()
	if err != nil {
		return M{"ok": false, "error": err.Error()}
	}
	_, has := loadBackup()
	return M{"ok": true, "fixed": allFixed(ads), "hasBackup": has, "adapters": len(ads)}
}

func dnsFix() M {
	ads, err := readAdapters()
	if err != nil {
		return M{"ok": false, "error": err.Error()}
	}
	if len(ads) == 0 {
		return M{"ok": false, "error": "Не найден активный сетевой адаптер (Wi-Fi или Ethernet)"}
	}
	if !allFixed(ads) { // исходные настройки сохраняем, только пока DNS ещё не заменён
		raw, _ := json.Marshal(dnsBackup{Adapters: ads})
		if err := os.WriteFile(backupPath(), raw, 0o600); err != nil {
			return M{"ok": false, "error": "не удалось сохранить текущие настройки: " + err.Error()}
		}
	}
	if err := runElevated(buildApply(ads, true)); err != nil {
		return M{"ok": false, "error": err.Error()}
	}
	after, err := readAdapters()
	if err != nil || !allFixed(after) {
		return M{"ok": false, "error": "Windows не применила новый DNS. Попробуйте ещё раз."}
	}
	return M{"ok": true, "fixed": true, "hasBackup": true}
}

func dnsRestore() M {
	b, has := loadBackup()
	ads := b.Adapters
	note := ""
	if !has { // сохранённых настроек нет — возвращаем автоматические (DHCP) на активных адаптерах
		cur, err := readAdapters()
		if err != nil {
			return M{"ok": false, "error": err.Error()}
		}
		ads = make([]adapter, 0, len(cur))
		for _, a := range cur {
			ads = append(ads, adapter{Index: a.Index, Name: a.Name})
		}
		note = "Сохранённых настроек не было — включено автоматическое получение DNS."
	}
	if len(ads) == 0 {
		return M{"ok": false, "error": "Не найден активный сетевой адаптер"}
	}
	if err := runElevated(buildApply(ads, false)); err != nil {
		return M{"ok": false, "error": err.Error()}
	}
	os.Remove(backupPath())
	return M{"ok": true, "fixed": false, "hasBackup": false, "note": note}
}

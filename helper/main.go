// Bogestv0 VPN © 2026 Bogestv0 (https://t.me/bogestv0) — native-messaging помощник. Запускает/останавливает xray-core.
// Протокол Chrome Native Messaging: 4 байта длины (LE) + JSON.
package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var baseDir string

type Profile struct {
	ID          string `json:"id"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Network     string `json:"network"`
	Security    string `json:"security"`
	Flow        string `json:"flow"`
	SNI         string `json:"sni"`
	FP          string `json:"fp"`
	PBK         string `json:"pbk"`
	SID         string `json:"sid"`
	SPX         string `json:"spx"`
	Path        string `json:"path"`
	HostHeader  string `json:"hostHeader"`
	ServiceName string `json:"serviceName"`
	Alpn        string `json:"alpn"`
	HeaderType  string `json:"headerType"`
}

type Msg struct {
	Cmd     string   `json:"cmd"`
	Profile *Profile `json:"profile"`
	Port    int      `json:"port"`
	Host    string   `json:"host"`
	Tag     string   `json:"tag"`
}

type M = map[string]any

func main() {
	exe, _ := os.Executable()
	baseDir = filepath.Dir(exe)
	updTag := ""
	for i := 1; i < len(os.Args); i++ {
		switch os.Args[i] {
		case "--base": // для тестов и для процесса обновления
			if i+1 < len(os.Args) {
				baseDir = os.Args[i+1]
				i++
			}
		case "--do-update": // процесс обновления, запущенный командой update-start
			if i+1 < len(os.Args) {
				updTag = os.Args[i+1]
				i++
			}
		}
	}
	if updTag != "" {
		doUpdate(updTag)
		return
	}
	raw := make([]byte, 4)
	if _, err := io.ReadFull(os.Stdin, raw); err != nil {
		return
	}
	buf := make([]byte, binary.LittleEndian.Uint32(raw))
	if _, err := io.ReadFull(os.Stdin, buf); err != nil {
		return
	}
	var m Msg
	if err := json.Unmarshal(buf, &m); err != nil {
		send(M{"ok": false, "error": err.Error()})
		return
	}
	send(handle(m))
}

func send(v any) {
	b, _ := json.Marshal(v)
	h := make([]byte, 4)
	binary.LittleEndian.PutUint32(h, uint32(len(b)))
	os.Stdout.Write(h)
	os.Stdout.Write(b)
}

func handle(m Msg) M {
	switch m.Cmd {
	case "ping":
		x := findXray()
		var name any
		if x != "" {
			name = filepath.Base(x)
		}
		return M{"ok": true, "xray": name, "version": 4, "app": appVersion, "features": []string{"tcping", "dns", "update"}, "hint": "переустановите Bogestv0 VPN"}
	case "start":
		if m.Profile == nil {
			return M{"ok": false, "error": "нет профиля"}
		}
		port := m.Port
		if port == 0 {
			port = 10808
		}
		return start(*m.Profile, port)
	case "stop":
		stop()
		return M{"ok": true}
	case "status":
		return status()
	case "tcping":
		return tcping(m.Host, m.Port)
	case "update-start":
		return updateStart(m.Tag)
	case "update-status":
		return updateStatus()
	case "dns-status":
		return dnsStatus()
	case "dns-fix":
		return dnsFix()
	case "dns-restore":
		return dnsRestore()
	}
	return M{"ok": false, "error": "unknown cmd"}
}

func p(name string) string { return filepath.Join(baseDir, name) }

func findXray() string {
	name := "xray"
	if runtime.GOOS == "windows" {
		name = "xray.exe"
	}
	for _, c := range []string{filepath.Join(baseDir, "bin", name), filepath.Join(baseDir, name)} {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	if x, err := exec.LookPath("xray"); err == nil {
		return x
	}
	return ""
}

// freePort ищет ближайший свободный порт выше занятого (1024–65535); 0, если не нашёл.
func freePort(from int) int {
	for p := from + 1; p <= from+200 && p <= 65535; p++ {
		if p < 1024 || portOpen(p) {
			continue
		}
		l, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p))
		if err != nil {
			continue
		}
		l.Close()
		return p
	}
	return 0
}

func portOpen(port int) bool {
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 400*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

type State struct {
	PID  int `json:"pid"`
	Port int `json:"port"`
}

func loadState() State {
	var s State
	if b, err := os.ReadFile(p("state.json")); err == nil {
		json.Unmarshal(b, &s)
	}
	return s
}

func stop() {
	s := loadState()
	if s.PID > 0 {
		if pr, err := os.FindProcess(s.PID); err == nil {
			pr.Kill()
		}
	}
	os.Remove(p("state.json"))
	time.Sleep(300 * time.Millisecond)
}

func status() M {
	s := loadState()
	return M{"ok": true, "running": s.Port > 0 && portOpen(s.Port), "port": s.Port}
}

func buildConfig(pr Profile, port int) M {
	user := M{"id": pr.ID, "encryption": "none"}
	if pr.Flow != "" {
		user["flow"] = pr.Flow
	}
	net_ := or(pr.Network, "tcp")
	sec := or(pr.Security, "none")
	ss := M{"network": net_, "security": sec}
	switch sec {
	case "reality":
		ss["realitySettings"] = M{"serverName": or(pr.SNI, pr.Host), "fingerprint": or(pr.FP, "chrome"),
			"publicKey": pr.PBK, "shortId": pr.SID, "spiderX": pr.SPX}
	case "tls":
		t := M{"serverName": or(pr.SNI, pr.Host), "fingerprint": or(pr.FP, "chrome")}
		if pr.Alpn != "" {
			t["alpn"] = strings.Split(pr.Alpn, ",")
		}
		ss["tlsSettings"] = t
	}
	switch {
	case net_ == "ws":
		ws := M{"path": or(pr.Path, "/")}
		if pr.HostHeader != "" {
			ws["headers"] = M{"Host": pr.HostHeader}
		}
		ss["wsSettings"] = ws
	case net_ == "grpc":
		ss["grpcSettings"] = M{"serviceName": pr.ServiceName}
	case net_ == "tcp" && pr.HeaderType == "http":
		ss["tcpSettings"] = M{"header": M{"type": "http"}}
	}
	return M{
		"log": M{"loglevel": "warning"},
		"inbounds": []M{{
			"tag": "socks-in", "listen": "127.0.0.1", "port": port, "protocol": "socks",
			"settings": M{"auth": "noauth", "udp": true, "ip": "127.0.0.1"},
			"sniffing": M{"enabled": true, "destOverride": []string{"http", "tls", "quic"}},
		}},
		"outbounds": []M{
			{"tag": "proxy", "protocol": "vless",
				"settings":       M{"vnext": []M{{"address": pr.Host, "port": pr.Port, "users": []M{user}}}},
				"streamSettings": ss},
			{"tag": "direct", "protocol": "freedom"},
		},
	}
}

func or(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func start(pr Profile, port int) M {
	xray := findXray()
	if xray == "" {
		return M{"ok": false, "error": "xray не найден. Переустановите Bogestv0 VPN."}
	}
	stop()
	if portOpen(port) {
		msg := fmt.Sprintf("Порт %d уже занят другой программой. Смените порт в настройках.", port)
		fp := freePort(port)
		if fp > 0 {
			msg += fmt.Sprintf(" Свободен порт %d — можно указать его.", fp)
		}
		return M{"ok": false, "error": msg, "freePort": fp}
	}
	cfg, _ := json.MarshalIndent(buildConfig(pr, port), "", "  ")
	if err := os.WriteFile(p("config.json"), cfg, 0o600); err != nil {
		return M{"ok": false, "error": err.Error()}
	}
	logf, _ := os.Create(p("xray.log"))
	cmd := exec.Command(xray, "run", "-c", p("config.json"))
	cmd.Dir = filepath.Dir(xray)
	cmd.Stdout, cmd.Stderr = logf, logf
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return M{"ok": false, "error": err.Error()}
	}
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	for i := 0; i < 40; i++ {
		select {
		case <-exited:
			i = 99
		default:
			if portOpen(port) {
				b, _ := json.Marshal(State{PID: cmd.Process.Pid, Port: port})
				os.WriteFile(p("state.json"), b, 0o600)
				return M{"ok": true, "pid": cmd.Process.Pid}
			}
			time.Sleep(150 * time.Millisecond)
		}
	}
	cmd.Process.Kill()
	tail := ""
	if b, err := os.ReadFile(p("xray.log")); err == nil {
		tail = string(b)
		if len(tail) > 600 {
			tail = tail[len(tail)-600:]
		}
	}
	return M{"ok": false, "error": "xray не запустился. " + strings.TrimSpace(tail)}
}

// tcping — время установки TCP-соединения с сервером (мс): 3 попытки, берём лучшую и среднюю.
func tcping(host string, port int) M {
	host = strings.TrimSpace(host)
	if host == "" || len(host) > 253 || port < 1 || port > 65535 || strings.ContainsAny(host, " /\\?#@") {
		return M{"ok": false, "error": "bad host"}
	}
	var best, sum time.Duration
	okN := 0
	for i := 0; i < 3; i++ {
		t0 := time.Now()
		c, err := net.DialTimeout("tcp", net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(port)), 2500*time.Millisecond)
		if err != nil {
			continue
		}
		d := time.Since(t0)
		c.Close()
		if okN == 0 || d < best {
			best = d
		}
		sum += d
		okN++
		time.Sleep(60 * time.Millisecond)
	}
	if okN == 0 {
		return M{"ok": false, "error": "нет ответа"}
	}
	return M{"ok": true, "ms": best.Milliseconds(), "avg": (sum / time.Duration(okN)).Milliseconds(), "n": okN}
}

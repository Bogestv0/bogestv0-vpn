// Bogestv0 VPN © 2026 Bogestv0 (https://t.me/bogestv0) — установщик для Windows (один .exe, без Python).
// Ключ --update: тихое обновление на месте (его запускает помощник по команде расширения).
package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

//go:embed all:assets
var assets embed.FS

const (
	hostID     = "com.bogestv0.vpn"
	devExtID   = "cfilndkhacojgcfnepiiljkpaikemkgc" // ID распакованного расширения (из "key" в manifest.json)
	xrayURLWin = "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip"
)

// version подставляется при сборке: -X main.version=1.3.2
var version = "1.3.2"

// updateMode — тихое обновление: без окон, вопросов и перезапуска xray.
var updateMode bool

// storeIDs — ID из Chrome Web Store / Edge Add-ons через запятую (задаётся при сборке: -ldflags "-X main.storeIDs=...")
var storeIDs = ""

var browsers = []string{`Google\Chrome`, `Microsoft\Edge`, `BraveSoftware\Brave-Browser`, `Chromium`, `Vivaldi`}

func main() {
	setupConsole()
	dest := os.Getenv("BOGESTV0_DEST")
	if dest == "" {
		dest = filepath.Join(os.Getenv("LOCALAPPDATA"), "Bogestv0VPN")
	}
	if len(os.Args) > 1 && (os.Args[1] == "--uninstall" || os.Args[1] == "/uninstall") {
		uninstall(dest)
		return
	}
	updateMode = len(os.Args) > 1 && os.Args[1] == "--update"
	install(dest)
}

func say(f string, a ...any) { fmt.Printf(f+"\n", a...) }

func pause() {
	if updateMode || os.Getenv("BOGESTV0_NOPAUSE") != "" {
		return
	}
	fmt.Print("\nНажмите Enter, чтобы закрыть окно...")
	bufio.NewReader(os.Stdin).ReadString('\n')
}

// writeUpdateStatus сообщает расширению (через помощника) итог тихого обновления.
func writeUpdateStatus(dest, state, errText string) {
	if !updateMode {
		return
	}
	b, _ := json.Marshal(map[string]any{"state": state, "version": version, "error": errText, "at": time.Now().Unix()})
	tmp := filepath.Join(dest, "update.json.tmp")
	if os.WriteFile(tmp, b, 0o600) == nil {
		os.Rename(tmp, filepath.Join(dest, "update.json"))
	}
}

var destDir string

func fatal(msg string, err error) {
	say("\n[ОШИБКА] %s", msg)
	text := msg
	if err != nil {
		say("         %v", err)
		text += ": " + err.Error()
	}
	writeUpdateStatus(destDir, "error", text)
	pause()
	os.Exit(1)
}

func install(dest string) {
	destDir = dest
	say("==============================================")
	say("   Bogestv0 VPN — установка (версия %s)", version)
	say("==============================================\n")

	if !updateMode { // при обновлении VPN не отключаем: xray не заменяется
		stopRunning(dest)
	}

	// 1. файлы
	say("[1/4] Копирую файлы...")
	if err := os.MkdirAll(filepath.Join(dest, "bin"), 0o755); err != nil {
		fatal("Не удалось создать папку "+dest, err)
	}
	for _, old := range []string{"bogestv0-host.exe.old", "uninstall.exe.old"} { // остатки прошлого обновления
		os.Remove(filepath.Join(dest, old))
	}
	newExt := map[string]bool{}
	err := fs.WalkDir(assets, "assets", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel := strings.TrimPrefix(path, "assets/")
		if rel == "xray.zip" {
			return nil
		}
		data, _ := assets.ReadFile(path)
		target := filepath.Join(dest, filepath.FromSlash(rel))
		if strings.HasPrefix(rel, "extension/") {
			newExt[filepath.Clean(target)] = true
		}
		os.MkdirAll(filepath.Dir(target), 0o755)
		return writeFile(target, data)
	})
	if err != nil {
		fatal("Не удалось распаковать файлы", err)
	}
	pruneExtension(filepath.Join(dest, "extension"), newExt) // убираем файлы прошлых версий, которых больше нет

	// 2. xray
	say("[2/4] Устанавливаю xray-core...")
	xray := filepath.Join(dest, "bin", exeName("xray"))
	if _, err := os.Stat(xray); err != nil {
		if err := getXray(xray); err != nil {
			say("\nНе удалось скачать xray-core автоматически: %v", err)
			say("Скачайте вручную Xray-windows-64.zip со страницы")
			say("  https://github.com/XTLS/Xray-core/releases")
			say("и положите xray.exe в папку:\n  %s", filepath.Join(dest, "bin"))
			say("Если GitHub не открывается — включите любой другой VPN на время установки.")
		}
	} else {
		say("      уже установлен")
	}

	// 3. регистрация помощника
	say("[3/4] Подключаю помощника к браузерам...")
	hostExe := filepath.Join(dest, exeName("bogestv0-host"))
	origins := []string{"chrome-extension://" + devExtID + "/"}
	for _, id := range strings.Split(storeIDs, ",") {
		if id = strings.TrimSpace(id); id != "" {
			origins = append(origins, "chrome-extension://"+id+"/")
		}
	}
	manifest, _ := json.MarshalIndent(map[string]any{
		"name": hostID, "description": "Bogestv0 VPN helper", "path": hostExe,
		"type": "stdio", "allowed_origins": origins,
	}, "", "  ")
	manifestPath := filepath.Join(dest, hostID+".json")
	writeFile(manifestPath, manifest)
	for _, b := range browsers {
		regAdd(`HKCU\Software\`+b+`\NativeMessagingHosts\`+hostID, "", manifestPath)
	}

	// запись в «Установка и удаление программ»
	if self, err := os.Executable(); err == nil {
		if data, err := os.ReadFile(self); err == nil {
			un := filepath.Join(dest, exeName("uninstall"))
			writeFile(un, data)
			k := `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Bogestv0VPN`
			regAdd(k, "DisplayName", "Bogestv0 VPN")
			regAdd(k, "DisplayVersion", version)
			regAdd(k, "Publisher", "Bogestv0")
			regAdd(k, "InstallLocation", dest)
			regAdd(k, "UninstallString", `"`+un+`" --uninstall`)
		}
	}

	// 4. расширение
	extDir := filepath.Join(dest, "extension")
	if updateMode {
		writeUpdateStatus(dest, "done", "")
		return
	}
	say("[4/4] Готово! Осталось добавить расширение в браузер.\n")
	if storeIDs == "" {
		say("  Сейчас откроются страница расширений и папка с расширением:")
		say("   1) Включите «Режим разработчика» (переключатель справа вверху)")
		say("   2) Нажмите «Загрузить распакованное расширение»")
		say("   3) Выберите открывшуюся папку  %s", extDir)
		say("   4) Закрепите значок «Bogestv0 VPN» (пазл рядом с адресной строкой)")
		openBrowserExtensions()
		openFolder(extDir)
		copyClipboard(extDir)
		say("\n  (путь к папке уже скопирован в буфер обмена — можно вставить Ctrl+V)")
	}
	say("\nУдалить программу можно в «Параметры → Приложения».")
	pause()
}

// writeFile пишет файл; если он занят (например, помощник как раз запущен браузером),
// несколько раз повторяет попытку, а затем отодвигает занятый файл в «.old» и пишет новый.
func writeFile(target string, data []byte) error {
	var err error
	for i := 0; i < 8; i++ {
		if err = os.WriteFile(target, data, 0o755); err == nil {
			return nil
		}
		time.Sleep(400 * time.Millisecond)
	}
	old := target + ".old"
	os.Remove(old)
	if os.Rename(target, old) == nil {
		return os.WriteFile(target, data, 0o755)
	}
	return err
}

func pruneExtension(dir string, keep map[string]bool) {
	var files []string
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && !keep[filepath.Clean(p)] {
			files = append(files, p)
		}
		return nil
	})
	for _, f := range files {
		os.Remove(f)
	}
	var dirs []string
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.IsDir() && p != dir {
			dirs = append(dirs, p)
		}
		return nil
	})
	for i := len(dirs) - 1; i >= 0; i-- {
		os.Remove(dirs[i]) // удалится только пустая папка
	}
}

func exeName(n string) string {
	if runtime.GOOS == "windows" {
		return n + ".exe"
	}
	return n
}

func getXray(target string) error {
	var data []byte
	if b, err := assets.ReadFile("assets/xray.zip"); err == nil {
		data = b
	} else {
		url := os.Getenv("BOGESTV0_XRAY_URL")
		if url == "" {
			url = xrayURLWin
		}
		var lastErr error
		for try := 1; try <= 3; try++ {
			say("      скачиваю (попытка %d)...", try)
			data, lastErr = download(url)
			if lastErr == nil {
				break
			}
			time.Sleep(2 * time.Second)
		}
		if lastErr != nil {
			return lastErr
		}
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	for _, f := range zr.File {
		if strings.EqualFold(filepath.Base(f.Name), exeName("xray")) {
			rc, err := f.Open()
			if err != nil {
				return err
			}
			defer rc.Close()
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
			if err != nil {
				return err
			}
			defer out.Close()
			_, err = io.Copy(out, rc)
			return err
		}
	}
	return fmt.Errorf("в архиве нет %s", exeName("xray"))
}

func download(url string) ([]byte, error) {
	cl := &http.Client{Timeout: 3 * time.Minute}
	resp, err := cl.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("сервер ответил %s", resp.Status)
	}
	var buf bytes.Buffer
	total := resp.ContentLength
	b := make([]byte, 64*1024)
	last := -1
	for {
		n, err := resp.Body.Read(b)
		buf.Write(b[:n])
		if total > 0 {
			if pct := int(int64(buf.Len()) * 100 / total); pct/10 != last {
				last = pct / 10
				fmt.Printf("      %d%%\n", pct)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	return buf.Bytes(), nil
}

func stopRunning(dest string) {
	if b, err := os.ReadFile(filepath.Join(dest, "state.json")); err == nil {
		var s struct{ PID int }
		if json.Unmarshal(b, &s) == nil && s.PID > 0 {
			if p, err := os.FindProcess(s.PID); err == nil {
				p.Kill()
			}
		}
		os.Remove(filepath.Join(dest, "state.json"))
		time.Sleep(300 * time.Millisecond)
	}
}

func uninstall(dest string) {
	say("Удаляю Bogestv0 VPN...")
	stopRunning(dest)
	for _, b := range browsers {
		regDelete(`HKCU\Software\` + b + `\NativeMessagingHosts\` + hostID)
	}
	regDelete(`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Bogestv0VPN`)
	// папку с запущенным uninstall.exe удаляет отдельный процесс после выхода
	if runtime.GOOS == "windows" {
		c := exec.Command("cmd", "/c", "ping -n 3 127.0.0.1 >nul & rmdir /s /q \""+dest+"\"")
		hide(c)
		c.Start()
	} else {
		os.RemoveAll(dest)
	}
	say("Готово. Расширение удалите вручную: chrome://extensions → Удалить.")
	pause()
}

func regAdd(key, name, value string) {
	if runtime.GOOS != "windows" {
		return
	}
	args := []string{"add", key, "/f", "/t", "REG_SZ", "/d", value}
	if name == "" {
		args = append(args, "/ve")
	} else {
		args = append(args, "/v", name)
	}
	c := exec.Command("reg", args...)
	hide(c)
	c.Run()
}

func regDelete(key string) {
	if runtime.GOOS != "windows" {
		return
	}
	c := exec.Command("reg", "delete", key, "/f")
	hide(c)
	c.Run()
}

func openFolder(p string) {
	if runtime.GOOS == "windows" {
		exec.Command("explorer", p).Start()
	}
}

func copyClipboard(s string) {
	if runtime.GOOS != "windows" {
		return
	}
	c := exec.Command("clip")
	c.Stdin = strings.NewReader(s)
	hide(c)
	c.Run()
}

func openBrowserExtensions() {
	if runtime.GOOS != "windows" {
		return
	}
	pf, pf86, la := os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")
	cands := []struct{ exe, url string }{
		{filepath.Join(pf, `Google\Chrome\Application\chrome.exe`), "chrome://extensions"},
		{filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`), "chrome://extensions"},
		{filepath.Join(la, `Google\Chrome\Application\chrome.exe`), "chrome://extensions"},
		{filepath.Join(pf86, `Microsoft\Edge\Application\msedge.exe`), "edge://extensions"},
		{filepath.Join(pf, `Microsoft\Edge\Application\msedge.exe`), "edge://extensions"},
		{filepath.Join(pf, `BraveSoftware\Brave-Browser\Application\brave.exe`), "brave://extensions"},
	}
	for _, c := range cands {
		if _, err := os.Stat(c.exe); err == nil {
			exec.Command(c.exe, c.url).Start()
			return
		}
	}
	say("  (откройте в браузере chrome://extensions вручную)")
}

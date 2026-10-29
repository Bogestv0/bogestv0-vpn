package main

// Автообновление: расширение просит помощника обновиться до релиза с тегом vX.Y.Z.
// Помощник сам собирает адрес на GitHub (расширение адрес не передаёт), скачивает установщик и SHA256SUMS.txt,
// сверяет контрольную сумму и запускает установщик с ключом --update (без окон, без вопросов).
// Установщик заменяет файлы расширения и помощника на месте и пишет итог в update.json.
// Расширение читает этот файл командой update-status и затем перезагружает себя.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const setupAsset = "Bogestv0-VPN-Setup.exe"

var (
	// подставляются при сборке: -X main.ghRepo=владелец/репозиторий -X main.appVersion=1.3.0
	ghRepo     = "bogestv0/bogestv0-vpn"
	appVersion = "1.3.0"
	// меняется только в тестах
	releaseBase = "https://github.com"

	tagRe  = regexp.MustCompile(`^v?\d{1,3}\.\d{1,3}\.\d{1,3}$`)
	repoRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$`)
)

// UpdStatus — содержимое update.json (его же пишет установщик в конце).
type UpdStatus struct {
	State   string `json:"state"` // downloading | verifying | installing | done | error
	Tag     string `json:"tag,omitempty"`
	Version string `json:"version,omitempty"`
	Error   string `json:"error,omitempty"`
	At      int64  `json:"at"`
}

func writeStatus(s UpdStatus) {
	s.At = time.Now().Unix()
	b, _ := json.Marshal(s)
	tmp := p("update.json.tmp")
	if os.WriteFile(tmp, b, 0o600) == nil {
		os.Rename(tmp, p("update.json"))
	}
}

func readStatus() (UpdStatus, bool) {
	var s UpdStatus
	b, err := os.ReadFile(p("update.json"))
	if err != nil || json.Unmarshal(b, &s) != nil {
		return s, false
	}
	return s, true
}

func inProgress(s UpdStatus) bool {
	return s.State == "downloading" || s.State == "verifying" || s.State == "installing"
}

// updateStatus — ответ на команду update-status.
func updateStatus() M {
	s, ok := readStatus()
	if !ok {
		return M{"ok": true, "state": "idle", "app": appVersion}
	}
	// зависшее обновление не должно блокировать следующее
	if inProgress(s) && time.Since(time.Unix(s.At, 0)) > 10*time.Minute {
		s = UpdStatus{State: "error", Tag: s.Tag, Error: "обновление не завершилось за 10 минут"}
		writeStatus(s)
	}
	return M{"ok": true, "state": s.State, "tag": s.Tag, "version": s.Version, "error": s.Error, "app": appVersion}
}

// updateStart запускает обновление в отдельном процессе и сразу возвращает управление.
func updateStart(tag string) M {
	tag = strings.TrimSpace(tag)
	if !tagRe.MatchString(tag) {
		return M{"ok": false, "error": "неверный номер версии"}
	}
	if !repoRe.MatchString(ghRepo) {
		return M{"ok": false, "error": "не задан репозиторий релизов"}
	}
	if s, ok := readStatus(); ok && inProgress(s) && time.Since(time.Unix(s.At, 0)) < 10*time.Minute {
		return M{"ok": false, "error": "обновление уже идёт"}
	}
	exe, err := os.Executable()
	if err != nil {
		return M{"ok": false, "error": err.Error()}
	}
	writeStatus(UpdStatus{State: "downloading", Tag: tag})
	cmd := exec.Command(exe, "--base", baseDir, "--do-update", tag)
	detach(cmd)
	if err := cmd.Start(); err != nil {
		writeStatus(UpdStatus{State: "error", Tag: tag, Error: err.Error()})
		return M{"ok": false, "error": err.Error()}
	}
	cmd.Process.Release()
	return M{"ok": true}
}

// doUpdate выполняется в дочернем процессе: скачать → проверить → запустить установщик.
func doUpdate(tag string) {
	fail := func(err error) {
		writeStatus(UpdStatus{State: "error", Tag: tag, Error: err.Error()})
	}
	if !tagRe.MatchString(tag) || !repoRe.MatchString(ghRepo) {
		fail(errors.New("неверные параметры обновления"))
		return
	}
	cleanOldUpdates()
	base := fmt.Sprintf("%s/%s/releases/download/%s/", releaseBase, ghRepo, tag)

	data, err := download(base+setupAsset, 200<<20)
	if err != nil {
		fail(fmt.Errorf("не удалось скачать установщик: %v", err))
		return
	}
	writeStatus(UpdStatus{State: "verifying", Tag: tag})
	if len(data) < 1<<20 || data[0] != 'M' || data[1] != 'Z' {
		fail(errors.New("скачанный файл не похож на установщик"))
		return
	}
	sums, err := download(base+"SHA256SUMS.txt", 1<<16)
	if err != nil {
		fail(fmt.Errorf("не удалось скачать контрольную сумму: %v", err))
		return
	}
	if err := verifySum(data, string(sums)); err != nil {
		fail(err)
		return
	}
	dir, err := os.MkdirTemp("", "bogestv0-vpn-update-")
	if err != nil {
		fail(err)
		return
	}
	path := filepath.Join(dir, setupAsset)
	if err := os.WriteFile(path, data, 0o755); err != nil {
		fail(err)
		return
	}
	writeStatus(UpdStatus{State: "installing", Tag: tag})
	cmd := exec.Command(path, "--update")
	cmd.Env = append(os.Environ(), "BOGESTV0_DEST="+baseDir, "BOGESTV0_NOPAUSE=1")
	detach(cmd)
	if err := cmd.Start(); err != nil {
		fail(fmt.Errorf("не удалось запустить установщик: %v", err))
		return
	}
	cmd.Process.Release()
}

// verifySum сверяет данные со строкой «<sha256>  Bogestv0-VPN-Setup.exe» из SHA256SUMS.txt.
func verifySum(data []byte, sums string) error {
	want := ""
	for _, l := range strings.Split(sums, "\n") {
		f := strings.Fields(l)
		if len(f) >= 2 && strings.TrimPrefix(f[1], "*") == setupAsset {
			want = strings.ToLower(f[0])
		}
	}
	h := sha256.Sum256(data)
	if want == "" || want != hex.EncodeToString(h[:]) {
		return errors.New("контрольная сумма не совпала — обновление отменено")
	}
	return nil
}

func download(url string, limit int64) ([]byte, error) {
	cl := &http.Client{Timeout: 5 * time.Minute}
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Bogestv0-VPN/"+appVersion)
	resp, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("сервер ответил %s", resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err == nil && int64(len(b)) > limit {
		err = errors.New("файл слишком большой")
	}
	return b, err
}

// cleanOldUpdates удаляет папки с установщиками прошлых обновлений.
func cleanOldUpdates() {
	m, _ := filepath.Glob(filepath.Join(os.TempDir(), "bogestv0-vpn-update-*"))
	for _, d := range m {
		os.RemoveAll(d)
	}
}

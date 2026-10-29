package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTagRe(t *testing.T) {
	for _, ok := range []string{"v1.3.0", "1.3.0", "v10.20.30"} {
		if !tagRe.MatchString(ok) {
			t.Errorf("%q должен подходить", ok)
		}
	}
	for _, bad := range []string{"", "v1.3", "1.3.0.1", "../x", "v1.3.0/../../a", "v1.3.0 --x", "latest", "v1.3.0\n"} {
		if tagRe.MatchString(bad) {
			t.Errorf("%q не должен подходить", bad)
		}
	}
}

func TestVerifySum(t *testing.T) {
	data := []byte("MZ" + strings.Repeat("x", 100))
	h := sha256.Sum256(data)
	sum := hex.EncodeToString(h[:])
	if err := verifySum(data, sum+"  "+setupAsset+"\n"); err != nil {
		t.Fatal(err)
	}
	if err := verifySum(data, sum+" *"+setupAsset+"\n"); err != nil {
		t.Fatal(err)
	}
	if verifySum(data, strings.Repeat("0", 64)+"  "+setupAsset+"\n") == nil {
		t.Error("чужая сумма принята")
	}
	if verifySum(data, sum+"  other.exe\n") == nil {
		t.Error("сумма для другого файла принята")
	}
	if verifySum(data, "") == nil {
		t.Error("пустой файл сумм принят")
	}
}

func setup(t *testing.T) string {
	d := t.TempDir()
	baseDir = d
	return d
}

func TestStatusIdleAndStale(t *testing.T) {
	d := setup(t)
	if r := updateStatus(); r["state"] != "idle" {
		t.Fatalf("ожидали idle: %v", r)
	}
	writeStatus(UpdStatus{State: "installing", Tag: "v1.3.0"})
	b, _ := os.ReadFile(filepath.Join(d, "update.json"))
	old := strings.Replace(string(b), `"at":`, `"at":1,"_":`, 1)
	os.WriteFile(filepath.Join(d, "update.json"), []byte(old), 0o600)
	if r := updateStatus(); r["state"] != "error" {
		t.Fatalf("зависшее обновление должно стать ошибкой: %v", r)
	}
}

func TestStartRejectsBadTag(t *testing.T) {
	setup(t)
	if r := updateStart("v1.3.0; calc"); r["ok"] != false {
		t.Fatalf("плохой тег принят: %v", r)
	}
}

func TestStartRejectsWhileBusy(t *testing.T) {
	setup(t)
	writeStatus(UpdStatus{State: "downloading", Tag: "v1.3.0"})
	if r := updateStart("v1.3.1"); r["ok"] != false {
		t.Fatalf("параллельное обновление принято: %v", r)
	}
}

// Полный путь без запуска установщика: скачать → проверить → положить; при неверной сумме — ошибка и ничего не запущено.
func TestDoUpdateChecksum(t *testing.T) {
	setup(t)
	data := []byte("MZ" + strings.Repeat("y", 2<<20))
	bad := strings.Repeat("0", 64) + "  " + setupAsset + "\n"
	sums := bad
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/a/b/releases/download/v9.9.9/" + setupAsset:
			w.Write(data)
		case "/a/b/releases/download/v9.9.9/SHA256SUMS.txt":
			w.Write([]byte(sums))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	oldBase, oldRepo := releaseBase, ghRepo
	releaseBase, ghRepo = srv.URL, "a/b"
	defer func() { releaseBase, ghRepo = oldBase, oldRepo }()

	doUpdate("v9.9.9")
	s, _ := readStatus()
	if s.State != "error" || !strings.Contains(s.Error, "контрольная сумма") {
		t.Fatalf("неверная сумма должна давать ошибку: %+v", s)
	}
	doUpdate("v8.8.8") // нет такого релиза
	if s, _ = readStatus(); s.State != "error" {
		t.Fatalf("404 должен давать ошибку: %+v", s)
	}
}

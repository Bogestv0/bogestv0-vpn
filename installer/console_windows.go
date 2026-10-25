//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

func setupConsole() {
	// UTF-8 в консоли, чтобы русский текст не превращался в кракозябры
	syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleOutputCP").Call(65001)
}

func hide(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

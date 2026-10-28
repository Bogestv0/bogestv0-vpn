//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

func detach(c *exec.Cmd) {
	// DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200 | 0x08000000, HideWindow: true}
}

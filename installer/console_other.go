//go:build !windows

package main

import "os/exec"

func setupConsole()    {}
func hide(c *exec.Cmd) {}

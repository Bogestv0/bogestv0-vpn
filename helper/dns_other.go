//go:build !windows

package main

func dnsUnsupported() M {
	return M{"ok": false, "error": "Смена DNS доступна только в Windows"}
}
func dnsStatus() M  { return dnsUnsupported() }
func dnsFix() M     { return dnsUnsupported() }
func dnsRestore() M { return dnsUnsupported() }

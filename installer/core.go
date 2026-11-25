// Rev Radar Setup - the parts that don't depend on Windows: the payload inside the setup file and
// replacing a folder safely. (Updates are not done here: the app downloads its new files itself
// and restarts onto them - no helper program, see electron/boot.cjs and electron/updater.cjs.)
package main

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"
)

const (
	appName   = "Rev Radar"
	exeName   = "Rev Radar.exe"
	setupName = "Rev Radar Setup.exe"
	magic     = "REVRDSET"
)

// version of this setup build (-ldflags "-X main.version=...")
var version = "0.0.0"

// Meta describes the payload appended to the setup file.
type Meta struct {
	Version string `json:"version"`
	Runtime string `json:"runtime"`
	Total   int64  `json:"total"` // bytes of all files
	Files   int    `json:"files"`
	SHA256  string `json:"sha256"` // of the compressed payload: checked before anything is unpacked
}

// InstallInfo is install.json in the app folder.
type InstallInfo struct {
	Scope     string `json:"scope"` // "user" | "machine"
	Version   string `json:"version"`
	Runtime   string `json:"runtime"`
	Desktop   bool   `json:"desktop"`
	Installed string `json:"installed"`
	// the names in the folder that the setup put there (top level): only these are ever replaced
	// or removed - anything else in the folder is the person's and stays
	Files []string `json:"files,omitempty"`
}

// Payload is the compressed app inside the setup file. The layout at the end of the file:
// [exe][payload][meta json][8: meta len][8: payload len][8: magic]
type Payload struct {
	Path    string
	ExeLen  int64
	Off     int64
	Len     int64
	Meta    Meta
	present bool
}

func openPayload(self string) (*Payload, error) {
	f, err := os.Open(self)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	p := &Payload{Path: self, ExeLen: st.Size()}
	end := payloadEnd(f, st.Size())
	if end < 24 {
		return p, nil
	}
	tail := make([]byte, 24)
	if _, err := f.ReadAt(tail, end-24); err != nil {
		return nil, err
	}
	if string(tail[16:]) != magic {
		return p, nil // the uninstaller kept in the app folder: no payload
	}
	ml := int64(binary.LittleEndian.Uint64(tail[0:8]))
	pl := int64(binary.LittleEndian.Uint64(tail[8:16]))
	metaOff := end - 24 - ml
	if ml <= 0 || pl <= 0 || metaOff-pl < 0 {
		return nil, errors.New("the setup file is damaged (bad trailer)")
	}
	mb := make([]byte, ml)
	if _, err := f.ReadAt(mb, metaOff); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(mb, &p.Meta); err != nil {
		return nil, fmt.Errorf("the setup file is damaged (meta): %w", err)
	}
	p.Off = metaOff - pl
	p.Len = pl
	p.ExeLen = p.Off
	p.present = true
	return p, nil
}

// payloadEnd is where the trailer ends: the end of the file - or, when the setup was code-signed
// after it was built, where the signature (appended at the end, after up to 7 bytes of padding)
// starts. Without this a signed setup found no payload and acted as the uninstaller.
func payloadEnd(f *os.File, size int64) int64 {
	off, n := securityDir(f)
	if off <= 0 || n <= 0 || int64(off)+int64(n) > size {
		return size
	}
	b := make([]byte, 8)
	for pad := int64(0); pad < 8; pad++ {
		e := int64(off) - pad
		if e < 24 {
			break
		}
		if _, err := f.ReadAt(b, e-8); err == nil && string(b) == magic {
			return e
		}
	}
	return size
}

// securityDir reads the PE header's certificate table entry (file offset, size; 0 if none)
// and where that entry is in the file.
func securityDir(f io.ReaderAt) (uint32, uint32) {
	off, n, _ := securityDirAt(f)
	return off, n
}
func securityDirAt(f io.ReaderAt) (uint32, uint32, int64) {
	h := make([]byte, 4)
	if _, err := f.ReadAt(h, 0x3c); err != nil {
		return 0, 0, 0
	}
	pe := int64(binary.LittleEndian.Uint32(h))
	sig := make([]byte, 4)
	if _, err := f.ReadAt(sig, pe); err != nil || string(sig) != "PE\x00\x00" {
		return 0, 0, 0
	}
	opt := pe + 4 + 20
	m := make([]byte, 2)
	if _, err := f.ReadAt(m, opt); err != nil {
		return 0, 0, 0
	}
	var dirs int64
	switch binary.LittleEndian.Uint16(m) {
	case 0x20b: // PE32+
		dirs = opt + 112
	case 0x10b:
		dirs = opt + 96
	default:
		return 0, 0, 0
	}
	at := dirs + 4*8 // entry 4: the certificate table
	e := make([]byte, 8)
	if _, err := f.ReadAt(e, at); err != nil {
		return 0, 0, 0
	}
	return binary.LittleEndian.Uint32(e[0:4]), binary.LittleEndian.Uint32(e[4:8]), at
}

// Extract unpacks the payload into dst (which must not exist yet). The payload is checked
// against its SHA-256 first: a setup damaged in copying never installs half-broken files.
func (p *Payload) Extract(dst string, prog func(done, total int64)) error {
	f, err := os.Open(p.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, io.NewSectionReader(f, p.Off, p.Len)); err != nil {
		return err
	}
	if p.Meta.SHA256 == "" || !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), p.Meta.SHA256) {
		return errors.New("the setup file is damaged (its contents don't match) - it may not have been copied completely. Get it again from where you got it")
	}
	dec, err := zstd.NewReader(io.NewSectionReader(f, p.Off, p.Len), zstd.WithDecoderMaxWindow(1<<30), zstd.WithDecoderMaxMemory(1<<31))
	if err != nil {
		return err
	}
	defer dec.Close()
	return untar(dec, dst, p.Meta.Total, prog)
}

func untar(r io.Reader, dst string, total int64, prog func(done, total int64)) error {
	tr := tar.NewReader(r)
	var done int64
	last := time.Time{}
	buf := make([]byte, 1<<20)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("the setup file is damaged: %w", err)
		}
		name, err := safeRel(h.Name)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		out := filepath.Join(dst, name)
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(out, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
				return err
			}
			w, err := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
			if err != nil {
				return err
			}
			for {
				n, rerr := tr.Read(buf)
				if n > 0 {
					if _, werr := w.Write(buf[:n]); werr != nil {
						w.Close()
						return werr
					}
					done += int64(n)
					if prog != nil && time.Since(last) > 80*time.Millisecond {
						prog(done, total)
						last = time.Now()
					}
				}
				if rerr == io.EOF {
					break
				}
				if rerr != nil {
					w.Close()
					return fmt.Errorf("the setup file is damaged: %w", rerr)
				}
			}
			if err := w.Close(); err != nil {
				return err
			}
		}
	}
	if prog != nil {
		prog(total, total)
	}
	return nil
}

// safeRel keeps archive paths inside the target folder.
func safeRel(name string) (string, error) {
	n := strings.TrimPrefix(strings.ReplaceAll(name, "\\", "/"), "./")
	n = strings.TrimSuffix(n, "/")
	if n == "" || n == "." {
		return "", nil
	}
	if strings.HasPrefix(n, "/") || strings.Contains(n, ":") {
		return "", fmt.Errorf("bad path in package: %s", name)
	}
	for _, part := range strings.Split(n, "/") {
		if part == ".." {
			return "", fmt.Errorf("bad path in package: %s", name)
		}
	}
	return filepath.FromSlash(n), nil
}

// copyExePart writes the setup program without its payload (kept in the app folder as the
// uninstaller - Windows' "Installed apps" runs it).
func (p *Payload) copyExePart(dst string) error {
	f, err := os.Open(p.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	tmp := dst + ".tmp"
	w, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(w, io.NewSectionReader(f, 0, p.ExeLen)); err != nil {
		w.Close()
		os.Remove(tmp)
		return err
	}
	// a signed setup: its header points at a signature this copy doesn't have - cleared (the
	// copy is simply unsigned, not "damaged")
	if off, n, at := securityDirAt(f); at > 0 && (off != 0 || n != 0) && int64(off) >= p.ExeLen {
		if _, err := w.WriteAt(make([]byte, 8), at); err != nil {
			w.Close()
			os.Remove(tmp)
			return err
		}
	}
	if err := w.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	os.Remove(dst)
	return os.Rename(tmp, dst)
}

// retry runs f until it works or the time is up (Explorer, antivirus or the closing app can
// hold files for a moment).
func retry(d time.Duration, f func() error) error {
	end := time.Now().Add(d)
	wait := 100 * time.Millisecond
	for {
		err := f()
		if err == nil || time.Now().After(end) {
			return err
		}
		time.Sleep(wait)
		if wait < time.Second {
			wait *= 2
		}
	}
}

// replaceDir fills a new copy of dir next to it, then swaps it in. Anything in the old folder that
// isn't ours (owned says what is) is moved into the new copy first: files a person put there stay.
// The old copy is put back if the swap fails, so a failed install never leaves a half-written app
// behind. Returns the names that were carried over.
func replaceDir(dir string, fill func(tmp string) error, owned func(name string) bool) ([]string, error) {
	// (names of our own: a folder of the person's called "<name>.new" / ".old" is never touched)
	tag := strconv.FormatInt(time.Now().UnixNano()%1e9, 36)
	tmp := dir + ".revradar-new-" + tag
	cleanLeftovers(dir)
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return nil, err
	}
	if err := fill(tmp); err != nil {
		_ = os.RemoveAll(tmp)
		return nil, err
	}
	if _, err := os.Stat(dir); err != nil {
		if err := retry(5*time.Second, func() error { return os.Rename(tmp, dir) }); err != nil {
			_ = os.RemoveAll(tmp)
			return nil, err
		}
		return nil, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		_ = os.RemoveAll(tmp)
		return nil, err
	}
	var carried []string
	type move struct{ from, to string }
	var moves []move
	putBack := func() {
		for _, m := range moves {
			_ = os.Rename(filepath.Join(tmp, m.to), filepath.Join(dir, m.from))
		}
	}
	for _, e := range entries {
		n := e.Name()
		if owned(n) {
			continue
		}
		// a file of the person's under a name the new copy brings too: kept under a name of its own,
		// not dropped with the old folder (RR-041)
		to := n
		if fileExists(filepath.Join(tmp, n)) {
			to = keptName(tmp, n)
		}
		if err := os.Rename(filepath.Join(dir, n), filepath.Join(tmp, to)); err != nil {
			logf("carry over %s: %v", n, err)
			putBack()
			_ = os.RemoveAll(tmp)
			return nil, fmt.Errorf("%s in %s is in use - close it and try again; nothing was changed", n, dir)
		}
		moves = append(moves, move{n, to})
		carried = append(carried, to)
	}
	old := dir + ".revradar-old-" + tag
	if err := retry(8*time.Second, func() error { return os.Rename(dir, old) }); err != nil {
		// something still holds a file in the old folder (an Explorer window, an antivirus):
		// nothing is changed - copying over it could stop halfway and leave old and new mixed
		logf("rename of the old folder failed: %v", err)
		putBack()
		_ = os.RemoveAll(tmp)
		return nil, fmt.Errorf("a file in %s is in use (an Explorer window showing that folder, or an antivirus scan) - close it and try again; nothing was changed", dir)
	}
	if err := retry(5*time.Second, func() error { return os.Rename(tmp, dir) }); err != nil {
		_ = os.Rename(old, dir)
		putBack()
		_ = os.RemoveAll(tmp)
		return nil, err
	}
	if err := os.RemoveAll(old); err != nil {
		logf("old folder left behind: %v", err)
	}
	if len(carried) > 0 {
		logf("kept in the folder (not the setup's): %v", carried)
	}
	return carried, nil
}

// keptName: a name in tmp for the person's file n that the new copy also brings ("notes.txt" ->
// "notes (yours).txt", then "notes (yours 2).txt", ...).
func keptName(tmp, n string) string {
	ext := filepath.Ext(n)
	stem := strings.TrimSuffix(n, ext)
	for k := 1; ; k++ {
		tag := " (yours)"
		if k > 1 {
			tag = fmt.Sprintf(" (yours %d)", k)
		}
		c := stem + tag + ext
		if !fileExists(filepath.Join(tmp, c)) {
			return c
		}
	}
}

// cleanLeftovers removes what an earlier, interrupted run left next to dir (our own names only),
// unless it is recent: it may belong to a setup that is running right now.
func cleanLeftovers(dir string) {
	left, _ := filepath.Glob(globEscape(dir) + ".revradar-*")
	for _, l := range left {
		if fi, err := os.Stat(l); err == nil && time.Since(fi.ModTime()) > 30*time.Minute {
			_ = os.RemoveAll(l)
		}
	}
}

// layoutName: a name the Rev Radar program folder has (the Electron runtime and the app) - how an
// older hand-made copy, which has no list of its files, is told apart from the person's own files.
func layoutName(n string) bool {
	l := strings.ToLower(n)
	switch l {
	case strings.ToLower(exeName), strings.ToLower(setupName), "install.json", "update.json", "resources", "locales",
		"license", "licenses.chromium.html", "version", "vk_swiftshader_icd.json", "swiftshader":
		return true
	}
	switch strings.ToLower(filepath.Ext(l)) {
	case ".dll", ".pak", ".bin", ".dat":
		return true
	}
	return false
}

// ownedBy: what in an installed (or older hand-made) folder is the setup's to replace or remove.
func ownedBy(ii *InstallInfo) func(string) bool {
	if ii != nil && len(ii.Files) > 0 {
		set := map[string]bool{}
		for _, f := range ii.Files {
			set[strings.ToLower(f)] = true
		}
		return func(n string) bool { return set[strings.ToLower(n)] }
	}
	return layoutName
}

// globEscape: a folder name used literally in a pattern ([, *, ? are pattern characters).
func globEscape(s string) string {
	return strings.NewReplacer("[", "[[]", "*", "[*]", "?", "[?]").Replace(s)
}

func readJSON(p string, v any) error {
	b, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func writeJSON(p string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func readInstall(dir string) (*InstallInfo, error) {
	var ii InstallInfo
	if err := readJSON(filepath.Join(dir, "install.json"), &ii); err != nil {
		return nil, err
	}
	return &ii, nil
}

// versionLess compares dotted numbers: 0.3.10 > 0.3.9.
func versionLess(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x < y
		}
	}
	return false
}

// dirSizeKB for the "Installed apps" list.
func dirSizeKB(dir string) uint32 {
	var n int64
	_ = filepath.Walk(dir, func(_ string, fi os.FileInfo, err error) error {
		if err == nil && !fi.IsDir() {
			n += fi.Size()
		}
		return nil
	})
	return uint32(n / 1024)
}

// storeDir: where the app keeps the copies it downloaded itself (electron/boot.cjs).
func storeDir() string { return filepath.Join(userDataDirs()[1], "app") }

func plainVersion(v string) bool {
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return false
	}
	for _, p := range parts {
		if _, err := strconv.Atoi(p); err != nil || p == "" {
			return false
		}
	}
	return true
}

// runningVersion: the version Rev Radar really starts with for this person - the installed one,
// a newer copy it downloaded itself, or the one they went back to (as electron/boot.cjs picks).
func runningVersion(installed, runtime string) string {
	store := storeDir()
	good := func(v string) bool {
		d := filepath.Join(store, v)
		var ready, pk struct {
			Version string `json:"version"`
			Runtime string `json:"runtime"`
		}
		if readJSON(filepath.Join(d, "ready.json"), &ready) != nil || readJSON(filepath.Join(d, "package.json"), &pk) != nil {
			return false
		}
		if ready.Version != v || pk.Version != v || (ready.Runtime != "" && runtime != "" && ready.Runtime != runtime) {
			return false
		}
		return fileExists(filepath.Join(d, "electron", "main.cjs")) && !fileExists(filepath.Join(d, "bad.json"))
	}
	var pin struct {
		Use string `json:"use"`
	}
	if readJSON(filepath.Join(store, "choice.json"), &pin) == nil && pin.Use != "" && (pin.Use == installed || good(pin.Use)) {
		return pin.Use
	}
	best := installed
	entries, _ := os.ReadDir(store)
	for _, e := range entries {
		if n := e.Name(); plainVersion(n) && versionLess(best, n) && good(n) {
			best = n
		}
	}
	return best
}

// ---------------------------------------------------------------- 0.6.1 T44, DECISIONS 152
// While Windows asks for admin rights, the file it will start is this setup, by path - another program running as the
// person could rename it and put its own there. So the setup holds its own file (read, shared for reading only: no
// rename, no delete, no write by anyone) from before the request until the admin side's first line arrives (its
// program is loaded by then) or the start fails; then lets go - the admin side must be able to move the uninstaller
// out of the app folder itself (park). Not closed: a swap before the setup's first instruction; only a code-signing
// certificate answers the prompt itself.

// errNotHeld: the file could not be held - the setup does not ask for admin rights
type errNotHeld struct{ err error }

func (e errNotHeld) Error() string {
	return "Rev Radar Setup could not lock its own file before asking Windows for admin rights (" + e.err.Error() + "), so it did not ask - nothing was changed. If another program has the setup file open, close it; or copy the setup file to a folder on this PC and run it from there."
}

// startHeld: hold `path`, then start it; let go on `started` (the first line) or when start returns, never before.
func startHeld(path string, hold func(string) (func(), error), start func(string) (uint32, error), started <-chan struct{}) (uint32, error) {
	release, err := hold(path)
	if err != nil {
		logf("hold %s: %v", path, err)
		return 0, errNotHeld{err}
	}
	var once sync.Once
	free := func() { once.Do(release) }
	stop := make(chan struct{})
	go func() {
		select {
		case <-started:
			free()
		case <-stop:
		}
	}()
	code, err := start(path)
	close(stop)
	free()
	return code, err
}

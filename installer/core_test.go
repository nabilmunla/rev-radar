//go:build !windows

package main

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// fakeSetup writes an "exe" with a payload holding files (path -> content).
func fakeSetup(t *testing.T, dir, ver string, files map[string]string) string {
	t.Helper()
	var tb bytes.Buffer
	tw := tar.NewWriter(&tb)
	var total int64
	for name, body := range files {
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(body))
		total += int64(len(body))
	}
	tw.Close()
	var zb bytes.Buffer
	zw, _ := zstd.NewWriter(&zb)
	_, _ = zw.Write(tb.Bytes())
	zw.Close()
	sum := sha256.Sum256(zb.Bytes())
	meta, _ := json.Marshal(Meta{Version: ver, Runtime: "44.5.1", Total: total, Files: len(files), SHA256: hex.EncodeToString(sum[:])})
	exe := []byte("MZ-this-is-the-program-part")
	var out bytes.Buffer
	out.Write(exe)
	out.Write(zb.Bytes())
	out.Write(meta)
	n := make([]byte, 8)
	binary.LittleEndian.PutUint64(n, uint64(len(meta)))
	out.Write(n)
	binary.LittleEndian.PutUint64(n, uint64(zb.Len()))
	out.Write(n)
	out.WriteString(magic)
	p := filepath.Join(dir, "setup-"+ver+".exe")
	if err := os.WriteFile(p, out.Bytes(), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func appFiles(ver string) map[string]string {
	return map[string]string{
		exeName:                         "electron",
		"resources/app/package.json":    `{"version":"` + ver + `"}`,
		"resources/app/dist/index.html": "<html>" + ver,
		"locales/en-US.pak":             "pak",
	}
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func setupTest(t *testing.T) string {
	root := t.TempDir()
	testRoot = root
	logPath = filepath.Join(root, "setup.log")
	return root
}

func TestPayloadInstallUpdateUninstall(t *testing.T) {
	root := setupTest(t)
	s1 := fakeSetup(t, root, "0.4.0", appFiles("0.4.0"))
	p, err := openPayload(s1)
	if err != nil || !p.present || p.Meta.Version != "0.4.0" {
		t.Fatalf("payload: %v %+v", err, p)
	}
	dir := filepath.Join(root, "Programs", appName)
	var last float64
	err = doInstall(p, Options{Scope: "user", Dir: dir, Desktop: true}, func(pct float64, _ string) { last = pct })
	if err != nil {
		t.Fatal(err)
	}
	if last != 1 {
		t.Errorf("progress ended at %v", last)
	}
	if read(t, filepath.Join(dir, "resources/app/dist/index.html")) != "<html>0.4.0" {
		t.Error("files not extracted")
	}
	// the uninstaller is the program part only
	if read(t, filepath.Join(dir, setupName)) != "MZ-this-is-the-program-part" {
		t.Error("the uninstaller should be the exe part without the payload")
	}
	hp, _ := openPayload(filepath.Join(dir, setupName))
	if hp.present {
		t.Error("the uninstaller must not have a payload")
	}
	// (0.5.0 on: updates come from GitHub - no updates folder is written)
	if fileExists(filepath.Join(dir, "update.json")) {
		t.Error("update.json was written")
	}
	ii, _ := readInstall(dir)
	if ii == nil || ii.Version != "0.4.0" || ii.Scope != "user" || !ii.Desktop {
		t.Errorf("install.json: %+v", ii)
	}

	// full setup 0.5.0 over it: old folder replaced, nothing left over
	s2 := fakeSetup(t, root, "0.5.0", map[string]string{exeName: "electron2", "resources/app/package.json": `{"version":"0.5.0"}`})
	p2, _ := openPayload(s2)
	if err := doInstall(p2, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if fileExists(filepath.Join(dir, "locales/en-US.pak")) || fileExists(dir+".old") || fileExists(dir+".new") {
		t.Error("old files / temp folders left behind")
	}
	if fileExists(filepath.Join(dir, "update.json")) {
		t.Error("cleared updates folder should remove update.json")
	}

	// uninstall removes the folder
	if err := doUninstall(dir, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if fileExists(dir) {
		t.Error("folder still there")
	}
}

func TestNeverDeletesOtherFolders(t *testing.T) {
	root := setupTest(t)
	docs := filepath.Join(root, "Documents")
	os.MkdirAll(docs, 0o755)
	os.WriteFile(filepath.Join(docs, "tender.xlsx"), []byte("x"), 0o644)
	if err := doUninstall(docs, func(float64, string) {}); err == nil {
		t.Error("uninstall must refuse a folder that isn't an install")
	}
	s := fakeSetup(t, root, "0.4.0", appFiles("0.4.0"))
	p, _ := openPayload(s)
	if err := doInstall(p, Options{Scope: "user", Dir: docs}, func(float64, string) {}); err == nil {
		t.Error("install must refuse a folder with other files")
	}
	if read(t, filepath.Join(docs, "tender.xlsx")) != "x" {
		t.Error("the person's file was touched")
	}
	if msg := checkDir("user", docs); msg == "" {
		t.Error("checkDir should warn about a folder with other files")
	}
	if msg := checkDir("user", "relative\\path"); msg == "" {
		t.Error("checkDir should want a full path")
	}
	if looksInstalled(filepath.VolumeName(root) + string(os.PathSeparator)) {
		t.Error("a drive root is never an install")
	}
}

func TestSafeRelAndVersions(t *testing.T) {
	for _, bad := range []string{"../x", "a/../../x", "/etc/passwd", "C:/Windows/x"} {
		if _, err := safeRel(bad); err == nil {
			t.Errorf("%s should be refused", bad)
		}
	}
	if r, _ := safeRel("./resources/app/x.js"); r != filepath.FromSlash("resources/app/x.js") {
		t.Errorf("got %s", r)
	}
	cases := [][2]string{{"0.3.9", "0.3.10"}, {"0.4.0", "0.4.1"}, {"0.9", "1.0.0"}, {"1.2.3", "1.10.0"}}
	for _, c := range cases {
		if !versionLess(c[0], c[1]) || versionLess(c[1], c[0]) {
			t.Errorf("%s < %s", c[0], c[1])
		}
	}
	if versionLess("0.4.0", "0.4.0") {
		t.Error("equal is not less")
	}
}

func TestDamagedSetup(t *testing.T) {
	root := setupTest(t)
	s := fakeSetup(t, root, "0.4.0", appFiles("0.4.0"))
	b, _ := os.ReadFile(s)
	// cut a chunk out of the middle of the payload
	cut := append(append([]byte{}, b[:40]...), b[60:]...)
	os.WriteFile(s, cut, 0o755)
	p, err := openPayload(s)
	if err == nil && p.present {
		if err := p.Extract(filepath.Join(root, "x"), nil); err == nil {
			t.Error("a damaged payload should fail to extract")
		}
	}
	dir := filepath.Join(root, "Programs", appName)
	if err == nil && p.present {
		if err := doInstall(p, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err == nil {
			t.Error("install from a damaged setup should fail")
		}
		if fileExists(dir) || fileExists(dir+".new") {
			t.Error("a failed install must leave nothing behind")
		}
	}
}

func TestReplaceKeepsOldOnFailure(t *testing.T) {
	root := setupTest(t)
	dir := filepath.Join(root, "app")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "a"), []byte("old"), 0o644)
	ours := func(n string) bool { return n == "b" }
	_, err := replaceDir(dir, func(tmp string) error { os.MkdirAll(tmp, 0o755); return os.ErrInvalid }, ours)
	if err == nil || read(t, filepath.Join(dir, "a")) != "old" || fileExists(dir+".new") {
		t.Error("a failed fill must keep the old folder")
	}
	// "a" isn't ours: it is carried into the new copy; "b" is replaced
	os.WriteFile(filepath.Join(dir, "b"), []byte("older"), 0o644)
	carried, err := replaceDir(dir, func(tmp string) error {
		os.MkdirAll(tmp, 0o755)
		return os.WriteFile(filepath.Join(tmp, "b"), []byte("new"), 0o644)
	}, ours)
	if err != nil || read(t, filepath.Join(dir, "b")) != "new" || read(t, filepath.Join(dir, "a")) != "old" || len(carried) != 1 {
		t.Errorf("replace keeping the person's file: %v %v", err, carried)
	}
	// a file of the person's under a name the new copy brings too: kept beside it (RR-041)
	os.WriteFile(filepath.Join(dir, "NOTICE.txt"), []byte("mine"), 0o644)
	carried, err = replaceDir(dir, func(tmp string) error {
		os.MkdirAll(tmp, 0o755)
		os.WriteFile(filepath.Join(tmp, "b"), []byte("new"), 0o644)
		return os.WriteFile(filepath.Join(tmp, "NOTICE.txt"), []byte("ours"), 0o644)
	}, ours)
	if err != nil || read(t, filepath.Join(dir, "NOTICE.txt")) != "ours" || read(t, filepath.Join(dir, "NOTICE (yours).txt")) != "mine" {
		t.Errorf("a clash must keep the person's file under its own name: %v %v", err, carried)
	}
}

// a minimal PE header: e_lfanew at 0x3c -> "PE\0\0", COFF header, PE32+ optional header with the
// certificate table entry (data directory 4)
func peHeader() ([]byte, int) {
	h := make([]byte, 0x200)
	h[0], h[1] = 'M', 'Z'
	binary.LittleEndian.PutUint32(h[0x3c:], 0x80)
	copy(h[0x80:], "PE\x00\x00")
	opt := 0x80 + 4 + 20
	binary.LittleEndian.PutUint16(h[opt:], 0x20b)
	return h, opt + 112 + 4*8
}

func TestSignedSetupStillFindsItsPayload(t *testing.T) {
	root := setupTest(t)
	plain := fakeSetup(t, root, "1.0.0", appFiles("1.0.0"))
	body, _ := os.ReadFile(plain)
	hdr, at := peHeader()
	exe := append(append([]byte{}, hdr...), body...)
	// signing: padded to 8 bytes, the certificate table appended, the header pointing at it
	for len(exe)%8 != 0 {
		exe = append(exe, 0)
	}
	cert := bytes.Repeat([]byte{0xA5}, 1500)
	binary.LittleEndian.PutUint32(exe[at:], uint32(len(exe)))
	binary.LittleEndian.PutUint32(exe[at+4:], uint32(len(cert)))
	exe = append(exe, cert...)
	signed := filepath.Join(root, "signed.exe")
	os.WriteFile(signed, exe, 0o755)
	p, err := openPayload(signed)
	if err != nil || !p.present || p.Meta.Version != "1.0.0" {
		t.Fatalf("signed setup: payload not found (%v, %+v)", err, p)
	}
	dir := filepath.Join(root, "inst")
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dir, "resources", "app", "package.json")) == "" {
		t.Error("not installed from the signed setup")
	}
	// the uninstaller: exe part only, its certificate entry cleared, no payload
	h, _ := os.ReadFile(filepath.Join(dir, setupName))
	if binary.LittleEndian.Uint64(h[at:]) != 0 {
		t.Error("the uninstaller still points at a signature it does not have")
	}
	if q, _ := openPayload(filepath.Join(dir, setupName)); q == nil || q.present {
		t.Error("the uninstaller must have no payload")
	}
}

func TestSwapLeavesNeighboursAlone(t *testing.T) {
	root := setupTest(t)
	dir := filepath.Join(root, "Work")
	for _, n := range []string{"Work.old", "Work.new"} {
		os.MkdirAll(filepath.Join(root, n), 0o755)
		os.WriteFile(filepath.Join(root, n, "mine.txt"), []byte("keep"), 0o644)
	}
	setup := fakeSetup(t, root, "1.0.0", appFiles("1.0.0"))
	p, _ := openPayload(setup)
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if err := doUninstall(dir, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"Work.old", "Work.new"} {
		if read(t, filepath.Join(root, n, "mine.txt")) != "keep" {
			t.Errorf("%s was touched", n)
		}
	}
	if left, _ := filepath.Glob(dir + ".revradar-*"); len(left) > 0 {
		t.Errorf("left behind: %v", left)
	}
}

func TestInstallFilesAreInBeforeTheSwap(t *testing.T) {
	root := setupTest(t)
	dir := filepath.Join(root, "inst")
	setup := fakeSetup(t, root, "1.0.0", appFiles("1.0.0"))
	p, _ := openPayload(setup)
	// the swap is the last step: watch what the new folder holds at that moment
	var seen []string
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, func(pct float64, stage string) {
		if pct >= 0.92 && seen == nil {
			for _, f := range []string{"install.json", setupName} {
				if fileExists(filepath.Join(dir, f)) {
					seen = append(seen, f)
				}
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 2 {
		t.Errorf("when the folder appeared it held only %v", seen)
	}
}

func TestOlderHandMadeCopyIsReplaced(t *testing.T) {
	root := setupTest(t)
	old := filepath.Join(root, "Program Files", "Rev Radar")
	os.MkdirAll(filepath.Join(old, "resources", "app"), 0o755)
	os.WriteFile(filepath.Join(old, exeName), []byte("old electron"), 0o755)
	os.WriteFile(filepath.Join(old, "resources", "app", "package.json"), []byte(`{"name":"rev-radar","productName":"Rev Radar","version":"0.2.2","main":"electron/main.cjs"}`), 0o644)
	if v := olderCopy(old); v != "0.2.2" {
		t.Fatalf("older copy not recognised: %q", v)
	}
	if msg := checkDir("user", old); msg != "" {
		t.Fatalf("checkDir refused the older copy: %s", msg)
	}
	setup := fakeSetup(t, root, "1.0.0", appFiles("1.0.0"))
	p, _ := openPayload(setup)
	if err := doInstall(p, Options{Scope: "user", Dir: old}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if !looksInstalled(old) || read(t, filepath.Join(old, "resources", "app", "dist", "index.html")) != "<html>1.0.0" {
		t.Error("the older copy was not replaced by the new version")
	}
	// anything that only looks a bit like it is still refused
	other := filepath.Join(root, "Tools")
	os.MkdirAll(filepath.Join(other, "resources", "app"), 0o755)
	os.WriteFile(filepath.Join(other, exeName), []byte("x"), 0o755)
	os.WriteFile(filepath.Join(other, "resources", "app", "package.json"), []byte(`{"productName":"Something else","main":"main.js"}`), 0o644)
	if olderCopy(other) != "" || checkDir("user", other) == "" {
		t.Error("a different program's folder must not count as an older copy")
	}
	if err := doInstall(p, Options{Scope: "user", Dir: other}, func(float64, string) {}); err == nil {
		t.Error("installing over a different program's folder must be refused")
	}
}

func TestPersonsFilesInTheFolderStay(t *testing.T) {
	root := setupTest(t)
	t.Setenv("TMPDIR", filepath.Join(root, "tmp"))
	os.MkdirAll(filepath.Join(root, "tmp"), 0o755)
	dir := filepath.Join(root, "Tools")
	p1, _ := openPayload(fakeSetup(t, root, "1.0.0", appFiles("1.0.0")))
	if err := doInstall(p1, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	ii, _ := readInstall(dir)
	if ii == nil || len(ii.Files) < 4 {
		t.Fatalf("install.json lists no files: %+v", ii)
	}
	// the person puts things in the folder afterwards
	os.MkdirAll(filepath.Join(dir, "OtherTool"), 0o755)
	os.WriteFile(filepath.Join(dir, "OtherTool", "tool.exe"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "tender notes.xlsx"), []byte("mine"), 0o644)
	p2, _ := openPayload(fakeSetup(t, root, "1.1.0", appFiles("1.1.0")))
	if err := doInstall(p2, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dir, "tender notes.xlsx")) != "mine" || !fileExists(filepath.Join(dir, "OtherTool", "tool.exe")) {
		t.Fatal("an update deleted the person's files in the folder")
	}
	if read(t, filepath.Join(dir, "resources", "app", "dist", "index.html")) != "<html>1.1.0" {
		t.Fatal("not updated")
	}
	if err := doUninstall(dir, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dir, "tender notes.xlsx")) != "mine" || !fileExists(filepath.Join(dir, "OtherTool", "tool.exe")) {
		t.Fatal("uninstall deleted the person's files in the folder")
	}
	for _, n := range []string{exeName, setupName, "install.json", "resources", "locales"} {
		if fileExists(filepath.Join(dir, n)) {
			t.Errorf("%s left after uninstall", n)
		}
	}
	// the uninstaller was moved out of the folder, not started anywhere - and then deleted
	if left, _ := filepath.Glob(filepath.Join(root, "tmp", "Rev Radar Setup (removed *).exe")); len(left) > 0 {
		t.Errorf("moved uninstaller not deleted: %v", left)
	}
}

func TestUninstallEmptiesAndRemovesTheFolder(t *testing.T) {
	root := setupTest(t)
	t.Setenv("TMPDIR", root)
	dir := filepath.Join(root, "inst")
	p, _ := openPayload(fakeSetup(t, root, "1.0.0", appFiles("1.0.0")))
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if err := doUninstall(dir, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if fileExists(dir) {
		t.Error("the emptied folder should go")
	}
}

func TestOlderCopyTakeoverKeepsExports(t *testing.T) {
	root := setupTest(t)
	old := filepath.Join(root, "Program Files", "Rev Radar")
	os.MkdirAll(filepath.Join(old, "resources", "app"), 0o755)
	os.MkdirAll(filepath.Join(old, "My exports"), 0o755)
	os.WriteFile(filepath.Join(old, "My exports", "Tower clouded.pdf"), []byte("pdf"), 0o644)
	os.WriteFile(filepath.Join(old, exeName), []byte("old electron"), 0o755)
	os.WriteFile(filepath.Join(old, "ffmpeg.dll"), []byte("dll"), 0o644)
	os.WriteFile(filepath.Join(old, "resources", "app", "package.json"), []byte(`{"productName":"Rev Radar","version":"0.2.2","main":"electron/main.cjs"}`), 0o644)
	p, _ := openPayload(fakeSetup(t, root, "1.0.0", appFiles("1.0.0")))
	if err := doInstall(p, Options{Scope: "user", Dir: old}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(old, "My exports", "Tower clouded.pdf")) != "pdf" {
		t.Error("taking over the older copy deleted the person's exports")
	}
	if fileExists(filepath.Join(old, "ffmpeg.dll")) {
		t.Error("the older copy's own runtime files should be replaced")
	}
}

func TestDamagedPayloadInstallsNothing(t *testing.T) {
	root := setupTest(t)
	dir := filepath.Join(root, "inst")
	s1 := fakeSetup(t, root, "1.0.0", appFiles("1.0.0"))
	p1, _ := openPayload(s1)
	if err := doInstall(p1, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	s2 := fakeSetup(t, root, "1.1.0", appFiles("1.1.0"))
	b, _ := os.ReadFile(s2)
	p2, _ := openPayload(s2)
	b[p2.Off+p2.Len/2] ^= 0x40 // one bit in the middle of the payload
	os.WriteFile(s2, b, 0o755)
	p2, _ = openPayload(s2)
	if err := doInstall(p2, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err == nil || !strings.Contains(err.Error(), "damaged") {
		t.Fatalf("a damaged payload must be refused, got %v", err)
	}
	if read(t, filepath.Join(dir, "resources", "app", "dist", "index.html")) != "<html>1.0.0" {
		t.Error("the installed copy was changed by a damaged setup")
	}
}

func TestFixArgs(t *testing.T) {
	got := fixArgs([]string{"--silent", "--updates", `\\srv\Software\Rev Radar" --no-desktop`})
	want := []string{"--silent", "--updates", `\\srv\Software\Rev Radar`, "--no-desktop"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("fixArgs: %q", got)
	}
}

func TestOldUpdatesFolderIsDroppedOnInstallOver(t *testing.T) {
	// a copy installed by a setup before 0.5.0 has update.json (its updates folder): installed over,
	// it goes - the app no longer reads it, and nothing should point at the old share
	root := setupTest(t)
	dir := filepath.Join(root, "inst")
	s1 := fakeSetup(t, root, "0.4.5", appFiles("0.4.5"))
	p1, _ := openPayload(s1)
	if err := doInstall(p1, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "update.json"), []byte(`{"source":"\\\\server\\Software\\Rev Radar"}`), 0o644)
	var ii InstallInfo
	readJSON(filepath.Join(dir, "install.json"), &ii)
	ii.Files = append(ii.Files, "update.json")
	writeJSON(filepath.Join(dir, "install.json"), ii)
	s2 := fakeSetup(t, root, "0.5.0", appFiles("0.5.0"))
	p2, _ := openPayload(s2)
	if err := doInstall(p2, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if fileExists(filepath.Join(dir, "update.json")) {
		t.Error("the old update.json is still there")
	}
}

func TestRunningVersionSeesTheStore(t *testing.T) {
	root := setupTest(t)
	store := storeDir()
	mk := func(v, rt string, bad bool) {
		d := filepath.Join(store, v)
		os.MkdirAll(filepath.Join(d, "electron"), 0o755)
		os.WriteFile(filepath.Join(d, "electron", "main.cjs"), []byte("//"), 0o644)
		os.WriteFile(filepath.Join(d, "package.json"), []byte(`{"version":"`+v+`"}`), 0o644)
		os.WriteFile(filepath.Join(d, "ready.json"), []byte(`{"version":"`+v+`","runtime":"`+rt+`"}`), 0o644)
		if bad {
			os.WriteFile(filepath.Join(d, "bad.json"), []byte(`{}`), 0o644)
		}
	}
	_ = root
	if v := runningVersion("0.3.0", "44.9.3"); v != "0.3.0" {
		t.Errorf("empty store: %s", v)
	}
	mk("0.3.2", "44.9.3", false)
	mk("0.3.5", "44.9.3", true)
	mk("0.4.0", "45.0.0", false)
	if v := runningVersion("0.3.0", "44.9.3"); v != "0.3.2" {
		t.Errorf("store copy not seen: %s", v)
	}
	os.WriteFile(filepath.Join(store, "choice.json"), []byte(`{"use":"0.3.0"}`), 0o644)
	if v := runningVersion("0.3.0", "44.9.3"); v != "0.3.0" {
		t.Errorf("going back not seen: %s", v)
	}
}

func TestWorkerTakesItsJobFromTheCommandLine(t *testing.T) {
	root := setupTest(t)
	dir := filepath.Join(root, "inst")
	p, _ := openPayload(fakeSetup(t, root, "1.0.0", appFiles("1.0.0")))
	b, _ := json.Marshal(Job{Kind: "install", Opts: Options{Scope: "user", Dir: dir}})
	if code := runWorker(p, base64.StdEncoding.EncodeToString(b)); code != workerOK || !looksInstalled(dir) {
		t.Fatalf("worker install: %d", code)
	}
	if code := runWorker(p, "not a job"); code != workerBadJob {
		t.Errorf("a bad job: %d", code)
	}
}

func TestReinstallIntoAFolderLeftWithThePersonsFiles(t *testing.T) {
	root := setupTest(t)
	t.Setenv("TMPDIR", root)
	dir := filepath.Join(root, "Programs", "Rev Radar")
	p, _ := openPayload(fakeSetup(t, root, "1.0.0", appFiles("1.0.0")))
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("mine"), 0o644)
	if err := doUninstall(dir, func(float64, string) {}); err != nil {
		t.Fatal(err)
	}
	if msg := checkDir("user", dir); msg != "" {
		t.Fatalf("installing again where the person's file was left is refused: %s", msg)
	}
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, func(float64, string) {}); err != nil || read(t, filepath.Join(dir, "notes.txt")) != "mine" {
		t.Fatalf("reinstall: %v", err)
	}
	other := filepath.Join(root, "Tools")
	os.MkdirAll(other, 0o755)
	os.WriteFile(filepath.Join(other, "notes.txt"), []byte("x"), 0o644)
	if checkDir("user", other) == "" {
		t.Error("any other folder with files in it is still refused")
	}
}

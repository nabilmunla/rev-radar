// Rev Radar Setup: one file that installs Rev Radar (for everyone on the PC, or just for you) and
// - as the copy kept in the app folder - uninstalls it.
//
//	Rev Radar Setup.exe                          install (window; plain prompts without WebView2)
//	  --silent [--just-me] [--dir D] [--no-desktop]
//	  (--updates <folder>: accepted and ignored - from 0.5.0 updates come from GitHub only)
//	--uninstall [--dir D] [--silent]             (also: the copy in the app folder started with no arguments)
//
// There is no update helper: the app downloads its new files and restarts onto them itself
// (company antivirus blocks helper programs started from AppData - Rev Radar never starts one).
package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Options are the choices made in the window (or on the command line).
type Options struct {
	Scope   string `json:"scope"` // "user" | "machine"
	Dir     string `json:"dir"`
	Desktop bool   `json:"desktop"`
}

var (
	errRunning      = errors.New("Rev Radar is open")
	errAdminRefused = errors.New("administrator permission was not given")
)

// reporter: how the elevated worker tells the window how far it is
type reporter interface {
	send(line string)
	close()
}

type nopReporter struct{}

func (nopReporter) send(string) {}
func (nopReporter) close()      {}

type progressFn func(pct float64, stage string)

var (
	logMu   sync.Mutex
	logPath string
)

func initLog() {
	logPath = filepath.Join(os.TempDir(), "Rev Radar Setup.log")
	if fi, err := os.Stat(logPath); err == nil && fi.Size() > 1<<20 {
		_ = os.Remove(logPath)
	}
}

func logf(format string, a ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s [%d] %s\n", time.Now().Format("2006-01-02 15:04:05"), os.Getpid(), fmt.Sprintf(format, a...))
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// plainUI: --plain - plain Windows prompts instead of the setup window (if that window misbehaves)
var plainUI bool

// canWrite: can this process create files in dir (made if missing)?
func canWrite(dir string) bool {
	probe := dir
	for !fileExists(probe) {
		parent := filepath.Dir(probe)
		if parent == probe {
			return false
		}
		probe = parent
	}
	f, err := os.CreateTemp(probe, ".revradar-write-test-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	_ = os.Remove(name)
	return true
}

// looksInstalled: never delete a folder that isn't a Rev Radar install.
func looksInstalled(dir string) bool {
	d := filepath.Clean(dir)
	if len(d) < 6 || filepath.Dir(d) == d {
		return false
	}
	return fileExists(filepath.Join(d, exeName)) && fileExists(filepath.Join(d, "install.json"))
}

// keptAfterUninstall: a "Rev Radar" folder that holds only what the person put there (an uninstall
// leaves those files) - installing into it again is fine: none of its names are the program's.
func keptAfterUninstall(dir string) bool {
	if !strings.EqualFold(filepath.Base(filepath.Clean(dir)), appName) {
		return false
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if layoutName(e.Name()) || strings.HasPrefix(e.Name(), ".revradar-") {
			return false
		}
	}
	return true
}

// olderCopy: a Rev Radar folder from before the setup existed (the portable copy, unzipped or put
// there by the install script) - the app is there, an install record isn't. Its version, or ""
// when the folder is anything else. Strict on purpose: only such a folder may be replaced like an
// install.
func olderCopy(dir string) string {
	d := filepath.Clean(dir)
	if len(d) < 6 || filepath.Dir(d) == d || fileExists(filepath.Join(d, "install.json")) || !fileExists(filepath.Join(d, exeName)) {
		return ""
	}
	var pk struct {
		ProductName string `json:"productName"`
		Main        string `json:"main"`
		Version     string `json:"version"`
	}
	if readJSON(filepath.Join(d, "resources", "app", "package.json"), &pk) != nil || pk.ProductName != appName || (pk.Main != "electron/main.cjs" && pk.Main != "electron/boot.cjs") {
		return ""
	}
	if pk.Version == "" {
		return "(older)"
	}
	return pk.Version
}

func doInstall(p *Payload, o Options, prog progressFn) error {
	if !p.present {
		return errors.New("this copy of the setup has no app inside")
	}
	if o.Dir == "" {
		o.Dir = defaultDir(o.Scope)
	}
	o.Dir = filepath.Clean(o.Dir)
	exe := filepath.Join(o.Dir, exeName)
	if fileExists(exe) && exeLocked(exe) {
		return errRunning
	}
	var prev *InstallInfo
	switch {
	case looksInstalled(o.Dir):
		prev, _ = readInstall(o.Dir)
	case olderCopy(o.Dir) != "":
		// a hand-made older copy: its program files are replaced, anything else in it stays
	case fileExists(o.Dir) && !keptAfterUninstall(o.Dir):
		if entries, err := os.ReadDir(o.Dir); err != nil || len(entries) > 0 {
			return fmt.Errorf("%s already has other files in it - choose an empty or new folder", o.Dir)
		}
	}
	logf("install %s to %s (%s) desktop=%v", p.Meta.Version, o.Dir, o.Scope, o.Desktop)
	prog(0.01, "Checking the setup file")
	ii := InstallInfo{Scope: o.Scope, Version: p.Meta.Version, Runtime: p.Meta.Runtime, Desktop: o.Desktop, Installed: time.Now().Format(time.RFC3339Nano)}
	// everything the folder needs goes into the new copy before it is swapped in: stopped
	// halfway (power cut, error), the old folder is still whole - or there is none yet
	_, err := replaceDir(o.Dir, func(tmp string) error {
		if err := p.Extract(tmp, func(d, t int64) {
			if t <= 0 {
				t = 1
			}
			prog(0.03+0.83*float64(d)/float64(t), "Copying files")
		}); err != nil {
			return err
		}
		prog(0.88, "Finishing")
		if err := p.copyExePart(filepath.Join(tmp, setupName)); err != nil {
			return fmt.Errorf("can't write the uninstaller: %w", err)
		}
		// (no update.json any more: from 0.5.0 every copy updates from GitHub - updater.cjs)
		// what the setup put there: only these are ever replaced or removed later
		entries, err := os.ReadDir(tmp)
		if err != nil {
			return err
		}
		for _, e := range entries {
			ii.Files = append(ii.Files, e.Name())
		}
		ii.Files = append(ii.Files, "install.json")
		return writeJSON(filepath.Join(tmp, "install.json"), ii)
	}, ownedBy(prev))
	if err != nil {
		return err
	}
	prog(0.94, "Creating shortcuts")
	if err := makeShortcuts(o.Dir, ii); err != nil {
		logf("shortcuts: %v", err)
	}
	prog(0.97, "Registering with Windows")
	if err := registerApp(o.Dir, ii); err != nil {
		logf("register: %v", err)
	}
	prog(1, "Done")
	logf("installed")
	return nil
}

// doUninstall removes what the setup put in the folder - app files first, the record of the
// install (install.json, the uninstaller, Installed apps, shortcuts) last: stopped by a file in
// use, Rev Radar stays listed and can be removed again. Files the person put in the folder stay.
func doUninstall(dir string, prog progressFn) error {
	dir = filepath.Clean(dir)
	if !looksInstalled(dir) {
		return fmt.Errorf("%s doesn't look like a Rev Radar installation - nothing was removed", dir)
	}
	if exeLocked(filepath.Join(dir, exeName)) {
		return errRunning
	}
	ii, _ := readInstall(dir)
	scope := "user"
	if ii != nil && ii.Scope != "" {
		scope = ii.Scope
	}
	owned := ownedBy(ii)
	logf("uninstall %s (%s)", dir, scope)
	// the uninstaller (usually this very program) can't be deleted while it runs, but Windows lets
	// it be moved out of the folder. Nothing is ever started from where it goes.
	setup := filepath.Join(dir, setupName)
	parked := ""
	if fileExists(setup) {
		p, err := park(setup, dir)
		if err != nil {
			return fmt.Errorf("the uninstaller can't be moved out of %s (%v) - nothing was removed", dir, err)
		}
		parked = p
	}
	unpark := func() {
		if parked != "" {
			if err := os.Rename(parked, setup); err != nil {
				logf("putting the uninstaller back: %v", err)
			}
		}
	}
	prog(0.05, "Removing files")
	entries, err := os.ReadDir(dir)
	if err != nil {
		unpark()
		return err
	}
	var mine, kept []string
	for _, e := range entries {
		switch n := e.Name(); {
		case strings.EqualFold(n, "install.json"):
		case owned(n):
			mine = append(mine, n)
		default:
			kept = append(kept, n)
		}
	}
	for i, n := range mine {
		if err := retry(10*time.Second, func() error { return os.RemoveAll(filepath.Join(dir, n)) }); err != nil {
			logf("uninstall stopped at %s: %v", n, err)
			unpark()
			return fmt.Errorf("%s is in use (Rev Radar, an Explorer window showing that folder, or an antivirus scan) - close it and try again", filepath.Join(dir, n))
		}
		prog(0.05+0.75*float64(i+1)/float64(len(mine)), "Removing files")
	}
	_ = os.Remove(filepath.Join(dir, "install.json"))
	if len(kept) == 0 {
		_ = retry(3*time.Second, func() error { return os.Remove(dir) })
	} else {
		logf("left in %s (not the setup's): %v", dir, kept)
	}
	prog(0.85, "Removing shortcuts")
	removeShortcuts(scope, dir)
	prog(0.92, "Removing from Windows")
	unregisterApp(dir, scope)
	cleanLeftovers(dir)
	if parked != "" {
		dispose(parked)
	}
	prog(1, "Done")
	logf("uninstalled")
	return nil
}

// park moves the uninstaller out of the app folder: into the temporary folder, or next to the app
// folder when that is on another drive. It is only moved, never started from there.
func park(setup, dir string) (string, error) {
	tag := strconv.FormatInt(time.Now().UnixNano()%1e9, 36)
	var last error
	// (0.6.1 T44: the setup that asked for admin rights holds this very file until the first line it gets from here -
	// a few moments, so the move is tried again for a while)
	moved := ""
	_ = retry(5*time.Second, func() error {
		for _, to := range []string{
			filepath.Join(os.TempDir(), "Rev Radar Setup (removed "+tag+").exe"),
			filepath.Join(filepath.Dir(dir), ".revradar-uninstall-"+tag+".exe"),
		} {
			if err := os.Rename(setup, to); err != nil {
				last = err
				continue
			}
			moved = to
			return nil
		}
		return last
	})
	if moved != "" {
		logf("uninstaller moved to %s", moved)
		return moved, nil
	}
	return "", last
}

// dispose deletes the moved uninstaller - when it is still running, Windows deletes it at the next
// restart (with admin rights), or the next run of a setup does.
func dispose(p string) {
	if os.Remove(p) == nil {
		return
	}
	deleteAtReboot(p)
}

// removeUserData: the person's settings, recent comparisons, remembered results, downloaded
// updates and temporary files (everything in Rev Radar's own data folders).
func removeUserData() {
	for _, d := range userDataDirs() {
		if d != "" && strings.HasSuffix(filepath.Clean(d), appName) {
			_ = os.RemoveAll(d)
		}
	}
}

// Job is work handed to an elevated copy of this program (installs for everyone, and removing
// such an install). It goes on the elevated copy's command line - never through a file another
// program could change in between - and the elevated copy reports back through a pipe.
type Job struct {
	Kind string  `json:"kind"` // install | uninstall
	Opts Options `json:"opts"`
	Dir  string  `json:"dir"`
	Pipe string  `json:"pipe"`
}

type jobResult struct {
	OK      bool   `json:"ok"`
	Err     string `json:"err"`
	Running bool   `json:"running"`
}

func runJob(p *Payload, j Job, prog progressFn) error {
	switch j.Kind {
	case "install":
		return doInstall(p, j.Opts, prog)
	case "uninstall":
		return doUninstall(j.Dir, prog)
	}
	return fmt.Errorf("unknown job %q", j.Kind)
}

func jobDir(j Job) string {
	if j.Kind == "uninstall" {
		return j.Dir
	}
	return orDefault(j.Opts.Dir, j.Opts.Scope)
}

// worker exit codes
const (
	workerOK      = 0
	workerFailed  = 1
	workerBadJob  = 2
	workerRunning = 3
)

// runWorker is the elevated side: does the job and reports progress and the result.
func runWorker(p *Payload, arg string) int {
	var j Job
	b, err := base64.StdEncoding.DecodeString(arg)
	if err == nil {
		err = json.Unmarshal(b, &j)
	}
	if err != nil {
		logf("worker: %v", err)
		return workerBadJob
	}
	// (0.6.1 T44, DECISIONS 153) the job is checked by the window's own rules before anything is written: any program
	// can start this with a job of its making
	if why := jobProblem(j, isElevated()); why != "" {
		logf("worker: job refused (%s): %+v", why, j)
		return workerBadJob
	}
	rep := openReport(j.Pipe)
	defer rep.close()
	// (152) the first line: the setup lets go of its file now - park below may then move it
	rep.send("h")
	err = runJob(p, j, func(pct float64, stage string) { rep.send(fmt.Sprintf("p %.4f %s", pct, stage)) })
	res := jobResult{OK: err == nil}
	if err != nil {
		res.Err = err.Error()
		res.Running = errors.Is(err, errRunning)
		logf("worker %s failed: %v", j.Kind, err)
	}
	rb, _ := json.Marshal(res)
	rep.send("r " + string(rb))
	switch {
	case err == nil:
		return workerOK
	case res.Running:
		return workerRunning
	}
	return workerFailed
}

// jobProblem (153): what is wrong with a job handed to the admin side ("" - nothing). Install: the window's checkDir, and
// with admin rights scope "machine" only inside Program Files (known folders) and scope "user" not at all - the window
// never asks for it: needsElevation would for a folder the person can't write, but checkDir refuses that folder first.
// Uninstall: a Rev Radar install, its record readable, a machine one inside Program Files (the window asks admin rights
// for a person's own install whose folder it can't write - that stays allowed).
func jobProblem(j Job, elevated bool) string {
	switch j.Kind {
	case "install":
		sc := j.Opts.Scope
		if sc != "machine" && sc != "user" {
			return "scope " + sc
		}
		if elevated && sc == "user" {
			return "a person's own install with admin rights"
		}
		dir := orDefault(j.Opts.Dir, sc)
		if why := checkDir(sc, dir); why != "" {
			return why
		}
		if sc == "machine" && !inProgramFiles(dir) {
			return "not inside Program Files"
		}
		return ""
	case "uninstall":
		d := filepath.Clean(j.Dir)
		if !filepath.IsAbs(d) || !looksInstalled(d) {
			return "not a Rev Radar install"
		}
		ii, err := readInstall(d)
		if err != nil || ii == nil {
			return "no readable install record"
		}
		if ii.Scope == "machine" && !inProgramFiles(d) {
			return "a machine install outside Program Files"
		}
		if ii.Scope != "" && ii.Scope != "machine" && ii.Scope != "user" {
			return "scope " + ii.Scope
		}
		return ""
	}
	return "kind " + j.Kind
}

// runAs does the job here, or in an elevated copy when this process can't write there.
func runAs(p *Payload, j Job, elevate bool, prog progressFn) error {
	// Rev Radar open: said before Windows asks for admin rights, not after
	if exe := filepath.Join(jobDir(j), exeName); fileExists(exe) && exeLocked(exe) {
		return errRunning
	}
	if !elevate || isElevated() {
		return runJob(p, j, prog)
	}
	return runElevated(j, prog)
}

func needsElevation(dir string, scope string) bool {
	if isElevated() {
		return false
	}
	return scope == "machine" || !canWrite(dir)
}

// selfPath: this program, as it was started (it may be moved out of the app folder later on)
var selfPath string

// quiet: --silent - nothing is shown at all (IT tools wait for the exit code and read the log)
var quiet bool

func main() {
	args := fixArgs(os.Args[1:])
	for _, a := range args {
		if a == "--silent" || a == "-silent" {
			quiet = true
		}
	}
	// DLLs loaded by name come from System32 only: a DLL put next to the setup (in Downloads) is
	// never loaded by it
	safeDllSearch()
	initLog()
	self, err := os.Executable()
	if err != nil {
		fatal("Can't find the setup program: " + err.Error())
	}
	selfPath = self
	p, err := openPayload(self)
	if err != nil {
		fatal(err.Error())
	}
	fs := flag.NewFlagSet("setup", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var (
		silent    = fs.Bool("silent", false, "")
		justMe    = fs.Bool("just-me", false, "")
		dir       = fs.String("dir", "", "")
		noDesktop = fs.Bool("no-desktop", false, "")
		updates   = fs.String("updates", "", "")
		uninstall = fs.Bool("uninstall", false, "")
		worker    = fs.String("worker", "", "")
		plain     = fs.Bool("plain", false, "")
	)
	if err := fs.Parse(args); err != nil || fs.NArg() > 0 {
		fatal("Unknown option: " + strings.Join(os.Args[1:], " ") + "\n\nOptions: --silent [--just-me] [--dir <folder>] [--no-desktop] [--updates <folder>], --uninstall [--silent]")
	}
	plainUI = *plain
	logf("start %s %q payload=%v elevated=%v", version, args, p.present, isElevated())
	cleanTemp(self)
	switch {
	case *worker != "":
		os.Exit(runWorker(p, *worker))
	case !p.present && !*uninstall && fs.NFlag() > btoi(*plain):
		// the uninstaller started with options it doesn't know: do nothing (never a silent uninstall)
		logf("no payload and no --uninstall: nothing to do")
		os.Exit(2)
	case !*uninstall && !p.present && !looksInstalled(filepath.Dir(self)):
		// a setup file without its app part (cut short when copied, or changed afterwards): it
		// says so - it never turns into the uninstaller of whatever is installed
		fatal2("This setup file is incomplete (the app part is missing) - it may not have been copied completely. Get it again from where you got it.")
	case *uninstall || !p.present:
		d := *dir
		if d == "" {
			d = filepath.Dir(self)
			if !looksInstalled(d) {
				if found, _ := findInstalled(); found != "" {
					d = found
				}
			}
		}
		os.Exit(cmdUninstall(filepath.Clean(d), *silent))
	case *silent:
		os.Exit(silentInstall(p, self, *justMe, *dir, *noDesktop, *updates))
	default:
		os.Exit(cmdInstall(p, self))
	}
}

// fixArgs mends a command line where a folder ended in a backslash before its closing quote
// (--updates "\\server\Rev Radar\" --no-desktop): Windows reads \" as a quote character and
// the rest of the line ends up inside that one argument.
func fixArgs(in []string) []string {
	var out []string
	for _, a := range in {
		if i := strings.IndexByte(a, '"'); i >= 0 {
			out = append(out, a[:i])
			out = append(out, strings.Fields(strings.ReplaceAll(a[i+1:], `"`, " "))...)
			continue
		}
		out = append(out, a)
	}
	return out
}

func btoi(b bool) int {
	if b {
		return 1
	}
	return 0
}

func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

// silentInstall: --silent (IT tools): no window, no questions; 0 = installed, 1 = not (see the log).
func silentInstall(p *Payload, self string, justMe bool, dir string, noDesktop bool, updates string) int {
	o := Options{Scope: "machine", Dir: strings.TrimSpace(dir), Desktop: !noDesktop}
	if justMe {
		o.Scope = "user"
	}
	// (older install scripts still pass --updates <folder>: accepted, not used)
	if strings.TrimSpace(updates) != "" {
		logf("silent install: --updates is no longer used (updates come from GitHub) - ignored")
	}
	found, ii := findInstalled()
	if found != "" && ii != nil {
		if o.Dir == "" && ii.Scope == o.Scope {
			o.Dir = found
		}
		if !samePath(orDefault(o.Dir, o.Scope), found) {
			logf("silent install: Rev Radar is already installed in %s (%s) - remove it first (--uninstall --silent)", found, ii.Scope)
			return 1
		}
		// over the installed copy: its choices stay unless told otherwise
		o.Desktop = ii.Desktop && !noDesktop
	}
	if msg := checkDir(o.Scope, orDefault(o.Dir, o.Scope)); msg != "" {
		logf("silent install: %s", msg)
		return 1
	}
	if err := runAs(p, Job{Kind: "install", Opts: o}, needsElevation(orDefault(o.Dir, o.Scope), o.Scope), func(float64, string) {}); err != nil {
		logf("silent install failed: %v", err)
		return 1
	}
	return 0
}

// cleanTemp removes uninstallers moved out of app folders by earlier runs (a program can't delete
// itself; the next run tidies up).
func cleanTemp(self string) {
	old, _ := filepath.Glob(filepath.Join(os.TempDir(), "Rev Radar Setup (removed *).exe"))
	old2, _ := filepath.Glob(filepath.Join(os.TempDir(), "Rev Radar Uninstall *.exe"))
	for _, f := range append(old, old2...) {
		if !samePath(f, self) {
			if fi, err := os.Stat(f); err == nil && time.Since(fi.ModTime()) > time.Minute {
				_ = os.Remove(f)
			}
		}
	}
}

func orDefault(dir, scope string) string {
	if dir == "" {
		return defaultDir(scope)
	}
	return dir
}

// cmdUninstall: from the app folder's uninstaller (Installed apps) or --uninstall.
func cmdUninstall(dir string, silent bool) int {
	if !looksInstalled(dir) {
		if !silent {
			messageBox("Rev Radar isn't installed here:\n"+dir, mbInfo)
		}
		logf("uninstall: not installed in %s", dir)
		return 2
	}
	ii, _ := readInstall(dir)
	scope := "user"
	if ii != nil && ii.Scope != "" {
		scope = ii.Scope
	}
	if silent {
		if err := runAs(nil, Job{Kind: "uninstall", Dir: dir}, needsElevation(dir, scope), func(float64, string) {}); err != nil {
			logf("silent uninstall failed: %v", err)
			return 1
		}
		return 0
	}
	return uninstallUI(dir, scope)
}

func cmdInstall(p *Payload, self string) int {
	st := installState(p, self)
	return installUI(p, st)
}

// UIState is what the window starts with.
type UIState struct {
	Mode      string            `json:"mode"` // install | uninstall
	Version   string            `json:"version"`
	Existing  *Existing         `json:"existing"`
	Dirs      map[string]string `json:"dirs"`
	Opts      Options           `json:"opts"`
	Downgrade bool              `json:"downgrade"` // this setup is older than the version that runs now
}

type Existing struct {
	Version string `json:"version"` // the version that runs now (it may have updated itself)
	Dir     string `json:"dir"`
	Scope   string `json:"scope"`
}

func installState(p *Payload, self string) UIState {
	st := UIState{Mode: "install", Version: p.Meta.Version, Dirs: map[string]string{"user": defaultDir("user"), "machine": defaultDir("machine")}}
	// for everyone by default: Program Files is where company antivirus lets programs run (it
	// often blocks programs in AppData, where a "just me" install goes)
	st.Opts = Options{Scope: "machine", Dir: st.Dirs["machine"], Desktop: true}
	if dir, ii := findInstalled(); dir != "" && ii != nil {
		st.Existing = &Existing{Version: runningVersion(ii.Version, ii.Runtime), Dir: dir, Scope: ii.Scope}
		st.Opts = Options{Scope: ii.Scope, Dir: dir, Desktop: ii.Desktop}
	} else {
		// no install of the setup's own, but a hand-made older copy in a usual place: offered as
		// the one to update (same folder, same reach), so there aren't two copies side by side
		for _, sc := range []string{"machine", "user"} {
			if v := olderCopy(st.Dirs[sc]); v != "" {
				st.Existing = &Existing{Version: v, Dir: st.Dirs[sc], Scope: sc}
				st.Opts = Options{Scope: sc, Dir: st.Dirs[sc], Desktop: true}
				logf("older copy %s found in %s", v, st.Dirs[sc])
				break
			}
		}
	}
	st.Downgrade = st.Existing != nil && plainVersion(st.Existing.Version) && versionLess(st.Version, st.Existing.Version)
	return st
}

// checkDir: can the chosen folder be used? (message for the window)
func checkDir(scope, dir string) string {
	d := strings.TrimSpace(dir)
	if d == "" || !filepath.IsAbs(d) {
		return "Enter a full folder path, like C:\\Apps\\Rev Radar."
	}
	if strings.HasPrefix(d, `\\`) || isRemote(d) {
		return "Install on this PC, not on a network folder."
	}
	if filepath.Dir(filepath.Clean(d)) == filepath.Clean(d) {
		return "Choose a folder, not a whole drive."
	}
	if found, ii := findInstalled(); found != "" && ii != nil && !samePath(found, d) {
		return "Rev Radar is already installed in " + found + ". To install it somewhere else, remove that one first (Windows Settings > Apps > Installed apps)."
	}
	if fileExists(d) && !looksInstalled(d) && olderCopy(d) == "" && !keptAfterUninstall(d) {
		if entries, err := os.ReadDir(d); err == nil && len(entries) > 0 {
			return "That folder has other files in it. Choose an empty or new one."
		}
	}
	if scope == "machine" && !inProgramFiles(d) {
		return "For everyone on this PC, Rev Radar goes inside Program Files (only admins can change programs there). For another folder, choose \"Just me\"."
	}
	if scope == "user" && !isElevated() && !canWrite(d) {
		return "That folder needs admin rights. Choose another, or install for everyone."
	}
	return ""
}

func fatal(msg string) {
	logf("fatal: %s", msg)
	messageBox(msg, mbError)
	os.Exit(1)
}

func fatal2(msg string) {
	logf("fatal: %s", msg)
	messageBox(msg, mbWarn)
	os.Exit(2)
}

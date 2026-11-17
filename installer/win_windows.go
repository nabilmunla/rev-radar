//go:build windows

// Windows side of the setup: elevation, processes, shortcuts, registry, folders, message boxes.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const aumid = "revradar.app" // the app's AppUserModelID (app.setAppUserModelId) - taskbar grouping

var (
	user32  = windows.NewLazySystemDLL("user32.dll")
	shell32 = windows.NewLazySystemDLL("shell32.dll")
	ole32   = windows.NewLazySystemDLL("ole32.dll")
	mpr     = windows.NewLazySystemDLL("mpr.dll")

	procMessageBoxW                 = user32.NewProc("MessageBoxW")
	procShellExecuteExW             = shell32.NewProc("ShellExecuteExW")
	procSHCreateItemFromParsingName = shell32.NewProc("SHCreateItemFromParsingName")
	procCoCreateInstance            = ole32.NewProc("CoCreateInstance")
	procCoInitializeEx              = ole32.NewProc("CoInitializeEx")
	procCoTaskMemFree               = ole32.NewProc("CoTaskMemFree")
	procWNetGetUniversalNameW       = mpr.NewProc("WNetGetUniversalNameW")
)

const (
	mbInfo  = 0x40 // MB_ICONINFORMATION
	mbWarn  = 0x30 // MB_ICONWARNING
	mbError = 0x10 // MB_ICONERROR
	mbYesNo = 0x04
	idYes   = 6
)

func messageBox(text string, flags uint32) int {
	if quiet || os.Getenv("RR_SETUP_NO_DIALOGS") == "1" { // --silent, automated tests
		logf("messagebox: %s", text)
		return idYes
	}
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString("Rev Radar Setup")
	r, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), uintptr(flags|0x10000 /*MB_SETFOREGROUND*/))
	return int(r)
}

// safeDllSearch: DLLs loaded by name are looked for in System32 only - never in the setup's own
// folder (Downloads) or the current folder.
func safeDllSearch() {
	if err := windows.SetDefaultDllDirectories(windows.LOAD_LIBRARY_SEARCH_SYSTEM32); err != nil {
		logf("SetDefaultDllDirectories: %v", err)
	}
}

// isRemote: a folder on a network drive (a mapped letter).
func isRemote(p string) bool {
	vol := filepath.VolumeName(p)
	if vol == "" || strings.HasPrefix(vol, `\\`) {
		return strings.HasPrefix(p, `\\`)
	}
	r, _ := windows.UTF16PtrFromString(vol + `\`)
	return windows.GetDriveType(r) == windows.DRIVE_REMOTE
}

// inProgramFiles: inside one of the Program Files folders (only admins can change files there).
func inProgramFiles(p string) bool {
	d := strings.ToLower(filepath.Clean(p))
	for _, pf := range []string{os.Getenv("ProgramW6432"), os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), knownFolder(windows.FOLDERID_ProgramFilesX64, "")} {
		if pf = strings.ToLower(filepath.Clean(pf)); pf != "." && pf != "" && strings.HasPrefix(d, pf+`\`) {
			return true
		}
	}
	return false
}

// deleteAtReboot: Windows deletes the file at the next restart (needs admin rights; without them
// the file stays until the next run of a setup tidies it).
func deleteAtReboot(p string) {
	if !isElevated() {
		logf("left for later: %s", p)
		return
	}
	from, _ := windows.UTF16PtrFromString(p)
	if err := windows.MoveFileEx(from, nil, windows.MOVEFILE_DELAY_UNTIL_REBOOT); err != nil {
		logf("delete at restart %s: %v", p, err)
	}
}

func isElevated() bool {
	return windows.GetCurrentProcessToken().IsElevated()
}

// exeLocked: Rev Radar from that folder is running. Opening the exe for writing tells (a running
// exe can't be written) - but without admin rights a copy in Program Files always says "access
// denied", so the running programs are looked through as well.
func exeLocked(path string) bool {
	if p, err := windows.UTF16PtrFromString(path); err == nil {
		h, err := windows.CreateFile(p, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if err == nil {
			windows.CloseHandle(h)
		} else if errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return true
		}
	}
	return appRunning(path)
}

// appRunning: a process started from exactly this exe (those this user may look at).
func appRunning(exe string) bool {
	want := strings.ToLower(filepath.Clean(exe))
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	base := strings.ToLower(filepath.Base(exe))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if strings.ToLower(windows.UTF16ToString(e.ExeFile[:])) != base || e.ProcessID == uint32(os.Getpid()) {
			continue
		}
		h, err2 := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, e.ProcessID)
		if err2 != nil {
			continue // another user's (the elevated helper sees those - it checks again)
		}
		buf := make([]uint16, windows.MAX_LONG_PATH)
		n := uint32(len(buf))
		err2 = windows.QueryFullProcessImageName(h, 0, &buf[0], &n)
		windows.CloseHandle(h)
		if err2 == nil && strings.ToLower(filepath.Clean(windows.UTF16ToString(buf[:n]))) == want {
			return true
		}
	}
	return false
}

func launch(path string, args ...string) error {
	cmd := exec.Command(path, args...)
	cmd.Dir = filepath.Dir(path)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 /*DETACHED_PROCESS*/ | 0x00000200 /*CREATE_NEW_PROCESS_GROUP*/}
	if err := cmd.Start(); err != nil {
		logf("launch %s: %v", path, err)
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

// launchApp starts Rev Radar as the signed-in person even when this program runs with admin
// rights (an app started from an elevated setup would be elevated too: no drag and drop from
// Explorer, files saved as admin). Explorer starts it at the person's normal level.
func launchApp(path string) error {
	if isElevated() {
		if err := exec.Command(filepath.Join(os.Getenv("WINDIR"), "explorer.exe"), path).Start(); err == nil {
			return nil
		}
	}
	return launch(path)
}

func knownFolder(id *windows.KNOWNFOLDERID, fallback string) string {
	if p, err := windows.KnownFolderPath(id, 0); err == nil && p != "" {
		return p
	}
	return fallback
}

func defaultDir(scope string) string {
	if scope == "machine" {
		pf := os.Getenv("ProgramW6432")
		if pf == "" {
			pf = knownFolder(windows.FOLDERID_ProgramFilesX64, `C:\Program Files`)
		}
		return filepath.Join(pf, appName)
	}
	return filepath.Join(knownFolder(windows.FOLDERID_UserProgramFiles, filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs")), appName)
}

func userDataDirs() []string {
	return []string{
		filepath.Join(knownFolder(windows.FOLDERID_RoamingAppData, os.Getenv("APPDATA")), appName),
		filepath.Join(knownFolder(windows.FOLDERID_LocalAppData, os.Getenv("LOCALAPPDATA")), appName),
		filepath.Join(os.TempDir(), appName),
	}
}

// toUNC turns a mapped drive path (Y:\Apps) into \\server\share\Apps; other paths stay.
func toUNC(p string) string {
	if strings.HasPrefix(p, `\\`) || len(p) < 2 || p[1] != ':' {
		return p
	}
	lp, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return p
	}
	buf := make([]byte, 4096)
	size := uint32(len(buf))
	r, _, _ := procWNetGetUniversalNameW.Call(uintptr(unsafe.Pointer(lp)), 1 /*UNIVERSAL_NAME_INFO_LEVEL*/, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if r != 0 {
		return p // a local drive (or not connected): keep it
	}
	ptr := *(**uint16)(unsafe.Pointer(&buf[0]))
	if ptr == nil {
		return p
	}
	if u := windows.UTF16PtrToString(ptr); u != "" {
		return u
	}
	return p
}

// ---------------------------------------------------------------- elevation

type shellExecuteInfo struct {
	cbSize         uint32
	fMask          uint32
	hwnd           uintptr
	lpVerb         *uint16
	lpFile         *uint16
	lpParameters   *uint16
	lpDirectory    *uint16
	nShow          int32
	hInstApp       uintptr
	lpIDList       uintptr
	lpClass        *uint16
	hkeyClass      uintptr
	dwHotKey       uint32
	hIconOrMonitor uintptr
	hProcess       windows.Handle
}

// ownerHwnd: the setup window, so Windows' admin prompt belongs to it
var ownerHwnd uintptr

func shellExecute(verb, file, params string, wait bool) (uint32, error) {
	v, _ := windows.UTF16PtrFromString(verb)
	f, _ := windows.UTF16PtrFromString(file)
	pa, _ := windows.UTF16PtrFromString(params)
	sei := shellExecuteInfo{fMask: 0x00000040 /*SEE_MASK_NOCLOSEPROCESS*/ | 0x00000100 /*SEE_MASK_NOASYNC*/, hwnd: ownerHwnd, lpVerb: v, lpFile: f, lpParameters: pa, nShow: 1}
	sei.cbSize = uint32(unsafe.Sizeof(sei))
	r, _, e := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&sei)))
	if r == 0 {
		return 0, e
	}
	if sei.hProcess == 0 {
		return 0, nil
	}
	defer windows.CloseHandle(sei.hProcess)
	if !wait {
		return 0, nil
	}
	_, _ = windows.WaitForSingleObject(sei.hProcess, windows.INFINITE)
	var code uint32
	_ = windows.GetExitCodeProcess(sei.hProcess, &code)
	return code, nil
}

func quoteArgs(args ...string) string {
	q := make([]string, len(args))
	for i, a := range args {
		q[i] = syscall.EscapeArg(a)
	}
	return strings.Join(q, " ")
}

// runElevated hands the job to a copy of this program started with admin rights (Windows asks
// the person) and follows its progress. The job goes on its command line; it reports back through a
// pipe this process made (a file in the temporary folder could be swapped by another program).
func runElevated(j Job, prog progressFn) error {
	name := fmt.Sprintf(`\\.\pipe\RevRadarSetup-%d-%d`, os.Getpid(), time.Now().UnixNano())
	pn, _ := windows.UTF16PtrFromString(name)
	h, err := windows.CreateNamedPipe(pn, windows.PIPE_ACCESS_INBOUND|windows.FILE_FLAG_FIRST_PIPE_INSTANCE,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS, 1, 0, 64<<10, 0, nil)
	lines := make(chan string, 256)
	readerDone := make(chan struct{})
	if err != nil {
		logf("pipe: %v", err)
		close(readerDone)
	} else {
		j.Pipe = name
		go func() {
			defer close(readerDone)
			if err := windows.ConnectNamedPipe(h, nil); err != nil && err != windows.ERROR_PIPE_CONNECTED {
				return
			}
			var pend []byte
			buf := make([]byte, 4096)
			for {
				var n uint32
				if err := windows.ReadFile(h, buf, &n, nil); err != nil || n == 0 {
					return
				}
				pend = append(pend, buf[:n]...)
				for {
					k := bytes.IndexByte(pend, '\n')
					if k < 0 {
						break
					}
					lines <- string(pend[:k])
					pend = pend[k+1:]
				}
			}
		}()
	}
	b, _ := json.Marshal(j)
	type exit struct {
		code uint32
		err  error
	}
	done := make(chan exit, 1)
	go func() {
		exe := selfPath
		if isRemote(exe) {
			exe = toUNC(exe) // the admin side may not see this person's mapped drive letters
		}
		code, err := shellExecute("runas", exe, quoteArgs("--worker", base64.StdEncoding.EncodeToString(b)), true)
		done <- exit{code, err}
	}()
	var res *jobResult
	take := func(l string) {
		switch {
		case strings.HasPrefix(l, "p "):
			if parts := strings.SplitN(l[2:], " ", 2); len(parts) == 2 {
				if f, err := strconv.ParseFloat(parts[0], 64); err == nil {
					prog(f, parts[1])
				}
			}
		case strings.HasPrefix(l, "r "):
			var r jobResult
			if json.Unmarshal([]byte(l[2:]), &r) == nil {
				res = &r
			}
		}
	}
	for {
		select {
		case l := <-lines:
			take(l)
		case x := <-done:
			if h != windows.InvalidHandle && err == nil {
				// the worker never came (admin rights refused): stop waiting for it
				if c, e := windows.CreateFile(pn, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, 0, 0); e == nil {
					windows.CloseHandle(c)
				}
				select {
				case <-readerDone:
				case <-time.After(3 * time.Second):
				}
				windows.CloseHandle(h)
			}
			for drained := false; !drained; {
				select {
				case l := <-lines:
					take(l)
				default:
					drained = true
				}
			}
			if x.err != nil {
				if errors.Is(x.err, windows.ERROR_CANCELLED) {
					return errAdminRefused
				}
				return x.err
			}
			if res != nil {
				if res.OK {
					return nil
				}
				if res.Running {
					return errRunning
				}
				return errors.New(res.Err)
			}
			switch x.code {
			case workerOK:
				return nil
			case workerRunning:
				return errRunning
			}
			return fmt.Errorf("the installer with admin rights stopped without finishing (code %d) - see %s", x.code, logPath)
		}
	}
}

// openReport: the elevated worker's line back to the window (nothing if there is no pipe).
func openReport(name string) reporter {
	if name == "" || !strings.HasPrefix(name, `\\.\pipe\RevRadarSetup-`) {
		return nopReporter{}
	}
	pn, _ := windows.UTF16PtrFromString(name)
	h, err := windows.CreateFile(pn, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		logf("report pipe: %v", err)
		return nopReporter{}
	}
	return &pipeReporter{h: h}
}

type pipeReporter struct {
	mu sync.Mutex
	h  windows.Handle
}

func (r *pipeReporter) send(line string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.h == windows.InvalidHandle {
		return
	}
	var n uint32
	if err := windows.WriteFile(r.h, []byte(strings.ReplaceAll(line, "\n", " ")+"\n"), &n, nil); err != nil {
		windows.CloseHandle(r.h)
		r.h = windows.InvalidHandle
	}
}

func (r *pipeReporter) close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.h != windows.InvalidHandle {
		windows.CloseHandle(r.h)
		r.h = windows.InvalidHandle
	}
}

// ---------------------------------------------------------------- COM (shortcuts, folder picker)

func comCall(obj uintptr, idx int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(idx)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{obj}, args...)...)
	return r
}

func comRelease(obj uintptr) {
	if obj != 0 {
		comCall(obj, 2)
	}
}

func mustGUID(s string) windows.GUID {
	g, err := windows.GUIDFromString(s)
	if err != nil {
		panic(err)
	}
	return g
}

var (
	clsidShellLink      = mustGUID("{00021401-0000-0000-C000-000000000046}")
	iidShellLinkW       = mustGUID("{000214F9-0000-0000-C000-000000000046}")
	iidPersistFile      = mustGUID("{0000010b-0000-0000-C000-000000000046}")
	iidPropertyStore    = mustGUID("{886d8eeb-8cf2-4446-8d02-cdba1dbdcf99}")
	pkeyAppUserModelID  = mustGUID("{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}")
	clsidFileOpenDialog = mustGUID("{DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7}")
	iidFileOpenDialog   = mustGUID("{d57c7288-d4ad-4768-be02-9d969532d960}")
	iidShellItem        = mustGUID("{43826d1e-e718-42ee-bc55-a1e261c37bfe}")
)

func coCreate(clsid, iid *windows.GUID) (uintptr, error) {
	var p uintptr
	hr, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(clsid)), 0, 1 /*CLSCTX_INPROC_SERVER*/, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&p)))
	if int32(hr) < 0 || p == 0 {
		return 0, fmt.Errorf("CoCreateInstance failed: %08x", uint32(hr))
	}
	return p, nil
}

func comQI(obj uintptr, iid *windows.GUID) (uintptr, error) {
	var p uintptr
	hr := comCall(obj, 0, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&p)))
	if int32(hr) < 0 || p == 0 {
		return 0, fmt.Errorf("QueryInterface failed: %08x", uint32(hr))
	}
	return p, nil
}

// withCOM runs f on a locked thread with COM ready (shortcut creation from a worker goroutine).
func withCOM(f func() error) error {
	ch := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		procCoInitializeEx.Call(0, 2 /*COINIT_APARTMENTTHREADED*/)
		ch <- f()
	}()
	return <-ch
}

type propertyKey struct {
	fmtid windows.GUID
	pid   uint32
}

type propVariant struct {
	vt       uint16
	r1, r2   uint16
	r3       uint16
	val      uintptr
	reserved uintptr
}

func u16(s string) uintptr {
	p, _ := windows.UTF16PtrFromString(s)
	return uintptr(unsafe.Pointer(p))
}

func makeShortcut(lnk, target, workdir, icon, desc string) error {
	sl, err := coCreate(&clsidShellLink, &iidShellLinkW)
	if err != nil {
		return err
	}
	defer comRelease(sl)
	strs := []string{target, workdir, desc, icon, lnk, aumid}
	keep := make([]*uint16, len(strs))
	for i, s := range strs {
		keep[i], _ = windows.UTF16PtrFromString(s)
	}
	comCall(sl, 20, uintptr(unsafe.Pointer(keep[0])))    // SetPath
	comCall(sl, 9, uintptr(unsafe.Pointer(keep[1])))     // SetWorkingDirectory
	comCall(sl, 7, uintptr(unsafe.Pointer(keep[2])))     // SetDescription
	comCall(sl, 17, uintptr(unsafe.Pointer(keep[3])), 0) // SetIconLocation
	if ps, err := comQI(sl, &iidPropertyStore); err == nil {
		key := propertyKey{fmtid: pkeyAppUserModelID, pid: 5}
		pv := propVariant{vt: 31 /*VT_LPWSTR*/, val: uintptr(unsafe.Pointer(keep[5]))}
		comCall(ps, 6, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&pv))) // SetValue
		comCall(ps, 7)                                                              // Commit
		comRelease(ps)
	}
	pf, err := comQI(sl, &iidPersistFile)
	if err != nil {
		return err
	}
	defer comRelease(pf)
	_ = os.MkdirAll(filepath.Dir(lnk), 0o755)
	if hr := comCall(pf, 6, uintptr(unsafe.Pointer(keep[4])), 1); int32(hr) < 0 { // Save
		return fmt.Errorf("saving %s failed: %08x", lnk, uint32(hr))
	}
	runtime.KeepAlive(keep)
	return nil
}

func shortcutPaths(scope string) (start, desktop string) {
	if scope == "machine" {
		return filepath.Join(knownFolder(windows.FOLDERID_CommonPrograms, filepath.Join(os.Getenv("ProgramData"), `Microsoft\Windows\Start Menu\Programs`)), appName+".lnk"),
			filepath.Join(knownFolder(windows.FOLDERID_PublicDesktop, filepath.Join(os.Getenv("PUBLIC"), "Desktop")), appName+".lnk")
	}
	return filepath.Join(knownFolder(windows.FOLDERID_Programs, filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs`)), appName+".lnk"),
		filepath.Join(knownFolder(windows.FOLDERID_Desktop, filepath.Join(os.Getenv("USERPROFILE"), "Desktop")), appName+".lnk")
}

const shortcutDesc = "See which drawings really changed between two issues"

func makeShortcuts(dir string, ii InstallInfo) error {
	exe := filepath.Join(dir, exeName)
	start, desktop := shortcutPaths(ii.Scope)
	return withCOM(func() error {
		var first error
		if err := makeShortcut(start, exe, dir, exe, shortcutDesc); err != nil {
			first = err
		}
		if ii.Desktop {
			if err := makeShortcut(desktop, exe, dir, exe, shortcutDesc); err != nil && first == nil {
				first = err
			}
		} else if lnkPointsTo(desktop, exe) {
			_ = os.Remove(desktop)
		}
		return first
	})
}

func removeShortcuts(scope, dir string) {
	exe := filepath.Join(dir, exeName)
	start, desktop := shortcutPaths(scope)
	for _, l := range []string{start, desktop} {
		if lnkPointsTo(l, exe) {
			_ = os.Remove(l)
		}
	}
}

// lnkPointsTo: the shortcut is one of this install's (its target is exe). A shortcut keeps its
// target's path as text (UTF-16 and/or the ANSI code page) - read without COM.
func lnkPointsTo(lnk, exe string) bool {
	b, err := os.ReadFile(lnk)
	if err != nil || len(b) > 1<<20 {
		return false
	}
	want := strings.ToLower(filepath.Clean(exe))
	if strings.Contains(strings.ToLower(string(b)), want) {
		return true
	}
	for off := 0; off < 2; off++ {
		u := make([]uint16, 0, len(b)/2)
		for i := off; i+1 < len(b); i += 2 {
			u = append(u, uint16(b[i])|uint16(b[i+1])<<8)
		}
		if strings.Contains(strings.ToLower(string(utf16.Decode(u))), want) {
			return true
		}
	}
	return false
}

// pickFolder: the standard Windows folder picker. "" when cancelled.
func pickFolder(owner uintptr, title, start string) string {
	d, err := coCreate(&clsidFileOpenDialog, &iidFileOpenDialog)
	if err != nil {
		logf("folder picker: %v", err)
		return ""
	}
	defer comRelease(d)
	var opts uint32
	comCall(d, 10, uintptr(unsafe.Pointer(&opts)))                              // GetOptions
	comCall(d, 9, uintptr(opts|0x20 /*PICKFOLDERS*/ |0x40 /*FORCEFILESYSTEM*/)) // SetOptions
	t, _ := windows.UTF16PtrFromString(title)
	comCall(d, 17, uintptr(unsafe.Pointer(t))) // SetTitle
	if start != "" {
		for p := start; p != "" && p != filepath.Dir(p); p = filepath.Dir(p) {
			if fileExists(p) {
				sp, _ := windows.UTF16PtrFromString(p)
				var item uintptr
				hr, _, _ := procSHCreateItemFromParsingName.Call(uintptr(unsafe.Pointer(sp)), 0, uintptr(unsafe.Pointer(&iidShellItem)), uintptr(unsafe.Pointer(&item)))
				if int32(hr) >= 0 && item != 0 {
					comCall(d, 12, item) // SetFolder
					comRelease(item)
				}
				break
			}
		}
	}
	if hr := comCall(d, 3, owner); int32(hr) < 0 { // Show (cancelled: 0x800704C7)
		return ""
	}
	var item uintptr
	if hr := comCall(d, 20, uintptr(unsafe.Pointer(&item))); int32(hr) < 0 || item == 0 { // GetResult
		return ""
	}
	defer comRelease(item)
	var name *uint16
	if hr := comCall(item, 5, 0x80058000 /*SIGDN_FILESYSPATH*/, uintptr(unsafe.Pointer(&name))); int32(hr) < 0 || name == nil {
		return ""
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(name)))
	return windows.UTF16PtrToString(name)
}

// ---------------------------------------------------------------- registry

const (
	uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\RevRadar`
	appPathsKey  = `Software\Microsoft\Windows\CurrentVersion\App Paths\Rev Radar.exe`
)

func rootFor(scope string) registry.Key {
	if scope == "machine" {
		return registry.LOCAL_MACHINE
	}
	return registry.CURRENT_USER
}

func setStr(root registry.Key, path, name, val string) error {
	k, _, err := registry.CreateKey(root, path, registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(name, val)
}

func setDword(root registry.Key, path, name string, val uint32) error {
	k, _, err := registry.CreateKey(root, path, registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetDWordValue(name, val)
}

func deleteTree(root registry.Key, path string) {
	k, err := registry.OpenKey(root, path, registry.ENUMERATE_SUB_KEYS|registry.WOW64_64KEY)
	if err == nil {
		subs, _ := k.ReadSubKeyNames(-1)
		k.Close()
		for _, s := range subs {
			deleteTree(root, path+`\`+s)
		}
	}
	_ = registry.DeleteKey(root, path)
}

func getStr(root registry.Key, path, name string) string {
	k, err := registry.OpenKey(root, path, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, _ := k.GetStringValue(name)
	return v
}

// registerApp: listed under Installed apps (with a working Uninstall button), and "Rev Radar" works
// in the Run box. Rev Radar opens no files from Explorer: no file associations.
func registerApp(dir string, ii InstallInfo) error {
	root := rootFor(ii.Scope)
	exe := filepath.Join(dir, exeName)
	setup := filepath.Join(dir, setupName)
	var errs []string
	add := func(err error) {
		if err != nil {
			errs = append(errs, err.Error())
		}
	}
	add(setStr(root, uninstallKey, "DisplayName", appName))
	add(setStr(root, uninstallKey, "DisplayVersion", ii.Version))
	add(setStr(root, uninstallKey, "DisplayIcon", `"`+exe+`",0`))
	add(setStr(root, uninstallKey, "InstallLocation", dir))
	add(setStr(root, uninstallKey, "UninstallString", `"`+setup+`" --uninstall`))
	add(setStr(root, uninstallKey, "QuietUninstallString", `"`+setup+`" --uninstall --silent`))
	add(setStr(root, uninstallKey, "InstallDate", time.Now().Format("20060102")))
	add(setDword(root, uninstallKey, "NoModify", 1))
	add(setDword(root, uninstallKey, "NoRepair", 1))
	add(setDword(root, uninstallKey, "EstimatedSize", dirSizeKB(dir)))
	add(setStr(root, appPathsKey, "", exe))
	add(setStr(root, appPathsKey, "Path", dir))
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

func unregisterApp(dir, scope string) {
	root := rootFor(scope)
	// only this install's entry (another copy may have registered since)
	if loc := getStr(root, uninstallKey, "InstallLocation"); loc == "" || samePath(loc, dir) {
		deleteTree(root, uninstallKey)
	}
	if strings.EqualFold(getStr(root, appPathsKey, ""), filepath.Join(dir, exeName)) {
		deleteTree(root, appPathsKey)
	}
}

// findInstalled: an existing install (this user's first, then for everyone).
func findInstalled() (string, *InstallInfo) {
	for _, root := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		dir := getStr(root, uninstallKey, "InstallLocation")
		if dir == "" || !looksInstalled(dir) {
			continue
		}
		ii, err := readInstall(dir)
		if err != nil {
			continue
		}
		return dir, ii
	}
	return "", nil
}

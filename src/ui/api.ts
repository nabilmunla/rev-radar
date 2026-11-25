// The bridge to the PC (electron/preload.cjs).
/** what a tab compares: drawings (PDF), BOQs (Excel / PDF), documents (PDF / Word) */
export type Kind = 'pdf' | 'boq' | 'docs';

export interface FileItem { path: string; rel: string; size: number; mtime: number }
/** where updates stand (electron/updater.cjs) */
export interface UpdateState {
  state: 'idle' | 'off' | 'checking' | 'none' | 'pending' | 'available' | 'downloading' | 'installing' | 'ready' | 'setup' | 'error' | 'unreachable' | 'empty';
  version: string; builtin: boolean; builtinVersion: string; installed: boolean; scope: string;
  /** where new versions come from (the GitHub repository) and its releases page */
  source: string; page: string; checked: number;
  previous: string; pinned: string; newest: string;
  /** the version on the card is one the person went back from */
  left?: boolean;
  available?: string; notes?: string[]; groups?: Record<string, string[]> | null; kind?: 'app' | 'full'; size?: number; pct?: number; err?: string; note?: string; show?: boolean; setupPath?: string;
}
/** reports (electron/reports.cjs): anon = a receiver is set (else they stay on this PC); crashes = crash reports turned on */
export interface ReportStatus { waiting: number; queue: string; state: 'idle' | 'local' | 'sent' | 'failed'; err: string; anon: boolean; crashes: boolean }
export interface CountState { available: boolean; ask: boolean; on: boolean }
export interface Updated { from: string; to: string; notes: string[]; groups: Record<string, string[]> | null; back: boolean }
export interface RR {
  engines: number;
  viewers: number;
  info(): Promise<{ version: string; cores: number; memGB: number; platform: string; engines: number; docs: string }>;
  settings(): Promise<Record<string, any>>;
  setSettings(patch: Record<string, unknown>): Promise<Record<string, any>>;
  setTheme(mode: 'light' | 'dark'): Promise<boolean>;
  setTitle(t: string): Promise<boolean>;
  list(dir: string, recursive: boolean, kind?: Kind): Promise<FileItem[]>;
  stat(paths: string[]): Promise<({ path: string; size: number; mtime: number; dir: boolean } | null)[]>;
  hash(p: string, quick?: boolean): Promise<string>;
  openDialog(opts: { title?: string; folder?: boolean; defaultPath?: string; kind?: Kind }): Promise<string[]>;
  saveDialog(opts: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  write(p: string, data: Uint8Array): Promise<boolean>;
  openPath(p: string): Promise<string>;
  showInFolder(p: string): Promise<boolean>;
  tempPath(name: string): Promise<string>;
  /** a Word file as a PDF in the temp folder (Word on Windows, else LibreOffice); `why` when it could not be (`none`: no converter at all) */
  docxConvert(p: string): Promise<{ ok: true; pdf: string; by: string; cached?: boolean; earlier?: boolean } | { ok: false; why: string; none?: boolean; cancelled?: boolean }>;
  /** Stop (0.6.1 T34): the conversion running now is ended - its PowerShell / LibreOffice and its Word - and answers `cancelled` */
  docxCancel(): Promise<boolean>;
  cacheGet(k: string): Promise<{ json: any; thumb: Uint8Array } | null>;
  cachePreview(k: string): Promise<Uint8Array | null>;
  cachePut(k: string, json: unknown, thumb: Uint8Array, preview: Uint8Array): Promise<boolean>;
  cacheClear(): Promise<boolean>;
  cacheSize(): Promise<number>;
  enginesStart(names: string[]): Promise<boolean>;
  enginePriority(name: string, low: boolean): Promise<boolean>;
  engineKill(name: string): Promise<boolean>;
  /** start an engine afresh (an old one of that name is closed), or close it for good */
  engineAdd(name: string): Promise<boolean>;
  engineStop(name: string, discard?: string[]): Promise<boolean>;
  /** a file being written (closing the window asks first), '' when done */
  busy(what: string): Promise<boolean>;
  pathOf(file: File): string;
  updateGet(): Promise<UpdateState>;
  updateCheck(): Promise<UpdateState>;
  updateDownload(): Promise<UpdateState>;
  updateCancel(): Promise<UpdateState>;
  updateLater(): Promise<boolean>;
  /** the releases page, in the browser */
  updateOpenPage(): Promise<boolean>;
  /** restart onto the downloaded version ('update'), the previous one ('back') or the newest ('newest') */
  updateRestart(what: 'update' | 'back' | 'newest'): Promise<boolean>;
  updateAfterStart(): Promise<Updated | null>;
  /** the setup for a new runtime: its download page (only what the updater found) */
  updateShowSetup(): Promise<boolean>;
  onUpdate(cb: (st: UpdateState) => void): () => void;
  /** Report a problem: kept on this PC; sent anonymously when there is a report receiver */
  reportProblem(text: string, extra?: { openFiles?: number; tab?: string }): Promise<ReportStatus>;
  reportStatus(): Promise<ReportStatus>;
  /** anonymous crash reports on / off (only with a receiver) */
  reportCrashSharing(on: boolean): Promise<ReportStatus>;
  /** what a crash report sent from here looks like (JSON) */
  reportPreview(): Promise<string>;
  reportOpenQueue(): Promise<string>;
  reportCrash(where: string, message: string, stack: string): void;
  onReports(cb: () => void): () => void;
  /** the user count (electron/counter.cjs): available = a receiver is set; ask = the pop-up isn't answered yet */
  countGet(): Promise<CountState>;
  /** the pop-up's answer / Settings > Privacy */
  countSet(on: boolean): Promise<CountState>;
  log(line: string): void;
  /** the window's code runs (a downloaded copy counts as working) */
  up?(): void;
}
export const rr: RR = (window as unknown as { rr: RR }).rr;

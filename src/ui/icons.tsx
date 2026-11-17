// Line icons (1.6 px strokes on a 20 px box).
const P: Record<string, string> = {
  folder: 'M3 6.5V15a1.5 1.5 0 001.5 1.5h11A1.5 1.5 0 0017 15V8a1.5 1.5 0 00-1.5-1.5H10L8.5 4.5h-4A1.5 1.5 0 003 6v.5',
  file: 'M5.5 2.5h6l3.5 3.5v11.5h-9.5zM11.5 2.5V6H15',
  files: 'M7.5 2.5h5l3 3v9h-8zM12.5 2.5v3h3M4.5 6v11.5h8',
  swap: 'M5 7h11M13 4l3 3-3 3M15 13H4M7 10l-3 3 3 3',
  play: 'M6.5 4.5l9 5.5-9 5.5z',
  stop: 'M5.5 5.5h9v9h-9z',
  next: 'M7.5 4.5L13 10l-5.5 5.5',
  prev: 'M12.5 4.5L7 10l5.5 5.5',
  down: 'M4.5 7.5L10 13l5.5-5.5',
  up: 'M4.5 12.5L10 7l5.5 5.5',
  fit: 'M3.5 7V3.5H7M13 3.5h3.5V7M16.5 13v3.5H13M7 16.5H3.5V13',
  zoomin: 'M9 4a5 5 0 100 10A5 5 0 009 4zM13 13l4 4M9 7v4M7 9h4',
  zoomout: 'M9 4a5 5 0 100 10A5 5 0 009 4zM13 13l4 4M7 9h4',
  overlay: 'M3.5 5.5h9v9h-9zM7.5 3.5h9v9',
  side: 'M3 4.5h6.5v11H3zM10.5 4.5H17v11h-6.5z',
  old: 'M4 4.5h12v11H4zM7 8h6M7 11h4',
  flicker: 'M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.4 1.4M13.6 13.6L15 15M5 15l1.4-1.4M13.6 6.4L15 5M10 7a3 3 0 100 6 3 3 0 000-6z',
  highlight: 'M11.5 3.5l5 5-6.5 6.5H5v-5zM8.2 6.8l5 5M3 17.5h8',
  export: 'M10 3v9M6.5 6.5L10 3l3.5 3.5M4 11v4.5a1 1 0 001 1h10a1 1 0 001-1V11',
  pdf: 'M5.5 2.5h6l3.5 3.5v11.5h-9.5zM7.5 10.5h5M7.5 13h5M7.5 8h2',
  sheet: 'M3.5 4h13v12h-13zM3.5 8h13M3.5 12h13M8 4v12M12 4v12',
  settings: 'M16.10 11.13 L17.90 12.19 L17.14 14.04 L15.11 13.51 L13.51 15.11 L14.04 17.14 L12.19 17.90 L11.13 16.10 L8.87 16.10 L7.81 17.90 L5.96 17.14 L6.49 15.11 L4.89 13.51 L2.86 14.04 L2.10 12.19 L3.90 11.13 L3.90 8.87 L2.10 7.81 L2.86 5.96 L4.89 6.49 L6.49 4.89 L5.96 2.86 L7.81 2.10 L8.87 3.90 L11.13 3.90 L12.19 2.10 L14.04 2.86 L13.51 4.89 L15.11 6.49 L17.14 5.96 L17.90 7.81 L16.10 8.87z M10 7.3a2.7 2.7 0 100 5.4 2.7 2.7 0 000-5.4z',
  check: 'M4.5 10.5l3.5 3.5 7.5-8',
  x: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
  search: 'M8.5 3.5a5 5 0 100 10 5 5 0 000-10zM12.2 12.2l4.3 4.3',
  rows: 'M3.5 5h13M3.5 10h13M3.5 15h13',
  grid: 'M3.5 3.5h5.5V9H3.5zM11 3.5h5.5V9H11zM3.5 11h5.5v5.5H3.5zM11 11h5.5v5.5H11z',
  eye: 'M2.5 10s3-5.5 7.5-5.5 7.5 5.5 7.5 5.5-3 5.5-7.5 5.5S2.5 10 2.5 10zM10 7.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
  eyeoff: 'M3 3l14 14M8.2 5a8 8 0 011.8-.2c4.5 0 7.5 5.2 7.5 5.2a14 14 0 01-2.2 2.8M12 15a7 7 0 01-2 .3C5.5 15.3 2.5 10 2.5 10a14 14 0 013-3.4',
  target: 'M10 3.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM10 7a3 3 0 100 6 3 3 0 000-6zM10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3',
  pin: 'M10 17.5s-5.5-5-5.5-9a5.5 5.5 0 0111 0c0 4-5.5 9-5.5 9zM10 6.5a2 2 0 100 4 2 2 0 000-4z',
  info: 'M10 3a7 7 0 100 14 7 7 0 000-14zM10 9v4.5M10 6.5v.2',
  refresh: 'M15.5 7A6 6 0 004.6 7.5M4.5 13a6 6 0 0010.9-.5M15.5 3.5V7H12M4.5 16.5V13H8',
  align: 'M4 4l4 4M4 4v3M4 4h3M16 16l-4-4M16 16v-3M16 16h-3M10 10.01',
  pair: 'M6 4.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM14 10.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM8 8.5l4 3',
  moon: 'M15.5 12.5A6.5 6.5 0 017.5 4.5a6.5 6.5 0 108 8z',
  sun: 'M10 6.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM10 2v1.5M10 16.5V18M2 10h1.5M16.5 10H18M4.3 4.3l1.1 1.1M14.6 14.6l1.1 1.1M4.3 15.7l1.1-1.1M14.6 5.4l1.1-1.1',
  home: 'M3.5 9.5L10 4l6.5 5.5M5.5 8v8h9V8',
  zone: 'M3.5 3.5h13v13h-13zM3.5 3.5l13 13M16.5 3.5l-13 13',
  undo: 'M6.5 8H12a4 4 0 010 8H8M9 5L6 8l3 3',
  panelleft: 'M3.5 4h13v12h-13zM7.5 4v12M5 7h1M5 9.5h1',
  panelright: 'M3.5 4h13v12h-13zM12.5 4v12M14 7h1M14 9.5h1',
  keyboard: 'M2.5 5.5h15v9h-15zM5 8h1M8 8h1M11 8h1M14 8h1M5 11h1M14 11h1M8 11h4',
};
export function Icon({ n, size = 18, sw = 1.6, className }: { n: string; size?: number; sw?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[n] || ''} />
    </svg>
  );
}

/** the app's mark: a radar sweep over a sheet */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="rrg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f8e189" /><stop offset=".45" stopColor="#d6af67" /><stop offset="1" stopColor="#b07741" /></linearGradient>
        <radialGradient id="rrs" cx="32" cy="32" r="26" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#d6af67" stopOpacity=".05" /><stop offset="1" stopColor="#d6af67" stopOpacity=".55" /></radialGradient>
      </defs>
      <circle cx="32" cy="32" r="27" fill="none" stroke="url(#rrg)" strokeWidth="3.5" />
      <circle cx="32" cy="32" r="17" fill="none" stroke="url(#rrg)" strokeWidth="2.5" opacity=".75" />
      <path d="M32 32 L32 5 A27 27 0 0 1 55.4 18.5 Z" fill="url(#rrs)" />
      <path d="M32 32 L55.4 18.5" stroke="url(#rrg)" strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="44.5" cy="15.5" r="4" fill="#ff5a4e" />
      <circle cx="32" cy="32" r="3.2" fill="url(#rrg)" />
    </svg>
  );
}

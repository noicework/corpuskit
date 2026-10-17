import type { ComponentType, ReactNode } from 'react'

export type IconSize = 'sm' | 'md' | 'lg'

export interface IconProps {
  size?: IconSize
  className?: string
  title?: string
}

export type IconComponent = ComponentType<IconProps>

const sizes: Record<IconSize, string> = { sm: '1rem', md: '1.25rem', lg: '1.5rem' }

/** Original paths on a shared grid; each shape is created once, outside the render. */
function createIcon(name: string, shape: ReactNode): IconComponent {
  function Icon({ size = 'md', className, title }: IconProps) {
    const named = Boolean(title?.trim())
    return (
      <svg
        xmlns='http://www.w3.org/2000/svg'
        viewBox='0 0 24 24'
        width={sizes[size]}
        height={sizes[size]}
        fill='none'
        stroke='currentColor'
        strokeWidth={1.75}
        strokeLinecap='round'
        strokeLinejoin='round'
        className={className}
        focusable='false'
        aria-hidden={named ? undefined : true}
        role={named ? 'img' : undefined}
        aria-label={named ? title : undefined}
      >
        {named && <title>{title}</title>}
        {shape}
      </svg>
    )
  }
  Icon.displayName = name
  return Icon
}

export const Search = /* @__PURE__ */ createIcon(
  'Search',
  <>
    <circle cx='10.5' cy='10.5' r='6.75' />
    <path d='m15.5 15.5 5 5' />
  </>,
)
export const X = /* @__PURE__ */ createIcon('X', <path d='m5 5 14 14M19 5 5 19' />)
export const Menu = /* @__PURE__ */ createIcon('Menu', <path d='M4 6h16M4 12h16M4 18h16' />)
export const ChevronDown = /* @__PURE__ */ createIcon(
  'ChevronDown',
  <path d='m5 8.5 7 7 7-7' />,
)
export const ChevronUp = /* @__PURE__ */ createIcon('ChevronUp', <path d='m5 15.5 7-7 7 7' />)
export const ChevronLeft = /* @__PURE__ */ createIcon('ChevronLeft', <path d='m15.5 5-7 7 7 7' />)
export const ChevronRight = /* @__PURE__ */ createIcon('ChevronRight', <path d='m8.5 5 7 7-7 7' />)
export const ArrowLeft = /* @__PURE__ */ createIcon(
  'ArrowLeft',
  <path d='M20 12H4m7-7-7 7 7 7' />,
)
export const ArrowRight = /* @__PURE__ */ createIcon(
  'ArrowRight',
  <path d='M4 12h16m-7-7 7 7-7 7' />,
)
export const ArrowUp = /* @__PURE__ */ createIcon('ArrowUp', <path d='M12 20V4m-7 7 7-7 7 7' />)
export const ArrowUpRight = /* @__PURE__ */ createIcon(
  'ArrowUpRight',
  <path d='M5 19 19 5M8 5h11v11' />,
)
export const ExternalLink = /* @__PURE__ */ createIcon(
  'ExternalLink',
  <path d='M14 4h6v6m0-6L10 14m0-9H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-5' />,
)
export const Plus = /* @__PURE__ */ createIcon('Plus', <path d='M12 4v16M4 12h16' />)
export const Minus = /* @__PURE__ */ createIcon('Minus', <path d='M4 12h16' />)
export const Check = /* @__PURE__ */ createIcon('Check', <path d='m4 12 5.5 5.5L20 7' />)
export const CheckCircle = /* @__PURE__ */ createIcon(
  'CheckCircle',
  <>
    <circle cx='12' cy='12' r='9' />
    <path d='m7.25 12 3.25 3.25 6.25-6.5' />
  </>,
)
export const Info = /* @__PURE__ */ createIcon(
  'Info',
  <>
    <circle cx='12' cy='12' r='9' />
    <path d='M12 10.5v6M12 7.25h.01' />
  </>,
)
export const AlertTriangle = /* @__PURE__ */ createIcon(
  'AlertTriangle',
  <path d='M12 3.75 21 20.25H3L12 3.75ZM12 9v5M12 17.25h.01' />,
)
export const AlertCircle = /* @__PURE__ */ createIcon(
  'AlertCircle',
  <>
    <circle cx='12' cy='12' r='9' />
    <path d='M12 6.75v6.5M12 17.25h.01' />
  </>,
)
export const HelpCircle = /* @__PURE__ */ createIcon(
  'HelpCircle',
  <>
    <circle cx='12' cy='12' r='9' />
    <path d='M9.25 8.5a2.8 2.8 0 0 1 5.5.75c0 2-2.75 2.25-2.75 4.25M12 17h.01' />
  </>,
)
export const User = /* @__PURE__ */ createIcon(
  'User',
  <>
    <circle cx='12' cy='7.75' r='3.75' />
    <path d='M4.5 20v-1.5a7.5 5 0 0 1 15 0V20' />
  </>,
)
export const Users = /* @__PURE__ */ createIcon(
  'Users',
  <>
    <circle cx='9' cy='8' r='3.25' />
    <path d='M2.75 20v-1.25a6.25 4.5 0 0 1 12.5 0V20M16 4.75a3.25 3.25 0 0 1 0 6.5m2 3a4.5 4.5 0 0 1 3.25 4.5V20' />
  </>,
)
export const Sun = /* @__PURE__ */ createIcon(
  'Sun',
  <>
    <circle cx='12' cy='12' r='4.25' />
    <path d='M12 2.75v2M12 19.25v2M2.75 12h2m14.5 0h2M5.5 5.5l1.4 1.4m10.2 10.2 1.4 1.4m0-13-1.4 1.4M6.9 17.1l-1.4 1.4' />
  </>,
)
export const Moon = /* @__PURE__ */ createIcon(
  'Moon',
  <path d='M14 3a9.1 9.1 0 1 0 7 12.5A8 8 0 0 1 14 3Z' />,
)
export const Trash = /* @__PURE__ */ createIcon(
  'Trash',
  <path d='M3.5 6.5h17M8.5 6.5v-3h7v3M6 6.5l.75 13a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1L18 6.5M10 10v7m4-7v7' />,
)
export const Bookmark = /* @__PURE__ */ createIcon(
  'Bookmark',
  <path d='M6 3.5h12v17l-6-4-6 4v-17Z' />,
)
export const BookmarkFilled = /* @__PURE__ */ createIcon(
  'BookmarkFilled',
  <path d='M6 3.5h12v17l-6-4-6 4v-17Z' fill='currentColor' />,
)
export const Pin = /* @__PURE__ */ createIcon(
  'Pin',
  <path d='M8 3.5h8l-1.5 6 3.5 4V15H6v-1.5l3.5-4L8 3.5ZM12 15v6' />,
)
export const Copy = /* @__PURE__ */ createIcon(
  'Copy',
  <>
    <rect x='8' y='8' width='12.5' height='12.5' rx='1.5' />
    <path d='M15.5 8V3.5h-12v12H8' />
  </>,
)
export const RotateCw = /* @__PURE__ */ createIcon(
  'RotateCw',
  <path d='M20.25 10A8.5 8.5 0 1 0 18 18M20.25 3.75V10H14' />,
)
export const RotateCcw = /* @__PURE__ */ createIcon(
  'RotateCcw',
  <path d='M3.75 10A8.5 8.5 0 1 1 6 18M3.75 3.75V10H10' />,
)
export const ThumbsUp = /* @__PURE__ */ createIcon(
  'ThumbsUp',
  <path d='M8 10 12.5 3a3 3 0 0 1 1.25 3.5L13 9h6a1.75 1.75 0 0 1 1.7 2.15l-1.75 7A2.5 2.5 0 0 1 16.5 20H8M3.5 10H8v10H3.5V10Z' />,
)
export const ThumbsDown = /* @__PURE__ */ createIcon(
  'ThumbsDown',
  <path d='M8 14 12.5 21a3 3 0 0 0 1.25-3.5L13 15h6a1.75 1.75 0 0 0 1.7-2.15l-1.75-7A2.5 2.5 0 0 0 16.5 4H8M3.5 4H8v10H3.5V4Z' />,
)
export const ShieldCheck = /* @__PURE__ */ createIcon(
  'ShieldCheck',
  <path d='m12 3 8 3v6c0 4-4.5 7.5-8 9-3.5-1.5-8-5-8-9V6l8-3Zm-4 9 2.75 2.75L16 9.5' />,
)
export const Eye = /* @__PURE__ */ createIcon(
  'Eye',
  <>
    <path d='M2.75 12s3.5-6.5 9.25-6.5 9.25 6.5 9.25 6.5-3.5 6.5-9.25 6.5S2.75 12 2.75 12Z' />
    <circle cx='12' cy='12' r='2.75' />
  </>,
)
export const EyeOff = /* @__PURE__ */ createIcon(
  'EyeOff',
  <path d='m3 3 18 18M8 6.25a10.5 10.5 0 0 1 4-.75c5.75 0 9.25 6.5 9.25 6.5a19 19 0 0 1-3 3.75M14.5 18.15a10 10 0 0 1-2.5.35c-5.75 0-9.25-6.5-9.25-6.5a19 19 0 0 1 2.5-3.25m4.8 1.3a2.75 2.75 0 0 0 3.9 3.9' />,
)
export const Pencil = /* @__PURE__ */ createIcon(
  'Pencil',
  <path d='m14.5 4.5 5 5M4.75 14.25 16 3l5 5L9.75 19.25 3 21l1.75-6.75Z' />,
)
export const Upload = /* @__PURE__ */ createIcon(
  'Upload',
  <path d='M12 16V3.5m-5 5 5-5 5 5M4 15v5.5h16V15' />,
)
export const Download = /* @__PURE__ */ createIcon(
  'Download',
  <path d='M12 3.5V16m-5-5 5 5 5-5M4 15v5.5h16V15' />,
)
export const Printer = /* @__PURE__ */ createIcon(
  'Printer',
  <path d='M7 8V3.5h10V8M7 17H3.5V8.5h17V17H17M7 13.5h10v7H7v-7ZM17 11h.01' />,
)
export const ZoomIn = /* @__PURE__ */ createIcon(
  'ZoomIn',
  <>
    <circle cx='10.5' cy='10.5' r='6.75' />
    <path d='m15.5 15.5 5 5M7 10.5h7m-3.5-3.5v7' />
  </>,
)
export const ZoomOut = /* @__PURE__ */ createIcon(
  'ZoomOut',
  <>
    <circle cx='10.5' cy='10.5' r='6.75' />
    <path d='m15.5 15.5 5 5M7 10.5h7' />
  </>,
)
export const Maximize = /* @__PURE__ */ createIcon(
  'Maximize',
  <path d='M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5' />,
)
export const FitWidth = /* @__PURE__ */ createIcon(
  'FitWidth',
  <path d='M3.5 4v16m17-16v16M7 12h10m-7-3-3 3 3 3m4-6 3 3-3 3' />,
)
export const SlidersHorizontal = /* @__PURE__ */ createIcon(
  'SlidersHorizontal',
  <>
    <path d='M3.5 5.5h2.75m4.5 0h9.75M3.5 12h9.75m4.5 0h2.75M3.5 18.5h2.75m4.5 0h9.75' />
    <circle cx='8.5' cy='5.5' r='2.25' />
    <circle cx='15.5' cy='12' r='2.25' />
    <circle cx='8.5' cy='18.5' r='2.25' />
  </>,
)
export const LayoutGrid = /* @__PURE__ */ createIcon(
  'LayoutGrid',
  <path d='M3.5 3.5H10V10H3.5V3.5Zm10.5 0h6.5V10H14V3.5ZM3.5 14H10v6.5H3.5V14ZM14 14h6.5v6.5H14V14Z' />,
)
export const LayoutList = /* @__PURE__ */ createIcon(
  'LayoutList',
  <path d='M3.5 4h4v4h-4V4Zm0 12h4v4h-4v-4Zm0-6h4v4h-4v-4ZM11 6h9.5M11 12h9.5M11 18h9.5' />,
)
export const FileText = /* @__PURE__ */ createIcon(
  'FileText',
  <path d='M13 3.5H5v17h14V9.5l-6-6Zm0 0v6h6M8.5 13h7m-7 3.5h7' />,
)
export const File = /* @__PURE__ */ createIcon(
  'File',
  <path d='M13 3.5H5v17h14V9.5l-6-6Zm0 0v6h6' />,
)
export const Globe = /* @__PURE__ */ createIcon(
  'Globe',
  <>
    <circle cx='12' cy='12' r='9' />
    <ellipse cx='12' cy='12' rx='3.75' ry='9' />
    <path d='M3 12h18M4.5 7.5h15m-15 9h15' />
  </>,
)
export const Image = /* @__PURE__ */ createIcon(
  'Image',
  <>
    <rect x='3.5' y='3.5' width='17' height='17' rx='1' />
    <circle cx='8.5' cy='8.5' r='1.5' />
    <path d='m3.5 17 5-5 3.5 3.5 4.5-6 4 5' />
  </>,
)
export const Table = /* @__PURE__ */ createIcon(
  'Table',
  <path d='M3.5 4.5h17v15h-17v-15Zm0 5h17m-17 5h17M9 4.5v15' />,
)
export const MessageSquare = /* @__PURE__ */ createIcon(
  'MessageSquare',
  <path d='M4 4h16v12H9l-5 4V4Z' />,
)
export const History = /* @__PURE__ */ createIcon(
  'History',
  <path d='M3.75 10A8.5 8.5 0 1 1 6 18M3.75 3.75V10H10m2-3v5l3.5 2' />,
)
export const Sparkles = /* @__PURE__ */ createIcon(
  'Sparkles',
  <path d='m11 5 2.25 5.75L19 13l-5.75 2.25L11 21l-2.25-5.75L3 13l5.75-2.25L11 5Zm8-2 1 2.5 2.5 1L20 7.5 19 10l-1-2.5-2.5-1 2.5-1L19 3ZM4.5 3v3M3 4.5h3' />,
)
export const Share = /* @__PURE__ */ createIcon(
  'Share',
  <>
    <circle cx='17.5' cy='5.5' r='2.5' />
    <circle cx='6' cy='12' r='2.5' />
    <circle cx='17.5' cy='18.5' r='2.5' />
    <path d='m8.25 10.75 7-4m-7 6.5 7 4' />
  </>,
)
export const Network = /* @__PURE__ */ createIcon(
  'Network',
  <path d='M9 3.5h6v5H9v-5Zm-6 12h6v5H3v-5Zm12 0h6v5h-6v-5Zm-3-7v4M6 15.5v-3h12v3' />,
)
export const Grid2x2 = /* @__PURE__ */ createIcon(
  'Grid2x2',
  <>
    <rect x='3.5' y='3.5' width='17' height='17' rx='1' />
    <path d='M12 3.5v17M3.5 12h17' />
  </>,
)
export const Scatter = /* @__PURE__ */ createIcon(
  'Scatter',
  <>
    <path d='M3.5 3.5v17h17' />
    <circle cx='7.75' cy='15.25' r='1.25' />
    <circle cx='12.5' cy='12.5' r='1.25' />
    <circle cx='12' cy='6' r='1.25' />
    <circle cx='18' cy='8.75' r='1.25' />
    <circle cx='18.75' cy='15.5' r='1.25' />
  </>,
)
export const Workflow = /* @__PURE__ */ createIcon(
  'Workflow',
  <path d='M3.5 3.5h6v6h-6v-6Zm11 11h6v6h-6v-6Zm-5-8h5a3 3 0 0 1 3 3v5M14 11l3.5 3.5L21 11M6.5 13v7.5M3 17l3.5 3.5L10 17' />,
)
export const Library = /* @__PURE__ */ createIcon(
  'Library',
  <path d='M3 4h3.5v16H3V4Zm6 0h3.5v16H9V4Zm6 1 3.25-.75 3 15-3.25.75L15 5ZM3 16h3.5M9 16h3.5' />,
)
export const Compass = /* @__PURE__ */ createIcon(
  'Compass',
  <>
    <circle cx='12' cy='12' r='9' />
    <path d='m16.5 7.5-2.75 6.25-6.25 2.75 2.75-6.25 6.25-2.75Z' />
  </>,
)
export const Link = /* @__PURE__ */ createIcon(
  'Link',
  <path d='m9 8 3-3a4.25 4.25 0 0 1 6 6l-3 3m-6-4-3 3a4.25 4.25 0 0 0 6 6l3-3m-7-1 8-8' />,
)
export const Key = /* @__PURE__ */ createIcon(
  'Key',
  <>
    <circle cx='8' cy='8' r='4.5' />
    <path d='m11.25 11.25 9 9M16 16l2.5-2.5M18.75 18.75l2.5-2.5' />
  </>,
)
export const Lock = /* @__PURE__ */ createIcon(
  'Lock',
  <>
    <rect x='5' y='10' width='14' height='10.5' rx='1.5' />
    <path d='M8 10V7.5a4 4 0 0 1 8 0V10m-4 4v3' />
  </>,
)
export const LogOut = /* @__PURE__ */ createIcon(
  'LogOut',
  <path d='M10 3.5H4v17h6m-1-8.5h12m-5-5 5 5-5 5' />,
)
export const Calendar = /* @__PURE__ */ createIcon(
  'Calendar',
  <path d='M4 5.5h16v15H4v-15Zm0 5h16M8 3v5m8-5v5m-8.5 6.5h.01m4.49 0h.01m4.49 0h.01m-9.01 3.25h.01m4.49 0h.01' />,
)
export const Clock = /* @__PURE__ */ createIcon(
  'Clock',
  <>
    <circle cx='12' cy='12' r='9' />
    <path d='M12 6.5V12l4 2.5' />
  </>,
)
export const Tag = /* @__PURE__ */ createIcon(
  'Tag',
  <>
    <path d='M3.5 3.5H12l9 9-8.5 8.5-9-9V3.5Z' />
    <circle cx='8' cy='8' r='1.25' />
  </>,
)
export const Database = /* @__PURE__ */ createIcon(
  'Database',
  <>
    <ellipse cx='12' cy='6' rx='8' ry='3' />
    <path d='M4 6v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0' />
  </>,
)
export const Settings = /* @__PURE__ */ createIcon(
  'Settings',
  <>
    <path d='m9.5 3-.75 2.5-2.5 1L3.75 6 2 9l1.75 2v2L2 15l1.75 3 2.5-.5 2.5 1L9.5 21h5l.75-2.5 2.5-1 2.5.5L22 15l-1.75-2v-2L22 9l-1.75-3-2.5.5-2.5-1L14.5 3h-5Z' />
    <circle cx='12' cy='12' r='3.25' />
  </>,
)
export const Send = /* @__PURE__ */ createIcon(
  'Send',
  <path d='m3 4 18 8-18 8 3-8-3-8Zm3 8h15' />,
)
export const Filter = /* @__PURE__ */ createIcon(
  'Filter',
  <path d='M3.5 4h17L14 12v7l-4 2v-9L3.5 4Z' />,
)
export const Wand = /* @__PURE__ */ createIcon(
  'Wand',
  <path d='m3 18 12-12 3 3L6 21l-3-3Zm9-9 3 3M5 3v4M3 5h4m12 9v4m-2-2h4m-1-13 1 1m-10-2v2' />,
)

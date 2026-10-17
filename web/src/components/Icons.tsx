import type { ReactNode } from "react";

function Svg({ children, size = 24 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const HomeIcon = () => (
  <Svg>
    <path d="M3 11l9-8 9 8" />
    <path d="M5 10v10h5v-6h4v6h5V10" />
  </Svg>
);
export const CatalogIcon = () => (
  <Svg>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </Svg>
);
export const SearchIcon = () => (
  <Svg>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4-4" />
  </Svg>
);
export const BrochureIcon = () => (
  <Svg>
    <path d="M4 5a2 2 0 012-2h12v16H6a2 2 0 00-2 2z" />
    <path d="M4 21V5" />
    <path d="M9 8h6M9 12h6" />
  </Svg>
);
export const FilterIcon = () => (
  <Svg size={20}>
    <path d="M3 5h18M6 12h12M10 19h4" />
  </Svg>
);
export const CloseIcon = () => (
  <Svg size={20}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const ShareIcon = () => (
  <Svg size={20}>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4" />
  </Svg>
);
export const FlagIcon = () => (
  <Svg size={20}>
    <path d="M5 21V4" />
    <path d="M5 4h12l-2 4 2 4H5" />
  </Svg>
);
export const BackIcon = () => (
  <Svg size={20}>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
);
export const ExternalIcon = () => (
  <Svg size={18}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-9 9" />
    <path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
  </Svg>
);

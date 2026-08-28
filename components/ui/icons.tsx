import type { SVGProps } from 'react';

/**
 * The icon set used by the ShopiQ design, transcribed from ShopiQ.dc.html so
 * stroke weights and geometry match the source exactly.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Stroke({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

function Filled({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** The four-point spark that marks every AI entry point in the design. */
export const SparkIcon = (props: IconProps) => (
  <Filled {...props}>
    <path d="M12 2l2.1 6.2L20 10l-5.9 1.8L12 18l-2.1-6.2L4 10l5.9-1.8z" />
  </Filled>
);

export const SearchIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    aria-hidden="true"
    {...rest}
  >
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4.2-4.2" />
  </svg>
);

export const CartIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M3 4h2l2.4 10.4a2 2 0 002 1.6h8.1a2 2 0 002-1.6L21 7H6" />
    <circle cx="10" cy="20" r="1.5" />
    <circle cx="18" cy="20" r="1.5" />
  </Stroke>
);

export const UserIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    aria-hidden="true"
    {...rest}
  >
    <circle cx="12" cy="8.5" r="3.6" />
    <path d="M5 20c1.4-3.4 4-5 7-5s5.6 1.6 7 5" />
  </svg>
);

export const HeartIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M12 20s-7-4.4-7-9.3A3.9 3.9 0 0112 8a3.9 3.9 0 017 2.7c0 4.9-7 9.3-7 9.3z" />
  </Stroke>
);

export const StarIcon = (props: IconProps) => (
  <Filled {...props}>
    <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z" />
  </Filled>
);

export const MicIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    aria-hidden="true"
    {...rest}
  >
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3" />
  </svg>
);

export const CloseIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Stroke>
);

export const ChevronDownIcon = ({ size = 12, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    aria-hidden="true"
    {...rest}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const ChevronRightIcon = ({ size = 12, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    aria-hidden="true"
    {...rest}
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const CheckIcon = ({ size = 12, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={3.2}
    strokeLinecap="round"
    aria-hidden="true"
    {...rest}
  >
    <path d="M5 13l4 4 10-10" />
  </svg>
);

export const HomeIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M4 11l8-6 8 6v8a1 1 0 01-1 1h-4v-6h-6v6H5a1 1 0 01-1-1z" />
  </Stroke>
);

export const BoxIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M21 8l-9-5-9 5 9 5 9-5z" />
    <path d="M3 8v8l9 5 9-5V8" />
    <path d="M12 13v8" />
  </Stroke>
);

export const LayersIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3 13l9 5 9-5" />
  </Stroke>
);

export const ChartIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Stroke>
);

export const ClipboardIcon = (props: IconProps) => (
  <Stroke {...props}>
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <path d="M9 4V3h6v1M9 10h6M9 14h4" />
  </Stroke>
);

export const PlusIcon = ({ size = 14, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    aria-hidden="true"
    {...rest}
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const MinusIcon = ({ size = 14, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    aria-hidden="true"
    {...rest}
  >
    <path d="M5 12h14" />
  </svg>
);

export const UploadIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M12 16V4M7 9l5-5 5 5" />
    <path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" />
  </Stroke>
);

export const AlertIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M12 3l9 16H3z" />
    <path d="M12 10v4M12 17.5v.01" />
  </Stroke>
);

export const PackageCheckIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M20 12V8l-8-5-8 5v8l8 5 4-2.5" />
    <path d="M15 19l2 2 4-4" />
  </Stroke>
);

export const LogOutIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M15 17l5-5-5-5M20 12H9" />
    <path d="M12 4H6a2 2 0 00-2 2v12a2 2 0 002 2h6" />
  </Stroke>
);

export const FilterIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M3 5h18M6 12h12M10 19h4" />
  </Stroke>
);

export const SpinnerIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    className="animate-spin"
    {...rest}
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={2.4} opacity={0.25} />
    <path
      d="M21 12a9 9 0 00-9-9"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
    />
  </svg>
);

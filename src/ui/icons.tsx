/**
 * Shared inline icons. Same convention as KindIcon: 18x18 by default, a
 * 24-unit viewBox, 1.7 stroke width, and `currentColor` so an icon inherits
 * the colour of the control it sits in.
 */

export function RefreshIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

import type { SVGProps } from "react";

/** Distinctive Caffy coffee-cup marker; badge color describes its schedule mode. */
export function CaffyCoffeePotIcon({ stopped = false, ...props }: SVGProps<SVGSVGElement> & { stopped?: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M4 8h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z" />
      <path d="M16 9h1.4a3 3 0 0 1 0 6H16" />
      <path d="M2.8 20h16.8" />
      <path d="M8 5c-.8-1 .7-1.5.1-2.4" />
      <path d="M12 5c-.8-1 .7-1.5.1-2.4" />
      {stopped && <path d="M3 21L21 3" strokeWidth="2.6" />}
    </svg>
  );
}

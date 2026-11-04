import type { SVGProps } from "react";

/** Distinctive Caffy marker: a small lidded coffee pot, not an alarm or timer. */
export function CaffyCoffeePotIcon(props: SVGProps<SVGSVGElement>) {
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
      <path d="M9.5 4h5" />
      <path d="M8 6.5h8" />
      <path d="M8 8h8l1.2 11H6.8L8 8Z" />
      <path d="M8 10H5.2L3 13.5l3.8 1.2" />
      <path d="M16.5 10h2a3 3 0 0 1 0 6h-1.6" />
      <path d="M7 19h10" />
    </svg>
  );
}

import type { SVGProps } from "react";

// A small browser-chat glyph drawn for the sidebar's New ChatGPT session action.
export function ChatGPTSessionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M16.5 4.5H7A4 4 0 0 0 3 8.5v6A4 4 0 0 0 7 18.5h2l3.2 2v-2" />
      <path d="M7.8 10.6a2.1 2.1 0 0 1 3.3-2.2 2.1 2.1 0 0 1 3.3 2.2 2.1 2.1 0 0 1-1.5 3.7 2.1 2.1 0 0 1-3.6-.6 2.1 2.1 0 0 1-1.5-3.1Z" />
      <path d="m9.3 9.9 2.8 1.5-2.1 1.3m2.1-1.3 1.4-1.1" />
      <path d="M19 14v6m-3-3h6" strokeWidth="2" />
    </svg>
  );
}

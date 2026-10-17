import type { SVGProps } from "react";

const paths = {
  sidebar: "M3 3h18v18H3z M9 3v18 M5.5 7h1 M5.5 11h1",
  new: "M12 5v14 M5 12h14",
  plus: "M12 5v14 M5 12h14",
  search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5",
  folder: "M3 5h6l2 3h10v12H3z",
  attach: "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48",
  image: "M4 4h16v16H4z M4 16l5-5 4 4 3-3 4 4 M9 9h.01",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h8",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  plan: "M8 5h13 M8 12h13 M8 19h13 M3 5h.01 M3 12h.01 M3 19h.01",
  close: "M6 6l12 12 M18 6 6 18",
  check: "m5 12 4 4L19 6",
  chevronDown: "m6 9 6 6 6-6",
  chevronLeft: "m15 18-6-6 6-6",
  model: "M5 4h14v16H5z M9 8h.01 M15 8h.01 M9 14h6",
  expand: "M9 3H3v6 M15 3h6v6 M3 15v6h6 M21 15v6h-6",
  send: "M12 19V5 M6 11l6-6 6 6",
  stop: "M6 6h12v12H6z",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.7 2.94-.08-.02a1.7 1.7 0 0 0-1.76.6l-.05.07h-3.4l-.03-.08a1.7 1.7 0 0 0-1.44-1.14l-.1-.01-2.4-2.4.02-.08a1.7 1.7 0 0 0-.6-1.76l-.07-.05v-3.4l.08-.03a1.7 1.7 0 0 0 1.14-1.44l.01-.1 2.4-2.4.08.02a1.7 1.7 0 0 0 1.76-.6l.05-.07h3.4l.03.08a1.7 1.7 0 0 0 1.44 1.14l.1.01 2.4 2.4-.02.08a1.7 1.7 0 0 0 .6 1.76l.07.05V15z",
  terminal: "m4 17 6-5-6-5 M12 19h8",
  edit: "M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
} as const;

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]} /></svg>;
}

import { type ReactNode, useEffect, useRef } from "react";

/**
 * The tab bar at the top of the sidebar. The English tabs are much longer than the Chinese ones, and when the sidebar is narrow and cannot fit them, it scrolls horizontally.
 * Do not wrap lines, and do not push the close button next to it out.
 *
 * When scrollKey changes, scroll the current tab (aria-pressed) into view — 'Locate in source code'
 * The tab that this kind of jump switches to might be scrolling outside.
 */
export function TabStrip({ scrollKey, children }: { scrollKey: string; children: ReactNode }) {
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [scrollKey]);

  return (
    <div
      ref={strip}
      onWheel={(event) => {
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
      }}
      className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap"
    >
      {children}
    </div>
  );
}

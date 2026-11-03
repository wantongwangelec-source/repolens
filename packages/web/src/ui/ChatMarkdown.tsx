import { memo, useEffect, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeLine } from "./CodeLines";
import { useT } from "../i18n";
import { shikiLanguage, useHighlightedLines } from "../lib/highlight";
import { useAppStore } from "../store/useAppStore";
import { canAttachNode } from "../store/useChatStore";

/** Only take the fields needed from the hast nodes passed in by react-markdown, without importing the hast type package */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Rendering of AI responses.
 *
 * The `[Name](node:ID)` in the answer is the context node referenced by the model according to the prompt: rendered as clickable.
 * Node labels, highlighted on the canvas when hovered over and showing a preview card, click to directly locate — Answer
 * It is always connected to the canvas, rather than a piece of text that requires people to look for on the image themselves.
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  return (
    <div className="chat-markdown text-[12px] leading-relaxed text-[var(--color-ink)]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={streaming ? STREAMING_COMPONENTS : COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

/**
 * Markdown documents (README) in the repository. Shares formatting with AI responses, but links only allow external addresses:
 * Relative paths have no pages to jump to here; images are not loaded at all, leaving only the alternative text — relative paths cannot be obtained.
 * The badge icon outside the site will send a request to a third party.
 */
export const DocMarkdown = memo(function DocMarkdown({ content }: { content: string }) {
  return (
    <div className="chat-markdown doc-markdown text-[12px] leading-relaxed text-[var(--color-ink)]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeStripHtml]} components={DOC_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
});

/** react-markdown by default displays inline HTML as plain text; centered headings and <br> in the README only leave the text */
function rehypeStripHtml() {
  const strip = (node: HastNode): void => {
    node.children?.forEach((child, index) => {
      if (child.type === "raw") node.children![index] = { type: "text", value: (child.value ?? "").replace(/<[^>]*>/g, "") };
      else strip(child);
    });
  };
  return strip;
}

function urlTransform(url: string): string {
  return url.startsWith("node:") ? url : defaultUrlTransform(url);
}

// Two sets of components share the same a/code, and when switching at the end of the stream, the node links will not be re-mounted as a whole
const link: Components["a"] = ({ href, children }) => {
  if (href?.startsWith("node:")) return <NodeLink id={href.slice(5)}>{children}</NodeLink>;
  return <ExternalLink href={href}>{children}</ExternalLink>;
};

function ExternalLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] underline-offset-2 hover:underline">
      {children}
    </a>
  );
}

const inlineCode: Components["code"] = ({ children }) => (
  <code className="mono rounded bg-[var(--color-surface-3)] px-1 py-px text-[0.92em] text-[var(--color-ink)]">
    {children}
  </code>
);

function buildComponents(streaming: boolean): Components {
  return {
    a: link,
    code: inlineCode,
    pre({ node }) {
      const code = (node as unknown as HastNode | undefined)?.children?.find(
        (child) => child.type === "element" && child.tagName === "code",
      );
      const classes = code?.properties?.["className"];
      const lang = Array.isArray(classes)
        ? classes.map(String).find((name) => name.startsWith("language-"))?.slice("language-".length) ?? null
        : null;
      return <ChatCodeBlock code={code ? textOf(code).replace(/\n$/, "") : ""} lang={lang} highlight={!streaming} />;
    },
  };
}

const COMPONENTS = buildComponents(false);
/** In the era of streaming output, every character in the code block changes. First render it as plain text, then highlight it after finishing. */
const STREAMING_COMPONENTS = buildComponents(true);

const DOC_COMPONENTS: Components = {
  ...COMPONENTS,
  a: ({ href, children }) =>
    href && /^(?:https?:|mailto:)/i.test(href)
      ? <ExternalLink href={href}>{children}</ExternalLink>
      : <span title={href}>{children}</span>,
  img: ({ alt }) => (alt ? <span className="text-[var(--color-ink-faint)]">[{alt}]</span> : null),
};

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function NodeLink({ id, children }: { id: string; children: ReactNode }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  const hover = useAppStore((s) => s.hover);
  // When unloaded while hovering (press Esc to retract the dialog or close the details), mouseleave is not received, and the canvas will remain in a highlighted state.
  useEffect(() => () => {
    if (useAppStore.getState().hovered === id) useAppStore.getState().hover(null);
  }, [id]);
  if (!canAttachNode(id)) return <span className="text-[var(--color-accent)]">{children}</span>;
  return (
    <button
      type="button"
      title={t("在画布上定位")}
      onClick={() => {
        hover(null);
        void reveal(id);
      }}
      onMouseEnter={(event) => {
        // Place the preview card on the canvas on the left side of the sidebar, without covering the answer being read
        const left = event.currentTarget.closest("aside")?.getBoundingClientRect().left ?? event.clientX;
        hover(id, { x: left - 4, y: event.currentTarget.getBoundingClientRect().top });
      }}
      onMouseLeave={() => hover(null)}
      className="mx-px inline rounded bg-[var(--color-accent)]/10 px-1 text-left text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/20"
    >
      {children}
    </button>
  );
}

function ChatCodeBlock({ code, lang, highlight }: { code: string; lang: string | null; highlight: boolean }) {
  const shiki = shikiLanguage(lang);
  const tokens = useHighlightedLines(highlight ? code : null, shiki);
  const lines = code.split("\n");
  return (
    <div className="my-2 overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)]/60">
      {lang && (
        <div className="mono border-b border-[var(--color-line)] px-2.5 py-0.5 text-[9.5px] text-[var(--color-ink-faint)]">
          {lang}
        </div>
      )}
      <div className="thin-scroll overflow-x-auto">
        <div className="w-max min-w-full py-1.5 pl-2.5">
          {lines.map((line, index) => (
            <CodeLine key={index} number={null} text={line} tokens={tokens?.[index]} />
          ))}
        </div>
      </div>
    </div>
  );
}

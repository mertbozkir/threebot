import { lazy, Suspense, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math-extended";
import { escapePriceDollars } from "../lib/currencyDollars";
import { remarkBotLinks } from "../lib/remarkBotLinks";
import { parseThreadLink } from "../lib/botMessages";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { MermaidDiagram } from "./MermaidDiagram";
import "./MermaidDiagram.css";

export type RichMarkdownProps = {
  children: string;
  bots?: { slug: string; name: string }[];
  components?: Omit<Components, "pre" | "code">;
  urlTransform?: Options["urlTransform"];
};

function literalCode(node: ExtraProps["node"]) {
  return node?.children.map((child) => child.type === "text" ? child.value : "").join("") ?? "";
}

const LazyMathMarkup = lazy(() => import("./MathMarkup"));

function MathMarkup({ source, display }: { source: string; display: boolean }) {
  return <Suspense fallback={<code className="rich-math-literal">{source}</code>}><LazyMathMarkup source={source} display={display} /></Suspense>;
}

function RichCode({ node, children, className, ...props }: ComponentPropsWithoutRef<"code"> & ExtraProps) {
  if (className?.split(/\s+/).includes("math-inline")) return <MathMarkup source={literalCode(node)} display={false} />;
  return <code {...props} className={className}>{children}</code>;
}

function RichPre(props: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const code = props.node?.children.find((child) => child.type === "element" && child.tagName === "code");
  if (code?.type === "element") {
    const classes = code.properties.className ?? [];
    const source = literalCode(code);
    if (classes.includes("math-display")) return <MathMarkup source={source} display />;
    if (classes.includes("language-mermaid")) return <MermaidDiagram source={source.replace(/\n$/, "")} />;
  }
  return <MarkdownCodeBlock {...props} />;
}

/** Drop-in message renderer. Caller retains workspace/link/image navigation. */
export function RichMarkdown({ children, bots = [], components, urlTransform }: RichMarkdownProps) {
  return <ReactMarkdown
    skipHtml
    remarkPlugins={[remarkGfm, [remarkMath, { backslashDelimiters: true }], [remarkBotLinks, { bots }]]}
    components={{ ...components, pre: RichPre, code: RichCode }}
    urlTransform={urlTransform ?? ((url) => parseThreadLink(url) || url.startsWith("bot:") ? url : defaultUrlTransform(url))}
  >{escapePriceDollars(children)}</ReactMarkdown>;
}

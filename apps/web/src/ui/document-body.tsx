import type { Nodes, Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { createElement, Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { isMapPath } from "../routes/route-table.ts";

// 資料の本文（信頼しない入力）を、Markdown の構文木の許した節だけから React の要素にする。HTML の文字列は作らない

export type DocumentBodyProps = { markdown: string };

const BASE = "https://base.invalid";

function link(href: string, children: ReactNode, key: number): ReactNode {
  if (/^https:\/\//i.test(href)) {
    return (
      <a key={key} className="nd-inline" href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  // 画面の中の行き先は、同じ配信元の絶対の path で、画面マップに合うものだけ
  if (href.startsWith("/") && !href.includes("\\")) {
    const url = new URL(href, BASE);
    if (url.origin === BASE && isMapPath(url.pathname)) {
      return (
        <Link key={key} className="nd-inline" to={`${url.pathname}${url.search}${url.hash}`}>
          {children}
        </Link>
      );
    }
  }
  return <Fragment key={key}>{children}</Fragment>;
}

function table(node: Table, key: number): ReactNode {
  const [head, ...body] = node.children;
  const row = (cells: Table["children"][number], tag: "th" | "td", index: number) => (
    <tr key={index}>{cells.children.map((cell, i) => createElement(tag, { key: i }, cell.children.map(render)))}</tr>
  );
  return (
    <div key={key} className="nd-scroll" tabIndex={0}>
      <table>
        {head ? <thead>{row(head, "th", 0)}</thead> : null}
        <tbody>{body.map((cells, i) => row(cells, "td", i))}</tbody>
      </table>
    </div>
  );
}

function render(node: Nodes, key: number): ReactNode {
  const children = () => ("children" in node ? (node.children as Nodes[]).map(render) : null);
  const element = (tag: string) => createElement(tag, { key }, children());
  switch (node.type) {
    case "text":
      return node.value;
    case "paragraph":
      return element("p");
    case "heading":
      // 画面の題が h1 なので 1 つ下げる
      return element(`h${Math.min(node.depth + 1, 6)}`);
    case "list":
      return element(node.ordered ? "ol" : "ul");
    case "listItem":
      return element("li");
    case "blockquote":
      return element("blockquote");
    case "emphasis":
      return element("em");
    case "strong":
      return element("strong");
    case "break":
      return <br key={key} />;
    case "inlineCode":
      return <code key={key}>{node.value}</code>;
    case "code":
      return (
        <div key={key} className="nd-scroll" tabIndex={0}>
          <pre>
            <code>{node.value}</code>
          </pre>
        </div>
      );
    case "table":
      return table(node, key);
    case "link":
      return link(node.url, children(), key);
    case "image":
    case "imageReference":
      // 外の資源は読まず、代わりの文だけを出す
      return node.alt ?? null;
    case "html":
      return null;
    default:
      return <Fragment key={key}>{children()}</Fragment>;
  }
}

export function DocumentBody({ markdown }: DocumentBodyProps) {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return <div className="nd-document">{tree.children.map(render)}</div>;
}

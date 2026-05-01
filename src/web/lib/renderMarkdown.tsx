import type { ReactNode } from "react";
import { renderInline } from "./renderInline";

/**
 * Collapse newlines inside single-backtick inline code spans so the
 * line-based parser doesn't break them. Walks char-by-char pairing single
 * backticks; only the content between a matched open/close pair is
 * touched. The previous regex-based version greedily spanned across two
 * unrelated single-backtick spans whenever any newline sat between them,
 * collapsing structural newlines and merging headings into bullets.
 */
function normalizeInlineCode(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    // Skip past fenced code blocks intact — the block parser consumes them later.
    if (text[i] === "`" && text[i + 1] === "`" && text[i + 2] === "`") {
      const end = text.indexOf("```", i + 3);
      if (end === -1) { out += text.slice(i); return out; }
      out += text.slice(i, end + 3);
      i = end + 3;
      continue;
    }
    // Single backtick (not part of `` or ```) — find its mate.
    if (text[i] === "`" && text[i - 1] !== "`" && text[i + 1] !== "`") {
      let close = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] === "`" && text[j - 1] !== "`" && text[j + 1] !== "`") {
          close = j;
          break;
        }
      }
      if (close === -1) { out += text.slice(i); return out; }
      const content = text.slice(i + 1, close);
      out += "`" + (content.includes("\n") ? content.replace(/\n/g, " ") : content) + "`";
      i = close + 1;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/** Ensure block-level elements (headings, table rows) start on their own line */
function normalizeBlocks(text: string): string {
  // Ensure markdown headings start on their own line. '#' is excluded from the
  // lookbehind so that '## Heading' is not split into '#\n# Heading' — only a
  // heading marker preceded by non-hash content gets broken onto its own line.
  let result = text.replace(/([^\n/&#])(#{1,4}\s+)/g, "$1\n$2");
  // Ensure pipe-table rows (3+ cells) start on their own line
  result = result.replace(/([^\n|])\s*(\|(?:[^|\n]+\|){2,})/g, "$1\n$2");
  // Ensure pipe-separator rows start on their own line
  result = result.replace(/([^\n])\s*(\|[\s\-:|]+\|)/g, "$1\n$2");
  return result;
}

/** Render block-level markdown (headings, code blocks, tables, lists, hr, paragraphs) */
export function renderMarkdown(md: string): ReactNode {
  const lines = normalizeBlocks(normalizeInlineCode(md)).split("\n");
  const nodes: ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (line.trim() === "") { i++; continue; }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim()) || /^\*{3,}$/.test(line.trim())) {
      nodes.push(<hr key={k++} className="border-border/30 my-3" />);
      i++; continue;
    }

    // Headings
    const hm = line.match(/^(#{1,4})\s+(.+)/);
    if (hm) {
      const cls = hm[1].length <= 2
        ? "text-xs font-display font-bold uppercase tracking-[0.08em] text-foreground/90 mt-3 mb-1.5"
        : "text-xs font-display font-semibold text-foreground/80 mt-2.5 mb-1";
      nodes.push(<div key={k++} className={cls}>{renderInline(hm[2])}</div>);
      i++; continue;
    }

    // Fenced code block
    if (line.trim().startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      nodes.push(
        <pre key={k++} className="my-2 px-3 py-2 rounded-md bg-secondary/40 border border-border/30 overflow-x-auto text-[11px] font-mono text-foreground/90 leading-relaxed">
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // Table (line has | and next line is separator)
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s\-:|]+\|/.test(lines[i + 1])) {
      const tLines: string[] = [];
      while (i < lines.length && lines[i].includes("|")) {
        tLines.push(lines[i]);
        i++;
      }
      const parseRow = (row: string) => row.split("|").map(c => c.trim()).filter(c => c !== "");
      const header = parseRow(tLines[0]);
      const body = tLines.slice(2).map(parseRow);
      nodes.push(
        <div key={k++} className="my-2 overflow-x-auto rounded-md border border-border/30">
          <table className="w-full text-[11px] font-body">
            <thead>
              <tr className="bg-secondary/30">
                {header.map((h, ci) => (
                  <th key={ci} className="px-2.5 py-1.5 text-left font-semibold text-foreground/85 border-b border-border/30 whitespace-nowrap">
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri} className={ri % 2 === 0 ? "" : "bg-secondary/15"}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-2.5 py-1.5 text-foreground/90 border-b border-border/20">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      nodes.push(
        <ul key={k++} className="my-1.5 space-y-1 ml-1">
          {items.map((item, ii) => (
            <li key={ii} className="flex items-start gap-2 text-foreground/90">
              <span className="text-accent mt-0.5 shrink-0">&bull;</span>
              <span className="leading-relaxed">{renderInline(item)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      nodes.push(
        <ol key={k++} className="my-1.5 space-y-1 ml-1">
          {items.map((item, ii) => (
            <li key={ii} className="flex items-start gap-2 text-foreground/90">
              <span className="text-[10px] font-mono text-primary/70 shrink-0 mt-px">{ii + 1}.</span>
              <span className="leading-relaxed">{renderInline(item)}</span>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // Paragraph (default)
    nodes.push(<p key={k++} className="text-foreground/90 leading-relaxed my-1">{renderInline(line)}</p>);
    i++;
  }

  return <>{nodes}</>;
}

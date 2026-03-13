import type { ReactNode } from "react";
import { renderInline } from "./renderInline";

/** Collapse newlines inside inline backtick code spans so the line-based parser doesn't break them */
function normalizeInlineCode(text: string): string {
  return text.replace(/(?<!`)`(?!`)([^`]*\n[^`]*?)`(?!`)/g, (_, content) =>
    "`" + content.replace(/\n/g, " ") + "`"
  );
}

/** Ensure block-level elements (headings, table rows) start on their own line */
function normalizeBlocks(text: string): string {
  // Ensure markdown headings start on their own line
  let result = text.replace(/([^\n])(#{1,4}\s+)/g, "$1\n$2");
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

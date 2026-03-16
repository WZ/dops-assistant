import React from "react";
import { Text, Box } from "ink";

type Segment =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "code"; value: string };

export function parseInline(line: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;

  while (i < line.length) {
    const boldIndex = line.indexOf("**", i);
    const codeIndex = line.indexOf("`", i);

    let nextIndex = -1;
    let marker: "**" | "`" | null = null;

    if (boldIndex !== -1 && (codeIndex === -1 || boldIndex < codeIndex)) {
      nextIndex = boldIndex;
      marker = "**";
    } else if (codeIndex !== -1) {
      nextIndex = codeIndex;
      marker = "`";
    } else {
      break;
    }

    if (nextIndex > i) {
      segments.push({ type: "text", value: line.slice(i, nextIndex) });
    }

    if (marker === "**") {
      const end = line.indexOf("**", nextIndex + 2);
      if (end !== -1 && end > nextIndex + 2) {
        segments.push({ type: "bold", value: line.slice(nextIndex + 2, end) });
        i = end + 2;
      } else {
        segments.push({ type: "text", value: line.slice(nextIndex, nextIndex + 2) });
        i = nextIndex + 2;
      }
    } else if (marker === "`") {
      const end = line.indexOf("`", nextIndex + 1);
      if (end !== -1 && end > nextIndex + 1) {
        segments.push({ type: "code", value: line.slice(nextIndex + 1, end) });
        i = end + 1;
      } else {
        segments.push({ type: "text", value: line.slice(nextIndex, nextIndex + 1) });
        i = nextIndex + 1;
      }
    }
  }

  if (i < line.length) {
    segments.push({ type: "text", value: line.slice(i) });
  }

  return segments;
}

function InlineText({ text }: { text: string }) {
  const segments = parseInline(text);
  return (
    <Text>
      {segments.map((seg, i) => {
        if (seg.type === "bold") return <Text key={i} bold>{seg.value}</Text>;
        if (seg.type === "code") return <Text key={i} color="cyan">{seg.value}</Text>;
        return <Text key={i}>{seg.value}</Text>;
      })}
    </Text>
  );
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line.trim());
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const stripped = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return stripped.split("|").map((cell) => cell.trim());
}

/** Strip markdown formatting markers for plain text display */
function stripInlineFormatting(text: string): string {
  return text.replace(/\*\*([^*]*)\*\*/g, "$1").replace(/`([^`]*)`/g, "$1");
}

function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return maxWidth <= 1 ? "…" : text.slice(0, maxWidth - 1) + "…";
}

function MarkdownTable({ rows }: { rows: string[][] }) {
  if (rows.length < 2) return null;

  const headers = rows[0]!;
  const dataRows = rows.slice(1);

  // Calculate natural column widths
  const colWidths = headers.map((h, c) => {
    const headerLen = stripInlineFormatting(h).length;
    const maxDataLen = dataRows.reduce(
      (max, row) => Math.max(max, stripInlineFormatting(row[c] ?? "").length),
      0,
    );
    return Math.max(headerLen, maxDataLen);
  });

  // Cap columns to fit terminal width
  const termWidth = process.stdout.columns || 80;
  const gapWidth = (colWidths.length - 1) * 2; // "  " between columns
  const availableWidth = termWidth - gapWidth;
  const totalNatural = colWidths.reduce((sum, w) => sum + w, 0);

  if (totalNatural > availableWidth && availableWidth > 0) {
    const scale = availableWidth / totalNatural;
    const minCol = 4; // minimum column width
    for (let c = 0; c < colWidths.length; c++) {
      colWidths[c] = Math.max(minCol, Math.floor(colWidths[c]! * scale));
    }
  }

  const pad = (text: string, width: number) => {
    const truncated = truncate(text, width);
    return truncated + " ".repeat(Math.max(0, width - truncated.length));
  };

  const separator = colWidths.map((w) => "─".repeat(w)).join("──");

  return (
    <Box flexDirection="column">
      <Text>
        {headers
          .map((h, c) => pad(stripInlineFormatting(h), colWidths[c]!))
          .join("  ")}
      </Text>
      <Text dimColor>{separator}</Text>
      {dataRows.map((row, r) => (
        <Text key={r}>
          {row
            .map((cell, c) =>
              pad(stripInlineFormatting(cell ?? ""), colWidths[c] ?? 0),
            )
            .join("  ")}
        </Text>
      ))}
    </Box>
  );
}

type Block =
  | { type: "line"; index: number; line: string; trimmed: string }
  | { type: "table"; index: number; rows: string[][] };

function groupLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i]!.trimStart();
    if (trimmed.startsWith("|")) {
      const tableRows: string[][] = [];
      const startIdx = i;
      while (i < lines.length && lines[i]!.trimStart().startsWith("|")) {
        const rowTrimmed = lines[i]!.trimStart();
        if (!isTableSeparator(rowTrimmed)) {
          tableRows.push(parseTableRow(rowTrimmed));
        }
        i++;
      }
      blocks.push({ type: "table", index: startIdx, rows: tableRows });
    } else {
      blocks.push({ type: "line", index: i, line: lines[i]!, trimmed });
      i++;
    }
  }

  return blocks;
}

export function Markdown({ text, indent = "  " }: { text: string; indent?: string }) {
  const lines = text.split("\n");
  const blocks = groupLines(lines);

  return (
    <Box flexDirection="column">
      {blocks.map((block) => {
        if (block.type === "table") {
          return (
            <Box key={`table-${block.index}`} marginLeft={indent.length}>
              <MarkdownTable rows={block.rows} />
            </Box>
          );
        }

        const { trimmed } = block;
        const key = `line-${block.index}-${trimmed.slice(0, 20)}`;

        // Headers: # ## ###
        if (trimmed.startsWith("### ")) {
          return (
            <Text key={key} bold color="yellow">
              {indent}{trimmed.slice(4)}
            </Text>
          );
        }
        if (trimmed.startsWith("## ")) {
          return (
            <Text key={key} bold color="yellow">
              {indent}{trimmed.slice(3)}
            </Text>
          );
        }
        if (trimmed.startsWith("# ")) {
          return (
            <Text key={key} bold color="yellow">
              {indent}{trimmed.slice(2)}
            </Text>
          );
        }

        // Numbered list: 1. item
        const numberedMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
        if (numberedMatch) {
          return (
            <Box key={key}>
              <Text>{indent}</Text>
              <Text bold color="green">{numberedMatch[1]}. </Text>
              <InlineText text={numberedMatch[2]} />
            </Box>
          );
        }

        // Bullet list: - item
        if (trimmed.startsWith("- ")) {
          const depth = block.line.length - trimmed.length;
          const extra = "  ".repeat(Math.floor(depth / 2));
          return (
            <Box key={key}>
              <Text>{indent}{extra}</Text>
              <Text color="green">• </Text>
              <InlineText text={trimmed.slice(2)} />
            </Box>
          );
        }

        // Empty line
        if (trimmed === "") {
          return <Text key={key}>{" "}</Text>;
        }

        // Regular text with inline formatting
        return (
          <Box key={key}>
            <Text>{indent}</Text>
            <InlineText text={trimmed} />
          </Box>
        );
      })}
    </Box>
  );
}

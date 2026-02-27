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
  // Strip leading/trailing pipes and split by |
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const stripped = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return stripped.split("|").map((cell) => cell.trim());
}

/** Measure visible length ignoring markdown formatting markers */
function visibleLength(text: string): number {
  // Strip **bold** markers and `code` markers for length calculation
  return text.replace(/\*\*([^*]*)\*\*/g, "$1").replace(/`([^`]*)`/g, "$1").length;
}

function Table({ rows, indent }: { rows: string[][]; indent: string }) {
  // Compute max visible width per column
  const colCount = Math.max(...rows.map((r) => r.length));
  const colWidths: number[] = Array.from({ length: colCount }, () => 0);
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      colWidths[c] = Math.max(colWidths[c] ?? 0, visibleLength(row[c] ?? ""));
    }
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, ri) => (
        <Box key={`trow-${ri}`}>
          <Text>{indent}</Text>
          {row.map((cell, ci) => {
            const pad = (colWidths[ci] ?? 0) - visibleLength(cell) + 1;
            return (
              <Text key={`tcell-${ri}-${ci}`}>
                {"| "}
                <InlineText text={cell} />
                {" ".repeat(Math.max(pad, 1))}
              </Text>
            );
          })}
          <Text>|</Text>
        </Box>
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
      // Collect consecutive table lines
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
          return <Table key={`table-${block.index}`} rows={block.rows} indent={indent} />;
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

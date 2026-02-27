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

export function Markdown({ text, indent = "  " }: { text: string; indent?: string }) {
  const lines = text.split("\n");

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const trimmed = line.trimStart();
        const key = `line-${i}-${trimmed.slice(0, 20)}`;

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
          const depth = line.length - trimmed.length;
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

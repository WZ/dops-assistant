// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { renderMarkdown } from "./renderMarkdown";

function renderToHtml(md: string): string {
  const { container } = render(<>{renderMarkdown(md)}</>);
  return container.innerHTML;
}

describe("renderMarkdown", () => {
  it("renders ## as a single H2 heading without a stray '#' paragraph", () => {
    const html = renderToHtml("## Errors found in `my-job`");
    // The hash markers are stripped; only the styled heading text remains.
    expect(html).not.toMatch(/<p[^>]*>#<\/p>/);
    expect(html).toMatch(/Errors found in/);
  });

  it("does not merge a heading line with the following bullet across an inline code span", () => {
    const md = [
      "## Errors found in `my-job`",
      "",
      "### 1. Replica already exists",
      "- **Message**: `Replica /clickhouse/foo already exists`",
      "- **Timestamp**: 2026-04-30 23:33:31 PDT",
    ].join("\n");
    const html = renderToHtml(md);
    // Heading text and bullet content must not collapse onto one element.
    // The previous bug glued the H3 line to the first bullet by collapsing
    // the newline between two unrelated single-backtick spans.
    expect(html).toMatch(/Replica already exists/);
    expect(html).toMatch(/<ul/);
    // No element should contain both the heading text AND the bullet text.
    const hasMergedNode = /Replica already exists[^<]*Message/.test(html);
    expect(hasMergedNode).toBe(false);
  });

  it("preserves single-line inline backtick spans", () => {
    const html = renderToHtml("Use `kubectl get pods` to list pods");
    expect(html).toMatch(/<code[^>]*>kubectl get pods<\/code>/);
  });

  it("collapses newlines inside a single multi-line inline backtick span", () => {
    // Synthetic: an LLM rarely emits this, but the function exists for it.
    const html = renderToHtml("Error: `line one\nline two` happened");
    expect(html).toMatch(/<code[^>]*>line one line two<\/code>/);
  });

  it("does not split adjacent '##' into '#\\n#'", () => {
    // Pure regex verification: rendering a heading followed by another heading
    // separated by a blank line should produce two H2 elements and no stray
    // hash paragraph between them.
    const md = "## First\n\n## Second";
    const html = renderToHtml(md);
    expect(html).not.toMatch(/<p[^>]*>#<\/p>/);
    expect(html).toMatch(/First/);
    expect(html).toMatch(/Second/);
  });

  it("renders a well-formed markdown table", () => {
    const md = [
      "| Time | Pod | Message |",
      "| --- | --- | --- |",
      "| 12:15 | pod-a | error one |",
      "| 12:16 | pod-b | error two |",
    ].join("\n");
    const html = renderToHtml(md);
    expect(html).toMatch(/<table/);
    expect(html).toMatch(/<thead/);
    expect(html).toMatch(/Pod/);
    expect(html).toMatch(/error one/);
    expect(html).toMatch(/error two/);
  });

  it("renders a malformed table (no separator row) as a real table, not stray paragraphs", () => {
    // Regression: LLMs sometimes emit a "table" without the separator row
    // and without trailing pipes. Previously this fell through to the
    // paragraph path and produced lines like `| Time | Pod | Message` with
    // visible pipe characters. The reader couldn't tell what was a column
    // and what was data.
    const md = [
      "| Time (UTC) | Pod / Instance | Message",
      "| 12:15 | pod-a | err one",
      "| 12:16 | pod-b | err two",
    ].join("\n");
    const html = renderToHtml(md);
    expect(html).toMatch(/<table/);
    expect(html).toMatch(/<thead/);
    // No stray pipe characters left as plain text in paragraphs.
    expect(html).not.toMatch(/<p[^>]*>\|/);
    expect(html).toMatch(/err one/);
    expect(html).toMatch(/err two/);
  });

  it("a single lone '|' line falls back to plain paragraph (not a 1-row table)", () => {
    const md = "| just a stray pipe with text";
    const html = renderToHtml(md);
    // Single line that looks tabular but has no peer row → plain paragraph,
    // not a one-row table that would look weird.
    expect(html).not.toMatch(/<table/);
  });
});

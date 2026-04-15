import { toPng } from "html-to-image";
import type { RcaReport } from "../../types/rca-types.js";
import { formatRcaMarkdown } from "./formatRcaMarkdown.js";

function triggerDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function safeName(service: string) {
  return service.replace(/[^a-z0-9-_]/gi, "-").toLowerCase() || "investigation";
}

export function downloadMarkdown(report: RcaReport, service: string) {
  const md = formatRcaMarkdown(report);
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `rca-${safeName(service)}-${Date.now()}.md`);
  URL.revokeObjectURL(url);
}

export function copyMarkdown(report: RcaReport) {
  return navigator.clipboard.writeText(formatRcaMarkdown(report));
}

// Wait for FontFaceSet + preload our custom Google Fonts so toPng captures them
// instead of falling back to system sans in the rasterized image.
async function ensureFontsLoaded() {
  if (!document.fonts) return;
  const faces = [
    '600 22px "Inter"',
    '400 14px "Plus Jakarta Sans"',
    '500 11px "JetBrains Mono"',
  ];
  await Promise.all(faces.map((f) => document.fonts.load(f).catch(() => undefined)));
  await document.fonts.ready;
}

export async function downloadPng(node: HTMLElement, service: string) {
  await ensureFontsLoaded();
  const dataUrl = await toPng(node, {
    backgroundColor: "#181B22",
    pixelRatio: 2,
    cacheBust: true,
  });
  triggerDownload(dataUrl, `rca-${safeName(service)}-${Date.now()}.png`);
}

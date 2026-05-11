#!/usr/bin/env python3
"""
analyze-ab.py — compare two discovery-app-eval JSONL files and print the
head-to-head table.

Usage:
    analyze-ab.py <control.jsonl> <treatment.jsonl>

Output:
    - Per-iter service-count summaries (count, duration, tool calls, retries)
    - Avg / median / min / max / stdev for each side
    - Per-iter delta table (TREATMENT - CONTROL)
    - Set analysis: consistent set (every iter), union (any iter), regressions,
      new finds, partial regressions
    - Frequency table of services that appear in different rates between sides

Assumes the JSONL format produced by scripts/discovery-app-eval.ts:
    { "round", "iteration", "success", "discoveredNames": [...],
      "durationMs", "toolCallCount", "retryCount", "error", ... }
"""
import json
import statistics
import sys
from collections import Counter
from pathlib import Path


def load(path):
    runs = []
    with open(path) as f:
        for line in f:
            runs.append(json.loads(line))
    return runs


def summarize(runs, label):
    counts = [len(r.get("discoveredNames", [])) for r in runs]
    durs = [r["durationMs"] / 1000 for r in runs]
    tools = [r["toolCallCount"] for r in runs]
    retries = [r["retryCount"] for r in runs]
    print(f"\n{label}:")
    print(f"  per-iter counts: {counts}")
    print(f"  avg services:    {statistics.mean(counts):.1f}")
    print(f"  median services: {statistics.median(counts):.0f}")
    print(f"  min/max:         {min(counts)} / {max(counts)}")
    if len(counts) > 1:
        print(f"  stdev:           {statistics.stdev(counts):.2f}")
    print(f"  avg duration:    {statistics.mean(durs):.1f}s")
    print(f"  avg tool calls:  {statistics.mean(tools):.1f}")
    print(f"  avg retries:     {statistics.mean(retries):.2f}")
    return counts


def per_iter_diff(control_counts, treatment_counts):
    print("\n=== PER-ITER COMPARISON ===")
    print("  iter | CTRL  | TREAT | Δ")
    print("  -----+-------+-------+-----")
    for i, (c, t) in enumerate(zip(control_counts, treatment_counts), 1):
        delta = t - c
        marker = "" if delta == 0 else (f"  ← treatment wins" if delta > 0 else f"  ← control wins")
        print(f"  {i:4d} | {c:5d} | {t:5d} | {delta:+d}{marker}")


def set_analysis(control_runs, treatment_runs):
    c_union, c_intersect = set(), None
    for r in control_runs:
        names = set(r.get("discoveredNames", []))
        c_union |= names
        c_intersect = names if c_intersect is None else (c_intersect & names)
    t_union, t_intersect = set(), None
    for r in treatment_runs:
        names = set(r.get("discoveredNames", []))
        t_union |= names
        t_intersect = names if t_intersect is None else (t_intersect & names)

    print("\n=== SET ANALYSIS (across all iters) ===")
    print(f"  CONTROL:   {len(c_intersect)} consistent | {len(c_union)} union")
    print(f"  TREATMENT: {len(t_intersect)} consistent | {len(t_union)} union")

    new_consistent = t_intersect - c_union
    print(f"\n  TREATMENT finds CONSISTENTLY that CONTROL never found ({len(new_consistent)}):")
    if new_consistent:
        for n in sorted(new_consistent):
            print(f"    + {n}")
    else:
        print("    (none)")

    new_sometimes = (t_union - t_intersect) - c_union
    print(f"\n  TREATMENT finds SOMETIMES that CONTROL never found ({len(new_sometimes)}):")
    if new_sometimes:
        for n in sorted(new_sometimes):
            print(f"    +? {n}")
    else:
        print("    (none)")

    regressed = c_intersect - t_union
    print(f"\n  REGRESSED (in EVERY control iter, in NO treatment iter) ({len(regressed)}):")
    if regressed:
        for n in sorted(regressed):
            print(f"    - {n}")
    else:
        print("    (none)")

    partial_regress = (c_union - c_intersect) - t_union
    print(f"\n  PARTIAL regress (in SOME control iters, in NO treatment iters) ({len(partial_regress)}):")
    if partial_regress:
        for n in sorted(partial_regress):
            print(f"    -? {n}")
    else:
        print("    (none)")


def frequency_table(control_runs, treatment_runs):
    """Show services whose detection frequency differs between sides."""
    c_freq = Counter()
    for r in control_runs:
        for n in r.get("discoveredNames", []):
            c_freq[n] += 1
    t_freq = Counter()
    for r in treatment_runs:
        for n in r.get("discoveredNames", []):
            t_freq[n] += 1

    n_c = len(control_runs)
    n_t = len(treatment_runs)
    diffs = []
    for s in sorted(set(c_freq) | set(t_freq)):
        if c_freq.get(s, 0) != t_freq.get(s, 0):
            diffs.append((s, c_freq.get(s, 0), t_freq.get(s, 0)))

    if not diffs:
        print(f"\n=== FREQUENCY TABLE ===")
        print(f"  (no per-service frequency differences — both sides found the same set in the same iters)")
        return

    print(f"\n=== SERVICE-LEVEL FREQUENCY DIFFS ({len(diffs)} services) ===")
    print(f"  {'service':<55} {'CTRL':>5} {'TREAT':>6}  Δ")
    print("  " + "─" * 76)
    for s, c, t in sorted(diffs, key=lambda x: -(x[2] - x[1])):
        delta = t - c
        arrow = " ← treatment more often" if delta > 0 else " ← control more often"
        print(f"  {s:<55} {c:>2}/{n_c}  {t:>2}/{n_t}  {delta:+d}{arrow}")


def verdict(control_counts, treatment_counts, control_runs, treatment_runs):
    """High-signal one-paragraph summary at the bottom."""
    c_avg = statistics.mean(control_counts)
    t_avg = statistics.mean(treatment_counts)
    c_stdev = statistics.stdev(control_counts) if len(control_counts) > 1 else 0
    t_stdev = statistics.stdev(treatment_counts) if len(treatment_counts) > 1 else 0

    c_union = set()
    c_intersect = None
    for r in control_runs:
        names = set(r.get("discoveredNames", []))
        c_union |= names
        c_intersect = names if c_intersect is None else (c_intersect & names)
    t_union = set()
    t_intersect = None
    for r in treatment_runs:
        names = set(r.get("discoveredNames", []))
        t_union |= names
        t_intersect = names if t_intersect is None else (t_intersect & names)
    regressed = c_intersect - t_union if c_intersect else set()

    print("\n=== VERDICT ===")
    print(f"  Avg services:     CTRL {c_avg:.1f}  →  TREAT {t_avg:.1f}  (Δ {t_avg - c_avg:+.1f})")
    print(f"  Stdev (variance): CTRL {c_stdev:.2f}  →  TREAT {t_stdev:.2f}")
    print(f"  Hard regressions: {len(regressed)} services (always-CTRL, never-TREAT)")
    if t_avg > c_avg and len(regressed) == 0:
        print(f"  → TREATMENT is strictly better on quality (no regressions, higher avg)")
    elif t_avg < c_avg and len(regressed) > 0:
        print(f"  → CONTROL wins (treatment has regressions and lower avg)")
    elif abs(t_avg - c_avg) < 1 and len(regressed) == 0:
        print(f"  → Roughly tied on quality. Compare duration / determinism for the tiebreaker.")
    else:
        print(f"  → Mixed signal. See per-iter and set analysis above.")


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    control_path = Path(sys.argv[1])
    treatment_path = Path(sys.argv[2])
    if not control_path.exists():
        sys.exit(f"ERROR: control jsonl not found: {control_path}")
    if not treatment_path.exists():
        sys.exit(f"ERROR: treatment jsonl not found: {treatment_path}")

    control_runs = load(control_path)
    treatment_runs = load(treatment_path)
    if not control_runs or not treatment_runs:
        sys.exit("ERROR: one or both JSONL files are empty")
    if len(control_runs) != len(treatment_runs):
        print(
            f"WARNING: iteration counts differ ({len(control_runs)} vs {len(treatment_runs)})."
            " Comparing best-effort up to the shorter side."
        )

    c_counts = summarize(control_runs, "CONTROL")
    t_counts = summarize(treatment_runs, "TREATMENT")
    per_iter_diff(c_counts, t_counts)
    set_analysis(control_runs, treatment_runs)
    frequency_table(control_runs, treatment_runs)
    verdict(c_counts, t_counts, control_runs, treatment_runs)


if __name__ == "__main__":
    main()

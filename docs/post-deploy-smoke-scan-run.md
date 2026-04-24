# Post-deploy smoke: Scan Run on Operations Desk

> Feature: `feat/scan-run-ops-desk` (shipped 2026-04-22)
>
> `docs/TODOS.md` is gitignored (see `.gitignore` line 28), so this post-deploy
> smoke checklist lives here as a committed doc instead.

After shipping `feat/scan-run-ops-desk`:

1. Enable scan in Settings → Scan tab.
2. Click **Scan now** on the Ops Desk. Expect navigation to `/scan/runs/:id`.
3. Verify phase stepper animates Probe → Triage → Investigate.
4. Back to Desk; run appears in Recent Scans.
5. If Slack webhook is configured + mode≠off: verify message posts with link back to run.
6. If email recipients with `scan-run` source exist: verify summary email received.
7. Wait for a cron tick (or reduce interval temporarily); verify clean ticks collapse in Recent Scans.
8. Open Recent Scans in two browser tabs on the same stack. Trigger scan in A; verify B sees the new row within 10s (polling).
9. Create a second stack; trigger a scan there; verify it's NOT visible when viewing the primary stack.
10. Use the Export menu on a scan run detail: Copy link, Copy as Markdown, Download PNG, Send to Slack (if configured). Confirm each.
11. On the NotificationsTab: verify the "Scan run summary" radio saves and loads correctly.
12. Scan runs should appear in the Event Stream rail (kind=`scan_run_complete`, severity=`info` for clean / `warn` for hits).

# Email Notifications Setup

Email notifications deliver a formatted representation of each completed
investigation to recipients filtered by severity and trigger source. Primary
delivery target: Microsoft Teams channel email addresses.

The feature runs alongside the existing Slack notifier; either or both can be
enabled.

## 1. Add SMTP credentials

Append to `dev/.env` (gitignored; put real values here):

```bash
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
```

## 2. Add the `notifications.email` config section

Append to `dev/config.yaml`:

```yaml
notifications:
  email:
    enabled: false                      # global kill switch
    smtp:
      host: smtp.internal.example
      port: 587
      secure: false                     # STARTTLS when false + port 587
      user: ${SMTP_USER}
      pass: ${SMTP_PASS}
    from: "DOps Assistant <dops@example.com>"
    appBaseUrl: https://dops.internal/  # base URL for "Open investigation" links
    retry:
      attempts: 4                       # total delivery attempts (initial + 3 retries)
      backoffMs: [1000, 5000, 30000]    # sleep between attempts (length must be attempts - 1)
```

Startup config validation enforces `backoffMs.length === attempts - 1` and a
valid `appBaseUrl`. Missing SMTP credentials will fail at send time, not at
startup.

## 3. Restart the server

```bash
CONFIG_PATH=dev/config.yaml npm run web
```

## 4. Configure recipients in the GUI

Open the **Notifications** tab and find the **Email** section beneath Slack.

- Enable the global toggle.
- Click **+ Add recipient** to create a row. Each recipient has:
  - Email address (Teams channel address, personal inbox, or distribution list)
  - Optional label (e.g. `#sre-alerts`)
  - Minimum severity (low / medium / high / critical)
  - Allowed trigger sources (Alertmanager webhook, Proactive scan, Health
    poller, Manual investigation)
  - Enabled toggle
- Click **Test** on a row to send a fixture investigation report immediately —
  useful for validating SMTP credentials and sender-acceptance rules.

Recipient changes take effect without a server restart.

## Teams channel delivery notes

Microsoft Teams' email-to-channel feature (see
<https://support.microsoft.com/en-us/office/send-an-email-to-a-channel-in-microsoft-teams-d91db004-d9d7-4a47-82e6-fb1b16dfd51e>)
accepts HTML with inline styles. This project's email template is intentionally
Teams-safe: inline `style=` attributes only, no `<style>` blocks, no external
CSS, no images.

Teams tenants may require the sender address to be within the organization, or
"accept channel email from anyone" to be enabled. If Teams silently drops the
email, check with your tenant admin — the SMTP relay will return success, so
the failure is invisible from the server side.

## Troubleshooting

- **No emails being sent**: check server logs for `email sent` (info) or
  `email failed` (error) lines. If there are no log lines at all, the global
  toggle may be off or no recipient matches the investigation's severity +
  source.
- **SMTP auth errors (535)**: the retry loop won't retry auth failures —
  credentials are wrong. Re-check `SMTP_USER` / `SMTP_PASS`.
- **Transient network errors**: `ETIMEDOUT`, `ECONNRESET`, etc. retry up to 4
  attempts with 1s / 5s / 30s backoff. Check network connectivity to the
  relay.
- **Emails arrive in inbox but not in Teams channel**: likely a tenant
  acceptance rule. Contact your Teams admin.

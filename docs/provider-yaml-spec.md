# Provider YAML Spec

Import and export MCP provider configurations via the Providers page YAML modal.

## Schema

Each provider is a YAML object with the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique identifier. Alphanumeric, hyphens, underscores only (`/^[a-zA-Z0-9_-]+$/`). |
| `roles` | string[] | yes | At least one of: `metrics`, `logs`, `dashboards`, `dependencies`, `infrastructure`, `changes`. |
| `mcpServer` | object | yes | MCP server connection. See transport types below. |
| `region` | string | no | Geographic region label (e.g., `us-west-1`). |
| `webUrl` | string (URL) | no | Link to the provider's web UI (e.g., Grafana dashboard URL). |

### Transport: HTTP

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transport` | `"http"` | yes | Transport type. |
| `url` | string (URL) | yes | MCP server endpoint. |
| `enabledTools` | string[] | no | Whitelist of tool names. Omit to enable all read-only tools by default. |

### Transport: stdio

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transport` | `"stdio"` | yes | Transport type. |
| `command` | string | yes | Command to launch the MCP server process. |
| `args` | string[] | no | Command-line arguments. Defaults to `[]`. |
| `env` | object | no | Environment variables passed to the process. Defaults to `{}`. |
| `enabledTools` | string[] | no | Whitelist of tool names. Omit to enable all read-only tools by default. |

## Example

```yaml
# Grafana — metrics, logs, and dashboards via HTTP
- name: grafana
  roles: [metrics, logs, dashboards]
  region: us-west-1
  webUrl: https://grafana.example.com
  mcpServer:
    transport: http
    url: http://grafana-mcp:8000/mcp
    enabledTools:
      - query_prometheus
      - list_prometheus_metric_metadata
      - query_loki_logs
      - list_loki_label_names
      - list_loki_label_values
      - list_datasources
      - search_dashboards
      - get_dashboard_by_uid
      - list_alert_rules

# Kubernetes — infrastructure via HTTP
- name: kubernetes
  roles: [infrastructure]
  mcpServer:
    transport: http
    url: http://k8s-mcp:8001/mcp

# GitLab — change tracking via stdio
- name: gitlab
  roles: [changes]
  webUrl: https://gitlab.example.com
  mcpServer:
    transport: stdio
    command: npx
    args: ["-y", "@anthropic/gitlab-mcp-server"]
    env:
      GITLAB_TOKEN: glpat-xxxxxxxxxxxxxxxxxxxx
      GITLAB_URL: https://gitlab.example.com

# Coroot — dependencies and infrastructure via HTTP
- name: coroot
  roles: [dependencies, infrastructure]
  webUrl: https://coroot.example.com
  mcpServer:
    transport: http
    url: http://coroot-mcp:8002/mcp

# Second Grafana — separate region
- name: grafana-eu
  roles: [metrics, logs]
  region: eu-west-1
  webUrl: https://grafana-eu.example.com
  mcpServer:
    transport: http
    url: http://grafana-eu-mcp:8000/mcp
```

## Import behavior

Paste one or more provider objects as a YAML array into the Import tab. The system validates each provider and checks for conflicts before applying changes.

**Validation:** Each provider is validated against the schema above. Invalid entries are flagged with specific error messages.

**Conflict resolution:** If a provider name already exists:
- **GUI providers** (added via the web UI) can be skipped or overwritten.
- **Config providers** (defined in `config.yaml`) cannot be overwritten. They are always skipped.

**Single provider:** You can paste a single object without the array prefix:

```yaml
name: my-grafana
roles: [metrics]
mcpServer:
  transport: http
  url: http://localhost:8000/mcp
```

**Limits:** Maximum 50 providers per import.

## Export behavior

The Export tab shows all configured providers (both config-sourced and GUI-sourced) as a YAML array. Copy the output to share with another instance or save as a backup.

## `enabledTools` field

Controls which MCP tools are available for the provider during investigations.

| Value | Behavior |
|-------|----------|
| Omitted | All read-only tools enabled by default. Write tools require explicit opt-in. |
| Empty array `[]` | No tools enabled. |
| List of names | Only the listed tools are enabled. |

Tool names come from the MCP server's tool discovery. You can see available tools by expanding a provider card on the Providers page.

# dops-assistant Helm chart

Deploys [dops-assistant](../../..) to Kubernetes.

## TL;DR

```sh
helm install dops deploy/helm/dops-assistant \
  --set image.repository=ghcr.io/your-org/dops-assistant \
  --set image.tag=0.1.0 \
  --set secrets.data.OPENAI_API_KEY=sk-your-key
```

## Prerequisites

- Kubernetes 1.25+
- A container image of dops-assistant pushed to a registry your cluster can pull from
  (build with the project's `Dockerfile`)
- An OpenAI-compatible LLM endpoint and API key
- Optional: one or more MCP servers (e.g. grafana-mcp, kubernetes-mcp) reachable from
  the cluster — the chart does **not** deploy them

## Architecture

A single Deployment (`replicas: 1`, `strategy: Recreate`) backed by a PVC at
`/app/data`. SQLite persistence forces single-replica; the chart does not support HA.

An `initContainer` copies the rendered `config.yaml` from a ConfigMap onto the PVC
at startup. This is required because the config loader expects `services.yaml` to
live next to `config.yaml`, and ConfigMap mounts are read-only
(see `src/config/loader.ts`).

The Service exposes two ports:

| Name    | Port | Purpose                       |
|---------|------|-------------------------------|
| http    | 3000 | Web UI, REST API, WebSocket   |
| metrics | 9090 | Prometheus metrics            |

## Configuration flow

```
values.yaml → ConfigMap → initContainer copy → /app/data/config.yaml
values.yaml → Secret     → envFrom           → ${VAR} substitution in config.yaml
```

Put secret values in `secrets.data` (they become env vars), then reference them
from `config` with `${OPENAI_API_KEY}` etc. This keeps secret material out of the
ConfigMap.

## Common values

| Key                                      | Default                              | Description                               |
|------------------------------------------|--------------------------------------|-------------------------------------------|
| `image.repository`                       | `dops-assistant`                     | Image name — set to your registry         |
| `image.tag`                              | `""` (→ `.Chart.AppVersion`)         | Image tag                                 |
| `service.type`                           | `ClusterIP`                          |                                           |
| `ingress.enabled`                        | `false`                              |                                           |
| `persistence.enabled`                    | `true`                               | Disable for ephemeral dev installs        |
| `persistence.size`                       | `2Gi`                                |                                           |
| `secrets.create`                         | `true`                               | Set `false` + `existingSecret` for GitOps |
| `secrets.data.OPENAI_API_KEY`            | `""`                                 | Required                                  |
| `config.llm.apiKey`                      | `${OPENAI_API_KEY}`                  | Env-var interpolated at startup           |
| `config.providers`                       | `[]`                                 | Array of MCP providers                    |
| `config.services`                        | `[]`                                 | Static service catalog                    |

Full schema reference: `src/config/schema.ts` in the project root.

## Example: Grafana MCP provider

```yaml
secrets:
  data:
    OPENAI_API_KEY: sk-...
    GRAFANA_URL: https://grafana.example.com
    GRAFANA_SERVICE_ACCOUNT_TOKEN: glsa_...

config:
  providers:
    - name: grafana
      roles: [metrics, logs, dashboards]
      mcpServer:
        transport: http
        url: http://grafana-mcp.observability.svc.cluster.local:8000/mcp
```

## Email notifications (SMTP from an existing Secret)

Investigation-complete emails are configured under `config.notifications.email`.
To keep SMTP credentials out of values.yaml, create a Kubernetes Secret with
`SMTP_USER` and `SMTP_PASS` keys and reference it via `extraEnvFrom`:

```sh
kubectl create secret generic dops-smtp-credentials \
  --from-literal=SMTP_USER='alerts@example.com' \
  --from-literal=SMTP_PASS='app-password'
```

```yaml
extraEnvFrom:
  - secretRef:
      name: dops-smtp-credentials

config:
  notifications:
    email:
      enabled: true
      smtp:
        host: smtp.gmail.com
        port: 587
        secure: false               # true only for port 465 (implicit TLS)
        user: ${SMTP_USER}
        pass: ${SMTP_PASS}
      from: "Ops Assistant <${SMTP_USER}>"   # Gmail requires From == user
      appBaseUrl: https://assistant.example.com
```

`${SMTP_USER}` / `${SMTP_PASS}` are resolved at pod startup by the config
loader, which reads them from env vars injected via `envFrom`.

## Using an existing Secret (GitOps-friendly)

```yaml
secrets:
  create: false
  existingSecret: dops-assistant-credentials
```

The Secret must contain `OPENAI_API_KEY` (and any other env vars referenced
from `config`).

## Ingress with TLS

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: dops.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: dops-tls
      hosts:
        - dops.example.com
```

## Uninstall

```sh
helm uninstall dops
```

The PVC is **not** deleted by `helm uninstall` — remove it manually if you want
to wipe investigation history:

```sh
kubectl delete pvc dops-dops-assistant-data
```

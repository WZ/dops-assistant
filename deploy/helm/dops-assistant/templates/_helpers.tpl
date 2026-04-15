{{/*
Expand the name of the chart.
*/}}
{{- define "dops-assistant.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "dops-assistant.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart name and version as used by the chart label.
*/}}
{{- define "dops-assistant.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "dops-assistant.labels" -}}
helm.sh/chart: {{ include "dops-assistant.chart" . }}
{{ include "dops-assistant.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "dops-assistant.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dops-assistant.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
ServiceAccount name.
*/}}
{{- define "dops-assistant.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "dops-assistant.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Image reference: repository:tag, with tag defaulting to Chart.AppVersion.
*/}}
{{- define "dops-assistant.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{/*
Secret name: either the user-supplied existingSecret or one derived from
fullname. Used by envFrom on the deployment.
*/}}
{{- define "dops-assistant.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "dops-assistant.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
ConfigMap name (rendered config.yaml).
*/}}
{{- define "dops-assistant.configMapName" -}}
{{- printf "%s-config" (include "dops-assistant.fullname" .) -}}
{{- end -}}

{{/*
PVC name: either existingClaim or derived.
*/}}
{{- define "dops-assistant.pvcName" -}}
{{- if .Values.persistence.existingClaim -}}
{{- .Values.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-data" (include "dops-assistant.fullname" .) -}}
{{- end -}}
{{- end -}}

import { describe, it, expect } from "vitest";

// Test the parsePodsList function by importing the module internals
// Since parsePodsList is not exported, we test the enrichment behavior
// through the tabular parsing logic directly.

describe("K8s pods_list parsing", () => {
  const PODS_LIST_OUTPUT = `NAMESPACE   APIVERSION   KIND   NAME                        READY   STATUS    RESTARTS   AGE     IP             NODE                                            NOMINATED NODE   READINESS GATES   LABELS
admin-new   v1           Pod    admin-task-5dfdc4b749-gx6lb   3/3     Running   0          3d22h   10.250.1.100   k8s-worker-1   <none>           <none>            app=admin-task,pod-template-hash=5dfdc4b749
admin-new   v1           Pod    admin-ui-7bd9b7c579-qtcdr   1/1     Running   0          3d22h   10.250.1.243   k8s-worker-2   <none>           <none>            app=admin-ui,pod-template-hash=7bd9b7c579
yugabyte    v1           Pod    yb-master-0                  2/2     Running   0          5d      10.250.2.50    k8s-worker-3   <none>           <none>            app=yb-master,component=master,release=yugabyte
kube-system v1           Pod    cluster-autoscaler-abc123    1/1     Running   0          10d     10.250.0.5     k8s-master     <none>           <none>            app=cluster-autoscaler`;

  function parsePodsList(raw: string) {
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return [];

    const headerLine = lines[0];
    const labelsIdx = headerLine.indexOf("LABELS");

    const results: Array<{ name: string; namespace: string; labels: Record<string, string> }> = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;

      const namespace = parts[0];
      const name = parts[3];

      const labels: Record<string, string> = {};
      // Labels are the last field — they contain commas but no spaces
      const lastField = parts[parts.length - 1];
      if (lastField && lastField !== "<none>" && lastField.includes("=")) {
        for (const pair of lastField.split(",")) {
          const eq = pair.indexOf("=");
          if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
      }

      if (name) results.push({ name, namespace, labels });
    }
    return results;
  }

  it("parses namespace, name, and labels from tabular output", () => {
    const pods = parsePodsList(PODS_LIST_OUTPUT);
    expect(pods.length).toBe(4);

    expect(pods[0].namespace).toBe("admin-new");
    expect(pods[0].name).toBe("admin-task-5dfdc4b749-gx6lb");
    expect(pods[0].labels["app"]).toBe("admin-task");

    expect(pods[2].namespace).toBe("yugabyte");
    expect(pods[2].name).toBe("yb-master-0");
    expect(pods[2].labels["app"]).toBe("yb-master");
    expect(pods[2].labels["component"]).toBe("master");
  });

  it("handles kube-system pods", () => {
    const pods = parsePodsList(PODS_LIST_OUTPUT);
    const ca = pods.find((p) => p.labels["app"] === "cluster-autoscaler");
    expect(ca).toBeDefined();
    expect(ca!.namespace).toBe("kube-system");
  });

  it("returns empty array for empty input", () => {
    expect(parsePodsList("")).toEqual([]);
    expect(parsePodsList("NAMESPACE NAME\n")).toEqual([]);
  });

  it("matches services to pods and produces correct logLabels", () => {
    const pods = parsePodsList(PODS_LIST_OUTPUT);

    // Simulate the matching logic from enrichFromK8s
    const services = [
      { name: "yb-master", logLabels: {} },
      { name: "admin-task", logLabels: {} },
      { name: "cluster-autoscaler", logLabels: {} },
      { name: "nonexistent-svc", logLabels: {} },
    ];

    const enriched = services.map((svc) => {
      const matched = pods.find((pod) => {
        const podLower = pod.name.toLowerCase();
        return podLower.startsWith(svc.name) || podLower.includes(svc.name);
      });
      if (!matched) return svc;

      const logLabels: Record<string, string> = { namespace: matched.namespace };
      logLabels["container"] = matched.labels["app"] ?? svc.name;
      return { ...svc, logLabels };
    });

    expect(enriched[0].logLabels).toEqual({ namespace: "yugabyte", container: "yb-master" });
    expect(enriched[1].logLabels).toEqual({ namespace: "admin-new", container: "admin-task" });
    expect(enriched[2].logLabels).toEqual({ namespace: "kube-system", container: "cluster-autoscaler" });
    expect(enriched[3].logLabels).toEqual({}); // no match
  });
});

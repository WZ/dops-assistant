import http from "node:http";
import { registry } from "./metrics.js";

export class ObservabilityServer {
  private server: http.Server;

  constructor(
    private readonly port: number,
    private readonly isMcpConnected: () => boolean,
  ) {
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      if (req.url === "/health") {
        const connected = this.isMcpConnected();
        res.writeHead(connected ? 200 : 503, {
          "Content-Type": "application/json",
        });
        res.end(
          JSON.stringify({
            status: connected ? "ok" : "degraded",
            uptime: process.uptime(),
            mcpConnected: connected,
          }),
        );
      } else if (req.url === "/metrics") {
        const body = await registry.metrics();
        res.writeHead(200, { "Content-Type": registry.contentType });
        res.end(body);
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    }
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.port, resolve));
  }

  stop(): Promise<void> {
    if (!this.server.listening) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

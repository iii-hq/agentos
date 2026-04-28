import { logError } from "./errors.js";

const DRAIN_TIMEOUT_MS = 10_000;

type CleanupCallback = () => void | Promise<void>;

class ShutdownManager {
  private inFlight = new Map<string, number>();
  private cleanupCallbacks: CleanupCallback[] = [];
  private shuttingDown = false;
  private initialized = false;

  register(operationId: string): void {
    if (this.shuttingDown) {
      throw new Error("Shutting down: rejecting new operation");
    }
    this.inFlight.set(operationId, Date.now());
  }

  complete(operationId: string): void {
    this.inFlight.delete(operationId);
  }

  onShutdown(callback: CleanupCallback): void {
    this.cleanupCallbacks.push(callback);
  }

  registerIIIShutdown(shutdownFn: () => Promise<void>): void {
    this.cleanupCallbacks.push(shutdownFn);
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  initShutdown(): void {
    if (this.initialized) return;
    this.initialized = true;

    const handler = async (signal: string) => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          message: `Shutdown initiated (${signal}), draining ${this.inFlight.size} in-flight operations`,
        }),
      );

      const deadline = Date.now() + DRAIN_TIMEOUT_MS;
      while (this.inFlight.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }

      if (this.inFlight.size > 0) {
        console.warn(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "warn",
            message: `Force shutdown: ${this.inFlight.size} operations still in-flight`,
            operations: [...this.inFlight.keys()],
          }),
        );
      }

      for (const cb of this.cleanupCallbacks) {
        try {
          await cb();
        } catch (e) {
          logError(e, { operation: "shutdown_cleanup" });
        }
      }

      process.exit(0);
    };

    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));
  }
}

export const shutdownManager = new ShutdownManager();

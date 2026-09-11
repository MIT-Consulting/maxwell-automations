import { createServer } from "node:net";

/**
 * Ask the OS for an unbound loopback port. Prefer this over
 * `base + Math.random()*N` — on Windows that pattern frequently lands in
 * Hyper-V / excluded ranges and fails with `listen EACCES`.
 *
 * Tiny TOCTOU remains between close and the caller's listen; retry at the
 * call site if needed. Far more reliable than a random high port.
 */
export function freeListenPort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("freeListenPort: no address")));
        return;
      }
      const { port } = addr;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

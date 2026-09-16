/**
 * Supervises the Next.js production server that the desktop window renders.
 *
 * The packaged app ships `.next/standalone`, whose `server.js` is a plain Node
 * script. Electron's own binary runs it under `ELECTRON_RUN_AS_NODE=1`, so no
 * separate Node runtime has to be installed or bundled.
 */
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const HOSTNAME = "127.0.0.1";
const FIRST_PORT = 3000;
const LAST_PORT = 3050;

/** Resolves true when `address` can be bound on `port`. */
function canBind(port, address) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    if (address) probe.listen(port, address);
    else probe.listen(port);
  });
}

/**
 * A port counts as free only when nothing holds it on either stack.
 *
 * Checking loopback alone is not enough. A server bound to the IPv6 wildcard
 * still leaves `127.0.0.1` bindable, so the port would look free while a
 * previous `next dev` was quietly answering on it — and the window would end
 * up rendering that server instead of this one.
 */
async function isPortFree(port) {
  return (await canBind(port)) && (await canBind(port, HOSTNAME));
}

function readJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("timeout", () => request.destroy(new Error("Request timed out")));
    request.on("error", reject);
  });
}

/**
 * Waits until the server identified by `instance` answers its health route.
 *
 * Matching the token rules out attaching to any other server that happens to
 * hold the port.
 */
async function waitForInstance(
  url,
  instance,
  { timeoutMs = 60000, intervalMs = 150, isAlive = () => true } = {},
) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (!isAlive()) throw new Error("The server exited before it was ready.");

    try {
      const body = await readJson(`${url}/api/health`, 5000);
      if (body?.instance === instance) return;
      throw new Error(`Port is held by another server.`);
    } catch (error) {
      if (error.message.includes("held by another server")) throw error;
      if (Date.now() > deadline) {
        throw new Error(`The server did not start within ${timeoutMs}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

function forkServer({ standaloneDir, port, instance, resourcesDir, onLog }) {
  const child = fork(path.join(standaloneDir, "server.js"), [], {
    cwd: standaloneDir,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      // Loopback only: the user's local configuration is never put on the
      // network, not even a trusted one.
      HOSTNAME,
      PLUGIN_MANAGER_RESOURCES: resourcesDir,
      PLUGIN_MANAGER_NODE_RUNTIME: process.execPath,
      PLUGIN_MANAGER_INSTANCE: instance,
      ELECTRON_RUN_AS_NODE: "1",
    },
  });

  const log = onLog || (() => {});
  child.stdout?.on("data", (chunk) => log(String(chunk)));
  child.stderr?.on("data", (chunk) => log(String(chunk)));

  return child;
}

/**
 * Starts the standalone server on the first usable port at or above 3000,
 * moving on if a port turns out to be taken after all.
 */
async function startNextServer({ resourcesDir, onLog, onExit }) {
  const standaloneDir = path.join(resourcesDir, "standalone");
  const failures = [];

  for (let port = FIRST_PORT; port <= LAST_PORT; port += 1) {
    if (!(await isPortFree(port))) continue;

    const instance = randomUUID();
    const url = `http://${HOSTNAME}:${port}`;
    const child = forkServer({
      standaloneDir,
      port,
      instance,
      resourcesDir,
      onLog,
    });

    let exited = false;
    child.once("exit", () => {
      exited = true;
    });

    try {
      await waitForInstance(url, instance, { isAlive: () => !exited });
    } catch (error) {
      if (!exited) child.kill();
      failures.push(`${port}: ${error.message}`);
      // A port can be claimed between the probe and the bind, so a failure
      // here is worth retrying further up the range before giving up.
      continue;
    }

    // The exit handler is attached only once the server is known to be
    // healthy, so a retry above is never reported to the caller as a crash.
    if (onExit) child.once("exit", onExit);
    return { child, port, url };
  }

  throw new Error(
    `No usable port between ${FIRST_PORT} and ${LAST_PORT}.\n${failures.join("\n")}`,
  );
}

/**
 * Ends the server process, escalating to SIGKILL if it ignores the polite
 * request, so quitting never strands a listener on the port.
 */
function stopNextServer(child, { graceMs = 3000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode) return;

  child.kill("SIGTERM");

  const timer = setTimeout(() => {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
  }, graceMs);

  // An unreferenced timer cannot keep the event loop alive during shutdown.
  timer.unref?.();
  child.once("exit", () => clearTimeout(timer));
}

module.exports = { isPortFree, startNextServer, stopNextServer };

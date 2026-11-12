import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function redeploy(mode: string, dockerHost?: string, options: { forward?: boolean; forwardFailure?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "azure-vision-k8s-test-"));
  const bin = join(directory, "bin");
  const log = join(directory, "calls.jsonl");
  const config = join(directory, "docker-config");
  mkdirSync(bin);
  mkdirSync(config);
  writeFileSync(join(config, "config.json"), "{}\n");
  const mock = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const host = process.env.DOCKER_HOST || "";
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ command, args, host, config: process.env.DOCKER_CONFIG }) + "\\n");
if (command === "kubectl" && args.includes("port-forward")) {
  if (process.env.MOCK_FORWARD_FAILURE === "1") {
    console.error("Unable to listen on port: address already in use");
    process.exit(1);
  }
  fs.writeFileSync(process.env.MOCK_FORWARD_PID, String(process.pid));
  console.log("Forwarding from 127.0.0.1:3001 -> 8080");
  setInterval(() => {}, 1000);
  return;
}
if (command === "docker") {
  if (args[0] === "context" && args[1] === "ls") {
    console.error("Docker context metadata: input/output error");
    process.exit(1);
  }
  if (args[0] === "context" && args[1] === "show") {
    console.log(process.env.MOCK_MODE === "healthy" ? "configured-context" : "default");
    process.exit(0);
  }
  if (args[0] === "--host") {
    if (["fallback", "build-failure"].includes(process.env.MOCK_MODE)) {
      console.log("Docker Desktop");
      process.exit(0);
    }
    console.error("Cannot connect to Docker");
    process.exit(1);
  }
  if (args[0] === "info") {
    if (process.env.MOCK_MODE === "healthy" || host === "unix:///var/run/docker.sock") process.exit(0);
    console.error("Docker context metadata: input/output error");
    process.exit(1);
  }
  if (args[0] === "inspect") process.exit(1);
  if (args[0] === "build") {
    if (["fallback", "build-failure"].includes(process.env.MOCK_MODE) &&
        (host !== "unix:///var/run/docker.sock" || process.env.DOCKER_CONFIG === process.env.MOCK_ORIGINAL_CONFIG)) {
      console.error("Docker context metadata: input/output error");
      process.exit(100);
    }
    if (host === "unix:///var/run/docker.sock") {
      fs.mkdirSync(path.join(process.env.DOCKER_CONFIG, "buildx"), { recursive: true });
      fs.writeFileSync(path.join(process.env.DOCKER_CONFIG, "buildx", "state"), "fixture");
    }
    if (process.env.MOCK_MODE === "build-failure") process.exit(23);
    process.exit(0);
  }
  throw new Error("Unexpected Docker command: " + args.join(" "));
}
if (command !== "kubectl") throw new Error("Unexpected command");
`;
  try {
    for (const command of ["docker", "kubectl"]) {
      writeFileSync(join(bin, command), mock, { mode: 0o700 });
    }
    const env = { ...process.env };
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;
    if (dockerHost) env.DOCKER_HOST = dockerHost;
    const result = spawnSync("bash", [
      fileURLToPath(new URL("../redeploy.sh", import.meta.url)),
      ...(options.forward ? [] : ["--no-forward"]), "--no-elastic",
    ], {
      encoding: "utf8",
      env: {
        ...env, PATH: `${bin}:${env.PATH}`, MOCK_LOG: log, MOCK_MODE: mode,
        DOCKER_CONFIG: config, MOCK_ORIGINAL_CONFIG: config,
        PORT_FORWARD_LOG: join(directory, "forward.log"),
        MOCK_FORWARD_PID: join(directory, "forward.pid"),
        MOCK_FORWARD_FAILURE: options.forwardFailure ? "1" : "0",
      },
      timeout: 10_000,
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      command: string;
      args: string[];
      host: string;
      config: string;
    });
    const pidFile = join(directory, "forward.pid");
    let forwardRunning = false;
    if (existsSync(pidFile)) {
      process.kill(Number(readFileSync(pidFile, "utf8")), 0);
      forwardRunning = true;
    }
    return { ...result, calls, forwardRunning };
  } finally {
    const pidFile = join(directory, "forward.pid");
    if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("local Kubernetes redeployment Docker preflight", () => {
  it("uses the configured Docker connection when healthy", () => {
    const result = redeploy("healthy");
    expect(result.status).toBe(0);
    expect(result.calls.some((call) => call.args[0] === "--host")).toBe(false);
    expect(result.calls.filter((call) => call.command === "docker" && call.args[0] === "build")).toHaveLength(2);
  });

  describe("detached redeploy forwarding", () => {
    it("returns after forwarding is ready and leaves the forward running", () => {
      const result = redeploy("healthy", undefined, { forward: true });
      expect(result.status).toBe(0);
      expect(result.forwardRunning).toBe(true);
      expect(result.stdout).toContain("Port-forward is detached (PID ");
      expect(result.stdout).toContain("Stop with: kill ");
      expect(result.calls.filter((call) => call.args.includes("port-forward"))).toHaveLength(1);
    });

    it("reports forwarding failure instead of announcing a working URL", () => {
      const result = redeploy("healthy", undefined, { forward: true, forwardFailure: true });
      expect(result.status).toBe(1);
      expect(result.forwardRunning).toBe(false);
      expect(result.stderr).toContain("Port-forward failed to start");
      expect(result.stderr).toContain("address already in use");
      expect(result.stdout).not.toContain("Port-forward is detached");
    });
  });

  it("recovers from unreadable context metadata using verified Docker Desktop", () => {
    const result = redeploy("fallback");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("verified local Docker Desktop socket");
    const builds = result.calls.filter((call) => call.command === "docker" && call.args[0] === "build");
    expect(builds).toHaveLength(2);
    expect(builds.every((call) => call.host === "unix:///var/run/docker.sock")).toBe(true);
    expect(builds.every((call) => !existsSync(call.config))).toBe(true);
    expect(result.stderr).toContain("temporary client configuration");
    expect(result.calls.some((call) => call.args.includes("port-forward"))).toBe(false);
  });

  it("fails before deleting workloads when Docker and the fallback are unavailable", () => {
    const result = redeploy("unavailable");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Docker is not reachable");
    expect(result.calls.some((call) => call.args.includes("delete") || call.args.includes("build"))).toBe(false);
  });

  it("does not override an explicitly selected Docker endpoint", () => {
    const result = redeploy("unavailable", "unix:///unavailable-docker.sock");
    expect(result.status).toBe(1);
    expect(result.calls.some((call) => call.args[0] === "--host" || call.args.includes("delete"))).toBe(false);
  });

  it("cleans temporary build metadata and preserves a failed build's exit status", () => {
    const result = redeploy("build-failure");
    expect(result.status).toBe(23);
    const builds = result.calls.filter((call) => call.command === "docker" && call.args[0] === "build");
    expect(builds).toHaveLength(1);
    expect(existsSync(builds[0].config)).toBe(false);
    expect(result.calls.some((call) => call.args.includes("apply") || call.args.includes("port-forward"))).toBe(false);
  });
});

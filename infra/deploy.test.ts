import { mkdtempSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function runDeployment(failedHealthChecks: number) {
  const directory = mkdtempSync(join(tmpdir(), "azure-vision-deploy-test-"));
  const bin = join(directory, "bin");
  const log = join(directory, "calls.jsonl");
  mkdirSync(bin);
  const mock = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ command, args }) + "\\n");
if (command === "sleep") process.exit(0);
if (command === "curl") {
  const calls = fs.readFileSync(process.env.MOCK_LOG, "utf8").trim().split("\\n").map(JSON.parse);
  const attempt = calls.filter(call => call.command === "curl").length;
  process.exit(attempt <= Number(process.env.MOCK_FAILURES) ? 22 : 0);
}
const query = args[args.indexOf("--query") + 1];
if (args[0] === "account") {
  if (args[1] === "show") console.log(query === "name" ? "Test subscription" : "test-id");
} else if (args[0] === "provider" && args[1] === "register") {
} else if (args[0] === "acr" && args[1] === "build") {
} else if (args[0] === "deployment" && args[1] === "sub" && args[2] === "create") {
} else if (args[0] === "deployment" && args[1] === "sub" && args[2] === "show") {
  if (query === "properties.outputs.acrName.value") console.log("testregistry");
  else if (query === "properties.outputs.url.value") console.log("https://azure-vision.example.test");
  else throw new Error("Unexpected output query: " + query);
} else {
  throw new Error("Unexpected Azure command: " + args.join(" "));
}
`;
  try {
    for (const command of ["az", "curl", "sleep"]) {
      writeFileSync(join(bin, command), mock, { mode: 0o700 });
    }
    const result = spawnSync("bash", [fileURLToPath(new URL("./deploy.sh", import.meta.url))], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        YES: "1",
        SUBSCRIPTION: "test-subscription",
        MOCK_LOG: log,
        MOCK_FAILURES: String(failedHealthChecks),
      },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      command: string;
      args: string[];
    });
    return { ...result, calls };
  } finally {
    for (const command of ["az", "curl", "sleep"]) unlinkSync(join(bin, command));
    unlinkSync(log);
    rmdirSync(bin);
    rmdirSync(directory);
  }
}

describe("Azure deployment readiness", () => {
  it("fails instead of announcing success when the app never answers", () => {
    const result = runDeployment(30);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("web health check failed");
    expect(result.stdout).not.toContain("Deployed:");
    expect(result.calls.filter((call) => call.command === "curl")).toHaveLength(30);
  });

  it("allows startup retries and announces the URL only after a successful check", () => {
    const result = runDeployment(2);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Deployed: https://azure-vision.example.test");
    expect(result.calls.filter((call) => call.command === "curl")).toHaveLength(3);
    expect(result.calls.filter((call) => call.command === "sleep")).toHaveLength(2);
  });
});

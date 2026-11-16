// External pool members: a provider family another extension registers and
// authenticates joins a pool like any template-backed one. Offline; drives the
// production extension through the fixture in tests/fixtures/external-members.ts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-pass-external-"));
try {
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({}));
	writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
		subscriptions: [],
		pools: [{ name: "seats", baseProvider: "fake-cli", members: ["fake-cli-1", "fake-cli-2", "fake-cli-3"], enabled: true }],
		chains: [],
		presets: [],
	}));
	const child = spawn("pi", [
		"--mode", "rpc", "--offline", "--no-extensions", "--no-skills",
		"--no-prompt-templates", "--no-context-files", "--extension",
		join(root, "tests", "fixtures", "external-members.ts"),
	], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
	let stdout = "", stderr = "";
	const status = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { child.kill(); reject(new Error(stdout + stderr)); }, 60_000);
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		let started = false;
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (process.env.DEBUG_EXTERNAL_TEST) process.stderr.write(chunk);
			if (!started && stdout.includes('"id":"ready"')) {
				started = true;
				child.stdin.write('{"id":"check","type":"prompt","message":"/check-external-members"}\n');
			}
			if (/external pool member checks passed|external member check failed:|"success":false|"type":"extension_error"/.test(stdout)) child.stdin.end();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (process.env.DEBUG_EXTERNAL_TEST) process.stderr.write(chunk);
		});
		child.on("close", (code) => { clearTimeout(timer); resolve(code); });
		child.stdin.write('{"id":"ready","type":"get_state"}\n');
	});
	assert.equal(status, 0, stderr);
	assert.doesNotMatch(stdout, /"type":"extension_error"/, stdout);
	assert.doesNotMatch(stdout, /external member check failed:/, stdout);
	assert.match(stdout, /external pool member checks passed/, stdout + stderr);
	console.log("external pool member checks passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}

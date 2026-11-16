// Offline fixture for external pool members. Three fake providers stand in for
// CLI-backed seats; the fixture declares them as an external base, drives
// multi-pass's own agent_end handler with synthetic usage-limit errors, and
// checks what the engine did through the pi surface it was given.
import assert from "node:assert/strict";
import multiPass, { isExternalMemberExhausted, registerExternalPoolBase } from "../../extensions/multi-sub.ts";

const MEMBERS = ["fake-cli-1", "fake-cli-2", "fake-cli-3"];
const MODEL = {
	id: "fake-model",
	name: "Fake model",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
	thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
};

export default function (pi) {
	for (const name of MEMBERS) {
		pi.registerProvider(name, { baseUrl: "process://fake-cli", api: "anthropic-messages", apiKey: "FAKE", models: [MODEL] });
	}

	const ready = new Set(MEMBERS);
	registerExternalPoolBase({
		base: "fake-cli",
		displayName: "Fake CLI",
		members: MEMBERS,
		isReady: (member) => ready.has(member),
		modelIds: () => [MODEL.id],
		piWillRetry: () => false,
		continuationPrompt: () => "CONTINUE FROM TRANSCRIPT",
	});

	// What a registration clash looks like.
	assert.throws(() => registerExternalPoolBase({ base: "anthropic", members: ["x-1"], isReady: () => true, modelIds: () => [] }), /clashes/);
	assert.throws(() => registerExternalPoolBase({ base: "other", members: ["fake-cli-1"], isReady: () => true, modelIds: () => [] }), /already belongs/);
	assert.throws(() => registerExternalPoolBase({ base: "other", members: ["a", "a"], isReady: () => true, modelIds: () => [] }), /unique/);

	const handlers = new Map();
	const commands = new Map();
	const switches = [];
	const followUps = [];
	let thinking = "high";
	multiPass({
		...pi,
		on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return pi.on(event, handler); },
		registerCommand(name, command) { commands.set(name, command); pi.registerCommand(name, command); },
		async setModel(model) { switches.push(model.provider); return true; },
		sendUserMessage(text, options) { followUps.push({ text, options }); },
		getThinkingLevel() { return thinking; },
		setThinkingLevel(level) { thinking = level; },
	});

	const fire = async (event, payload, ctx) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};

	pi.registerCommand("check-external-members", {
		description: "Offline external pool member checks",
		handler: async (_args, ctx) => Promise.resolve().then(async () => {
			const notes = [];
			const quiet = { notify(message) { notes.push(message); }, setStatus() {} };
			const modelOn = (provider) => ctx.modelRegistry.find(provider, MODEL.id);
			assert.ok(modelOn("fake-cli-1"), "fake providers are registered with Pi");
			const context = (provider) => ({ ...ctx, hasUI: false, ui: quiet, model: modelOn(provider) });

			// Pool status lists the members and reports readiness from the owner.
			ready.delete("fake-cli-3");
			let shown;
			await commands.get("pool").handler("status", { ...context("fake-cli-1"), ui: { ...quiet, async select(_title, options) { shown = options; return undefined; } } });
			const statusText = shown.join("\n");
			assert.match(statusText, /=== seats \(enabled\) ===/);
			assert.match(statusText, /availability: 2\/3 available/);
			assert.match(statusText, /fake-cli-3 -- not logged in/);
			ready.add("fake-cli-3");

			// A usage limit on member 1 rotates to member 2, keeps the thinking
			// level, and queues the owner's continuation text (Pi will not retry).
			const limit = (provider) => ({ messages: [{ role: "assistant", stopReason: "error", provider, errorMessage: "Claude subscription rate limit reported by the CLI (429)" }] });
			thinking = "xhigh";
			await fire("before_agent_start", { prompt: "do the thing" }, context("fake-cli-1"));
			await fire("agent_end", limit("fake-cli-1"), context("fake-cli-1"));
			assert.deepEqual(switches, ["fake-cli-2"]);
			assert.equal(thinking, "xhigh");
			assert.equal(followUps.length, 1);
			assert.equal(followUps[0].text, "CONTINUE FROM TRANSCRIPT");
			assert.equal(followUps[0].options.deliverAs, "followUp");
			assert.equal(isExternalMemberExhausted("fake-cli-1"), false);

			// Member 2 limited too, member 3 not ready: the cascade is exhausted
			// and the owner can see that for member 2.
			ready.delete("fake-cli-3");
			await fire("agent_end", limit("fake-cli-2"), context("fake-cli-2"));
			assert.deepEqual(switches, ["fake-cli-2"], "no switch when nothing is ready");
			assert.equal(isExternalMemberExhausted("fake-cli-2"), true);
			assert.equal(isExternalMemberExhausted("fake-cli-1"), false);
			assert.ok(notes.some((note) => /fake-cli-3 skipped \(no auth\)/.test(note)), notes.join("\n"));

			// A non-limit error does not rotate and clears the exhaustion flag.
			await fire("agent_end", { messages: [{ role: "assistant", stopReason: "error", provider: "fake-cli-2", errorMessage: "400 bad request" }] }, context("fake-cli-2"));
			assert.equal(isExternalMemberExhausted("fake-cli-2"), false);
			assert.deepEqual(switches, ["fake-cli-2"]);

			// /subs status includes the external members with readiness.
			let subsShown;
			await commands.get("subs").handler("status", { ...context("fake-cli-2"), ui: { ...quiet, async select(_t, options) { subsShown = options; return undefined; } } });
			const subsText = (subsShown ?? []).join("\n");
			assert.match(subsText, /fake-cli-1 \| ready \| 1 models \| Fake CLI \| pools: seats/);
			assert.match(subsText, /fake-cli-3 \| not ready/);

			ctx.ui.notify("external pool member checks passed", "info");
		}).catch((error) => {
			ctx.ui.notify(`external member check failed: ${error?.stack ?? error}`, "error");
		}),
	});
}

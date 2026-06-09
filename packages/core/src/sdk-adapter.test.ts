import { describe, expect, test } from "bun:test";
import {
	adaptSdkClient,
	adaptWakeClient,
	type SdkSessionClient,
	type SdkWakeSessionClient,
} from "./sdk-adapter";

/**
 * A scripted fake of the real SDK client's `session` surface. Each method records
 * the exact options object it was called with, and returns a canned
 * `RequestResult`-shaped payload (`{ data, ... }`) so we can assert the adapter
 * narrows to `{ data }` and forwards the call shape verbatim.
 */
interface Call {
	method: string;
	opts: unknown;
}

function makeFake(overrides: Partial<Record<string, unknown>> = {}): {
	client: SdkSessionClient;
	calls: Call[];
} {
	const calls: Call[] = [];
	const record =
		(method: string, result: unknown) =>
		async (opts: unknown): Promise<unknown> => {
			calls.push({ method, opts });
			return result;
		};

	const client = {
		session: {
			create: record("create", {
				data: { id: "ses_new", extra: "ignored" },
				request: {},
				response: {},
			}),
			promptAsync: record("promptAsync", {
				data: { messageID: "msg_1" },
			}),
			abort: record("abort", { data: true }),
			messages: record("messages", {
				data: [
					{ info: { role: "assistant", time: { created: 1000 } }, parts: [] },
				],
			}),
			get: record("get", { data: { id: "ses_new" } }),
			status: record("status", {
				data: { ses_child: { type: "busy" } },
			}),
			...overrides,
		},
	} as unknown as SdkSessionClient;

	return { client, calls };
}

describe("adaptSdkClient", () => {
	test("create: forwards { body } and narrows to { data: { id } }", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		const res = await engine.session.create({
			body: { parentID: "ses_parent", title: "a task" },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			method: "create",
			opts: { body: { parentID: "ses_parent", title: "a task" } },
		});
		// Narrowed to exactly { id } — extra fields dropped.
		expect(res).toEqual({ data: { id: "ses_new" } });
	});

	test("create: undefined data narrows to { data: undefined }", async () => {
		const { client } = makeFake({
			create: async () => ({ data: undefined }),
		});
		const engine = adaptSdkClient(client);

		const res = await engine.session.create({ body: { title: "x" } });
		expect(res).toEqual({ data: undefined });
	});

	test("create: forwards query.directory verbatim when present (Epic H.1)", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		await engine.session.create({
			body: { parentID: "ses_parent", title: "a task" },
			query: { directory: "/tmp/wt-abc" },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			method: "create",
			opts: {
				body: { parentID: "ses_parent", title: "a task" },
				query: { directory: "/tmp/wt-abc" },
			},
		});
	});

	test("create: omits query when absent (byte-identical to today)", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		await engine.session.create({ body: { title: "x" } });

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			method: "create",
			opts: { body: { title: "x" } },
		});
	});

	test("promptAsync: forwards { path, body } verbatim", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		const body = {
			agent: "build",
			tools: { bg_task: false },
			parts: [{ type: "text" as const, text: "go" }],
		};
		await engine.session.promptAsync({ path: { id: "ses_1" }, body });

		expect(calls[0]).toEqual({
			method: "promptAsync",
			opts: { path: { id: "ses_1" }, body },
		});
	});

	test("abort: forwards { path } only", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		await engine.session.abort({ path: { id: "ses_1" } });

		expect(calls[0]).toEqual({
			method: "abort",
			opts: { path: { id: "ses_1" } },
		});
	});

	test("messages: forwards { path } and narrows to { data }", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		const res = await engine.session.messages({ path: { id: "ses_1" } });

		expect(calls[0]).toEqual({
			method: "messages",
			opts: { path: { id: "ses_1" } },
		});
		expect(res).toEqual({
			data: [
				{ info: { role: "assistant", time: { created: 1000 } }, parts: [] },
			],
		});
	});

	test("messages: null data narrows to { data: undefined }", async () => {
		const { client } = makeFake({
			messages: async () => ({ data: null }),
		});
		const engine = adaptSdkClient(client);

		const res = await engine.session.messages({ path: { id: "ses_1" } });
		expect(res).toEqual({ data: undefined });
	});

	test("get: forwards { path }", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		await engine.session.get({ path: { id: "ses_1" } });

		expect(calls[0]).toEqual({
			method: "get",
			opts: { path: { id: "ses_1" } },
		});
	});

	test("status: forwards the no-arg call and narrows a populated map", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		const res = await engine.session.status();

		expect(calls[0]).toEqual({ method: "status", opts: undefined });
		// Narrowed to exactly { data } — the canned map from makeFake().
		expect(res).toEqual({ data: { ses_child: { type: "busy" } } });
	});

	test("status: empty map passes through as { data: {} }", async () => {
		const { client } = makeFake({
			status: async () => ({ data: {} }),
		});
		const engine = adaptSdkClient(client);

		const res = await engine.session.status();
		expect(res).toEqual({ data: {} });
	});

	test("status: null data narrows to { data: undefined }", async () => {
		const { client } = makeFake({
			status: async () => ({ data: null }),
		});
		const engine = adaptSdkClient(client);

		const res = await engine.session.status();
		expect(res).toEqual({ data: undefined });
	});
});

/**
 * Scripted fake of the wake notifier's `session` surface: the global
 * `session.status` map read and `promptAsync` to the parent. Mirrors
 * {@link makeFake} so the wake adapter is exercised under the same drift-
 * detection contract as the engine adapter.
 */
function makeWakeFake(overrides: Partial<Record<string, unknown>> = {}): {
	client: SdkWakeSessionClient;
	calls: Call[];
} {
	const calls: Call[] = [];
	const record =
		(method: string, result: unknown) =>
		async (opts: unknown): Promise<unknown> => {
			calls.push({ method, opts });
			return result;
		};

	const client = {
		session: {
			status: record("status", {
				data: { ses_parent: { type: "idle" } },
				request: {},
				response: {},
			}),
			promptAsync: record("promptAsync", { data: { messageID: "msg_1" } }),
			...overrides,
		},
	} as unknown as SdkWakeSessionClient;

	return { client, calls };
}

describe("adaptWakeClient", () => {
	test("status: narrows a populated map", async () => {
		const { client, calls } = makeWakeFake();
		const wake = adaptWakeClient(client);

		const res = await wake.session.status();

		expect(calls[0]).toEqual({ method: "status", opts: undefined });
		// Narrowed to exactly { data } — request/response metadata dropped.
		expect(res).toEqual({ data: { ses_parent: { type: "idle" } } });
	});

	test("status: null data narrows to { data: undefined }", async () => {
		const { client } = makeWakeFake({
			status: async () => ({ data: null }),
		});
		const wake = adaptWakeClient(client);

		const res = await wake.session.status();
		expect(res).toEqual({ data: undefined });
	});

	test("promptAsync: forwards { path, body } verbatim", async () => {
		const { client, calls } = makeWakeFake();
		const wake = adaptWakeClient(client);

		const body = {
			parts: [{ type: "text" as const, text: "wake up" }],
		};
		await wake.session.promptAsync({ path: { id: "ses_parent" }, body });

		expect(calls[0]).toEqual({
			method: "promptAsync",
			opts: { path: { id: "ses_parent" }, body },
		});
	});
});

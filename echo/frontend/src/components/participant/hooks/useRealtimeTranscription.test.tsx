// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	callbacks: {} as Record<string, (...args: any[]) => void>,
	post: vi.fn(),
	disconnect: vi.fn(async () => {
		if (fake.autoReady) fake.callbacks.onSessionStarted();
	}),
	commit: vi.fn(),
	send: vi.fn(),
	closed: vi.fn(),
	node: null as any,
	autoReady: true,
}));
vi.mock("@/lib/api", () => ({ apiNoAuth: { post: fake.post } }));
vi.mock("@elevenlabs/react", () => ({
	AudioFormat: { PCM_16000: "pcm_16000" },
	CommitStrategy: { VAD: "vad" },
	useScribe: (callbacks: typeof fake.callbacks) => {
		fake.callbacks = callbacks;
		return {
			connect: vi.fn(async () => {
				if (fake.autoReady) fake.callbacks.onSessionStarted();
			}),
			disconnect: fake.disconnect,
			commit: fake.commit,
			sendAudio: fake.send,
			isConnected: true,
			partialTranscript: "",
		};
	},
}));
import { useRealtimeTranscription } from "./useRealtimeTranscription";

beforeEach(() => {
	i18n.load("nl-NL", {});
	i18n.activate("nl-NL");
	vi.clearAllMocks();
	fake.autoReady = true;
	fake.node = null;
	sessionStorage.clear();
	const connection = { connect: () => connection, disconnect: vi.fn() };
	vi.stubGlobal(
		"AudioContext",
		class {
			state = "running";
			destination = {};
			audioWorklet = { addModule: vi.fn() };
			resume = vi.fn();
			close = fake.closed;
			createMediaStreamSource = () => connection;
			createGain = () => ({ ...connection, gain: { value: 0 } });
		},
	);
	vi.stubGlobal(
		"AudioWorkletNode",
		class {
			port = {
				onmessage: (_event: any) => {},
				postMessage: () => this.port.onmessage({ data: "flushed" }),
			};
			connect = () => connection;
			disconnect = vi.fn();
			constructor() {
				fake.node = this;
			}
		},
	);
	fake.post.mockImplementation(async (url: string) =>
		url.endsWith("realtime-token")
			? { token: "single-use", participant_token: "participant" }
			: { id: "saved" },
	);
});

it("persists committed text with a stable ID and participant authorization", async () => {
	const { result } = renderHook(() =>
		useRealtimeTranscription("project", "conversation", vi.fn()),
	);
	await act(() => result.current.start({} as MediaStream));
	await act(async () => {
		fake.callbacks.onCommittedTranscript({ text: "Hallo Twentyseven" });
	});
	const [, segment, config] = fake.post.mock.calls.find(([url]) =>
		url.endsWith("realtime-segments"),
	)!;
	expect(segment).toMatchObject({
		text: "Hallo Twentyseven",
		id: expect.any(String),
	});
	expect(config.headers.Authorization).toBe("Bearer participant");
	expect(result.current.pending).toBe(0);
	await act(() => result.current.flush());
	expect(fake.closed).toHaveBeenCalled();
});

it("retries the same segment after a storage failure before finishing", async () => {
	const { result } = renderHook(() =>
		useRealtimeTranscription("project", "conversation", vi.fn()),
	);
	await act(() => result.current.start({} as MediaStream));
	fake.post.mockRejectedValueOnce(new Error("offline"));
	await act(async () => {
		fake.callbacks.onCommittedTranscript({ text: "Bewaar deze tekst" });
	});
	expect(result.current.pending).toBe(1);
	const saved = JSON.parse(
		sessionStorage.getItem("twentyseven-transcripts:conversation")!,
	);
	await act(() => result.current.flush());
	const writes = fake.post.mock.calls.filter(([url]) =>
		url.endsWith("realtime-segments"),
	);
	expect(writes.map(([, body]) => body.id)).toEqual([saved[0].id, saved[0].id]);
	expect(result.current.pending).toBe(0);
});

it("interrupts the recorder when the streaming connection breaks", async () => {
	const interrupted = vi.fn();
	const { result } = renderHook(() =>
		useRealtimeTranscription("project", "conversation", interrupted),
	);
	await act(() => result.current.start({} as MediaStream));
	act(() => fake.callbacks.onDisconnect());
	expect(interrupted).toHaveBeenCalledOnce();
	expect(result.current.error).toBeTruthy();
});

it("waits for the final committed transcript and cleans up after confirmation", async () => {
	const { result } = renderHook(() =>
		useRealtimeTranscription("project", "conversation", vi.fn()),
	);
	await act(() => result.current.start({} as MediaStream));
	act(() => fake.node.port.onmessage({ data: new Int16Array([1000]).buffer }));
	fake.commit.mockImplementation(() =>
		fake.callbacks.onCommittedTranscript({ text: "Laatste zin" }),
	);
	await act(() => result.current.flush());
	expect(fake.commit).toHaveBeenCalledOnce();
	expect(
		fake.post.mock.calls.some(([, body]) => body?.text === "Laatste zin"),
	).toBe(true);
	expect(fake.closed).toHaveBeenCalled();
});

it("commits continuous speech without waiting for silence", async () => {
	vi.useFakeTimers();
	const { result, unmount } = renderHook(() =>
		useRealtimeTranscription("project", "conversation", vi.fn()),
	);
	try {
		await act(() => result.current.start({} as MediaStream));
		act(() =>
			fake.callbacks.onPartialTranscript({ text: "Continuous speech" }),
		);
		await act(() => vi.advanceTimersByTimeAsync(15000));
		expect(fake.commit).toHaveBeenCalledOnce();
	} finally {
		unmount();
		vi.useRealTimers();
	}
});

it("retries unsaved text during recording with the same ID", async () => {
	vi.useFakeTimers();
	const { result, unmount } = renderHook(() =>
		useRealtimeTranscription("project", "conversation", vi.fn()),
	);
	try {
		await act(() => result.current.start({} as MediaStream));
		fake.post.mockRejectedValueOnce(new Error("timeout"));
		await act(async () =>
			fake.callbacks.onCommittedTranscript({ text: "Save after recovery" }),
		);
		expect(result.current.pending).toBe(1);
		await act(() => vi.advanceTimersByTimeAsync(5000));
		expect(result.current.pending).toBe(0);
		const writes = fake.post.mock.calls.filter(([url]) =>
			url.endsWith("realtime-segments"),
		);
		expect(writes[0][1].id).toBe(writes[1][1].id);
		expect(writes[0][2].timeout).toBe(15000);
	} finally {
		unmount();
		vi.useRealTimers();
	}
});

it("handles provider failures once instead of leaving a frozen recorder", async () => {
	const interrupted = vi.fn();
	const { result, unmount } = renderHook(() =>
		useRealtimeTranscription("project", "conversation", interrupted),
	);
	await act(() => result.current.start({} as MediaStream));
	act(() => {
		fake.callbacks.onQueueOverflowError({});
		fake.callbacks.onDisconnect();
	});
	expect(interrupted).toHaveBeenCalledOnce();
	unmount();
});

it("contains send errors and stops the recorder instead of throwing from the worklet", async () => {
	const interrupted = vi.fn();
	const { result, unmount } = renderHook(() =>
		useRealtimeTranscription("project", "conversation", interrupted),
	);
	await act(() => result.current.start({} as MediaStream));
	fake.send.mockImplementationOnce(() => {
		throw new Error("Socket closed");
	});
	act(() => fake.node.port.onmessage({ data: new Int16Array([1000]).buffer }));
	expect(interrupted).toHaveBeenCalledOnce();
	unmount();
});

it("detects stalled transcription during speech but permits silence", async () => {
	vi.useFakeTimers();
	const interrupted = vi.fn();
	const { result, unmount } = renderHook(() =>
		useRealtimeTranscription("project", "conversation", interrupted),
	);
	try {
		await act(() => result.current.start({} as MediaStream));
		await act(() => vi.advanceTimersByTimeAsync(50000));
		expect(interrupted).not.toHaveBeenCalled();
		act(() =>
			fake.node.port.onmessage({ data: new Int16Array([1000]).buffer }),
		);
		await act(() => vi.advanceTimersByTimeAsync(50000));
		expect(interrupted).toHaveBeenCalledOnce();
	} finally {
		unmount();
		vi.useRealTimers();
	}
});

it("waits for the provider session before connecting microphone audio", async () => {
	fake.autoReady = false;
	const { result, unmount } = renderHook(() =>
		useRealtimeTranscription("project", "conversation", vi.fn()),
	);
	let starting: Promise<void>;
	await act(async () => {
		starting = result.current.start({} as MediaStream);
	});
	expect(fake.node).toBeNull();
	expect(fake.send).not.toHaveBeenCalled();
	await act(async () => {
		fake.callbacks.onSessionStarted();
		await starting;
	});
	expect(fake.node).not.toBeNull();
	unmount();
});

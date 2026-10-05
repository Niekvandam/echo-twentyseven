import { AudioFormat, CommitStrategy, useScribe } from "@elevenlabs/react";
import { t } from "@lingui/core/macro";
import { useEffect, useRef, useState } from "react";
import { apiNoAuth } from "@/lib/api";

type Segment = { id: string; text: string; timestamp: string };

export function useRealtimeTranscription(
	projectId: string,
	conversationId: string,
	onInterrupted: () => void,
) {
	const path = `/participant/projects/${projectId}/conversations/${conversationId}`;
	const storageKey = `twentyseven-transcripts:${conversationId}`;
	const queue = useRef<Segment[]>([]);
	const participantToken = useRef("");
	const draining = useRef<Promise<void> | null>(null);
	const stopping = useRef<Promise<void> | null>(null);
	const context = useRef<AudioContext | null>(null);
	const processor = useRef<AudioWorkletNode | null>(null);
	const input = useRef<MediaStreamAudioSourceNode | null>(null);
	const expectedDisconnect = useRef(true);
	const pendingCommit = useRef<(() => void) | null>(null);
	const connectionReady = useRef<{
		resolve: () => void;
		reject: (error: Error) => void;
	} | null>(null);
	const flushAudio = useRef<(() => void) | null>(null);
	const hasUncommittedAudio = useRef(false);
	const partialText = useRef("");
	const epoch = useRef(0);
	const lastActivity = useRef(Date.now());
	const lastCommit = useRef(Date.now());
	const lastAudio = useRef(0);
	const maintenance = useRef<ReturnType<typeof setInterval> | null>(null);
	const interrupt = useRef(onInterrupted);
	interrupt.current = onInterrupted;
	const [error, setError] = useState<string | null>(null);
	const [lastText, setLastText] = useState("");
	const [pending, setPending] = useState(0);

	function persist() {
		setPending(queue.current.length);
		try {
			sessionStorage.setItem(storageKey, JSON.stringify(queue.current));
		} catch {
			setError(
				t`Bewaren op dit apparaat lukt niet. Houd dit venster open totdat de tekst is opgeslagen.`,
			);
		}
	}
	function drain(): Promise<void> {
		if (draining.current) return draining.current;
		const run = async () => {
			while (queue.current.length) {
				const segment = queue.current[0];
				await apiNoAuth.post(`${path}/realtime-segments`, segment, {
					headers: { Authorization: `Bearer ${participantToken.current}` },
					timeout: 15000,
				});
				queue.current.shift();
				persist();
			}
		};
		draining.current = run().finally(() => {
			draining.current = null;
		});
		return draining.current;
	}
	function interrupted() {
		connectionReady.current?.reject(
			new Error("Transcription connection failed"),
		);
		if (expectedDisconnect.current) return;
		expectedDisconnect.current = true;
		setError(
			t`Live transcriptie is onderbroken. Start de opname opnieuw om verder te gaan.`,
		);
		interrupt.current();
	}
	const scribe = useScribe({
		modelId: "scribe_v2_realtime",
		commitStrategy: CommitStrategy.VAD,
		audioFormat: AudioFormat.PCM_16000,
		sampleRate: 16000,
		onSessionStarted: () => connectionReady.current?.resolve(),
		onPartialTranscript: ({ text }) => {
			partialText.current = text;
			lastActivity.current = Date.now();
		},
		onCommittedTranscript: ({ text }) => {
			hasUncommittedAudio.current = false;
			lastActivity.current = Date.now();
			lastCommit.current = Date.now();
			partialText.current = "";
			if (text.trim()) {
				queue.current.push({
					id: crypto.randomUUID(),
					text,
					timestamp: new Date().toISOString(),
				});
				persist();
				setLastText(text);
				void drain().catch(() =>
					setError(
						t`De tekst is nog niet opgeslagen. Controleer je verbinding en probeer opnieuw.`,
					),
				);
			}
			pendingCommit.current?.();
			pendingCommit.current = null;
		},
		onError: (event) => {
			if (!("message_type" in event) || event.message_type !== "commit_throttled") interrupted();
		},
		onDisconnect: interrupted,
		onAuthError: interrupted,
		onQuotaExceededError: interrupted,
		onTranscriberError: interrupted,
		onUnacceptedTermsError: interrupted,
		onRateLimitedError: interrupted,
		onInputError: interrupted,
		onQueueOverflowError: interrupted,
		onResourceExhaustedError: interrupted,
		onSessionTimeLimitExceededError: interrupted,
		onChunkSizeExceededError: interrupted,
		onInsufficientAudioActivityError: interrupted,
	});
	const scribeRef = useRef(scribe);
	scribeRef.current = scribe;

	async function start(stream: MediaStream) {
		const version = ++epoch.current;
		connectionReady.current?.reject(new Error("Recording cancelled"));
		if (maintenance.current) clearInterval(maintenance.current);
		maintenance.current = null;
		if (stopping.current) await stopping.current.catch(() => {});
		stopping.current = null;
		setError(null);
		hasUncommittedAudio.current = false;
		partialText.current = "";
		let stored: string | null = null;
		try {
			stored = sessionStorage.getItem(storageKey);
		} catch {
			/* Memory queue still works. */
		}
		if (stored) {
			try {
				const saved: unknown = JSON.parse(stored);
				if (
					Array.isArray(saved) &&
					saved.every(
						(item) =>
							typeof item.id === "string" &&
							typeof item.text === "string" &&
							typeof item.timestamp === "string",
					)
				)
					queue.current = saved;
			} catch {
				/* Keep the in-memory queue if storage was corrupted. */
			}
		}
		const audio = new AudioContext({ sampleRate: 16000 });
		context.current = audio;
		await audio.resume();
		try {
			const credentials = await apiNoAuth.post<
				unknown,
				{ token: string; participant_token: string }
			>(`${path}/realtime-token`, undefined, { timeout: 20000 });
			participantToken.current = credentials.participant_token;
			await drain();
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("Transcription connection timed out")),
					20000,
				);
				connectionReady.current = {
					resolve: () => {
						clearTimeout(timeout);
						resolve();
					},
					reject: (cause) => {
						clearTimeout(timeout);
						reject(cause);
					},
				};
				void scribeRef.current
					.connect({ token: credentials.token })
					.catch((cause) => connectionReady.current?.reject(cause));
			}).finally(() => {
				connectionReady.current = null;
			});
			await audio.audioWorklet.addModule("/realtime-pcm.js");
			if (version !== epoch.current) throw new Error("Recording cancelled");
			const node = new AudioWorkletNode(audio, "twentyseven-pcm");
			node.port.onmessage = ({ data }: MessageEvent<ArrayBuffer | string>) => {
				if (data === "flushed") {
					flushAudio.current?.();
					return;
				}
				if (!(data instanceof ArrayBuffer)) return;
				// Only audible samples require final confirmation; silence alone
				// may not produce a committed transcript.
				if (new Int16Array(data).some((value) => Math.abs(value) > 300)) {
					if (!hasUncommittedAudio.current) lastActivity.current = Date.now();
					hasUncommittedAudio.current = true;
					lastAudio.current = Date.now();
				}
				let binary = "";
				for (const byte of new Uint8Array(data))
					binary += String.fromCharCode(byte);
				try {
					scribeRef.current.sendAudio(btoa(binary));
				} catch {
					interrupted();
				}
			};
			const source = audio.createMediaStreamSource(stream);
			const silence = audio.createGain();
			silence.gain.value = 0;
			source.connect(node).connect(silence).connect(audio.destination);
			processor.current = node;
			input.current = source;
			expectedDisconnect.current = false;
			lastActivity.current = lastCommit.current = Date.now();
			lastAudio.current = 0;
			maintenance.current = setInterval(() => {
				if (expectedDisconnect.current) return;
				// Retry durable text independently of the microphone connection.
				if (queue.current.length) void drain().catch(() => {});
				const now = Date.now();
				if (
					hasUncommittedAudio.current &&
					lastAudio.current > 0 &&
					now - lastActivity.current > 45000
				) {
					interrupted();
					return;
				}
				// Continuous speech need not wait indefinitely for a VAD pause.
				if (partialText.current.trim() && now - lastCommit.current >= 15000) {
					lastCommit.current = now;
					try {
						scribeRef.current.commit();
					} catch {
						interrupted();
					}
				}
			}, 5000);
		} catch (cause) {
			expectedDisconnect.current = true;
			if (maintenance.current) clearInterval(maintenance.current);
			scribeRef.current.disconnect();
			if (audio.state !== "closed") await audio.close();
			setError(
				t`Live transcriptie kon niet starten. Controleer je verbinding en probeer opnieuw.`,
			);
			throw cause;
		}
	}

	function stop(): Promise<void> {
		++epoch.current;
		connectionReady.current?.reject(new Error("Recording cancelled"));
		if (maintenance.current) clearInterval(maintenance.current);
		maintenance.current = null;
		if (stopping.current) return stopping.current;
		expectedDisconnect.current = true;
		stopping.current = (async () => {
			try {
				if (processor.current && context.current?.state === "running") {
					input.current?.disconnect();
					await new Promise<void>((resolve) => {
						const timeout = setTimeout(resolve, 1000);
						flushAudio.current = () => {
							clearTimeout(timeout);
							resolve();
						};
						processor.current?.port.postMessage("flush");
					});
				}
				if (!scribeRef.current.isConnected && partialText.current.trim())
					throw new Error("Unconfirmed transcript after disconnect");
				if (scribeRef.current.isConnected && hasUncommittedAudio.current) {
					await new Promise<void>((resolve, reject) => {
						const timeout = setTimeout(
							() => reject(new Error("Transcript confirmation timed out")),
							10000,
						);
						pendingCommit.current = () => {
							clearTimeout(timeout);
							resolve();
						};
						scribeRef.current.commit();
					});
				}
			} finally {
				pendingCommit.current = null;
				flushAudio.current = null;
				scribeRef.current.disconnect();
				input.current?.disconnect();
				processor.current?.disconnect();
				processor.current = null;
				if (context.current && context.current.state !== "closed")
					await context.current.close();
			}
		})();
		void stopping.current.catch(() =>
			setError(
				t`De laatste tekst is nog niet bevestigd. Probeer opnieuw voordat je het gesprek afrondt.`,
			),
		);
		return stopping.current;
	}

	async function flush() {
		await stop();
		await drain();
	}
	useEffect(
		() => () => {
			expectedDisconnect.current = true;
			if (maintenance.current) clearInterval(maintenance.current);
			scribeRef.current.disconnect();
			input.current?.disconnect();
			if (context.current && context.current.state !== "closed")
				void context.current.close();
		},
		[],
	);
	return {
		start,
		stop,
		flush,
		error,
		pending,
		text: scribe.partialTranscript || lastText,
	};
}

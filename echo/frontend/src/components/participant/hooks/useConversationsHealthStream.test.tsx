// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useConversationsHealthStream } from "./useConversationsHealthStream";

it("keeps one health connection across transcript renders and heartbeat updates", () => {
 const streams: { close: ReturnType<typeof vi.fn>; listeners: Record<string, (event: Event) => void> }[] = [];
 vi.stubGlobal("EventSource", class {
  close = vi.fn();
  listeners: Record<string, (event: Event) => void> = {};
  constructor() { streams.push(this); }
  addEventListener(name: string, callback: (event: Event) => void) { this.listeners[name] = callback; }
 });
 const { rerender, unmount } = renderHook(({ id }) => useConversationsHealthStream([id]), { initialProps: { id: "conversation" } });
 for (let i = 0; i < 20; i++) {
  rerender({ id: "conversation" });
  act(() => streams[0].listeners.ping(new MessageEvent("ping")));
 }
 expect(streams).toHaveLength(1);
 expect(streams[0].close).not.toHaveBeenCalled();
 rerender({ id: "another-conversation" });
 expect(streams).toHaveLength(2);
 expect(streams[0].close).toHaveBeenCalledOnce();
 unmount();
 expect(streams[1].close).toHaveBeenCalledOnce();
 vi.unstubAllGlobals();
});

// Reproduces how peer signals reach LocalFileRoomPlayer: useRoomConnection
// stores each WebSocket message with setPeerSignal(...) and the player handles
// it in a useEffect. Counts how many signals the effect actually sees, versus
// a queue that hands every message to a subscriber.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

type Signal = { burst: number; index: number; receivedAt: number };
const params = new URLSearchParams(location.search);
const wsUrl = params.get("ws")!;
const pattern = params.get("pattern") ?? "state";

function StatePattern({ onSeen }: { onSeen: (signal: Signal) => void }) {
  const [peerSignal, setPeerSignal] = useState<Signal | null>(null);
  useEffect(() => {
    const socket = new WebSocket(wsUrl);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      setPeerSignal({ ...message, receivedAt: Date.now() });
    });
    return () => socket.close();
  }, []);
  useEffect(() => {
    if (peerSignal) onSeen(peerSignal);
  }, [peerSignal]);
  return null;
}

function QueuePattern({ onSeen }: { onSeen: (signal: Signal) => void }) {
  const onSeenRef = useRef(onSeen);
  useEffect(() => {
    const socket = new WebSocket(wsUrl);
    socket.addEventListener("message", (event) => {
      onSeenRef.current({ ...JSON.parse(event.data), receivedAt: Date.now() });
    });
    return () => socket.close();
  }, []);
  return null;
}

let seen = 0;
const onSeen = () => {
  seen += 1;
};
(window as any).__seenCount = () => seen;
createRoot(document.getElementById("root")!).render(
  pattern === "state" ? <StatePattern onSeen={onSeen} /> : <QueuePattern onSeen={onSeen} />
);

import { useEffect, useMemo, useRef } from "react";
import YouTube, { type YouTubeEvent } from "react-youtube";

import type { RoomState, YoutubeMediaSource } from "@syncplay/shared";

type YoutubePlayerApi = {
  getCurrentTime(): number | Promise<number>;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
};

type RemotePlaybackCommand =
  | {
      kind: "sync";
      room: RoomState;
      actorId?: string;
      receivedAt: number;
    }
  | {
      kind: "event";
      room: RoomState;
      actorId: string;
      action: "player_play" | "player_pause" | "player_seek";
      receivedAt: number;
    };

interface YouTubeRoomPlayerProps {
  room: RoomState & { mediaSource: YoutubeMediaSource };
  selfId: string | null;
  remoteCommand: RemotePlaybackCommand | null;
  onPlay: (currentTime: number) => void;
  onPause: (currentTime: number) => void;
}

const PLAYER_STATE_PLAYING = 1;
const PLAYER_STATE_PAUSED = 2;
const DRIFT_THRESHOLD_SECONDS = 1.2;

export function YouTubeRoomPlayer({ room, selfId, remoteCommand, onPlay, onPause }: YouTubeRoomPlayerProps) {
  const playerRef = useRef<YoutubePlayerApi | null>(null);
  const suppressEventsRef = useRef(false);
  const isReadyRef = useRef(false);
  const lastAppliedEventIdRef = useRef(-1);

  const playerOptions = useMemo(
    () => ({
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: 0,
        rel: 0,
        modestbranding: 1
      }
    }),
    []
  );

  useEffect(() => {
    if (room.mediaSource.type !== "youtube" || !remoteCommand || !playerRef.current || !isReadyRef.current) {
      return;
    }

    if (lastAppliedEventIdRef.current === remoteCommand.room.lastEventId && remoteCommand.kind === "event") {
      return;
    }

    if (remoteCommand.kind === "event" && remoteCommand.actorId === selfId) {
      lastAppliedEventIdRef.current = remoteCommand.room.lastEventId;
      return;
    }

    applyAuthoritativeState(playerRef.current, remoteCommand.room);
    lastAppliedEventIdRef.current = remoteCommand.room.lastEventId;
  }, [remoteCommand, selfId, room.mediaSource.type]);

  useEffect(() => {
    const interval = window.setInterval(async () => {
      const player = playerRef.current;

      if (!player || !isReadyRef.current || room.playbackState !== "playing") {
        return;
      }

      const expectedTime = room.currentTime + (Date.now() - room.updatedAt) / 1000;
      const currentTime = await player.getCurrentTime();

      if (Math.abs(expectedTime - currentTime) > DRIFT_THRESHOLD_SECONDS) {
        applyAuthoritativeState(player, {
          ...room,
          currentTime: expectedTime
        });
      }
    }, 2500);

    return () => {
      window.clearInterval(interval);
    };
  }, [room]);

  function handleReady(event: YouTubeEvent<number>) {
    playerRef.current = event.target;
    isReadyRef.current = true;
    applyAuthoritativeState(event.target, room);
  }

  async function handleStateChange(event: YouTubeEvent<number>) {
    if (suppressEventsRef.current || !playerRef.current || !isReadyRef.current) {
      return;
    }

    const currentTime = await playerRef.current.getCurrentTime();

    if (event.data === PLAYER_STATE_PLAYING) {
      onPlay(currentTime);
      return;
    }

    if (event.data === PLAYER_STATE_PAUSED) {
      onPause(currentTime);
    }
  }

  return (
    <div className="player-wrapper">
      <YouTube
        className="youtube-frame"
        iframeClassName="youtube-iframe"
        videoId={room.mediaSource.videoId}
        opts={playerOptions}
        onReady={handleReady}
        onStateChange={handleStateChange}
      />
    </div>
  );

  function applyAuthoritativeState(player: YoutubePlayerApi, authoritativeRoom: RoomState) {
    suppressEventsRef.current = true;

    void Promise.resolve(player.getCurrentTime()).then((currentTime: number) => {
      if (
        Math.abs(authoritativeRoom.currentTime - currentTime) > DRIFT_THRESHOLD_SECONDS ||
        authoritativeRoom.playbackState === "paused"
      ) {
        player.seekTo(authoritativeRoom.currentTime, true);
      }

      if (authoritativeRoom.playbackState === "playing") {
        player.playVideo();
      } else {
        player.pauseVideo();
      }

      window.setTimeout(() => {
        suppressEventsRef.current = false;
      }, 150);
    });
  }
}

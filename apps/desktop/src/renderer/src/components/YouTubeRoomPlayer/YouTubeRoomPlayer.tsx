import { useEffect, useMemo, useRef, useState } from "react";
import YouTube, { type YouTubeEvent } from "react-youtube";

import type { RoomState, YoutubeMediaSource } from "@syncplay/shared";

import type { DebugEntry } from "../../hooks/useRoomConnection";
import "./YouTubeRoomPlayer.css";

type YoutubePlayerApi = {
  getCurrentTime(): number | Promise<number>;
  getPlayerState?(): number;
  cueVideoById?(options: { videoId: string; startSeconds?: number }): void;
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
  onDebug: (entry: Omit<DebugEntry, "id" | "timestamp">) => void;
}

const PLAYER_STATE_PLAYING = 1;
const PLAYER_STATE_PAUSED = 2;
const PLAYER_STATE_BUFFERING = 3;
const PLAYER_STATE_CUED = 5;
const PLAYER_STATE_UNSTARTED = -1;
const DRIFT_THRESHOLD_SECONDS = 1.2;

export function YouTubeRoomPlayer({ room, selfId, remoteCommand, onPlay, onPause, onDebug }: YouTubeRoomPlayerProps) {
  const playerRef = useRef<YoutubePlayerApi | null>(null);
  const suppressEventsRef = useRef(false);
  const isReadyRef = useRef(false);
  const lastAppliedEventIdRef = useRef(-1);
  const lastVideoIdRef = useRef<string | null>(null);
  const [playerNotice, setPlayerNotice] = useState<string | null>(null);

  const playerOptions = useMemo(
    () => ({
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: 0,
        controls: 1,
        disablekb: 0,
        rel: 0,
        modestbranding: 1,
        origin: window.location.origin
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

    onDebug({
      scope: "youtube",
      message: `apply remote ${remoteCommand.kind}`,
      details: JSON.stringify({
        playbackState: remoteCommand.room.playbackState,
        currentTime: remoteCommand.room.currentTime,
        lastEventId: remoteCommand.room.lastEventId
      })
    });
    applyAuthoritativeState(playerRef.current, remoteCommand.room);
    lastAppliedEventIdRef.current = remoteCommand.room.lastEventId;
  }, [onDebug, remoteCommand, selfId, room.mediaSource.type]);

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

  useEffect(() => {
    setPlayerNotice(null);
  }, [room.mediaSource.videoId]);

  function handleReady(event: YouTubeEvent<number>) {
    playerRef.current = event.target;
    isReadyRef.current = true;
    lastVideoIdRef.current = room.mediaSource.videoId;
    cueVideo(event.target, room.mediaSource.videoId, room.currentTime);
    onDebug({
      scope: "youtube",
      message: "player ready",
      details: room.mediaSource.videoId
    });
    window.setTimeout(() => {
      applyAuthoritativeState(event.target, room);
    }, 0);
  }

  async function handleStateChange(event: YouTubeEvent<number>) {
    if (suppressEventsRef.current || !playerRef.current || !isReadyRef.current) {
      return;
    }

    const currentTime = await playerRef.current.getCurrentTime();
    onDebug({
      scope: "youtube",
      message: `state ${String(event.data)}`,
      details: `t=${currentTime.toFixed(2)}`
    });

    if (event.data === PLAYER_STATE_BUFFERING || event.data === PLAYER_STATE_CUED) {
      return;
    }

    if (event.data === PLAYER_STATE_PLAYING) {
      onPlay(currentTime);
      return;
    }

    if (event.data === PLAYER_STATE_PAUSED) {
      onPause(currentTime);
    }
  }

  function handleError(event: YouTubeEvent<number>) {
    setPlayerNotice(getYouTubePlayerNotice(event.data));
    onDebug({
      scope: "youtube",
      message: `player error ${String(event.data)}`,
      details: room.mediaSource.videoId
    });
  }

  return (
    <div className="youtube-player-shell">
      <div className="player-wrapper">
        <YouTube
          className="youtube-frame"
          iframeClassName="youtube-iframe"
          videoId={room.mediaSource.videoId}
          opts={playerOptions}
          onReady={handleReady}
          onStateChange={handleStateChange}
          onError={handleError}
        />
      </div>
      <p className="youtube-room-note">
        YouTube availability can change by country, account restrictions, or whether the video allows embedded playback.
      </p>
      {playerNotice ? <div className="youtube-player-notice">{playerNotice}</div> : null}
    </div>
  );

  function applyAuthoritativeState(player: YoutubePlayerApi, authoritativeRoom: RoomState) {
    const playerState = player.getPlayerState?.() ?? null;

    onDebug({
      scope: "youtube",
      message: "apply authoritative state",
      details: JSON.stringify({
        playbackState: authoritativeRoom.playbackState,
        currentTime: authoritativeRoom.currentTime,
        playerState
      })
    });
    suppressEventsRef.current = true;

    void Promise.resolve(player.getCurrentTime()).then((currentTime: number) => {
      if (lastVideoIdRef.current !== room.mediaSource.videoId) {
        lastVideoIdRef.current = room.mediaSource.videoId;
        cueVideo(player, room.mediaSource.videoId, authoritativeRoom.currentTime);
      }

      if (Math.abs(authoritativeRoom.currentTime - currentTime) > DRIFT_THRESHOLD_SECONDS) {
        player.seekTo(authoritativeRoom.currentTime, true);
      }

      if (authoritativeRoom.playbackState === "playing") {
        player.playVideo();
      } else {
        const isStablePreviewState =
          playerState === PLAYER_STATE_CUED || playerState === PLAYER_STATE_UNSTARTED || playerState === null;
        const isAligned = Math.abs(authoritativeRoom.currentTime - currentTime) <= DRIFT_THRESHOLD_SECONDS;

        if (!isStablePreviewState || !isAligned) {
          player.pauseVideo();
        } else {
          onDebug({
            scope: "youtube",
            message: "skip pause on stable preview",
            details: JSON.stringify({
              currentTime,
              playerState
            })
          });
        }
      }

      window.setTimeout(() => {
        suppressEventsRef.current = false;
      }, 500);
    });
  }

  function cueVideo(player: YoutubePlayerApi, videoId: string, startSeconds: number) {
    player.cueVideoById?.({
      videoId,
      startSeconds
    });
    onDebug({
      scope: "youtube",
      message: "cue video",
      details: JSON.stringify({
        videoId,
        startSeconds
      })
    });
  }
}

function getYouTubePlayerNotice(errorCode: number) {
  switch (errorCode) {
    case 100:
      return "This YouTube video is unavailable, private, or no longer published.";
    case 101:
    case 150:
      return "This video cannot be played inside SyncPlay. The uploader or YouTube requires watching it directly on YouTube, and availability may also vary by country.";
    case 2:
      return "This YouTube link looks invalid. Try pasting the video URL again.";
    case 5:
      return "YouTube could not load this video in the embedded player. Try reloading the room, disabling blockers, or opening the video directly on YouTube.";
    default:
      return "YouTube could not load this video here. This can happen because of embed restrictions, regional blocks, or temporary playback issues.";
  }
}

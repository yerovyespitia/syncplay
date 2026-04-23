import type { ChangeEvent, CSSProperties, RefObject } from "react";

import type { SubtitleTrack } from "@syncplay/shared";
import "./VideoPlayer.css";

interface VideoPlayerProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  subtitleInputRef: RefObject<HTMLInputElement | null>;
  subtitleMenuRef: RefObject<HTMLDivElement | null>;
  mediaUrl: string | null;
  subtitleUrl: string | null;
  subtitleTrack?: SubtitleTrack | null;
  activeSubtitleLines: string[];
  isPointerActive: boolean;
  isPlaying: boolean;
  isMuted: boolean;
  isCaptionsEnabled: boolean;
  isSubtitleMenuOpen: boolean;
  isFullscreenMode: boolean;
  isTheaterMode: boolean;
  showLoadingOverlay: boolean;
  loadingPercent: number;
  isHost: boolean;
  mediaTitle: string;
  subtitleLabel: string;
  subtitleButtonTitle: string;
  hasSubtitleTrack: boolean;
  currentTime: number;
  duration: number;
  safeDuration: number;
  progressPercent: number;
  bufferedPercent: number;
  volume: number;
  volumePercent: number;
  showTransferStatus: boolean;
  isTransferComplete: boolean;
  transferPercent: number;
  formatTime: (totalSeconds: number) => string;
  onRevealControls: () => void;
  onLoadedMetadata: () => void;
  onLoadedData: () => void;
  onCanPlay: () => void;
  onVideoError: () => void;
  onPlay: () => void;
  onPause: () => void;
  onSeeked: () => void;
  onTimeUpdate: () => void;
  onVolumeChange: () => void;
  onToggleFullscreen: () => Promise<void>;
  onSeekBy: (offsetSeconds: number) => void;
  onTogglePlayback: () => void;
  onTimelineInput: (event: ChangeEvent<HTMLInputElement>) => void;
  onToggleMute: () => void;
  onVolumeInput: (event: ChangeEvent<HTMLInputElement>) => void;
  onToggleTheaterMode: () => void;
  onClosedCaptionsAction: () => void;
  onReplaceSubtitles: () => void;
  onToggleCaptions: () => void;
  onSubtitleTrackLoad: () => void;
  onSubtitleFileChange: (event: ChangeEvent<HTMLInputElement>) => void | Promise<void>;
}

export function VideoPlayer({
  videoRef,
  subtitleInputRef,
  subtitleMenuRef,
  mediaUrl,
  subtitleUrl,
  subtitleTrack,
  activeSubtitleLines,
  isPointerActive,
  isPlaying,
  isMuted,
  isCaptionsEnabled,
  isSubtitleMenuOpen,
  isFullscreenMode,
  isTheaterMode,
  showLoadingOverlay,
  loadingPercent,
  isHost,
  mediaTitle,
  subtitleLabel,
  subtitleButtonTitle,
  hasSubtitleTrack,
  currentTime,
  duration,
  safeDuration,
  progressPercent,
  bufferedPercent,
  volume,
  volumePercent,
  showTransferStatus,
  isTransferComplete,
  transferPercent,
  formatTime,
  onRevealControls,
  onLoadedMetadata,
  onLoadedData,
  onCanPlay,
  onVideoError,
  onPlay,
  onPause,
  onSeeked,
  onTimeUpdate,
  onVolumeChange,
  onToggleFullscreen,
  onSeekBy,
  onTogglePlayback,
  onTimelineInput,
  onToggleMute,
  onVolumeInput,
  onToggleTheaterMode,
  onClosedCaptionsAction,
  onReplaceSubtitles,
  onToggleCaptions,
  onSubtitleTrackLoad,
  onSubtitleFileChange
}: VideoPlayerProps) {
  return (
    <>
      <input
        ref={subtitleInputRef}
        className="hidden-file-input"
        type="file"
        accept=".srt,.vtt,text/vtt,application/x-subrip"
        onChange={onSubtitleFileChange}
      />
      <div
        className={`local-player-wrapper ${isFullscreenMode ? "local-player-wrapper--fullscreen" : ""}`}
        onMouseMove={onRevealControls}
        onMouseEnter={onRevealControls}
      >
        <video
          key={mediaUrl ?? "empty-media"}
          ref={videoRef}
          className="local-video"
          playsInline
          src={mediaUrl ?? undefined}
          onLoadedMetadata={onLoadedMetadata}
          onLoadedData={onLoadedData}
          onCanPlay={onCanPlay}
          onError={onVideoError}
          onPlay={onPlay}
          onPause={onPause}
          onSeeked={onSeeked}
          onTimeUpdate={onTimeUpdate}
          onVolumeChange={onVolumeChange}
          onDoubleClick={() => {
            void onToggleFullscreen();
          }}
        >
          {subtitleUrl && subtitleTrack ? (
            <track
              key={`${subtitleTrack.uploadedAt}-${subtitleTrack.fileName}`}
              kind="subtitles"
              src={subtitleUrl}
              srcLang={subtitleTrack.language}
              label={subtitleTrack.label}
              default={isCaptionsEnabled}
              onLoad={onSubtitleTrackLoad}
            />
          ) : null}
        </video>
        {activeSubtitleLines.length > 0 ? (
          <div
            className={`local-player-subtitle-overlay ${
              isPointerActive ? "local-player-subtitle-overlay--controls-visible" : "local-player-subtitle-overlay--controls-hidden"
            }`}
            aria-live="off"
          >
            {activeSubtitleLines.map((line, index) => (
              <span key={`${index}-${line}`} className="local-player-subtitle-line">
                {line}
              </span>
            ))}
          </div>
        ) : null}
        {showLoadingOverlay ? (
          <div className="local-player-loading-overlay" aria-live="polite">
            <div className="local-player-loading-content">
              <p className="local-player-loading-label">{isHost ? "Buffering for guest" : "Buffering video"}</p>
              <strong className="local-player-loading-percent">{loadingPercent}%</strong>
              <div
                className="local-player-loading-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={loadingPercent}
                aria-label={`Loading playback ${loadingPercent}%`}
              >
                <span style={{ width: `${loadingPercent}%` }} />
              </div>
              <p className="local-player-loading-hint">
                {isHost ? "Playback will unlock once your guest has enough buffer to start" : "Downloading enough video to start playback in sync"}
              </p>
            </div>
          </div>
        ) : null}
        {mediaUrl ? (
          <div
            className={`local-player-center-controls ${
              isPointerActive ? "local-player-center-controls--visible" : "local-player-center-controls--hidden"
            }`}
          >
            <button
              className="local-player-center-action local-player-center-action--seek"
              type="button"
              onClick={() => {
                onRevealControls();
                onSeekBy(-10);
              }}
              aria-label="Back 10 seconds"
              title="Back 10 seconds (Left Arrow)"
            >
              <span className="local-player-seek-content">
                <Seek10Icon />
                <span className="local-player-seek-label">10</span>
              </span>
            </button>
            <button
              className="local-player-center-action"
              type="button"
              onClick={() => {
                onRevealControls();
                onTogglePlayback();
              }}
              aria-label={isPlaying ? "Pause video" : "Play video"}
              title={`${isPlaying ? "Pause video" : "Play video"} (Space)`}
            >
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button
              className="local-player-center-action local-player-center-action--seek"
              type="button"
              onClick={() => {
                onRevealControls();
                onSeekBy(10);
              }}
              aria-label="Forward 10 seconds"
              title="Forward 10 seconds (Right Arrow)"
            >
              <span className="local-player-seek-content">
                <Seek10Icon mirrored />
                <span className="local-player-seek-label">10</span>
              </span>
            </button>
          </div>
        ) : null}
        <div className={`local-player-overlay ${isPointerActive ? "local-player-overlay--visible" : "local-player-overlay--hidden"}`}>
          <div className="local-player-topbar">
            <div className="local-player-title-block">
              <strong>{mediaTitle}</strong>
              <span>{subtitleLabel}</span>
            </div>
            <div className="local-player-view-modes">
              <div className="local-player-badge">
                <span className={`local-player-dot ${isPlaying ? "local-player-dot--live" : ""}`} />
                <span>{isPlaying ? "In sync" : "Paused in room"}</span>
              </div>
            </div>
          </div>

          <div className="local-player-bottom">
            <div className="local-player-scrubber">
              <div
                className="local-player-scrubber-track"
                aria-hidden="true"
                style={
                  {
                    "--player-progress": `${progressPercent}%`,
                    "--player-buffered": `${Math.max(progressPercent, bufferedPercent)}%`
                  } as CSSProperties
                }
              />
              <input
                className="local-player-range"
                type="range"
                min={0}
                max={safeDuration}
                step={0.1}
                value={Math.min(currentTime, safeDuration)}
                onChange={(event) => {
                  onRevealControls();
                  onTimelineInput(event);
                }}
                disabled={!mediaUrl || duration <= 0 || showLoadingOverlay}
                aria-label="Playback timeline"
              />
            </div>

            <div className="local-player-controls">
              <div className="local-player-control-group">
                <button
                  className="local-player-icon-button"
                  type="button"
                  onClick={() => {
                    onRevealControls();
                    onTogglePlayback();
                  }}
                  disabled={!mediaUrl || showLoadingOverlay}
                  aria-label={isPlaying ? "Pause video" : "Play video"}
                  title={`${isPlaying ? "Pause video" : "Play video"} (Space)`}
                >
                  {isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>
                <button
                  className="local-player-icon-button"
                  type="button"
                  onClick={() => {
                    onRevealControls();
                    onToggleMute();
                  }}
                  disabled={!mediaUrl}
                  aria-label={isMuted || volume === 0 ? "Unmute video" : "Mute video"}
                  title={`${isMuted || volume === 0 ? "Unmute video" : "Mute video"} (M)`}
                >
                  {isMuted || volume === 0 ? <VolumeMutedIcon /> : <VolumeHighIcon />}
                </button>
                <input
                  className="local-player-volume"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={isMuted ? 0 : volume}
                  onChange={(event) => {
                    onRevealControls();
                    onVolumeInput(event);
                  }}
                  disabled={!mediaUrl}
                  aria-label="Volume"
                  style={
                    {
                      "--player-progress": `${volumePercent}%`
                    } as CSSProperties
                  }
                />
                {showTransferStatus ? (
                  <span
                    className={`local-player-download-status ${
                      isTransferComplete ? "local-player-download-status--complete" : ""
                    }`}
                    role="status"
                    aria-live="polite"
                    aria-label={`Downloading video ${transferPercent}%`}
                    title={`Downloading video ${transferPercent}%`}
                  >
                    <DownloadIcon />
                    {transferPercent}%
                  </span>
                ) : null}
              </div>

              <div className="local-player-time-block">
                <div className="local-player-time">
                  <strong>{formatTime(currentTime)}</strong>
                  <span>/ {formatTime(duration)}</span>
                </div>
                <div className="local-player-time-actions">
                  <button
                    className="local-player-toolbar-button local-player-toolbar-button--icon"
                    type="button"
                    onClick={() => {
                      onRevealControls();
                      onToggleTheaterMode();
                    }}
                    aria-label={isTheaterMode ? "Exit theater mode" : "Enter theater mode"}
                    title={`${isTheaterMode ? "Exit theater mode" : "Enter theater mode"} (T)`}
                  >
                    <TheaterIcon />
                  </button>
                  <div ref={subtitleMenuRef} className="local-player-subtitle-menu-anchor">
                    <button
                      className={`local-player-toolbar-button local-player-toolbar-button--icon ${
                        hasSubtitleTrack && isCaptionsEnabled ? "local-player-toolbar-button--active" : ""
                      }`}
                      type="button"
                      onClick={() => {
                        onRevealControls();
                        onClosedCaptionsAction();
                      }}
                      aria-label={hasSubtitleTrack ? "Subtitle options" : "Upload subtitles"}
                      aria-expanded={hasSubtitleTrack ? isSubtitleMenuOpen : undefined}
                      aria-haspopup={hasSubtitleTrack ? "menu" : undefined}
                      title={subtitleButtonTitle}
                    >
                      <ClosedCaptionsIcon />
                    </button>
                    {hasSubtitleTrack && isSubtitleMenuOpen ? (
                      <div className="local-player-subtitle-menu" role="menu" aria-label="Subtitle options">
                        <button
                          className="local-player-subtitle-menu-item"
                          type="button"
                          role="menuitem"
                          onClick={onReplaceSubtitles}
                        >
                          <ReplaceSubtitlesIcon />
                          <span>Replace subtitles</span>
                        </button>
                        <button
                          className="local-player-subtitle-menu-item"
                          type="button"
                          role="menuitem"
                          onClick={onToggleCaptions}
                        >
                          <ToggleSubtitlesIcon isHiddenAction={isCaptionsEnabled} />
                          <span>{isCaptionsEnabled ? "Hide subtitles" : "Show subtitles"}</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <button
                    className="local-player-toolbar-button local-player-toolbar-button--icon"
                    type="button"
                    onClick={() => {
                      onRevealControls();
                      void onToggleFullscreen();
                    }}
                    aria-label={isFullscreenMode ? "Exit fullscreen" : "Enter fullscreen"}
                    title={`${isFullscreenMode ? "Exit fullscreen" : "Enter fullscreen"} (F)`}
                  >
                    <ExpandIcon />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M8 6.2v11.6c0 .63.7 1.01 1.23.67l9.18-5.8a.8.8 0 0 0 0-1.34L9.23 5.53A.8.8 0 0 0 8 6.2Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M7 5.5A1.5 1.5 0 0 1 8.5 4h1A1.5 1.5 0 0 1 11 5.5v13A1.5 1.5 0 0 1 9.5 20h-1A1.5 1.5 0 0 1 7 18.5v-13Zm6 0A1.5 1.5 0 0 1 14.5 4h1A1.5 1.5 0 0 1 17 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-1A1.5 1.5 0 0 1 13 18.5v-13Z" />
    </svg>
  );
}

function Seek10Icon({ mirrored = false }: { mirrored?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={mirrored ? { transform: "scaleX(-1)" } : undefined}
    >
      <path
        d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 3v5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function VolumeHighIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M4 10.5A1.5 1.5 0 0 1 5.5 9H8l4.47-3.58A1 1 0 0 1 14 6.2v11.6a1 1 0 0 1-1.53.78L8 15H5.5A1.5 1.5 0 0 1 4 13.5v-3Zm13.34-2.74a.75.75 0 0 1 1.06-.05 6 6 0 0 1 0 8.58.75.75 0 1 1-1.1-1.02 4.5 4.5 0 0 0 0-6.54.75.75 0 0 1 .04-1.07Zm-2.42 1.92a.75.75 0 0 1 1.06.06 3 3 0 0 1 0 4.52.75.75 0 1 1-1.12-1 1.5 1.5 0 0 0 0-2.52.75.75 0 0 1 .06-1.06Z"
      />
    </svg>
  );
}

function VolumeMutedIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M4 10.5A1.5 1.5 0 0 1 5.5 9H8l4.47-3.58A1 1 0 0 1 14 6.2v11.6a1 1 0 0 1-1.53.78L8 15H5.5A1.5 1.5 0 0 1 4 13.5v-3Zm11.03-.97a.75.75 0 0 1 1.06 0L18 11.44l1.91-1.9a.75.75 0 1 1 1.06 1.06l-1.9 1.9 1.9 1.91a.75.75 0 1 1-1.06 1.06L18 13.56l-1.9 1.91a.75.75 0 1 1-1.07-1.06l1.91-1.9-1.91-1.91a.75.75 0 0 1 0-1.06Z"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M11.25 4.75a.75.75 0 0 1 1.5 0v8.69l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V4.75ZM5.75 17a.75.75 0 0 1 .75.75v.75h11v-.75a.75.75 0 0 1 1.5 0v1.5a.75.75 0 0 1-.75.75H5.75a.75.75 0 0 1-.75-.75v-1.5a.75.75 0 0 1 .75-.75Z"
      />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M6.75 4A2.75 2.75 0 0 0 4 6.75v2.5a.75.75 0 0 0 1.5 0v-2.5c0-.69.56-1.25 1.25-1.25h2.5a.75.75 0 0 0 0-1.5h-2.5Zm8 0a.75.75 0 0 0 0 1.5h2.5c.69 0 1.25.56 1.25 1.25v2.5a.75.75 0 0 0 1.5 0v-2.5A2.75 2.75 0 0 0 17.25 4h-2.5Zm4.5 10a.75.75 0 0 0-.75.75v2.5c0 .69-.56 1.25-1.25 1.25h-2.5a.75.75 0 0 0 0 1.5h2.5A2.75 2.75 0 0 0 20 17.25v-2.5a.75.75 0 0 0-.75-.75Zm-14.5 0a.75.75 0 0 0-.75.75v2.5A2.75 2.75 0 0 0 6.75 20h2.5a.75.75 0 0 0 0-1.5h-2.5c-.69 0-1.25-.56-1.25-1.25v-2.5a.75.75 0 0 0-.75-.75Z"
      />
    </svg>
  );
}

function ClosedCaptionsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="2" y="5" width="20" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text x="12.75" y="12" textAnchor="middle" dominantBaseline="central" fill="currentColor" stroke="currentColor" strokeWidth="0.6" fontSize="9.5" fontWeight="900" fontFamily="sans-serif" letterSpacing="1.5">CC</text>
    </svg>
  );
}

function ReplaceSubtitlesIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M7 5.5h7.35l-1.57-1.57a.75.75 0 0 1 1.06-1.06l2.85 2.85a.75.75 0 0 1 0 1.06l-2.85 2.85a.75.75 0 0 1-1.06-1.06L14.35 7H7a2.5 2.5 0 0 0-2.5 2.5v.75a.75.75 0 0 1-1.5 0V9.5A4 4 0 0 1 7 5.5Zm10.25 2.75A3.75 3.75 0 0 1 21 12v2.5a4 4 0 0 1-4 4H9.65l1.57 1.57a.75.75 0 1 1-1.06 1.06l-2.85-2.85a.75.75 0 0 1 0-1.06l2.85-2.85a.75.75 0 1 1 1.06 1.06L9.65 17H17a2.5 2.5 0 0 0 2.5-2.5V12a2.25 2.25 0 0 0-2.25-2.25h-.25a.75.75 0 0 1 0-1.5h.25Z"
      />
    </svg>
  );
}

function ToggleSubtitlesIcon({ isHiddenAction }: { isHiddenAction: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="2.75" y="5.75" width="18.5" height="12.5" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <text
        x="12.75"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.35"
        fontSize="9"
        fontWeight="900"
        fontFamily="sans-serif"
        letterSpacing="1.2"
      >
        CC
      </text>
      {isHiddenAction ? (
        <path
          d="M4.5 19.5 19.5 4.5"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.8"
        />
      ) : null}
    </svg>
  );
}

function TheaterIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M5.75 5A2.75 2.75 0 0 0 3 7.75v8.5A2.75 2.75 0 0 0 5.75 19h12.5A2.75 2.75 0 0 0 21 16.25v-8.5A2.75 2.75 0 0 0 18.25 5H5.75Zm0 1.5h12.5c.69 0 1.25.56 1.25 1.25v1.75H4.5V7.75c0-.69.56-1.25 1.25-1.25Zm-1.25 4.5H10v6.5H5.75c-.69 0-1.25-.56-1.25-1.25V11Zm7 0h8v5.25c0 .69-.56 1.25-1.25 1.25H11.5V11Z"
      />
    </svg>
  );
}

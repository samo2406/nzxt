/**
 * The contract the real Spotify poller and the mock player both satisfy, so
 * the whole music screen can be built and profiled without an account.
 */

export interface NowPlaying {
  /** Stable per track; a change means new artwork and a re-parked tonearm. */
  id: string;
  title: string;
  /** Artist names joined, or the show name for a podcast episode. */
  artist: string;
  artUrl: string | null;
  durationMs: number;
  progressMs: number;
  isPlaying: boolean;
  isEpisode: boolean;
  /** When `progressMs` was true, used to interpolate between polls. */
  sampledAt: number;
  /**
   * Position jumped further than playback alone explains. The renderer snaps
   * instead of tweening, otherwise a seek crawls over a whole poll interval.
   */
  seeked: boolean;
}

/** What it takes to look a track up elsewhere (lyrics). */
export type TrackInfo = Pick<NowPlaying, 'id' | 'title' | 'artist' | 'durationMs' | 'isEpisode'>;

export type PollResult =
  | { kind: 'track'; now: NowPlaying }
  /** Authoritative: nothing is loaded in the player. */
  | { kind: 'idle' }
  /** Authoritative: there is no usable authorisation any more. */
  | { kind: 'unauthorized' }
  /** Transport failure — the caller must hold its current state. */
  | { kind: 'error'; reason: string };

export interface PlayerSource {
  start(): void;
  stop(): void;
  onResult(fn: (result: PollResult) => void): () => void;
  /** The track after this one in the queue, when the source knows it. */
  upNext?(): Promise<TrackInfo | null>;
}

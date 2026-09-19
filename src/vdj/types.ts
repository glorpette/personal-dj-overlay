export interface DeckInfo {
  deck: number;
  artist: string;
  title: string;
  artistTitle: string;
  album: string;
  bpm: number | null;
  key: string;
  remix: string;
  playing: boolean;
  audible: boolean;
  elapsedMs: number | null;
  lengthSec: number | null;
  filepath: string;
  hasCover: boolean;
  coverUrl: string;
}

export interface NowPlayingState {
  connected: boolean;
  source: "http" | "history" | "none";
  deck1: DeckInfo;
  deck2: DeckInfo;
  deck3?: DeckInfo;
  deck4?: DeckInfo;
  onAirDeck: number | null;
  masterTitle: string;
  updatedAt: string;
  lastError?: string;
}

export function emptyDeck(n: number): DeckInfo {
  return {
    deck: n,
    artist: "",
    title: "",
    artistTitle: "",
    album: "",
    bpm: null,
    key: "",
    remix: "",
    playing: false,
    audible: false,
    elapsedMs: null,
    lengthSec: null,
    filepath: "",
    hasCover: false,
    coverUrl: "",
  };
}

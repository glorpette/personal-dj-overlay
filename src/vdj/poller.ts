import type { AppConfig } from "../config.ts";
import { log } from "../logger.ts";
import { VdjClient, queryDeck, queryMaster } from "./client.ts";
import { readHistoryFallback } from "./history.ts";
import { emptyDeck, type NowPlayingState } from "./types.ts";
import { AtomicWriter } from "./writer.ts";
import { ensureCover } from "./covers.ts";
import { resolveAppPath } from "../runtime/paths.ts";

export class VdjPoller {
  private cfg: AppConfig;
  private client: VdjClient;
  private writer: AtomicWriter;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastJson = "";
  private lastWrite = 0;
  private failStreak = 0;
  private state: NowPlayingState;
  private listeners = new Set<(s: NowPlayingState) => void>();

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    this.client = new VdjClient(cfg.vdj.host, cfg.vdj.port, cfg.vdj.bearer);
    this.writer = new AtomicWriter(cfg.nowPlaying.txtPath, cfg.nowPlaying.jsonPath);
    this.state = {
      connected: false,
      source: "none",
      deck1: emptyDeck(1),
      deck2: emptyDeck(2),
      onAirDeck: null,
      masterTitle: "",
      updatedAt: new Date().toISOString(),
    };
  }

  onUpdate(fn: (s: NowPlayingState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getState(): NowPlayingState {
    return this.state;
  }

  configure(cfg: AppConfig): void {
    this.cfg = cfg;
    this.client.configure(cfg.vdj.host, cfg.vdj.port, cfg.vdj.bearer);
    this.writer.configure(cfg.nowPlaying.txtPath, cfg.nowPlaying.jsonPath);
  }

  start(): void {
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    try {
      await this.pollHttp();
      this.failStreak = 0;
      this.schedule(this.cfg.vdj.pollIntervalMs);
    } catch (err) {
      this.failStreak++;
      const wait = Math.min(15_000, 500 * 2 ** Math.min(this.failStreak, 5));
      const message = err instanceof Error ? err.message : String(err);
      if (this.failStreak === 1 || this.failStreak % 8 === 0) {
        log.warn("VDJ HTTP poll failed", { message, failStreak: this.failStreak, nextMs: wait });
      }
      this.applyDisconnected(message);
      this.schedule(wait);
    }
  }

  private async pollHttp(): Promise<void> {
    const decks = this.cfg.vdj.decks.length ? this.cfg.vdj.decks : [1, 2];
    const results = await Promise.all(decks.map((d) => queryDeck(this.client, d)));
    const masterTitle = await queryMaster(this.client);
    const byDeck = new Map(results.map((d) => [d.deck, d]));
    const deck1 = byDeck.get(1) ?? emptyDeck(1);
    const deck2 = byDeck.get(2) ?? emptyDeck(2);

    let onAir: number | null = null;
    const audible = results.filter((d) => d.audible).map((d) => d.deck);
    if (audible.length === 1) onAir = audible[0];
    else if (audible.length > 1) {
      onAir = audible.includes(2) && deck2.playing ? 2 : audible[0];
    }

    const next: NowPlayingState = {
      connected: true,
      source: "http",
      deck1,
      deck2,
      onAirDeck: onAir,
      masterTitle: masterTitle || (onAir === 2 ? deck2.artistTitle : deck1.artistTitle),
      updatedAt: new Date().toISOString(),
    };
    if (byDeck.has(3)) next.deck3 = byDeck.get(3);
    if (byDeck.has(4)) next.deck4 = byDeck.get(4);
    if (deck1.filepath) ensureCover(1, deck1.filepath);
    if (deck2.filepath) ensureCover(2, deck2.filepath);
    this.commit(next);
  }

  private applyDisconnected(message: string): void {
    if (this.cfg.vdj.historyFallback) {
      const hist = readHistoryFallback(this.cfg.vdj.historyDir ? resolveAppPath(this.cfg.vdj.historyDir) : "");
      if (hist) {
        hist.deck1 = this.state.deck1.artistTitle ? this.state.deck1 : hist.deck1;
        hist.deck2 = this.state.deck2;
        hist.lastError = message;
        this.commit(hist, true);
        return;
      }
    }
    this.commit(
      {
        ...this.state,
        connected: false,
        source: this.state.source === "http" ? "none" : this.state.source,
        updatedAt: new Date().toISOString(),
        lastError: message,
      },
      true,
    );
  }

  private commit(next: NowPlayingState, forceHeartbeat = false): void {
    const comparable = { ...next, updatedAt: "" };
    const json = JSON.stringify(comparable);
    const now = Date.now();
    const heartbeat = now - this.lastWrite >= this.cfg.nowPlaying.heartbeatMs;
    if (json === this.lastJson && !heartbeat && !forceHeartbeat) {
      this.state = next;
      return;
    }
    this.lastJson = json;
    this.lastWrite = now;
    this.state = next;
    try {
      this.writer.write(next);
    } catch (err) {
      log.error("Failed atomic now-playing write", err);
    }
    for (const fn of this.listeners) fn(next);
  }
}

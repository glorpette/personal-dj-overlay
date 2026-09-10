import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NowPlayingState } from "./types.ts";
import { resolveAppPath } from "../runtime/paths.ts";

export function formatTxt(state: NowPlayingState): string {
  const d1 = state.deck1.artistTitle || blank(state.deck1);
  const d2 = state.deck2.artistTitle || blank(state.deck2);
  const lines = [
    `DECK1=${d1}`,
    `DECK2=${d2}`,
    `ONAIR=${state.onAirDeck ?? ""}`,
    `MASTER=${state.masterTitle}`,
    `CONNECTED=${state.connected ? "1" : "0"}`,
    `SOURCE=${state.source}`,
    `UPDATED=${state.updatedAt}`,
  ];
  if (state.deck3) lines.splice(2, 0, `DECK3=${state.deck3.artistTitle || blank(state.deck3)}`);
  if (state.deck4) lines.splice(state.deck3 ? 3 : 2, 0, `DECK4=${state.deck4.artistTitle || blank(state.deck4)}`);
  return lines.join("\n") + "\n";
}

function blank(d: { artist: string; title: string }): string {
  return [d.artist, d.title].filter(Boolean).join(" - ");
}

export class AtomicWriter {
  private txtPath = "";
  private jsonPath = "";
  constructor(txtPath: string, jsonPath: string) {
    this.configure(txtPath, jsonPath);
  }

  configure(txtPath: string, jsonPath: string): void {
    this.txtPath = resolveAppPath(txtPath);
    this.jsonPath = resolveAppPath(jsonPath);
  }

  write(state: NowPlayingState): void {
    const txt = formatTxt(state);
    const json = JSON.stringify(state, null, 2) + "\n";
    atomicWrite(this.txtPath, txt);
    atomicWrite(this.jsonPath, json);
  }
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, path);
}

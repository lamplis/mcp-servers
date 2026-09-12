export type IndexingPhase = "idle" | "running";

export interface IndexingState {
  indexing: IndexingPhase;
  lastRun: string | null;
  lastError: string | null;
}

const state: IndexingState = {
  indexing: "idle",
  lastRun: null,
  lastError: null,
};

export function getIndexingState(): IndexingState {
  return { ...state };
}

export function setIndexingRunning(): void {
  state.indexing = "running";
  state.lastError = null;
}

export function setIndexingIdle(error?: string): void {
  state.indexing = "idle";
  state.lastRun = new Date().toISOString();
  state.lastError = error ?? null;
}

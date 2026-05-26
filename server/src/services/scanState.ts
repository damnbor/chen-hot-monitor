import { randomUUID } from 'crypto';

export type ScanRunStatus = 'idle' | 'running' | 'paused' | 'completed';

export interface HotspotScanState {
  status: ScanRunStatus;
  manual: boolean;
  pauseRequested: boolean;
  manualBatchId: string | null;
  currentKeyword: string | null;
  keywordsTotal: number;
  keywordsProcessed: number;
  newHotspotsFound: number;
  startedAt: string | null;
  finishedAt: string | null;
}

const idleState = (): HotspotScanState => ({
  status: 'idle',
  manual: false,
  pauseRequested: false,
  manualBatchId: null,
  currentKeyword: null,
  keywordsTotal: 0,
  keywordsProcessed: 0,
  newHotspotsFound: 0,
  startedAt: null,
  finishedAt: null,
});

let state: HotspotScanState = idleState();
let isLocked = false;

export function getScanState(): HotspotScanState {
  return { ...state };
}

export function getManualBatchId(): string | null {
  return state.manualBatchId;
}

function beginScan(manual: boolean): boolean {
  if (isLocked) return false;
  isLocked = true;
  state = {
    ...idleState(),
    status: 'running',
    manual,
    manualBatchId: manual ? randomUUID() : null,
    startedAt: new Date().toISOString(),
  };
  return true;
}

export function beginManualScan(): boolean {
  return beginScan(true);
}

export function beginScheduledScan(): boolean {
  return beginScan(false);
}

export function requestPause(): boolean {
  if (state.status !== 'running' || !state.manual) return false;
  state.pauseRequested = true;
  return true;
}

export function shouldAbortManualScan(): boolean {
  return state.status === 'running' && state.manual && state.pauseRequested;
}

export function updateScanProgress(partial: {
  currentKeyword?: string | null;
  keywordsTotal?: number;
  keywordsProcessed?: number;
  newHotspotsFound?: number;
}): void {
  if (partial.currentKeyword !== undefined) state.currentKeyword = partial.currentKeyword;
  if (partial.keywordsTotal !== undefined) state.keywordsTotal = partial.keywordsTotal;
  if (partial.keywordsProcessed !== undefined) state.keywordsProcessed = partial.keywordsProcessed;
  if (partial.newHotspotsFound !== undefined) state.newHotspotsFound = partial.newHotspotsFound;
}

export function finishScan(options: {
  paused: boolean;
  newHotspotsFound: number;
  keywordsProcessed: number;
}): void {
  state.newHotspotsFound = options.newHotspotsFound;
  state.keywordsProcessed = options.keywordsProcessed;
  state.status = options.paused ? 'paused' : 'completed';
  state.pauseRequested = false;
  state.currentKeyword = null;
  state.finishedAt = new Date().toISOString();
  isLocked = false;
}

export function abortScanOnError(): void {
  state.status = 'idle';
  state.pauseRequested = false;
  state.currentKeyword = null;
  state.finishedAt = new Date().toISOString();
  isLocked = false;
}

/** @internal testing */
export function resetScanStateForTests(): void {
  state = idleState();
  isLocked = false;
}

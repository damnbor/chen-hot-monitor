import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginManualScan,
  beginScheduledScan,
  requestPause,
  shouldAbortManualScan,
  updateScanProgress,
  finishScan,
  getScanState,
  resetScanStateForTests,
} from '../services/scanState.js';

describe('scanState', () => {
  beforeEach(() => {
    resetScanStateForTests();
  });

  it('beginManualScan locks state to running manual scan', () => {
    expect(beginManualScan()).toBe(true);
    expect(getScanState()).toMatchObject({
      status: 'running',
      manual: true,
      pauseRequested: false,
    });
  });

  it('rejects concurrent manual scan', () => {
    expect(beginManualScan()).toBe(true);
    expect(beginManualScan()).toBe(false);
  });

  it('scheduled scan is skipped while manual scan runs', () => {
    beginManualScan();
    expect(beginScheduledScan()).toBe(false);
  });

  it('requestPause only works for manual running scan', () => {
    beginManualScan();
    expect(requestPause()).toBe(true);
    expect(shouldAbortManualScan()).toBe(true);
    expect(getScanState().pauseRequested).toBe(true);
  });

  it('finishScan clears lock and marks paused/completed', () => {
    beginManualScan();
    updateScanProgress({
      currentKeyword: 'AI',
      keywordsTotal: 2,
      keywordsProcessed: 1,
      newHotspotsFound: 3,
    });
    finishScan({ paused: true, newHotspotsFound: 3, keywordsProcessed: 1 });

    expect(getScanState()).toMatchObject({
      status: 'paused',
      manual: true,
      pauseRequested: false,
      newHotspotsFound: 3,
      keywordsProcessed: 1,
      currentKeyword: null,
    });
    expect(beginManualScan()).toBe(true);
  });
});

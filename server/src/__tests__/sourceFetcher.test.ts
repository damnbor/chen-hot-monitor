import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  detectAndFetchAccount: vi.fn(),
  expandKeyword: vi.fn(),
  searchTwitter: vi.fn(),
  searchBing: vi.fn(),
  searchHackerNews: vi.fn(),
  searchSogou: vi.fn(),
  searchBilibili: vi.fn(),
  searchWeibo: vi.fn(),
}));

vi.mock('../services/chinaSearch.js', () => ({
  detectAndFetchAccount: mocks.detectAndFetchAccount,
  searchSogou: mocks.searchSogou,
  searchBilibili: mocks.searchBilibili,
  searchWeibo: mocks.searchWeibo,
}));

vi.mock('../services/ai.js', () => ({
  expandKeyword: mocks.expandKeyword,
}));

vi.mock('../services/twitter.js', () => ({
  searchTwitter: mocks.searchTwitter,
}));

vi.mock('../services/search.js', () => ({
  searchBing: mocks.searchBing,
  searchHackerNews: mocks.searchHackerNews,
}));

import {
  fetchMonitorSources,
  gatherKeywordSearchContext,
} from '../services/sourceFetcher.js';

function delay(ms: number, value: unknown = []) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('fetchMonitorSources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchTwitter.mockImplementation(() => delay(50, [{ title: 't', source: 'twitter' }]));
    mocks.searchBing.mockImplementation(() => delay(30, [{ title: 'b', source: 'bing' }]));
    mocks.searchHackerNews.mockImplementation(() => delay(20, []));
    mocks.searchSogou.mockImplementation(() => delay(10, []));
    mocks.searchBilibili.mockImplementation(() => delay(10, []));
    mocks.searchWeibo.mockImplementation(() => delay(10, []));
  });

  it('runs all sources in parallel (wall time < sum)', async () => {
    const start = Date.now();
    const result = await fetchMonitorSources('test', { timeoutMs: 5000 });
    const wall = Date.now() - start;

    expect(wall).toBeLessThan(120); // 50+30+... serial would be >100
    expect(result.completedSources).toContain('Twitter');
    expect(result.completedSources).toContain('Bing');
    expect(result.results.length).toBeGreaterThanOrEqual(2);
    expect(mocks.searchTwitter).toHaveBeenCalledOnce();
    expect(mocks.searchBing).toHaveBeenCalledOnce();
  });

  it('isolates single source failure', async () => {
    mocks.searchTwitter.mockRejectedValue(new Error('api down'));

    const result = await fetchMonitorSources('test', { timeoutMs: 5000 });

    expect(result.failedSources).toContain('Twitter');
    expect(result.completedSources).toContain('Bing');
  });
});

describe('gatherKeywordSearchContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectAndFetchAccount.mockImplementation(() =>
      delay(80, { accounts: [], results: [] })
    );
    mocks.expandKeyword.mockImplementation(() => delay(60, ['kw', 'kw2']));
    mocks.searchTwitter.mockImplementation(() => delay(100, [{ title: 't', source: 'twitter' }]));
    mocks.searchBing.mockImplementation(() => delay(10, []));
    mocks.searchHackerNews.mockImplementation(() => delay(10, []));
    mocks.searchSogou.mockImplementation(() => delay(10, []));
    mocks.searchBilibili.mockImplementation(() => delay(10, []));
    mocks.searchWeibo.mockImplementation(() => delay(10, []));
  });

  it('parallelizes account, expand, and sources', async () => {
    const start = Date.now();
    const result = await gatherKeywordSearchContext('Agentic');
    const wall = Date.now() - start;

    // serial would be 80+60+100 = 240ms+
    expect(wall).toBeLessThan(200);
    expect(result.expandedKeywords).toEqual(['kw', 'kw2']);
    expect(result.timings.accountMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.expandMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.sourcesMs).toBeGreaterThanOrEqual(0);
    expect(mocks.detectAndFetchAccount).toHaveBeenCalledWith('Agentic');
    expect(mocks.expandKeyword).toHaveBeenCalledWith('Agentic');
  });
});

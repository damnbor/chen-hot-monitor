import { searchTwitter } from './twitter.js';
import { searchBing, searchHackerNews } from './search.js';
import {
  searchSogou,
  searchBilibili,
  searchWeibo,
  detectAndFetchAccount,
  type AccountInfo,
} from './chinaSearch.js';
import { expandKeyword } from './ai.js';
import type { SearchResult } from '../types.js';

/** 与 searchOrchestrator 单源超时对齐 */
export const MONITOR_SOURCE_FETCH_TIMEOUT_MS = 25_000;

export interface MonitorSourceFetchResult {
  results: SearchResult[];
  completedSources: string[];
  failedSources: string[];
  /** 各源成功返回的条数 */
  sourceCounts: Record<string, number>;
  durationMs: number;
}

export interface KeywordGatherResult {
  accountResult: {
    accounts: AccountInfo[];
    results: SearchResult[];
  };
  expandedKeywords: string[];
  sourceFetch: MonitorSourceFetchResult;
  durationMs: number;
  timings: {
    accountMs: number;
    expandMs: number;
    sourcesMs: number;
  };
}

type SourceRunner = {
  name: string;
  run: () => Promise<SearchResult[]>;
};

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout`)), ms)
    ),
  ]);
}

/**
 * 监控任务：6 个信息源并行抓取（Promise.allSettled + 单源超时）
 */
export async function fetchMonitorSources(
  query: string,
  options?: { timeoutMs?: number }
): Promise<MonitorSourceFetchResult> {
  const start = Date.now();
  const timeoutMs = options?.timeoutMs ?? MONITOR_SOURCE_FETCH_TIMEOUT_MS;

  const runners: SourceRunner[] = [
    { name: 'Twitter', run: () => searchTwitter(query) },
    { name: 'Bing', run: () => searchBing(query) },
    { name: 'HackerNews', run: () => searchHackerNews(query) },
    { name: 'Sogou', run: () => searchSogou(query) },
    { name: 'Bilibili', run: () => searchBilibili(query) },
    { name: 'Weibo', run: () => searchWeibo(query) },
  ];

  const allResults: SearchResult[] = [];
  const completedSources: string[] = [];
  const failedSources: string[] = [];
  const sourceCounts: Record<string, number> = {};

  await Promise.allSettled(
    runners.map(async ({ name, run }) => {
      try {
        const results = await withTimeout(run(), timeoutMs, name);
        if (results.length > 0) {
          allResults.push(...results);
          completedSources.push(name);
          sourceCounts[name] = results.length;
        } else {
          failedSources.push(name);
        }
      } catch (error) {
        failedSources.push(name);
        const reason = error instanceof Error ? error.message : String(error);
        console.log(`  ${name}: failed - ${reason}`);
      }
    })
  );

  return {
    results: allResults,
    completedSources,
    failedSources,
    sourceCounts,
    durationMs: Date.now() - start,
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
}

/**
 * 阶段 1 优化：账号检测、关键词扩展、多源抓取并行执行
 */
export async function gatherKeywordSearchContext(
  keyword: string
): Promise<KeywordGatherResult> {
  const wallStart = Date.now();

  const [accountTimed, expandTimed, sourcesTimed] = await Promise.all([
    timed(() => detectAndFetchAccount(keyword)),
    timed(() => expandKeyword(keyword)),
    timed(() => fetchMonitorSources(keyword)),
  ]);

  const durationMs = Date.now() - wallStart;

  console.log(
    `  ⚡ Parallel gather (${durationMs}ms wall): account ${accountTimed.ms}ms, expand ${expandTimed.ms}ms, sources ${sourcesTimed.ms}ms`
  );

  return {
    accountResult: accountTimed.value,
    expandedKeywords: expandTimed.value,
    sourceFetch: sourcesTimed.value,
    durationMs,
    timings: {
      accountMs: accountTimed.ms,
      expandMs: expandTimed.ms,
      sourcesMs: sourcesTimed.ms,
    },
  };
}

import { searchTwitter } from './twitter.js';
import { searchBing, searchHackerNews, deduplicateResults } from './search.js';
import { searchSogou } from './chinaSearch.js';
import { analyzeContent, preMatchKeyword } from './ai.js';
import { IMPORTANCE_ORDER, calcHotScore } from '../utils/sortHotspots.js';
import type { SearchResult, AIAnalysis } from '../types.js';

/** 搜索总超时 60s，不做内部硬截止，留足 AI 分析时间 */
export const SEARCH_TIMEOUT_MS = 60_000;
export const SOURCE_FETCH_TIMEOUT_MS = 25_000;

export const FETCH_PER_SOURCE = 3;
export const RESULTS_PER_SOURCE = 1;
export const MAX_RETURN = 4;
export const HIGH_RELEVANCE_THRESHOLD = 65;
export const LOW_RELEVANCE_THRESHOLD = 40;

const SOURCE_PRIORITY: Record<string, number> = {
  twitter: 1,
  hackernews: 2,
  sogou: 3,
  bing: 4
};

/** 全网搜索：每源 1 条结果，共最多 4 条 */
const WEB_SEARCH_SOURCES = ['bing', 'hackernews', 'sogou', 'twitter'] as const;

export type SourceId = (typeof WEB_SEARCH_SOURCES)[number];

export interface AnalyzedSearchItem {
  id: string;
  title: string;
  content: string;
  url: string;
  source: string;
  sourceId: string | null;
  isReal: boolean;
  relevance: number;
  relevanceReason: string | null;
  keywordMentioned: boolean | null;
  importance: 'low' | 'medium' | 'high' | 'urgent';
  summary: string | null;
  viewCount: number | null;
  likeCount: number | null;
  retweetCount: number | null;
  replyCount: number | null;
  commentCount: number | null;
  quoteCount: number | null;
  danmakuCount: number | null;
  authorName: string | null;
  authorUsername: string | null;
  authorAvatar: string | null;
  authorFollowers: number | null;
  authorVerified: boolean | null;
  publishedAt: string | null;
  createdAt: string;
  keyword: null;
  analyzed: boolean;
  sortScore: number;
}

export interface WebSearchMeta {
  totalFetched: number;
  totalUnique: number;
  totalAnalyzed: number;
  highQualityCount: number;
  timedOut: boolean;
  completedSources: string[];
  failedSources: string[];
  lowRelevanceCount: number;
  durationMs: number;
}

export interface WebSearchResponse {
  query: string;
  results: AnalyzedSearchItem[];
  meta: WebSearchMeta;
}

function buildQueryTerms(query: string): string[] {
  const terms = [query];
  const parts = query.split(/[\s\-_\/\\·]+/).filter(p => p.length >= 2);
  if (parts.length > 1) {
    terms.push(...parts);
  }
  return [...new Set(terms)];
}

function scoreCandidate(item: SearchResult, queryTerms: string[]): number {
  const text = `${item.title}\n${item.content}`;
  const preMatch = preMatchKeyword(text, queryTerms);
  let score = preMatch.matched ? 100 : 0;
  score += (item.score ?? 0) * 2;
  score += (item.likeCount ?? 0) / 100;
  score += (item.viewCount ?? 0) / 1000;
  score -= (SOURCE_PRIORITY[item.source] ?? 99);
  return score;
}

function rankCandidates(items: SearchResult[], queryTerms: string[]): SearchResult[] {
  return [...items].sort(
    (a, b) => scoreCandidate(b, queryTerms) - scoreCandidate(a, queryTerms)
  );
}

/** 每个来源只保留预筛后的最佳 1 条 */
function pickOnePerSource(items: SearchResult[], queryTerms: string[]): SearchResult[] {
  const bySource = new Map<string, SearchResult[]>();
  for (const item of items) {
    const list = bySource.get(item.source) ?? [];
    list.push(item);
    bySource.set(item.source, list);
  }

  const picked: SearchResult[] = [];
  for (const list of bySource.values()) {
    const best = rankCandidates(list, queryTerms)[0];
    if (best) picked.push(best);
  }
  return rankCandidates(picked, queryTerms);
}

function calcSortScore(item: AnalyzedSearchItem): number {
  const importanceBonus = (4 - (IMPORTANCE_ORDER[item.importance] ?? 4)) * 12;
  const sourceBonus = (9 - (SOURCE_PRIORITY[item.source] ?? 9)) * 3;
  const hotBonus = Math.min(15, calcHotScore(item) / 10);
  return item.relevance * 0.8 + importanceBonus + sourceBonus + hotBonus;
}

function fallbackAnalysis(item: SearchResult, queryTerms: string[]): AIAnalysis {
  const preMatch = preMatchKeyword(`${item.title}\n${item.content}`, queryTerms);
  return {
    isReal: true,
    relevance: preMatch.matched ? 55 : 35,
    relevanceReason: 'AI 分析超时，已用关键词预匹配打分',
    keywordMentioned: preMatch.matched,
    importance: 'medium',
    summary: item.title.slice(0, 80)
  };
}

function mapSearchResultToItem(
  item: SearchResult,
  analysis: AIAnalysis,
  analyzed: boolean
): AnalyzedSearchItem {
  const base: AnalyzedSearchItem = {
    id: `${item.source}:${item.url}`,
    title: item.title,
    content: item.content,
    url: item.url,
    source: item.source,
    sourceId: item.sourceId ?? null,
    isReal: analysis.isReal,
    relevance: analysis.relevance,
    relevanceReason: analysis.relevanceReason || null,
    keywordMentioned: analysis.keywordMentioned ?? null,
    importance: analysis.importance,
    summary: analysis.summary || null,
    viewCount: item.viewCount ?? null,
    likeCount: item.likeCount ?? null,
    retweetCount: item.retweetCount ?? null,
    replyCount: item.replyCount ?? null,
    commentCount: item.commentCount ?? null,
    quoteCount: item.quoteCount ?? null,
    danmakuCount: item.danmakuCount ?? null,
    authorName: item.author?.name ?? null,
    authorUsername: item.author?.username ?? null,
    authorAvatar: item.author?.avatar ?? null,
    authorFollowers: item.author?.followers ?? null,
    authorVerified: item.author?.verified ?? null,
    publishedAt: item.publishedAt?.toISOString() ?? null,
    createdAt: new Date().toISOString(),
    keyword: null,
    analyzed,
    sortScore: 0
  };
  base.sortScore = calcSortScore(base);
  return base;
}

async function analyzeItem(
  item: SearchResult,
  query: string,
  queryTerms: string[]
): Promise<AnalyzedSearchItem> {
  const fullText = `${item.title}\n${item.content}`;
  const preMatch = preMatchKeyword(fullText, queryTerms);
  try {
    const analysis = await analyzeContent(fullText, query, preMatch);
    return mapSearchResultToItem(item, analysis, true);
  } catch {
    return mapSearchResultToItem(item, fallbackAnalysis(item, queryTerms), false);
  }
}

type SourceRunner = {
  id: SourceId;
  label: string;
  run: () => Promise<SearchResult[]>;
};

function buildSourceRunners(query: string, sources: SourceId[]): SourceRunner[] {
  const runners: SourceRunner[] = [];

  if (sources.includes('twitter')) {
    runners.push({
      id: 'twitter',
      label: 'Twitter',
      run: () => searchTwitter(query, { lite: true, maxResults: FETCH_PER_SOURCE })
    });
  }
  if (sources.includes('bing')) {
    runners.push({
      id: 'bing',
      label: 'Bing',
      run: async () => (await searchBing(query)).slice(0, FETCH_PER_SOURCE)
    });
  }
  if (sources.includes('hackernews')) {
    runners.push({
      id: 'hackernews',
      label: 'HackerNews',
      run: async () => (await searchHackerNews(query)).slice(0, FETCH_PER_SOURCE)
    });
  }
  if (sources.includes('sogou')) {
    runners.push({
      id: 'sogou',
      label: 'Sogou',
      run: async () => (await searchSogou(query)).slice(0, FETCH_PER_SOURCE)
    });
  }

  return runners;
}

export async function runWebSearch(
  query: string,
  options?: { sources?: SourceId[] }
): Promise<WebSearchResponse> {
  const start = Date.now();
  const deadline = start + SEARCH_TIMEOUT_MS;
  const remainingMs = () => Math.max(0, deadline - Date.now());

  const enabledSources = options?.sources?.length
    ? options.sources.filter(s => WEB_SEARCH_SOURCES.includes(s as SourceId)) as SourceId[]
    : [...WEB_SEARCH_SOURCES];

  const allResults: SearchResult[] = [];
  const completedSources: string[] = [];
  const failedSources: string[] = [];

  const runners = buildSourceRunners(query, enabledSources);

  await Promise.allSettled(
    runners.map(async ({ label, run }) => {
      const timeout = Math.min(SOURCE_FETCH_TIMEOUT_MS, remainingMs());
      if (timeout <= 0) {
        failedSources.push(label);
        return;
      }
      try {
        const results = await Promise.race([
          run(),
          new Promise<SearchResult[]>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timeout`)), timeout)
          )
        ]);
        if (results.length > 0) {
          allResults.push(...results);
          completedSources.push(label);
        } else {
          failedSources.push(label);
        }
      } catch {
        failedSources.push(label);
      }
    })
  );

  const totalFetched = allResults.length;
  const uniqueResults = deduplicateResults(allResults);
  const queryTerms = buildQueryTerms(query);
  const candidates = pickOnePerSource(uniqueResults, queryTerms).slice(0, MAX_RETURN);

  let analyzedItems: AnalyzedSearchItem[] = [];
  if (candidates.length > 0 && remainingMs() > 0) {
    analyzedItems = await Promise.all(
      candidates.map(item => analyzeItem(item, query, queryTerms))
    );
  }

  const results = analyzedItems
    .sort((a, b) => b.sortScore - a.sortScore)
    .slice(0, MAX_RETURN);

  const durationMs = Date.now() - start;
  const lowRelevanceCount = results.filter(r => r.relevance < LOW_RELEVANCE_THRESHOLD).length;
  const timedOut = durationMs >= SEARCH_TIMEOUT_MS;

  return {
    query,
    results,
    meta: {
      totalFetched,
      totalUnique: uniqueResults.length,
      totalAnalyzed: results.filter(r => r.analyzed).length,
      highQualityCount: results.filter(r => r.relevance >= HIGH_RELEVANCE_THRESHOLD).length,
      timedOut,
      completedSources,
      failedSources,
      lowRelevanceCount,
      durationMs
    }
  };
}

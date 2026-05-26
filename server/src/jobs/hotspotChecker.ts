import { Server } from 'socket.io';
import { prisma } from '../db.js';
import { deduplicateResults } from '../services/search.js';
import { analyzeContent, preMatchKeyword } from '../services/ai.js';
import { gatherKeywordSearchContext } from '../services/sourceFetcher.js';
import { enqueueHotspotNotification } from '../services/notificationAggregator.js';
import {
  shouldAbortManualScan,
  updateScanProgress,
  finishScan,
  abortScanOnError,
  getScanState,
} from '../services/scanState.js';
import type { SearchResult } from '../types.js';

export interface HotspotCheckOptions {
  manual?: boolean;
}

export interface HotspotCheckResult {
  paused: boolean;
  newHotspotsCount: number;
  keywordsProcessed: number;
}

// 新鲜度过滤：丢弃超过指定小时数的内容
// Twitter 层面已通过 since: 限制了时间范围，这里只做兜底
const MAX_AGE_HOURS = 7 * 24; // 7天

function filterByFreshness(results: SearchResult[]): SearchResult[] {
  const cutoff = new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000);
  return results.filter(item => {
    // 没有发布时间的，暂时保留（搜索引擎结果通常没有时间）
    if (!item.publishedAt) return true;
    return item.publishedAt >= cutoff;
  });
}

// 按来源优先级排序：Twitter > 微博 > B站/账号内容 > 搜索引擎
function prioritizeResults(results: SearchResult[]): SearchResult[] {
  const priorityMap: Record<string, number> = {
    twitter: 1,
    weibo: 2,
    bilibili: 3,
    hackernews: 4,
    sogou: 5,
    bing: 6,
    google: 7,
    duckduckgo: 8
  };
  return [...results].sort((a, b) => {
    return (priorityMap[a.source] || 99) - (priorityMap[b.source] || 99);
  });
}

export async function runHotspotCheck(
  io: Server,
  options: HotspotCheckOptions = {}
): Promise<HotspotCheckResult> {
  const manual = options.manual ?? false;
  console.log(`🔍 Starting hotspot check${manual ? ' (manual)' : ''}...`);

  let newHotspotsCount = 0;
  let keywordsProcessed = 0;
  let paused = false;

  try {
    const keywords = await prisma.keyword.findMany({
      where: { isActive: true },
    });

    if (keywords.length === 0) {
      console.log('No active keywords to monitor');
      finishScan({ paused: false, newHotspotsFound: 0, keywordsProcessed: 0 });
      return { paused: false, newHotspotsCount: 0, keywordsProcessed: 0 };
    }

    updateScanProgress({ keywordsTotal: keywords.length, keywordsProcessed: 0, newHotspotsFound: 0 });
    console.log(`Checking ${keywords.length} keywords...`);

    for (const keyword of keywords) {
      if (manual && shouldAbortManualScan()) {
        paused = true;
        console.log('⏸ Manual scan paused by user');
        break;
      }

      updateScanProgress({ currentKeyword: keyword.text, keywordsProcessed });
      console.log(`\n📎 Checking keyword: "${keyword.text}"`);

    try {
      // 账号检测 + 关键词扩展 + 6 源抓取并行
      console.log(`  🚀 Gathering account, expansion & sources in parallel...`);
      const { accountResult, expandedKeywords, sourceFetch } =
        await gatherKeywordSearchContext(keyword.text);

      if (accountResult.accounts.length > 0) {
        for (const acc of accountResult.accounts) {
          console.log(`  ✅ Found ${acc.platform} account: ${acc.name} (${acc.followers} followers)`);
        }
      }

      console.log(
        `  📋 Expanded to ${expandedKeywords.length} variants: ${expandedKeywords.slice(0, 5).join(', ')}${expandedKeywords.length > 5 ? '...' : ''}`
      );

      const allResults: SearchResult[] = [];

      if (accountResult.results.length > 0) {
        allResults.push(...accountResult.results);
        console.log(`  AccountFetch: ${accountResult.results.length} results`);
      }

      allResults.push(...sourceFetch.results);
      for (const name of sourceFetch.completedSources) {
        console.log(`  ${name}: ${sourceFetch.sourceCounts[name] ?? 0} results`);
      }
      for (const name of sourceFetch.failedSources) {
        console.log(`  ${name}: failed or empty`);
      }

      // 去重 → 新鲜度过滤 → 按来源优先级排序
      const uniqueResults = deduplicateResults(allResults);
      const freshResults = filterByFreshness(uniqueResults);
      const sortedResults = prioritizeResults(freshResults);
      console.log(`  Total: ${allResults.length} raw → ${uniqueResults.length} unique → ${freshResults.length} fresh (within ${MAX_AGE_HOURS}h)`);

      if (manual && shouldAbortManualScan()) {
        paused = true;
        console.log('⏸ Manual scan paused by user');
        break;
      }

      // 处理结果：Twitter 优先多给配额
      // Twitter 最多处理 15 条，其他来源共享 10 条配额
      let twitterProcessed = 0;
      let otherProcessed = 0;
      const TWITTER_QUOTA = 15;
      const OTHER_QUOTA = 10;

      for (const item of sortedResults) {
        if (manual && shouldAbortManualScan()) {
          paused = true;
          console.log('⏸ Manual scan paused by user');
          break;
        }

        // 检查配额
        if (item.source === 'twitter' && twitterProcessed >= TWITTER_QUOTA) continue;
        if (item.source !== 'twitter' && otherProcessed >= OTHER_QUOTA) continue;
        if (twitterProcessed + otherProcessed >= TWITTER_QUOTA + OTHER_QUOTA) break;
        try {
          // 检查是否已存在
          const existing = await prisma.hotspot.findFirst({
            where: {
              url: item.url,
              source: item.source
            }
          });

          if (existing) {
            continue;
          }

          // AI 分析（传入关键词和预匹配结果）
          const fullText = item.title + '\n' + item.content;
          const preMatch = preMatchKeyword(fullText, expandedKeywords);
          const analysis = await analyzeContent(fullText, keyword.text, preMatch);

          // 只保存真实且相关的热点
          if (!analysis.isReal) {
            console.log(`  ❌ Filtered fake/spam: ${item.title.slice(0, 30)}...`);
            continue;
          }

          // 相关性阈值：50 分以下过滤
          if (analysis.relevance < 50) {
            console.log(`  ⏭ Low relevance (${analysis.relevance}): ${item.title.slice(0, 30)}...`);
            continue;
          }

          // 额外规则：关键词未被提及且相关性不足 65 → 过滤
          if (!analysis.keywordMentioned && analysis.relevance < 65) {
            console.log(`  ⏭ Keyword not mentioned & relevance < 65 (${analysis.relevance}): ${item.title.slice(0, 30)}...`);
            continue;
          }

          // 保存热点
          const hotspot = await prisma.hotspot.create({
            data: {
              title: item.title,
              content: item.content,
              url: item.url,
              source: item.source,
              sourceId: item.sourceId || null,
              isReal: analysis.isReal,
              relevance: analysis.relevance,
              relevanceReason: analysis.relevanceReason || null,
              keywordMentioned: analysis.keywordMentioned ?? null,
              importance: analysis.importance,
              summary: analysis.summary,
              viewCount: item.viewCount || null,
              likeCount: item.likeCount || null,
              retweetCount: item.retweetCount || null,
              replyCount: item.replyCount || null,
              commentCount: item.commentCount || null,
              quoteCount: item.quoteCount || null,
              danmakuCount: item.danmakuCount || null,
              authorName: item.author?.name || null,
              authorUsername: item.author?.username || null,
              authorAvatar: item.author?.avatar || null,
              authorFollowers: item.author?.followers || null,
              authorVerified: item.author?.verified ?? null,
              publishedAt: item.publishedAt || null,
              keywordId: keyword.id
            },
            include: {
              keyword: true
            }
          });

          newHotspotsCount++;
          if (item.source === 'twitter') twitterProcessed++;
          else otherProcessed++;
          updateScanProgress({ newHotspotsFound: newHotspotsCount });
          console.log(`  ✅ New hotspot [${item.source}]: ${hotspot.title.slice(0, 40)}... (${analysis.importance})`);

          // 入队聚合通知（UI 5 分钟 / 邮件 30 分钟）；hotspot:new 仍实时推送列表
          await enqueueHotspotNotification(hotspot, io);

        } catch (error) {
          console.error(`  Error processing result:`, error);
        }
      }

      if (paused) break;

      // 避免过快请求
      await new Promise(resolve => setTimeout(resolve, 2000));
      keywordsProcessed++;

    } catch (error) {
      console.error(`Error checking keyword "${keyword.text}":`, error);
      keywordsProcessed++;
    }
  }

    if (paused) {
      console.log(`\n⏸ Hotspot check paused. Found ${newHotspotsCount} new hotspots (${keywordsProcessed}/${keywords.length} keywords).`);
    } else {
      console.log(`\n✨ Hotspot check completed. Found ${newHotspotsCount} new hotspots.`);
    }

    finishScan({ paused, newHotspotsFound: newHotspotsCount, keywordsProcessed });
    io.emit('scan:status', getScanState());

    return { paused, newHotspotsCount, keywordsProcessed };
  } catch (error) {
    abortScanOnError();
    io.emit('scan:status', getScanState());
    throw error;
  }
}

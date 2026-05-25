import { Router } from 'express';
import { prisma } from '../db.js';
import { runWebSearch, type SourceId } from '../services/searchOrchestrator.js';

const router = Router();

const VALID_SOURCES: SourceId[] = ['bing', 'hackernews', 'sogou', 'twitter'];

// 全网搜索（多源聚合 + AI 分析 + 排序）
router.post('/', async (req, res) => {
  try {
    const { query, sources } = req.body;

    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const normalizedSources = Array.isArray(sources)
      ? sources.filter((s): s is SourceId => VALID_SOURCES.includes(s))
      : undefined;

    const result = await runWebSearch(query.trim(), { sources: normalizedSources });
    res.json(result);
  } catch (error) {
    console.error('Web search error:', error);
    res.status(500).json({ error: 'Failed to run web search' });
  }
});

// 搜索建议（监控词 + 热点标题，历史由前端 localStorage 提供）
router.get('/suggest', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(String(req.query.limit || '8'), 10) || 8, 20);

    if (!q || q.length < 1) {
      return res.json({ suggestions: [] });
    }

    const [keywords, hotspots] = await Promise.all([
      prisma.keyword.findMany({
        where: {
          text: { contains: q }
        },
        select: { text: true },
        take: limit,
        orderBy: { updatedAt: 'desc' }
      }),
      prisma.hotspot.findMany({
        where: {
          title: { contains: q }
        },
        select: { title: true },
        take: limit * 2,
        orderBy: { createdAt: 'desc' }
      })
    ]);

    const seen = new Set<string>();
    const suggestions: string[] = [];

    for (const kw of keywords) {
      const lower = kw.text.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        suggestions.push(kw.text);
      }
    }

    for (const h of hotspots) {
      const trimmed = h.title.trim();
      if (trimmed.length < 2) continue;
      const lower = trimmed.toLowerCase();
      if (!seen.has(lower) && trimmed.toLowerCase().includes(q.toLowerCase())) {
        seen.add(lower);
        // 用标题前 60 字作为建议片段
        suggestions.push(trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed);
      }
      if (suggestions.length >= limit) break;
    }

    res.json({ suggestions: suggestions.slice(0, limit) });
  } catch (error) {
    console.error('Search suggest error:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

export default router;

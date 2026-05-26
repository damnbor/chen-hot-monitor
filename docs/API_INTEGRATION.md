# 🔌 API 集成技术文档

## 1. OpenRouter API 集成

### 1.1 SDK 安装

```bash
npm install @openrouter/sdk
```

### 1.2 基本配置

```typescript
import { OpenRouter } from "@openrouter/sdk";

const openRouter = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
});
```

### 1.3 Chat Completion 调用

```typescript
// 非流式调用
async function analyzeHotspot(content: string) {
  const result = await openRouter.chat.send({
    model: "openai/gpt-4",
    messages: [
      {
        role: "system",
        content: `你是一个热点分析专家，请分析以下内容：
1. 判断是否为真实的热点新闻（排除标题党、假新闻）
2. 评估该热点与 AI 编程领域的相关性（0-100分）
3. 评估热点的重要程度（low/medium/high/urgent）
4. 生成简短摘要（50字以内）

输出 JSON 格式：
{
  "isReal": true/false,
  "relevance": 0-100,
  "importance": "low/medium/high/urgent",
  "summary": "..."
}`
      },
      {
        role: "user",
        content: content
      }
    ],
    stream: false,
    temperature: 0.3,
    maxTokens: 500
  });

  return JSON.parse(result.choices[0].message.content);
}
```

### 1.4 响应格式

```json
{
  "id": "chatcmpl-xxxxxxxxxxxxxxxxx",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "openai/gpt-4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "{\"isReal\": true, \"relevance\": 85, \"importance\": \"high\", \"summary\": \"...\"}"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 15,
    "total_tokens": 25
  }
}
```

---

## 2. Twitter API (twitterapi.io) 集成

### 2.1 认证

```typescript
const TWITTER_API_BASE = 'https://api.twitterapi.io';
const TWITTER_API_KEY = process.env.TWITTER_API_KEY;

const headers = {
  'X-API-Key': TWITTER_API_KEY,
  'Content-Type': 'application/json'
};
```

### 2.2 高级搜索 API

**Endpoint:** `GET /twitter/tweet/advanced_search`

**参数:**
- `query` (string, required): 搜索查询，支持高级语法
- `queryType` (enum, required): `Latest` 或 `Top`
- `cursor` (string, optional): 分页游标

**查询语法示例:**
```
"AI" OR "GPT" lang:en since:2024-01-01
from:OpenAI OR from:Anthropic
#AINews min_faves:100
```

**请求示例:**

```typescript
async function searchTwitter(query: string, cursor?: string) {
  const params = new URLSearchParams({
    query: query,
    queryType: 'Latest'
  });
  
  if (cursor) {
    params.append('cursor', cursor);
  }

  const response = await fetch(
    `${TWITTER_API_BASE}/twitter/tweet/advanced_search?${params}`,
    { headers }
  );

  return response.json();
}
```

**响应格式:**

```json
{
  "tweets": [
    {
      "type": "tweet",
      "id": "1234567890",
      "url": "https://twitter.com/user/status/1234567890",
      "text": "Breaking: OpenAI announces GPT-5...",
      "source": "Twitter Web App",
      "retweetCount": 1500,
      "replyCount": 300,
      "likeCount": 5000,
      "quoteCount": 200,
      "viewCount": 150000,
      "createdAt": "2024-01-15T10:30:00Z",
      "lang": "en",
      "author": {
        "userName": "techreporter",
        "name": "Tech Reporter",
        "isBlueVerified": true,
        "followers": 50000,
        "profilePicture": "https://..."
      },
      "entities": {
        "hashtags": [{ "text": "AI" }],
        "urls": [{ "expanded_url": "https://..." }]
      }
    }
  ],
  "has_next_page": true,
  "next_cursor": "xxxx"
}
```

### 2.3 获取热门趋势

**Endpoint:** `GET /twitter/trends`

```typescript
async function getTrends(woeid: number = 1) { // 1 = Worldwide
  const response = await fetch(
    `${TWITTER_API_BASE}/twitter/trends?woeid=${woeid}`,
    { headers }
  );
  return response.json();
}
```

---

## 3. 网页搜索爬虫

### 3.1 Bing 搜索爬虫

```typescript
import axios from 'axios';
import * as cheerio from 'cheerio';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36...',
];

async function searchBing(query: string): Promise<SearchResult[]> {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  
  const response = await axios.get('https://www.bing.com/search', {
    params: { q: query },
    headers: { 'User-Agent': userAgent }
  });

  const $ = cheerio.load(response.data);
  const results: SearchResult[] = [];

  $('li.b_algo').each((_, element) => {
    const title = $(element).find('h2 a').text();
    const url = $(element).find('h2 a').attr('href');
    const snippet = $(element).find('.b_caption p').text();
    
    if (title && url) {
      results.push({ title, url, snippet, source: 'bing' });
    }
  });

  return results;
}
```

### 3.2 频率控制

```typescript
class RateLimiter {
  private queue: (() => Promise<void>)[] = [];
  private processing = false;
  private lastRequestTime = 0;
  private minInterval = 5000; // 5 秒间隔

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.process();
    });
  }

  private async process() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const elapsed = Date.now() - this.lastRequestTime;
      if (elapsed < this.minInterval) {
        await new Promise(r => setTimeout(r, this.minInterval - elapsed));
      }
      
      const task = this.queue.shift();
      if (task) {
        this.lastRequestTime = Date.now();
        await task();
      }
    }
    
    this.processing = false;
  }
}
```

---

## 4. Prisma + SQLite 配置

### 4.1 Schema 定义

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Keyword {
  id        String    @id @default(uuid())
  text      String    @unique
  category  String?
  isActive  Boolean   @default(true)
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  hotspots  Hotspot[]
}

model Hotspot {
  id          String   @id @default(uuid())
  title       String
  content     String
  url         String
  source      String   // twitter, bing, google
  sourceId    String?  // 原始推文ID等
  isReal      Boolean  @default(true)
  relevance   Int      @default(0)
  importance  String   @default("low")
  summary     String?
  viewCount   Int?
  likeCount   Int?
  retweetCount Int?
  publishedAt DateTime?
  createdAt   DateTime @default(now())
  keywordId   String?
  keyword     Keyword? @relation(fields: [keywordId], references: [id])
  
  @@unique([url, source])
}

model Notification {
  id        String   @id @default(uuid())
  type      String   // hotspot, alert
  title     String
  content   String
  isRead    Boolean  @default(false)
  hotspotId String?
  createdAt DateTime @default(now())
}

model Setting {
  id    String @id @default(uuid())
  key   String @unique
  value String
}
```

### 4.2 迁移命令

```bash
# 初始化数据库
npx prisma migrate dev --name init

# 生成 Prisma Client
npx prisma generate
```

### 4.3 环境变量

```env
DATABASE_URL="file:./dev.db"
```

---

## 5. Express + WebSocket 配置

### 5.1 服务器配置

```typescript
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// WebSocket 连接
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('subscribe', (keywords: string[]) => {
    keywords.forEach(kw => socket.join(`keyword:${kw}`));
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// 发送热点通知
function notifyNewHotspot(hotspot: Hotspot) {
  io.to(`keyword:${hotspot.keyword?.text}`).emit('hotspot:new', hotspot);
  io.emit('notification', {
    type: 'hotspot',
    title: '发现新热点',
    content: hotspot.title
  });
}

export { app, httpServer, io, notifyNewHotspot };
```

### 5.2 路由结构

```typescript
// routes/keywords.ts
import { Router } from 'express';
import { prisma } from '../db';

const router = Router();

router.get('/', async (req, res) => {
  const keywords = await prisma.keyword.findMany({
    orderBy: { createdAt: 'desc' }
  });
  res.json(keywords);
});

router.post('/', async (req, res) => {
  const { text, category } = req.body;
  const keyword = await prisma.keyword.create({
    data: { text, category }
  });
  res.status(201).json(keyword);
});

router.delete('/:id', async (req, res) => {
  await prisma.keyword.delete({
    where: { id: req.params.id }
  });
  res.status(204).send();
});

export default router;
```

---

## 6. 定时任务配置

```typescript
import cron from 'node-cron';

// 每 30 分钟执行一次热点检查
cron.schedule('*/30 * * * *', async () => {
  console.log('Running hotspot check...');
  await checkHotspots();
});

async function checkHotspots() {
  const keywords = await prisma.keyword.findMany({
    where: { isActive: true }
  });

  for (const keyword of keywords) {
    // 账号检测 + 关键词扩展 + 6 源抓取并行（见 sourceFetcher.ts）
    const { accountResult, expandedKeywords, sourceFetch } =
      await gatherKeywordSearchContext(keyword.text);

    const allResults = [
      ...accountResult.results,
      ...sourceFetch.results
    ];

    // AI 分析（逐条，与抓取并行阶段分离）
    for (const item of allResults) {
      const analysis = await analyzeContent(item, keyword.text, expandedKeywords);
      // 过滤、入库、通知...
    }
  }
}
```

实现文件：`server/src/services/sourceFetcher.ts`

| 函数 | 说明 |
|------|------|
| `fetchMonitorSources(query)` | 6 源 `Promise.allSettled` + 单源 25s 超时 |
| `gatherKeywordSearchContext(keyword)` | 账号检测 + `expandKeyword` + `fetchMonitorSources` 三者 `Promise.all` |

---

## 7. 通知聚合与邮件

实现文件：`server/src/services/notificationAggregator.ts`、`server/src/services/email.ts`

发现新热点后**不再逐条推送通知/邮件**，而是入队后按**滚动窗口**聚合：

| 通道 | 窗口 | 行为 |
|------|------|------|
| `hotspot:new` (WebSocket) | 无 | **实时**更新前端热点列表，不 Toast |
| UI 通知 + Toast | **5 分钟**（默认） | 窗口到期后 1 条 `hotspot_digest` 通知 |
| SMTP 邮件 | **30 分钟**（默认） | 窗口到期后 1 封汇总邮件，**仅 high / urgent** |

环境变量（`server/.env`）：

```env
NOTIFICATION_UI_WINDOW_MINUTES=5
NOTIFICATION_EMAIL_WINDOW_MINUTES=30
```

### 7.1 聚合流程

```typescript
// hotspotChecker：热点入库后
await enqueueHotspotNotification(hotspot, io);
// → 立即 emit hotspot:new（列表实时）
// → 写入 NotificationQueue，等待窗口 flush

// index.ts：每分钟检查 + 启动时 flush
cron.schedule('* * * * *', () => tryFlushNotificationWindows(io));
```

### 7.2 WebSocket 聚合通知事件

```typescript
io.emit('notification', {
  type: 'hotspot_digest',
  title: '热点汇总',
  content: '5 分钟内发现 3 条新热点',
  count: 3,
  hotspotIds: ['uuid-1', 'uuid-2', 'uuid-3']
});
```

前端收到 `hotspot_digest` 后：Toast 一次 + 刷新通知列表。

### 7.3 邮件汇总

```typescript
await sendDigestEmail(highUrgentHotspots, { windowMinutes: 30 });
```

仅包含窗口内 `importance` 为 `high` 或 `urgent` 的热点。

---

## 8. 全网搜索 API

实现文件：`server/src/services/searchOrchestrator.ts`、`server/src/routes/search.ts`

与定时监控（`hotspotChecker`）共用 AI 分析能力。搜索策略：**每源 1 条、最多 4 条**，并行抓取 + 并行 AI，总超时 **60s**。

| 参数 | 值 |
|------|-----|
| 数据源 | **Bing + HN + 搜狗 + Twitter(lite)** |
| 每源展示 | **1 条** |
| 返回条数 | **最多 4 条** |
| 总超时 | **60s**（无内部硬截止） |
| 单源抓取超时 | **25s** |
| AI 调用 | **最多 4 次并行**，不设单条 AI 硬超时 |

### 8.1 全网搜索

**Endpoint:** `POST /api/search`

**请求体：**

```json
{
  "query": "Cursor AI",
  "sources": ["bing", "hackernews", "sogou", "twitter"]
}
```

- `sources` 可选，默认上述 4 源
- **每源只返回 1 条** AI 分析结果
- 总超时 **60 秒**，AI 并行分析不设单条硬超时

**响应示例：**

```json
{
  "query": "Cursor AI",
  "results": [
    {
      "id": "bing:https://...",
      "title": "...",
      "content": "...",
      "url": "https://...",
      "source": "bing",
      "isReal": true,
      "relevance": 85,
      "relevanceReason": "...",
      "keywordMentioned": true,
      "importance": "high",
      "summary": "此内容与【Cursor AI】的关联：...",
      "analyzed": true,
      "sortScore": 72.5,
      "createdAt": "2026-05-20T12:00:00.000Z",
      "keyword": null
    }
  ],
  "meta": {
    "totalFetched": 45,
    "totalUnique": 38,
    "totalAnalyzed": 8,
    "highQualityCount": 5,
    "timedOut": false,
    "completedSources": ["Bing", "HackerNews", "Sogou", "Twitter"],
    "failedSources": ["Sogou"],
    "lowRelevanceCount": 5,
    "durationMs": 28500
  }
}
```

**排序公式（`sortScore`）：**

- `relevance × 0.65` + 重要性加权 + 来源优先级 + 互动热度
- 未 AI 分析的条目 `sortScore` 会降权，排在已分析结果之后

**兼容旧路径：** `POST /api/hotspots/search` 与上述逻辑一致。

### 8.2 搜索建议

**Endpoint:** `GET /api/search/suggest?q=Cur&limit=8`

服务端返回监控关键词、热点标题前缀匹配建议。**搜索历史**由前端 `localStorage`（`hotpulse_search_history`）维护，优先级：历史 > 监控词 > 本接口。

```json
{
  "suggestions": ["Cursor", "Cursor 2.0 Agent"]
}
```

### 8.3 前端集成要点

| 能力 | 实现 |
|------|------|
| 搜索历史 | `client/src/utils/searchHistory.ts`，最多 50 条 |
| 自动补全 | 输入防抖 300ms，合并本地 + `GET /suggest` |
| 低相关折叠 | `relevance < 40` 默认折叠，可展开 |
| 进度提示 | Toast：搜索开始 / 完成或超时 |

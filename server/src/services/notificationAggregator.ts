import type { Server } from 'socket.io';
import { prisma } from '../db.js';
import { sendDigestEmail } from './email.js';

const UI_WINDOW_START_KEY = 'notification_ui_window_start';
const EMAIL_WINDOW_START_KEY = 'notification_email_window_start';

export const UI_WINDOW_MS =
  parseInt(process.env.NOTIFICATION_UI_WINDOW_MINUTES || '5', 10) * 60 * 1000;
export const EMAIL_WINDOW_MS =
  parseInt(process.env.NOTIFICATION_EMAIL_WINDOW_MINUTES || '30', 10) * 60 * 1000;

const EMAIL_IMPORTANCE = new Set(['high', 'urgent']);

type HotspotWithKeyword = {
  id: string;
  title: string;
  content: string;
  url: string;
  source: string;
  importance: string;
  relevance: number;
  summary: string | null;
  createdAt: Date;
  keyword?: { text: string } | null;
};

async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

async function clearSetting(key: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key } });
}

export function isWindowExpired(windowStart: Date, windowMs: number, now = Date.now()): boolean {
  return now - windowStart.getTime() >= windowMs;
}

export function buildDigestTitle(count: number, windowMinutes: number): string {
  return `📊 热点汇总：${windowMinutes} 分钟内发现 ${count} 条新热点`;
}

export function buildDigestContent(
  hotspots: Array<{ title: string; source: string; importance: string }>
): string {
  const lines = hotspots.slice(0, 10).map(
    (h) => `• [${h.importance}] ${h.title.slice(0, 40)} (${h.source})`
  );
  if (hotspots.length > 10) {
    lines.push(`... 还有 ${hotspots.length - 10} 条`);
  }
  return lines.join('\n');
}

export function isEmailEligible(importance: string): boolean {
  return EMAIL_IMPORTANCE.has(importance);
}

export async function enqueueHotspotNotification(
  hotspot: HotspotWithKeyword,
  io: Server
): Promise<void> {
  if (hotspot.keyword?.text) {
    io.to(`keyword:${hotspot.keyword.text}`).emit('hotspot:new', hotspot);
  } else {
    io.emit('hotspot:new', hotspot);
  }

  const uiWindowStart = await getSetting(UI_WINDOW_START_KEY);
  if (!uiWindowStart) {
    await setSetting(UI_WINDOW_START_KEY, new Date().toISOString());
  }

  if (isEmailEligible(hotspot.importance)) {
    const emailWindowStart = await getSetting(EMAIL_WINDOW_START_KEY);
    if (!emailWindowStart) {
      await setSetting(EMAIL_WINDOW_START_KEY, new Date().toISOString());
    }
  }

  await prisma.notificationQueue.upsert({
    where: { hotspotId: hotspot.id },
    create: {
      hotspotId: hotspot.id,
      importance: hotspot.importance,
      emailFlushed: !isEmailEligible(hotspot.importance),
    },
    update: {},
  });
}

async function resetUiWindowIfEmpty(): Promise<void> {
  const remaining = await prisma.notificationQueue.count({ where: { uiFlushed: false } });
  if (remaining === 0) {
    await clearSetting(UI_WINDOW_START_KEY);
    return;
  }

  const first = await prisma.notificationQueue.findFirst({
    where: { uiFlushed: false },
    orderBy: { enqueuedAt: 'asc' },
  });
  if (first) {
    await setSetting(UI_WINDOW_START_KEY, first.enqueuedAt.toISOString());
  }
}

async function resetEmailWindowIfEmpty(): Promise<void> {
  const remaining = await prisma.notificationQueue.count({
    where: { emailFlushed: false, importance: { in: [...EMAIL_IMPORTANCE] } },
  });
  if (remaining === 0) {
    await clearSetting(EMAIL_WINDOW_START_KEY);
    return;
  }

  const first = await prisma.notificationQueue.findFirst({
    where: { emailFlushed: false, importance: { in: [...EMAIL_IMPORTANCE] } },
    orderBy: { enqueuedAt: 'asc' },
  });
  if (first) {
    await setSetting(EMAIL_WINDOW_START_KEY, first.enqueuedAt.toISOString());
  }
}

async function cleanupFlushedQueueItems(): Promise<void> {
  await prisma.notificationQueue.deleteMany({
    where: {
      uiFlushed: true,
      OR: [
        { emailFlushed: true },
        { importance: { notIn: [...EMAIL_IMPORTANCE] } },
      ],
    },
  });
}

export async function tryFlushUiWindow(io?: Server, now = Date.now()): Promise<boolean> {
  const windowStartStr = await getSetting(UI_WINDOW_START_KEY);
  if (!windowStartStr) return false;

  const windowStart = new Date(windowStartStr);
  if (!isWindowExpired(windowStart, UI_WINDOW_MS, now)) return false;

  const pending = await prisma.notificationQueue.findMany({
    where: { uiFlushed: false },
    orderBy: { enqueuedAt: 'asc' },
  });
  if (pending.length === 0) {
    await clearSetting(UI_WINDOW_START_KEY);
    return false;
  }

  const hotspots = await prisma.hotspot.findMany({
    where: { id: { in: pending.map((p) => p.hotspotId) } },
    include: { keyword: true },
    orderBy: { createdAt: 'desc' },
  });

  if (hotspots.length > 0) {
    const windowMinutes = Math.round(UI_WINDOW_MS / 60000);
    const title = buildDigestTitle(hotspots.length, windowMinutes);
    const content = buildDigestContent(hotspots);

    await prisma.notification.create({
      data: {
        type: 'hotspot_digest',
        title,
        content,
        hotspotId: hotspots[0].id,
      },
    });

    io?.emit('notification', {
      type: 'hotspot_digest',
      title: '热点汇总',
      content: `${windowMinutes} 分钟内发现 ${hotspots.length} 条新热点`,
      count: hotspots.length,
      hotspotIds: hotspots.map((h) => h.id),
    });

    console.log(`📬 UI digest sent: ${hotspots.length} hotspot(s) in ${windowMinutes}min window`);
  }

  await prisma.notificationQueue.updateMany({
    where: { id: { in: pending.map((p) => p.id) } },
    data: { uiFlushed: true },
  });

  await resetUiWindowIfEmpty();
  return true;
}

export async function tryFlushEmailWindow(now = Date.now()): Promise<boolean> {
  const windowStartStr = await getSetting(EMAIL_WINDOW_START_KEY);
  if (!windowStartStr) return false;

  const windowStart = new Date(windowStartStr);
  if (!isWindowExpired(windowStart, EMAIL_WINDOW_MS, now)) return false;

  const pending = await prisma.notificationQueue.findMany({
    where: {
      emailFlushed: false,
      importance: { in: [...EMAIL_IMPORTANCE] },
    },
    orderBy: { enqueuedAt: 'asc' },
  });

  if (pending.length === 0) {
    await clearSetting(EMAIL_WINDOW_START_KEY);
    return false;
  }

  const hotspots = await prisma.hotspot.findMany({
    where: { id: { in: pending.map((p) => p.hotspotId) } },
    include: { keyword: true },
    orderBy: { createdAt: 'desc' },
  });

  const emailHotspots = hotspots.filter((h) => isEmailEligible(h.importance));
  if (emailHotspots.length > 0) {
    const windowMinutes = Math.round(EMAIL_WINDOW_MS / 60000);
    await sendDigestEmail(emailHotspots, { windowMinutes });
    console.log(
      `📧 Email digest sent: ${emailHotspots.length} high/urgent hotspot(s) in ${windowMinutes}min window`
    );
  }

  await prisma.notificationQueue.updateMany({
    where: { id: { in: pending.map((p) => p.id) } },
    data: { emailFlushed: true },
  });

  await resetEmailWindowIfEmpty();
  return emailHotspots.length > 0;
}

export async function tryFlushNotificationWindows(io?: Server, now = Date.now()): Promise<void> {
  await tryFlushUiWindow(io, now);
  await tryFlushEmailWindow(now);
  await cleanupFlushedQueueItems();
}

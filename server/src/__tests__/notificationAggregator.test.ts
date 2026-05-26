import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockSendDigestEmail } = vi.hoisted(() => {
  const mockPrisma = {
    setting: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    notificationQueue: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    hotspot: {
      findMany: vi.fn(),
    },
    notification: {
      create: vi.fn(),
    },
  };
  const mockSendDigestEmail = vi.fn().mockResolvedValue(true);
  return { mockPrisma, mockSendDigestEmail };
});

vi.mock('../db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../services/email.js', () => ({
  sendDigestEmail: (...args: unknown[]) => mockSendDigestEmail(...args),
}));

import {
  isWindowExpired,
  buildDigestTitle,
  buildManualDigestTitle,
  buildDigestContent,
  isEmailEligible,
  tryFlushUiWindow,
  tryFlushEmailWindow,
  flushManualScanUiNotifications,
  UI_WINDOW_MS,
  EMAIL_WINDOW_MS,
} from '../services/notificationAggregator.js';

describe('notificationAggregator helpers', () => {
  it('isWindowExpired returns true after window elapses', () => {
    const start = new Date('2026-05-20T10:00:00Z');
    const now = start.getTime() + 5 * 60 * 1000;
    expect(isWindowExpired(start, 5 * 60 * 1000, now)).toBe(true);
  });

  it('isWindowExpired returns false before window elapses', () => {
    const start = new Date('2026-05-20T10:00:00Z');
    const now = start.getTime() + 4 * 60 * 1000;
    expect(isWindowExpired(start, 5 * 60 * 1000, now)).toBe(false);
  });

  it('buildDigestTitle formats count and window', () => {
    expect(buildDigestTitle(3, 5)).toBe('📊 热点汇总：5 分钟内发现 3 条新热点');
  });

  it('buildManualDigestTitle formats manual scan summary', () => {
    expect(buildManualDigestTitle(4)).toBe('📊 热点汇总：本次扫描发现 4 条新热点');
  });

  it('buildDigestContent truncates long lists', () => {
    const hotspots = Array.from({ length: 12 }, (_, i) => ({
      title: `Hotspot ${i}`,
      source: 'bing',
      importance: 'medium',
    }));
    const content = buildDigestContent(hotspots);
    expect(content).toContain('Hotspot 0');
    expect(content).toContain('... 还有 2 条');
  });

  it('isEmailEligible only allows high and urgent', () => {
    expect(isEmailEligible('high')).toBe(true);
    expect(isEmailEligible('urgent')).toBe(true);
    expect(isEmailEligible('medium')).toBe(false);
    expect(isEmailEligible('low')).toBe(false);
  });
});

describe('tryFlushUiWindow', () => {
  const io = { emit: vi.fn() } as any;
  const windowStart = new Date('2026-05-20T10:00:00Z');
  const expiredNow = windowStart.getTime() + UI_WINDOW_MS + 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.setting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
      if (where.key === 'notification_ui_window_start') {
        return { key: where.key, value: windowStart.toISOString() };
      }
      return null;
    });
    mockPrisma.notificationQueue.findMany.mockResolvedValue([
      { id: 'q1', hotspotId: 'h1', importance: 'medium', uiFlushed: false },
      { id: 'q2', hotspotId: 'h2', importance: 'low', uiFlushed: false },
    ]);
    mockPrisma.hotspot.findMany.mockResolvedValue([
      { id: 'h1', title: 'Alpha', source: 'bing', importance: 'medium' },
      { id: 'h2', title: 'Beta', source: 'twitter', importance: 'low' },
    ]);
    mockPrisma.notificationQueue.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.notificationQueue.count.mockResolvedValue(0);
    mockPrisma.setting.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.notification.create.mockResolvedValue({ id: 'n1' });
  });

  it('does not flush before UI window expires', async () => {
    const notExpired = windowStart.getTime() + 60 * 1000;
    const flushed = await tryFlushUiWindow(io, notExpired);
    expect(flushed).toBe(false);
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('creates one digest notification after UI window expires', async () => {
    const flushed = await tryFlushUiWindow(io, expiredNow);
    expect(flushed).toBe(true);
    expect(mockPrisma.notification.create).toHaveBeenCalledOnce();
    expect(mockPrisma.notification.create.mock.calls[0][0].data.type).toBe('hotspot_digest');
    expect(io.emit).toHaveBeenCalledWith(
      'notification',
      expect.objectContaining({ type: 'hotspot_digest', count: 2 })
    );
    expect(mockPrisma.notificationQueue.updateMany).toHaveBeenCalled();
  });
});

describe('tryFlushEmailWindow', () => {
  const windowStart = new Date('2026-05-20T10:00:00Z');
  const expiredNow = windowStart.getTime() + EMAIL_WINDOW_MS + 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.setting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
      if (where.key === 'notification_email_window_start') {
        return { key: where.key, value: windowStart.toISOString() };
      }
      return null;
    });
    mockPrisma.notificationQueue.findMany.mockResolvedValue([
      { id: 'q1', hotspotId: 'h1', importance: 'high', emailFlushed: false },
      { id: 'q2', hotspotId: 'h2', importance: 'low', emailFlushed: false },
      { id: 'q3', hotspotId: 'h3', importance: 'urgent', emailFlushed: false },
    ]);
    mockPrisma.hotspot.findMany.mockResolvedValue([
      { id: 'h1', title: 'High one', source: 'bing', importance: 'high', url: 'https://a.com' },
      { id: 'h3', title: 'Urgent one', source: 'twitter', importance: 'urgent', url: 'https://b.com' },
    ]);
    mockPrisma.notificationQueue.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.notificationQueue.count.mockResolvedValue(0);
    mockPrisma.setting.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('does not send email before email window expires', async () => {
    const notExpired = windowStart.getTime() + 5 * 60 * 1000;
    const flushed = await tryFlushEmailWindow(notExpired);
    expect(flushed).toBe(false);
    expect(mockSendDigestEmail).not.toHaveBeenCalled();
  });

  it('sends digest email with only high/urgent hotspots', async () => {
    const flushed = await tryFlushEmailWindow(expiredNow);
    expect(flushed).toBe(true);
    expect(mockSendDigestEmail).toHaveBeenCalledOnce();
    const [hotspots, options] = mockSendDigestEmail.mock.calls[0];
    expect(hotspots).toHaveLength(2);
    expect(hotspots.every((h: { importance: string }) => ['high', 'urgent'].includes(h.importance))).toBe(true);
    expect(options.windowMinutes).toBe(10);
  });
});

describe('flushManualScanUiNotifications', () => {
  const io = { emit: vi.fn() } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.notificationQueue.findMany.mockResolvedValue([
      { id: 'q1', hotspotId: 'h1', manualBatchId: 'batch-1', uiFlushed: false },
    ]);
    mockPrisma.hotspot.findMany.mockResolvedValue([
      { id: 'h1', title: 'Manual hit', source: 'twitter', importance: 'high' },
    ]);
    mockPrisma.notification.create.mockResolvedValue({ id: 'n1' });
    mockPrisma.notificationQueue.updateMany.mockResolvedValue({ count: 1 });
  });

  it('flushes manual batch immediately without waiting for UI window', async () => {
    const flushed = await flushManualScanUiNotifications(io, 'batch-1');
    expect(flushed).toBe(true);
    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: buildManualDigestTitle(1),
        }),
      })
    );
    expect(io.emit).toHaveBeenCalledWith(
      'notification',
      expect.objectContaining({
        content: '本次扫描发现 1 条新热点',
      })
    );
  });
});

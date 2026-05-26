import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import cron from 'node-cron';

import { prisma } from './db.js';
import keywordsRouter from './routes/keywords.js';
import hotspotsRouter from './routes/hotspots.js';
import searchRouter from './routes/search.js';
import settingsRouter from './routes/settings.js';
import notificationsRouter from './routes/notifications.js';
import { runHotspotCheck } from './jobs/hotspotChecker.js';
import { tryFlushNotificationWindows } from './services/notificationAggregator.js';
import {
  beginManualScan,
  beginScheduledScan,
  getScanState,
  requestPause,
} from './services/scanState.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/keywords', keywordsRouter);
app.use('/api/hotspots', hotspotsRouter);
app.use('/api/search', searchRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/notifications', notificationsRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Manual trigger for hotspot check (async, supports pause)
app.post('/api/check-hotspots', (req, res) => {
  if (!beginManualScan()) {
    return res.status(409).json({
      error: 'Scan already in progress',
      state: getScanState(),
    });
  }

  void runHotspotCheck(io, { manual: true }).catch((error) => {
    console.error('❌ Manual hotspot check failed:', error);
  });

  res.json({ message: 'Scan started', state: getScanState() });
});

app.post('/api/check-hotspots/pause', (req, res) => {
  const accepted = requestPause();
  if (!accepted) {
    return res.status(400).json({
      error: 'No pausable manual scan is running',
      state: getScanState(),
    });
  }
  res.json({ message: 'Pause requested', state: getScanState() });
});

app.get('/api/check-hotspots/status', (req, res) => {
  res.json(getScanState());
});

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('subscribe', (keywords: string[]) => {
    keywords.forEach(kw => socket.join(`keyword:${kw}`));
    console.log(`Socket ${socket.id} subscribed to:`, keywords);
  });

  socket.on('unsubscribe', (keywords: string[]) => {
    keywords.forEach(kw => socket.leave(`keyword:${kw}`));
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Scheduled job: flush aggregated notifications every minute
cron.schedule('* * * * *', async () => {
  try {
    await tryFlushNotificationWindows(io);
  } catch (error) {
    console.error('❌ Notification flush failed:', error);
  }
});

// Scheduled job: Run hotspot check every 30 minutes
cron.schedule('*/30 * * * *', async () => {
  console.log('🔄 Running scheduled hotspot check...');
  if (!beginScheduledScan()) {
    console.log('⏭ Skipping scheduled scan — another scan is in progress');
    return;
  }
  try {
    await runHotspotCheck(io, { manual: false });
    console.log('✅ Scheduled hotspot check completed');
  } catch (error) {
    console.error('❌ Scheduled hotspot check failed:', error);
  }
});

// Export for use in other modules
export { io };

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, async () => {
  console.log(`
  🔥 热点监控服务启动成功!
  📡 Server running on http://localhost:${PORT}
  🔌 WebSocket ready
  ⏰ Hotspot check scheduled every 30 minutes
  📬 Notification digest: UI ${process.env.NOTIFICATION_UI_WINDOW_MINUTES || '5'}min / Email ${process.env.NOTIFICATION_EMAIL_WINDOW_MINUTES || '10'}min
  `);
  try {
    await tryFlushNotificationWindows(io);
  } catch (error) {
    console.error('❌ Startup notification flush failed:', error);
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await prisma.$disconnect();
  process.exit(0);
});

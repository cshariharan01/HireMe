import { startSync, getSyncStatus } from './sync';

let schedulerInterval: NodeJS.Timeout | null = null;
let lastSlotExecuted: string | null = null;

/**
 * Scheduled automatic ingestion for LinkedIn & Naukri jobs:
 * 3 times a day:
 * - Morning: 09:00 - 09:30
 * - Afternoon: 14:00 - 14:30
 * - Evening: 20:00 - 20:30
 */
export function setupSyncScheduler() {
  if (schedulerInterval) return;

  console.log('[scheduler] Sync scheduler initialized for 3x daily ingestion (9 AM, 2 PM, 8 PM)');

  const checkAndRun = () => {
    try {
      const now = new Date();
      const hour = now.getHours();
      const minute = now.getMinutes();
      const today = now.toISOString().slice(0, 10);

      let currentSlot: 'morning' | 'noon' | 'evening' | null = null;

      if (hour === 9 && minute <= 30) currentSlot = 'morning';
      else if (hour === 14 && minute <= 30) currentSlot = 'noon';
      else if (hour === 20 && minute <= 30) currentSlot = 'evening';

      if (!currentSlot) return;

      const slotKey = `${today}-${currentSlot}`;
      if (lastSlotExecuted === slotKey) return;

      const status = getSyncStatus();
      if (status.running) {
        console.log(`[scheduler] ${currentSlot} sync window active, but sync is already in progress`);
        return;
      }

      console.log(`[scheduler] Triggering automated 3x/day full sync for slot: ${currentSlot} at ${now.toLocaleTimeString()}`);
      lastSlotExecuted = slotKey;
      const res = startSync('full');
      if (!res.ok) {
        console.warn(`[scheduler] automated sync failed to start:`, res.error);
      }
    } catch (err) {
      console.error('[scheduler] error in checkAndRun:', err);
    }
  };

  // Run initial check after 10s, then check every 5 minutes
  setTimeout(checkAndRun, 10000);
  schedulerInterval = setInterval(checkAndRun, 5 * 60 * 1000);
  schedulerInterval.unref();
}

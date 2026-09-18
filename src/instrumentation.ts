export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { setupSyncScheduler } = await import('@/lib/scheduler');
    setupSyncScheduler();
  }
}

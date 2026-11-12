/*
 * NativeKit TestLab background runner.
 * Loaded by @capacitor/background-runner from android asset public/runners/.
 * Fires on every dispatch of app.config backgroundRunner.event ('nativekit.sync'),
 * both from the demo button (runSyncNow) and the periodic repeat timer.
 */
/* global addEventListener, CapacitorKV, console */
addEventListener('nativekit.sync', async (resolve, reject, args) => {
  try {
    let count = 1;
    try {
      const previous = await CapacitorKV.get('testlab.sync.count');
      count = Number((previous && previous.value) || '0') + 1;
      await CapacitorKV.set('testlab.sync.count', String(count));
    } catch (kvError) {
      console.log('[nativekit.sync] KV unavailable, continuing without counter', kvError);
    }
    console.log('[nativekit.sync] run #' + count, JSON.stringify(args || {}));
    resolve({ ran: true, count, at: new Date().toISOString(), args: args || {} });
  } catch (error) {
    console.error('[nativekit.sync] failed', error);
    reject(error);
  }
});

/*
 * NativeKit headless runner. This is not a persistent service: Android/iOS decide
 * when it executes and may throttle or skip runs. Keep each run short.
 */
addEventListener('nativekit.sync', async (resolve, reject, args) => {
  const startedAt = new Date().toISOString();
  try {
    const stored = CapacitorKV.get('nativekit.sync.url');
    const syncUrl = args?.syncUrl || stored?.value || '';
    if (!syncUrl) {
      CapacitorKV.set('nativekit.sync.lastResult', JSON.stringify({ ok: true, skipped: true, startedAt }));
      resolve({ ok: true, skipped: true, reason: 'No sync URL configured', startedAt });
      return;
    }
    if (!syncUrl.startsWith('https://')) throw new Error('Background sync URL must use HTTPS');

    const response = await fetch(syncUrl, {
      method: args?.method || 'POST',
      headers: { 'content-type': 'application/json', ...(args?.headers || {}) },
      body: JSON.stringify(args?.body || { reason: 'periodic', startedAt }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const result = { ok: true, status: response.status, startedAt, completedAt: new Date().toISOString() };
    CapacitorKV.set('nativekit.sync.lastResult', JSON.stringify(result));
    resolve(result);
  } catch (error) {
    const result = { ok: false, message: String(error?.message || error), startedAt, completedAt: new Date().toISOString() };
    CapacitorKV.set('nativekit.sync.lastResult', JSON.stringify(result));
    reject(result.message);
  }
});

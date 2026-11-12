const output = document.querySelector('#output');
const show = (label, value) => {
  output.textContent = `${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`;
};

addEventListener('nativekitready', async () => {
  show('Broker policy', await NativeKit.capabilities());
});

document.querySelector('#count').addEventListener('click', async () => {
  try {
    const old = await NativeKit.preferences.getJSON('counter') || { count: 0 };
    const next = { count: old.count + 1, updatedAt: new Date().toISOString() };
    await NativeKit.preferences.setJSON('counter', next);
    show('Namespaced Preferences', next);
  } catch (error) { show('Denied/error', error.message); }
});

document.querySelector('#haptic').addEventListener('click', async () => {
  try { await NativeKit.haptics.impact('LIGHT'); show('Haptics', 'completed'); }
  catch (error) { show('Denied/error', error.message); }
});

document.querySelector('#network').addEventListener('click', async () => {
  try { show('Network state', await NativeKit.network.status()); }
  catch (error) { show('Denied/error', error.message); }
});

document.querySelector('#denied').addEventListener('click', async () => {
  try { show('Camera', await NativeKit.camera.getPhoto()); }
  catch (error) { show('Expected policy denial', error.message); }
});

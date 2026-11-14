/* ==========================================================================
   Generative UI — draws GenUICore specs with the app's own components.
     render_spec   flat JSON spec, built from JSON Patch lines; same title = update
     present       a nested display-only tree, converted to a spec
   Versions are keyed by chat + title. A new version shows at the bottom of
   the chat, the older card collapses to "Updated below", and whatever the
   user typed or picked carries over to the new version.
   ========================================================================== */
const GenUI = (() => {
  'use strict';
  const C = GenUICore;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const numOr = (v, d) => { const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v); return Number.isFinite(n) ? n : d; };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u.trim()) ? u.trim() : '');
  const linkUrl = (u) => (typeof u === 'string' && /^(https?:\/\/|mailto:|tel:)[^\s"'<>]+$/i.test(u.trim()) ? u.trim() : '');
  const mediaUrl = (u) => httpsUrl(u) || (typeof u === 'string' && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(u) ? u : '');
  const TONES = new Set(['neutral', 'muted', 'info', 'success', 'warning', 'danger', 'accent']);
  const tone = (t, d = 'neutral') => (TONES.has(t) ? t : d);
  const MAX_CALLS = 400;
  const MAX_REPEAT = 500;
  const MAX_DEPTH = 40;
  const STATE_KEY = 'genuiUserState';
  let uid = 0;
  // Line icons for the Icon component and icon props (Lucide, ISC licence).
  const GU_ICONS = {"map-pin":"<path d=\"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0\" /><circle cx=\"12\" cy=\"10\" r=\"3\" />","calendar":"<path d=\"M8 2v3\" /><path d=\"M16 2v3\" /><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\" /><path d=\"M3 9h18\" />","clock":"<circle cx=\"12\" cy=\"12\" r=\"10\" /><path d=\"M12 6v6l4 2\" />","star":"<path d=\"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z\" />","heart":"<path d=\"M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5\" />","home":"<path d=\"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8\" /><path d=\"M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\" />","user":"<path d=\"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2\" /><circle cx=\"12\" cy=\"7\" r=\"4\" />","users":"<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\" /><path d=\"M16 3.128a4 4 0 0 1 0 7.744\" /><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\" /><circle cx=\"9\" cy=\"7\" r=\"4\" />","mail":"<path d=\"m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7\" /><rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"2\" />","phone":"<path d=\"M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384\" />","cloud":"<path d=\"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z\" />","cloud-rain":"<path d=\"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242\" /><path d=\"M16 14v6\" /><path d=\"M8 14v6\" /><path d=\"M12 16v6\" />","thermometer":"<path d=\"M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z\" />","droplet":"<path d=\"M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z\" />","wind":"<path d=\"M12.8 19.6A2 2 0 1 0 14 16H2\" /><path d=\"M17.5 8a2.5 2.5 0 1 1 2 4H2\" /><path d=\"M9.8 4.4A2 2 0 1 1 11 8H2\" />","wallet":"<path d=\"M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1\" /><path d=\"M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4\" />","cart":"<path d=\"m2.05 2.05 1.099-.028a1 1 0 0 1 1.008.815l2.69 14.347A1 1 0 0 0 7.83 18H18\" /><path d=\"M4.563 5h16.435a1 1 0 0 1 .981 1.204l-1.026 6.226A2 2 0 0 1 18.962 14H6.25\" /><circle cx=\"18\" cy=\"20\" r=\"2\" /><circle cx=\"8\" cy=\"20\" r=\"2\" />","bell":"<path d=\"M10.268 21a2 2 0 0 0 3.464 0\" /><path d=\"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326\" />","globe":"<circle cx=\"12\" cy=\"12\" r=\"10\" /><path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\" /><path d=\"M2 12h20\" />","link":"<path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\" /><path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\" />","lightbulb":"<path d=\"M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5\" /><path d=\"M9 18h6\" /><path d=\"M10 22h4\" />","zap":"<path d=\"M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z\" />","trending-up":"<path d=\"M16 7h6v6\" /><path d=\"m22 7-8.5 8.5-5-5L2 17\" />","trending-down":"<path d=\"M16 17h6v-6\" /><path d=\"m22 17-8.5-8.5-5 5L2 7\" />","lock":"<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\" /><path d=\"M7 11V7a5 5 0 0 1 10 0v4\" />","camera":"<path d=\"M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z\" /><circle cx=\"12\" cy=\"13\" r=\"3\" />","music":"<path d=\"M21 16V3a1 1 0 0 0-1.28-.96l-10 2.917a1 1 0 0 0-.72.96V19\" /><circle cx=\"18\" cy=\"16\" r=\"3\" /><circle cx=\"6\" cy=\"19\" r=\"3\" />","book":"<path d=\"M12 5v16\" /><path d=\"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z\" />","plane":"<path d=\"M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z\" />","car":"<path d=\"M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2\" /><circle cx=\"7\" cy=\"17\" r=\"2\" /><path d=\"M9 17h6\" /><circle cx=\"17\" cy=\"17\" r=\"2\" />","utensils":"<path d=\"M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2\" /><path d=\"M7 2v20\" /><path d=\"M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7\" />","gift":"<path d=\"M12 7v14\" /><path d=\"M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8\" /><path d=\"M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5\" /><rect x=\"3\" y=\"7\" width=\"18\" height=\"4\" rx=\"1\" />","tag":"<path d=\"M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z\" /><circle cx=\"7.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\" />","map":"<path d=\"M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z\" /><path d=\"M15 5.764v15\" /><path d=\"M9 3.236v15\" />","navigation":"<polygon points=\"3 11 22 2 13 21 11 13 3 11\" />","flag":"<path d=\"M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528\" />","award":"<path d=\"m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526\" /><circle cx=\"12\" cy=\"8\" r=\"6\" />","target":"<circle cx=\"12\" cy=\"12\" r=\"10\" /><circle cx=\"12\" cy=\"12\" r=\"6\" /><circle cx=\"12\" cy=\"12\" r=\"2\" />","activity":"<path d=\"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2\" />","bar-chart":"<path d=\"M3 3v16a2 2 0 0 0 2 2h16\" /><path d=\"M18 17V9\" /><path d=\"M13 17V5\" /><path d=\"M8 17v-3\" />","pie-chart":"<path d=\"M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z\" /><path d=\"M21.21 15.89A10 10 0 1 1 8 2.83\" />","list":"<path d=\"M3 5h.01\" /><path d=\"M3 12h.01\" /><path d=\"M3 19h.01\" /><path d=\"M8 5h13\" /><path d=\"M8 12h13\" /><path d=\"M8 19h13\" />","filter":"<path d=\"M2 5h20\" /><path d=\"M6 12h12\" /><path d=\"M9 19h6\" />","sparkles":"<path d=\"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z\" /><path d=\"M20 2v4\" /><path d=\"M22 4h-4\" /><circle cx=\"4\" cy=\"20\" r=\"2\" />","shield":"<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\" />","briefcase":"<path d=\"M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16\" /><rect width=\"20\" height=\"14\" x=\"2\" y=\"6\" rx=\"2\" />","graduation-cap":"<path d=\"M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z\" /><path d=\"M22 10v6\" /><path d=\"M6 12.5V16a6 3 0 0 0 12 0v-3.5\" />","leaf":"<path d=\"M11 20a10 10 0 0010-10 25.9 25.9 0 00-1.04-7.281 1 1 0 00-1.755-.325C15.833 5.5 13 5.5 9.8 6.1A7 7 0 0011 20\" /><path d=\"M2 21a5 5 0 012.911-4.544C7.613 15.212 8.351 15.24 11 13\" />","coffee":"<path d=\"M10 2v2\" /><path d=\"M14 2v2\" /><path d=\"M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1\" /><path d=\"M6 2v2\" />","dollar-sign":"<path d=\"M12 3v18\" /><path d=\"M17 5H9.5a1 1 0 000 7h5a1 1 0 010 7H6\" />","credit-card":"<rect width=\"20\" height=\"14\" x=\"2\" y=\"5\" rx=\"2\" /><line x1=\"2\" x2=\"22\" y1=\"10\" y2=\"10\" /><path d=\"M6 14h2\" />","package":"<path d=\"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z\" /><path d=\"M12 22V12\" /><polyline points=\"3.29 7 12 12 20.71 7\" /><path d=\"m7.5 4.27 9 5.15\" />","truck":"<path d=\"M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2\" /><path d=\"M15 18H9\" /><path d=\"M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14\" /><circle cx=\"17\" cy=\"18\" r=\"2\" /><circle cx=\"7\" cy=\"18\" r=\"2\" />","bed":"<path d=\"M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8\" /><path d=\"M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4\" /><path d=\"M12 4v6\" /><path d=\"M2 18h20\" />","dumbbell":"<path d=\"M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829z\" /><path d=\"m2.5 21.5 1.4-1.4\" /><path d=\"m20.1 3.9 1.4-1.4\" /><path d=\"M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829z\" /><path d=\"m9.6 14.4 4.8-4.8\" />","pill":"<path d=\"m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z\" /><path d=\"m8.5 8.5 7 7\" />","stethoscope":"<path d=\"M11 2v2\" /><path d=\"M5 2v2\" /><path d=\"M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1\" /><path d=\"M8 15a6 6 0 0 0 12 0v-3\" /><circle cx=\"20\" cy=\"10\" r=\"2\" />","smile":"<path d=\"M15 10V9\" /><path d=\"M16.472 15a6 6 0 01-8.943 0\" /><path d=\"M9 10V9\" /><circle cx=\"12\" cy=\"12\" r=\"10\" />","thumbs-up":"<path d=\"M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z\" /><path d=\"M7 10v12\" />","share":"<circle cx=\"18\" cy=\"5\" r=\"3\" /><circle cx=\"6\" cy=\"12\" r=\"3\" /><circle cx=\"18\" cy=\"19\" r=\"3\" /><line x1=\"8.59\" x2=\"15.42\" y1=\"13.51\" y2=\"17.49\" /><line x1=\"15.41\" x2=\"8.59\" y1=\"6.51\" y2=\"10.49\" />","circle":"<circle cx=\"12\" cy=\"12\" r=\"10\" />","external-link":"<path d=\"M15 3h6v6\" /><path d=\"M10 14 21 3\" /><path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\" />","triangle-alert":"<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\" /><path d=\"M12 9v4\" /><path d=\"M12 17h.01\" />"};
  for (const [k, val] of Object.entries(GU_ICONS)) if (!ICONS[k]) ICONS[k] = val;
  const iconName = (v) => { const s = str(v).trim().toLowerCase(); return /^[a-z][a-z0-9-]*$/.test(s) && ICONS[s] ? s : ''; };

  const nf = (opts) => { try { return new Intl.NumberFormat(undefined, opts); } catch { return new Intl.NumberFormat(undefined); } };
  const fmtNum = (v, opts) => (typeof v === 'number' && Number.isFinite(v) ? nf(opts).format(v) : str(v));
  const compact = (v) => fmtNum(v, Math.abs(v) >= 10000 ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 2 });
  const isDark = () => doc.documentElement.classList.contains('dark');

  function openExternal(url) {
    const a = h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' });
    doc.body.append(a); a.click(); a.remove();
  }

  /* ---------- user edits survive a reload ---------- */
  const userStore = {
    read() { try { const v = JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); return isObj(v) ? v : {}; } catch { return {}; } },
    get(id) { const v = this.read()[id]; return isObj(v?.values) ? v.values : null; },
    put(id, values) {
      try {
        const all = this.read();
        all[id] = { at: Date.now(), values };
        const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
        for (const k of keys.slice(150)) delete all[k];
        const text = JSON.stringify(all);
        if (text.length < 400000) localStorage.setItem(STATE_KEY, text);
      } catch { /* storage full or blocked */ }
    },
  };

  /* ---------- versions ---------- */
  const calls = new Map(); // toolCallId -> version
  const byTitle = new Map(); // chat|title -> [toolCallId…]
  let seq = 0;
  const chatId = (ctx) => String(ctx?.sessionKey || app?.chat?.main?.id || 'chat');
  const titleKey = (chat, title) => `${chat}|${String(title || '').trim().toLowerCase()}`;

  function latest(key, exceptId) {
    const list = byTitle.get(key) || [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i] !== exceptId && calls.has(list[i])) return calls.get(list[i]);
    return null;
  }

  function track(v) {
    calls.set(v.id, v);
    const list = byTitle.get(v.key) || [];
    if (!list.includes(v.id)) list.push(v.id);
    byTitle.set(v.key, list);
    for (const id of list) if (id !== v.id) calls.get(id)?.supersede(v);
    if (calls.size > MAX_CALLS) {
      for (const [id, old] of calls) {
        if (calls.size <= MAX_CALLS) break;
        if (latest(old.key) !== old) { calls.delete(id); const l = byTitle.get(old.key); if (l) l.splice(l.indexOf(id), 1); }
      }
    }
  }

  /** Carries values the user changed in the previous version into the new state. */
  function carryUserValues(prev, spec) {
    const paths = new Set(prev?.userPaths || []);
    for (const p of paths) {
      const value = C.readPointer(prev.spec.state, p);
      if (value === undefined) continue;
      try { C.setAt(spec.state, C.parsePointer(p), clone(value)); } catch { paths.delete(p); }
    }
    return paths;
  }

  /** Builds the version for a tool call once; the tool's execute and its card share it. */
  function ensureVersion(part, ctx) {
    const id = String(part.toolCallId || `local-${++uid}`);
    if (calls.has(id)) return calls.get(id);
    const args = isObj(part.args) ? part.args : {};
    const tool = String(part.toolName || '').replace(/^ui__/, '');
    const chat = chatId(ctx);
    let title = String(args.title || '').trim();
    let spec = null; let issues = []; let patchErrors = []; let prev = null;
    if (tool === 'present') {
      if (!title) title = `present_${id.slice(-6)}`;
      const tree = args.tree ?? args.ui ?? args.component ?? args.node ?? args.root;
      const r = C.treeToSpec(tree);
      spec = r.spec; issues = r.issues;
    } else {
      if (!title) title = `ui_${id.slice(-6)}`;
      prev = latest(titleKey(chat, title), id);
      const base = isObj(args.spec) ? clone(args.spec) : prev ? clone(prev.spec) : null;
      if (base && !isObj(base.state)) base.state = {};
      const patches = args.patches ?? args.jsonl ?? args.ops;
      const r = patches != null && patches !== '' ? C.applyPatches(base, patches) : { spec: base || C.emptySpec(), errors: [] };
      spec = r.spec; patchErrors = r.errors;
      issues = C.validateSpec(spec).issues;
    }
    if (!isObj(spec.state)) spec.state = {};
    if (!isObj(spec.elements)) spec.elements = {};
    const v = new Version({ id, key: titleKey(chat, title), title, tool, spec, issues, patchErrors, number: (prev?.number || 0) + 1 });
    v.userPaths = carryUserValues(prev, spec);
    const saved = userStore.get(id);
    if (saved) for (const [p, value] of Object.entries(saved)) { try { C.setAt(spec.state, C.parsePointer(p), value); v.userPaths.add(p); } catch { /* path gone */ } }
    track(v);
    return v;
  }

  /* ---------- one drawn version ---------- */
  /** updateModelContext: runtime id -> Map(title -> text), taken by the next user message. */
  const modelContext = new Map();
  function takeModelContext(rt) {
    const m = rt?.id ? modelContext.get(rt.id) : null;
    if (!m || !m.size) return '';
    modelContext.delete(rt.id);
    return `<ui_context>\nWhat the user did in your UIs since their last message:\n${[...m].map(([t, x]) => `- ${t}: ${x}`).join('\n')}\n</ui_context>`;
  }

  class Version {
    constructor(o) {
      Object.assign(this, o);
      this.seq = ++seq;
      this.local = new Map(); // UI-only state (a tab without a binding, map zoom…)
      this.runtimeErrors = [];
      this.el = null; this.body = null; this.superseded = null;
      this._queued = false;
    }

    exprCtx(rctx, event) {
      return { state: this.spec.state, item: rctx?.item, index: rctx?.index, itemPath: rctx?.itemPath, event };
    }

    /** A user change: write the bound state path, remember it, redraw. */
    write(rawProp, value, rctx, opts) {
      const path = C.bindingPath(rawProp, this.exprCtx(rctx));
      if (!path) return false;
      this.setPath(path, value, opts);
      return true;
    }

    setPath(path, value, opts) {
      try { C.setAt(this.spec.state, C.parsePointer(path), clone(value)); } catch (e) { this.runtimeErrors.push(`state ${path}: ${e.message}`); return; }
      this.userPaths.add(path);
      const values = {};
      for (const p of this.userPaths) { const val = C.readPointer(this.spec.state, p); if (val !== undefined) values[p] = val; }
      userStore.put(this.id, values);
      if (opts?.lazy) this.scheduleLazy(); else this.schedule();
    }

    /** Typing redraws after a short pause, never in the middle of an IME composition. */
    scheduleLazy() {
      clearTimeout(this._lazy);
      this._lazy = setTimeout(() => {
        if (this.composing) { this.scheduleLazy(); return; }
        this.render();
      }, 320);
    }

    schedule() {
      clearTimeout(this._lazy);
      if (this._queued) return;
      this._queued = true;
      queueMicrotask(() => { this._queued = false; this.render(); });
    }

    /** Runs the actions bound to an element event. */
    fire(el, event, payload, rctx, domEvent) {
      const raw = el?.on?.[event];
      if (!raw) return;
      const list = Array.isArray(raw) ? raw : [raw];
      for (const b of list.slice(0, 20)) {
        if (!isObj(b)) continue;
        const params = C.resolve(isObj(b.params) ? b.params : {}, this.exprCtx(rctx, payload));
        const path = typeof params.path === 'string' ? params.path : '';
        try {
          switch (b.action) {
            case 'setState':
              if (path) this.setPath(path, params.value === undefined ? null : params.value);
              break;
            case 'toggle':
              if (path) this.setPath(path, !C.truthy(C.readPointer(this.spec.state, path)));
              break;
            case 'pushState': {
              if (!path) break;
              const cur = C.readPointer(this.spec.state, path);
              this.setPath(path, [...(Array.isArray(cur) ? cur : []), params.value]);
              break;
            }
            case 'removeState': {
              const cur = C.readPointer(this.spec.state, path);
              const index = Number(params.index);
              if (path && Array.isArray(cur) && Number.isInteger(index)) this.setPath(path, cur.filter((_, i) => i !== index));
              break;
            }
            case 'sendMessage': {
              // Only a real tap or key press may speak for the user.
              const text = str(params.text ?? params.message).trim();
              if (!text || !domEvent?.isTrusted) break;
              sendFromUI(text.slice(0, 4000));
              break;
            }
            case 'copyText': {
              const text = str(params.text);
              if (text) Promise.resolve(copyText(text)).then(() => toast('Copied', { type: 'success' })).catch(() => toast('Could not copy', { type: 'error' }));
              break;
            }
            case 'updateModelContext': {
              // Quiet context for the agent: the newest text per UI rides on the next user message.
              const text = str(params.text).trim().slice(0, 2000);
              const rt = app?.thread?.runtime;
              if (!text || !rt?.id) break;
              if (!modelContext.has(rt.id)) modelContext.set(rt.id, new Map());
              modelContext.get(rt.id).set(this.title, text);
              break;
            }
            case 'openUrl': {
              const url = httpsUrl(str(params.url));
              if (url && domEvent?.isTrusted) openExternal(url);
              break;
            }
            default: break;
          }
        } catch (e) { this.runtimeErrors.push(`${b.action}: ${e?.message || e}`); }
      }
    }

    /** The card for this version; the same element is reused on every re-render of the thread. */
    card() {
      if (this.el) return this.el;
      this.body = h('div', { class: 'gu-body' });
      this.body.addEventListener('compositionstart', () => { this.composing = true; });
      this.body.addEventListener('compositionend', () => { this.composing = false; });
      this.el = h('div', { class: 'gu-root', 'data-genui': this.title, 'data-version': String(this.number), 'data-tool': this.tool }, this.body);
      this.render();
      if (this.superseded) { const n = this.superseded; this.superseded = null; this.supersede(n); }
      return this.el;
    }

    supersede(newer) {
      this.superseded = newer;
      if (!this.el || this.el.classList.contains('gu-old')) return;
      this.el.classList.add('gu-old');
      const toggle = h('button', { type: 'button', class: 'gu-old-toggle', 'aria-expanded': 'false' }, icon('chevron-down'), h('span', {}, 'Show'));
      const bar = h('div', { class: 'gu-old-bar' },
        h('span', { class: 'gu-old-text' }, icon('arrow-down'), h('span', {}, `${this.title.replace(/[_-]+/g, ' ')}: updated below`)), toggle);
      toggle.addEventListener('click', () => {
        const open = this.el.classList.toggle('gu-old-open');
        toggle.setAttribute('aria-expanded', String(open));
        toggle.lastChild.textContent = open ? 'Hide' : 'Show';
      });
      this.el.prepend(bar);
    }

    render() {
      if (!this.body) return;
      const host = this.body;
      const active = doc.activeElement;
      const focusGid = active && host.contains(active) ? active.getAttribute('data-gid') : null;
      let sel = null;
      try { if (focusGid && typeof active.selectionStart === 'number') sel = [active.selectionStart, active.selectionEnd]; } catch { /* not a text input */ }
      this.runtimeErrors = [];
      const r = new Renderer(this);
      let node;
      try { node = r.draw(); } catch (e) { node = notice(`This view could not be drawn: ${e?.message || e}`, 'danger'); this.runtimeErrors.push(String(e?.message || e)); }
      host.replaceChildren(node);
      if (focusGid) {
        const next = host.querySelector(`[data-gid="${CSS.escape(focusGid)}"]`);
        if (next) { next.focus({ preventScroll: true }); try { if (sel) next.setSelectionRange(sel[0], sel[1]); } catch { /* no selection */ } }
      }
    }

    /** Short plain summary of the values the user changed, for the model. */
    userSummary() {
      const values = {};
      for (const p of this.userPaths) { const val = C.readPointer(this.spec.state, p); if (val !== undefined) values[p] = val; }
      return Object.keys(values).length ? JSON.stringify(values).slice(0, 1500) : '';
    }
  }

  function notice(text, t = 'neutral') {
    return h('p', { class: 'gu-notice', 'data-tone': t }, text);
  }

  /* ---------- the renderer ---------- */
  class Renderer {
    constructor(v) { this.v = v; this.count = 0; }

    draw() {
      const spec = this.v.spec;
      if (!spec.root || !isObj(spec.elements[spec.root])) {
        return notice(this.v.tool === 'present' ? 'Nothing to show.' : 'This view has no root element yet.', 'warning');
      }
      return this.build(spec.root, { gid: '', item: undefined, index: undefined }, 0) || h('div');
    }

    build(id, rctx, depth) {
      const el = this.v.spec.elements[id];
      if (!isObj(el)) return null;
      if (depth > MAX_DEPTH) return notice('This view nests too deeply.', 'warning');
      if (++this.count > 2500) return null;
      const ectx = this.v.exprCtx(rctx);
      if (el.visible !== undefined && !C.checkCondition(el.visible, ectx)) return null;
      const gid = `${rctx.gid}/${id}`;
      const raw = isObj(el.props) ? el.props : {};
      let p;
      try { p = C.resolve(raw, ectx); } catch (e) { p = {}; this.v.runtimeErrors.push(`${id}: ${e.message}`); }
      if (!isObj(p)) p = {};
      const kidIds = Array.isArray(el.children) ? el.children.filter((k) => typeof k === 'string') : [];
      const kids = () => {
        const out = [];
        if (isObj(el.repeat) && typeof el.repeat.path === 'string') {
          const list = C.readPointer(this.v.spec.state, el.repeat.path);
          if (!Array.isArray(list)) return out;
          list.slice(0, MAX_REPEAT).forEach((item, index) => {
            const key = el.repeat.key && isObj(item) && item[el.repeat.key] != null ? str(item[el.repeat.key]) : String(index);
            const sub = { gid: `${gid}[${key}]`, item, index, itemPath: `${el.repeat.path}/${index}` };
            for (const k of kidIds) { const n = this.build(k, sub, depth + 1); if (n) out.push(n); }
          });
          return out;
        }
        for (const k of kidIds) { const n = this.build(k, rctx, depth + 1); if (n) out.push(n); }
        return out;
      };
      const v = this.v;
      const api = {
        id, el, p, raw, rctx, gid, kids, v, r: this,
        on: (event, payload, domEvent) => v.fire(el, event, payload, rctx, domEvent),
        has: (event) => !!el.on?.[event],
        bind: (prop, value, opts) => v.write(raw[prop], value, rctx, opts),
        bound: (prop) => !!C.bindingPath(raw[prop], ectx),
        local: (key, init) => (v.local.has(`${gid}:${key}`) ? v.local.get(`${gid}:${key}`) : init),
        setLocal: (key, value) => { v.local.set(`${gid}:${key}`, value); v.schedule(); },
      };
      const make = Object.prototype.hasOwnProperty.call(R, el.type) ? R[el.type] : null;
      let node;
      try {
        node = make ? make(api) : notice(`Unknown component "${str(el.type)}".`, 'warning');
      } catch (e) {
        v.runtimeErrors.push(`${id} (${el.type}): ${e?.message || e}`);
        node = notice(`${str(el.type)} could not be drawn.`, 'danger');
      }
      if (node && node.nodeType === 1 && !node.hasAttribute('data-el')) node.setAttribute('data-el', id);
      return node;
    }
  }

  /* ---------- small shared pieces ---------- */
  function hash(s) { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return x; }
  const fieldId = (gid) => `gu-${Math.abs(hash(gid)).toString(36)}-${++uid}`;
  const gap = (g, d) => (['none', 'xs', 'sm', 'md', 'lg'].includes(g) ? g : d);
  const emoji = (v) => {
    if (!v) return null;
    const name = iconName(v);
    if (name) return h('span', { class: 'gu-emoji gu-glyph', 'aria-hidden': 'true' }, icon(name));
    return h('span', { class: 'gu-emoji', 'aria-hidden': 'true' }, Array.from(str(v)).slice(0, 2).join(''));
  };
  const ext = (href, kids, cls) => h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' }, kids);

  function field(api, control, label) {
    const id = control.id || (control.id = fieldId(api.gid));
    return h('div', { class: 'gu-field' }, label ? h('label', { class: 'gu-label', for: id }, label) : null, control);
  }

  function options(list) {
    return (Array.isArray(list) ? list : []).slice(0, 200).map((o) => (isObj(o)
      ? { value: str(o.value ?? o.label), label: str(o.label ?? o.value), description: o.description ? str(o.description) : '' }
      : { value: str(o), label: str(o), description: '' }));
  }

  /* ---------- chart (SVG, redrawn at its real width) ---------- */
  function chartData(p) {
    let labels; let series;
    if (Array.isArray(p.series) && p.series.length) {
      labels = (Array.isArray(p.labels) ? p.labels : []).slice(0, 120).map(str);
      series = p.series.slice(0, 6).map((s, i) => ({
        name: str(isObj(s) ? s.name ?? `Series ${i + 1}` : `Series ${i + 1}`),
        values: (isObj(s) ? s.values ?? s.data ?? [] : Array.isArray(s) ? s : []).slice(0, 120).map((x) => numOr(x, null)),
      }));
    } else {
      const data = (Array.isArray(p.data) ? p.data : []).slice(0, 120);
      labels = data.map((d, i) => (isObj(d) ? str(d.label ?? d.name ?? d.x ?? '') : Array.isArray(p.labels) ? str(p.labels[i] ?? '') : ''));
      series = [{ name: str(p.title || 'Value'), values: data.map((d) => numOr(isObj(d) ? d.value ?? d.y : d, null)) }];
    }
    const n = Math.max(labels.length, ...series.map((s) => s.values.length));
    while (labels.length < n) labels.push('');
    return { labels, series, n };
  }

  function niceTicks(min, max, count = 4) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
    if (min === max) { if (min === 0) max = 1; else if (min > 0) min = 0; else max = 0; }
    const step0 = (max - min) / count;
    const mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0 * 0.999) || step0;
    const lo = Math.floor(min / step + 1e-9) * step;
    const hi = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let t = lo; t <= hi + step / 2 && ticks.length < 12; t += step) ticks.push(+t.toFixed(10));
    return ticks.length > 1 ? ticks : [lo, lo + step];
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs = {}, ...kids) {
    const n = doc.createElementNS(SVGNS, tag);
    for (const [k, val] of Object.entries(attrs)) if (val != null) n.setAttribute(k, String(val));
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }
  const svgTitle = (t) => svg('title', {}, t);
  const CHART_TYPES = ['bar', 'line', 'area', 'pie', 'donut', 'sparkline'];

  function drawChart(p, width) {
    const type = CHART_TYPES.includes(p.type) ? p.type : 'bar';
    const { labels, series, n } = chartData(p);
    const unit = p.unit ? str(p.unit) : '';
    const short = unit && Array.from(unit).length <= 2 ? unit : '';
    const fmt = (x) => (x == null ? '–' : `${compact(x)}${short}`);
    const H = clamp(numOr(p.height, 180), 120, 360);
    const W = Math.max(200, Math.round(width || 320));
    if (!n || series.every((s) => s.values.every((x) => x == null))) return h('p', { class: 'gu-hint' }, 'No data.');
    if (type === 'sparkline') {
      const vals = series[0].values;
      const nums = vals.filter((x) => x != null);
      const lo = Math.min(...nums); const hi = Math.max(...nums);
      const SH = clamp(numOr(p.height, 48), 32, 120); const pad = 4;
      const sw = Math.max(120, W - 96);
      const X = (i) => pad + (vals.length > 1 ? (i / (vals.length - 1)) * (sw - 2 * pad) : (sw - 2 * pad) / 2);
      const Y = (x) => pad + (hi === lo ? (SH - 2 * pad) / 2 : (1 - (x - lo) / (hi - lo)) * (SH - 2 * pad));
      const pts = vals.map((x, i) => (x == null ? null : [X(i), Y(x)])).filter(Boolean);
      const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
      const last = pts[pts.length - 1];
      const first = nums[0]; const end = nums[nums.length - 1];
      const dir = end > first ? 'up' : end < first ? 'down' : 'flat';
      const g = svg('svg', { viewBox: `0 0 ${sw} ${SH}`, width: sw, height: SH, class: 'gu-spark', 'aria-hidden': 'true', preserveAspectRatio: 'none' },
        svg('path', { d: `${line} L ${last[0].toFixed(1)} ${SH - pad} L ${pts[0][0].toFixed(1)} ${SH - pad} Z`, class: 'gu-spark-area' }),
        svg('path', { d: line, class: 'gu-spark-line' }),
        svg('circle', { cx: last[0].toFixed(1), cy: last[1].toFixed(1), r: 3, class: 'gu-spark-dot' }));
      return h('div', { class: 'gu-spark-wrap' }, g, h('span', { class: 'gu-spark-value', 'data-dir': dir }, fmt(end), h('span', { class: 'gu-muted gu-spark-range' }, `${fmt(lo)}–${fmt(hi)}`)));
    }
    if (type === 'pie' || type === 'donut') {
      const vals = series[0].values.map((x) => Math.max(0, x || 0));
      const total = vals.reduce((a, b) => a + b, 0) || 1;
      const r = Math.min(H / 2 - 4, 100); const cx = r + 4; const cy = r + 4; const inner = type === 'donut' ? r * 0.6 : 0;
      const g = svg('svg', { viewBox: `0 0 ${2 * r + 8} ${2 * r + 8}`, width: 2 * r + 8, height: 2 * r + 8, class: 'gu-pie', 'aria-hidden': 'true' });
      const pt = (rad, a) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
      let a0 = -Math.PI / 2;
      vals.forEach((val, i) => {
        if (val <= 0) return;
        const frac = val / total;
        const a1 = a0 + frac * Math.PI * 2;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        let d;
        if (frac >= 0.9999) {
          d = `M ${pt(r, 0)} A ${r} ${r} 0 1 1 ${pt(r, Math.PI)} A ${r} ${r} 0 1 1 ${pt(r, 0)} Z`;
          if (inner) d += ` M ${pt(inner, 0)} A ${inner} ${inner} 0 1 0 ${pt(inner, Math.PI)} A ${inner} ${inner} 0 1 0 ${pt(inner, 0)} Z`;
        } else if (inner) {
          d = `M ${pt(r, a0)} A ${r} ${r} 0 ${large} 1 ${pt(r, a1)} L ${pt(inner, a1)} A ${inner} ${inner} 0 ${large} 0 ${pt(inner, a0)} Z`;
        } else {
          d = `M ${cx} ${cy} L ${pt(r, a0)} A ${r} ${r} 0 ${large} 1 ${pt(r, a1)} Z`;
        }
        g.append(svg('path', { d, class: `gu-s${i % 8} gu-slice`, 'fill-rule': 'evenodd' }, svgTitle(`${labels[i]}: ${fmt(val)} (${Math.round(frac * 100)}%)`)));
        a0 = a1;
      });
      const legend = h('ul', { class: 'gu-legend gu-legend-col' }, vals.map((val, i) => h('li', {},
        h('span', { class: `gu-swatch gu-s${i % 8}` }), h('span', { class: 'gu-legend-label' }, labels[i] || `#${i + 1}`),
        h('span', { class: 'gu-legend-value' }, `${fmt(val)} · ${Math.round((val / total) * 100)}%`))));
      return h('div', { class: 'gu-pie-wrap' }, g, legend);
    }
    const stacked = !!p.stacked && type !== 'line';
    const all = [];
    if (stacked) {
      for (let i = 0; i < n; i++) { let pos = 0; let neg = 0; for (const s of series) { const x = s.values[i] || 0; if (x >= 0) pos += x; else neg += x; } all.push(pos, neg); }
    } else for (const s of series) for (const x of s.values) if (x != null) all.push(x);
    const dMin = Math.min(...all); const dMax = Math.max(...all);
    // Bars and areas start at zero; a line may zoom into its own range.
    const zero = type !== 'line' || (dMin >= 0 && dMin < dMax * 0.35) || dMin < 0;
    const ticks = niceTicks(zero ? Math.min(0, dMin) : dMin, zero ? Math.max(0, dMax) : dMax);
    const tMin = ticks[0]; const tMax = ticks[ticks.length - 1];
    const labelW = Math.min(70, Math.max(...ticks.map((t) => fmt(t).length)) * 6.2 + 10);
    const pad = { l: labelW, r: 8, t: 8, b: 24 };
    const pw = W - pad.l - pad.r; const ph = H - pad.t - pad.b;
    const y = (val) => pad.t + ph - ((val - tMin) / (tMax - tMin || 1)) * ph;
    const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'gu-chart-svg', 'aria-hidden': 'true' });
    for (const t of ticks) {
      g.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(t).toFixed(1), y2: y(t).toFixed(1), class: t === 0 ? 'gu-axis' : 'gu-gridline' }));
      g.append(svg('text', { x: pad.l - 6, y: (y(t) + 3.5).toFixed(1), 'text-anchor': 'end', class: 'gu-tick' }, fmt(t)));
    }
    const band = pw / n;
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 48))));
    labels.forEach((l, i) => {
      if (i % every) return;
      const x = pad.l + band * i + band / 2;
      g.append(svg('text', { x: x.toFixed(1), y: H - 7, 'text-anchor': 'middle', class: 'gu-tick' }, l.length > 9 ? `${l.slice(0, 8)}…` : l));
    });
    const tip = (s, i) => svgTitle(`${series.length > 1 ? `${s.name}, ` : ''}${labels[i] ? `${labels[i]}: ` : ''}${fmt(s.values[i])}${unit && !short ? ` ${unit}` : ''}`);
    if (type === 'bar') {
      const groupW = band * 0.74;
      const bw = stacked ? groupW : groupW / series.length;
      for (let i = 0; i < n; i++) {
        let pos = 0; let neg = 0;
        series.forEach((s, si) => {
          const val = s.values[i];
          if (val == null) return;
          let y0; let y1;
          if (stacked) { if (val >= 0) { y0 = pos; pos += val; y1 = pos; } else { y0 = neg; neg += val; y1 = neg; } } else { y0 = 0; y1 = val; }
          const x = pad.l + band * i + (band - groupW) / 2 + (stacked ? 0 : bw * si);
          const top = Math.min(y(y0), y(y1)); const hgt = Math.max(1, Math.abs(y(y1) - y(y0)));
          g.append(svg('rect', { x: (x + 0.5).toFixed(1), y: top.toFixed(1), width: Math.max(1, bw - 1).toFixed(1), height: hgt.toFixed(1), rx: Math.min(3, bw / 4).toFixed(1), class: `gu-s${si % 8}` }, tip(s, i)));
        });
      }
    } else {
      const cum = new Array(n).fill(0);
      series.forEach((s, si) => {
        const pts = s.values.map((val, i) => {
          if (val == null) return null;
          const base = stacked ? cum[i] : Math.max(tMin, Math.min(0, tMax));
          const top = (stacked ? cum[i] : 0) + val;
          if (stacked) cum[i] = top;
          return [pad.l + band * i + band / 2, y(top), y(base)];
        });
        const segs = []; let cur = [];
        for (const pt of pts) { if (pt) cur.push(pt); else if (cur.length) { segs.push(cur); cur = []; } }
        if (cur.length) segs.push(cur);
        for (const seg of segs) {
          const line = seg.map((pt, i) => `${i ? 'L' : 'M'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(' ');
          if (type === 'area') {
            const back = seg.slice().reverse().map((pt) => `L${pt[0].toFixed(1)} ${pt[2].toFixed(1)}`).join(' ');
            g.append(svg('path', { d: `${line} ${back} Z`, class: `gu-area gu-s${si % 8}` }));
          }
          g.append(svg('path', { d: line, class: `gu-line gu-st${si % 8}` }));
          if (seg.length <= 40) for (const pt of seg) g.append(svg('circle', { cx: pt[0].toFixed(1), cy: pt[1].toFixed(1), r: 2.75, class: `gu-dot gu-s${si % 8}` }));
        }
      });
      // One hit area per x position, with every series in its tooltip.
      for (let i = 0; i < n; i++) {
        const text = series.map((s) => `${series.length > 1 ? `${s.name}: ` : ''}${fmt(s.values[i])}`).join(', ');
        g.append(svg('rect', { x: (pad.l + band * i).toFixed(1), y: pad.t, width: band.toFixed(1), height: ph, class: 'gu-hit' }, svgTitle(`${labels[i] ? `${labels[i]}: ` : ''}${text}`)));
      }
    }
    const wrap = h('div', { class: 'gu-chart-plot' }, g);
    if (series.length > 1) wrap.append(h('ul', { class: 'gu-legend' }, series.map((s, i) => h('li', {}, h('span', { class: `gu-swatch gu-s${i % 8}` }), h('span', { class: 'gu-legend-label' }, s.name)))));
    return wrap;
  }

  function chartTable(p) {
    const { labels, series } = chartData(p);
    return h('table', { class: 'sr-only' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Label'), series.map((s) => h('th', {}, s.name)))),
      h('tbody', {}, labels.map((l, i) => h('tr', {}, h('th', {}, l), series.map((s) => h('td', {}, s.values[i] == null ? '' : String(s.values[i])))))));
  }

  /* ---------- map (CARTO raster tiles: light and dark, OpenStreetMap data) ---------- */
  const TILE = 256;
  function worldPx(lat, lon, z) {
    const s = TILE * 2 ** z;
    const sin = Math.sin((clamp(lat, -85.05, 85.05) * Math.PI) / 180);
    return [((lon + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
  }
  function tileUrl(x, y, z) {
    const n = 2 ** z; const xx = ((x % n) + n) % n;
    return `https://${'abcd'[(xx + y) % 4]}.basemaps.cartocdn.com/${isDark() ? 'dark_all' : 'light_all'}/${z}/${xx}/${y}@2x.png`;
  }

  /* ---------- forecasts from get_weather results in this chat ---------- */
  const weatherCache = new Map();
  function parseData(result) {
    let value = result;
    if (isObj(value) && Array.isArray(value.content)) value = value.content.map((c) => c?.text || '').join('\n');
    if (typeof value === 'string') {
      // Text first, then the JSON (a long result is wrapped in an untrusted tag).
      const i = value.indexOf('\n{') >= 0 ? value.indexOf('\n{') + 1 : value.indexOf('{');
      const j = value.lastIndexOf('}');
      if (i < 0 || j < i) return null;
      try { value = JSON.parse(value.slice(i, j + 1)); } catch { return null; }
    }
    return isObj(value) ? value : null;
  }
  function rememberData(result) {
    const data = parseData(result);
    if (data?.id && (data.current || data.daily)) weatherCache.set(String(data.id), data);
    return data;
  }
  function findWeather(id) {
    if (!id) return null;
    if (weatherCache.has(id)) return weatherCache.get(id);
    const threads = app?.chat?.runtimes ? [...app.chat.runtimes.values()] : [app?.chat?.main];
    for (const m of threads.flatMap((rt) => rt?.messages || [])) {
      for (const part of Array.isArray(m?.content) ? m.content : []) {
        if (part?.type !== 'tool-call' || !/get_weather$/.test(part.toolName || '') || part.result == null) continue;
        const data = rememberData(part.result);
        if (data?.id === id) return data;
      }
    }
    return null;
  }
  const WEMOJI = { sun: '\u2600\uFE0F', 'cloud-sun': '\u26C5', cloud: '\u2601\uFE0F', fog: '\uD83C\uDF2B\uFE0F', drizzle: '\uD83C\uDF26\uFE0F', rain: '\uD83C\uDF27\uFE0F', snow: '\uD83C\uDF28\uFE0F', storm: '\u26C8\uFE0F' };
  function wmo(code) {
    const w = C.weatherCode(code);
    const key = String((Array.isArray(w) ? w[1] : w?.icon) || '');
    const label = (Array.isArray(w) ? w[0] : w?.label) || 'Unknown';
    let e = WEMOJI.cloud;
    if (/storm|lightning|thunder/.test(key)) e = WEMOJI.storm;
    else if (/snow/.test(key)) e = WEMOJI.snow;
    else if (/drizzle/.test(key)) e = WEMOJI.drizzle;
    else if (/rain|shower/.test(key)) e = WEMOJI.rain;
    else if (/fog/.test(key)) e = WEMOJI.fog;
    else if (/sun/.test(key) && /cloud/.test(key)) e = WEMOJI['cloud-sun'];
    else if (/sun|clear/.test(key)) e = WEMOJI.sun;
    return { label, emoji: e };
  }
  const dayName = (iso, i) => {
    if (i === 0) return 'Today';
    const d = new Date(`${iso}T12:00:00`);
    return Number.isNaN(d.getTime()) ? str(iso) : d.toLocaleDateString(undefined, { weekday: 'short' });
  };

  /* ---------- components ---------- */
  const R = {
    Stack(a) {
      return h('div', { class: 'gu-stack', 'data-dir': a.p.direction === 'horizontal' ? 'row' : 'col', 'data-gap': gap(a.p.gap, 'md'), 'data-align': a.p.align || '', 'data-wrap': a.p.wrap ? '1' : '' }, a.kids());
    },
    Row(a) {
      return h('div', { class: 'gu-stack', 'data-dir': 'row', 'data-gap': gap(a.p.gap, 'sm'), 'data-align': a.p.align || 'center', 'data-justify': a.p.justify || '', 'data-wrap': a.p.wrap === false ? '' : '1' }, a.kids());
    },
    Grid(a) {
      const cols = clamp(Math.round(numOr(a.p.columns, 2)), 1, 4);
      return h('div', { class: 'gu-grid', 'data-gap': gap(a.p.gap, 'sm'), style: `--gu-cols:${cols}` }, a.kids());
    },
    Card(a) {
      const head = a.p.title || a.p.subtitle ? h('div', { class: 'gu-card-head' }, emoji(a.p.icon),
        h('div', { class: 'gu-card-titles' }, a.p.title ? h('h3', { class: 'gu-card-title' }, str(a.p.title)) : null, a.p.subtitle ? h('p', { class: 'gu-card-sub' }, str(a.p.subtitle)) : null)) : null;
      const kids = a.kids();
      const node = h('div', { class: 'gu-card', 'data-variant': ['muted', 'outline', 'accent'].includes(a.p.variant) ? a.p.variant : 'default' }, head, kids.length ? h('div', { class: 'gu-card-body' }, kids) : null);
      if (a.has('press')) {
        node.setAttribute('role', 'button'); node.tabIndex = 0; node.dataset.press = '1'; node.dataset.gid = a.gid;
        node.addEventListener('click', (e) => { if (!e.target.closest('button, a, input, select, textarea, label')) a.on('press', {}, e); });
        node.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === node) { e.preventDefault(); a.on('press', {}, e); } });
      }
      return node;
    },
    Section(a) {
      return h('section', { class: 'gu-section' },
        a.p.title ? h('h3', { class: 'gu-section-title' }, str(a.p.title)) : null,
        a.p.description ? h('p', { class: 'gu-muted' }, str(a.p.description)) : null,
        h('div', { class: 'gu-stack', 'data-dir': 'col', 'data-gap': 'sm' }, a.kids()));
    },
    Tabs(a) {
      const tabs = options(a.p.tabs);
      const kids = a.kids();
      const toIndex = (v) => {
        if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v) && !tabs.some((t) => t.value === v))) return clamp(Math.round(Number(v)), 0, Math.max(0, tabs.length - 1));
        const i = tabs.findIndex((t) => t.value === str(v) || t.label === str(v));
        return i < 0 ? 0 : i;
      };
      const index = toIndex(a.bound('value') ? a.p.value ?? 0 : a.local('tab', a.p.value ?? 0));
      const base = fieldId(a.gid);
      const pick = (i, e) => {
        if (!tabs[i]) return;
        if (!a.bind('value', i)) a.setLocal('tab', i);
        a.on('change', { value: i, label: tabs[i].label }, e);
      };
      const list = h('div', { class: 'gu-tabs', role: 'tablist' }, tabs.map((t, i) => {
        const b = h('button', { type: 'button', role: 'tab', id: `${base}-t${i}`, 'aria-controls': `${base}-p`, 'aria-selected': String(i === index), tabindex: i === index ? '0' : '-1', class: 'gu-tab', 'data-gid': `${a.gid}#${i}` }, t.label);
        b.addEventListener('click', (e) => pick(i, e));
        b.addEventListener('keydown', (e) => {
          const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
          let next = null;
          if (step) next = (i + step + tabs.length) % tabs.length; else if (e.key === 'Home') next = 0; else if (e.key === 'End') next = tabs.length - 1;
          if (next == null) return;
          e.preventDefault();
          b.parentElement.children[next]?.focus();
          pick(next, e);
        });
        return b;
      }));
      return h('div', { class: 'gu-tabs-wrap' }, list, h('div', { class: 'gu-tab-panel', role: 'tabpanel', id: `${base}-p`, 'aria-labelledby': `${base}-t${index}` }, kids[index] || null));
    },
    Collapsible(a) {
      const open = a.local('open', !!a.p.open);
      const d = h('details', { class: 'gu-collapsible', ...(open ? { open: true } : {}) },
        h('summary', { class: 'gu-collapsible-head', 'data-gid': a.gid }, h('span', {}, str(a.p.title || 'Details')), icon('chevron-down')),
        h('div', { class: 'gu-collapsible-body' }, a.kids()));
      d.addEventListener('toggle', () => a.v.local.set(`${a.gid}:open`, d.open));
      return d;
    },
    Divider(a) {
      return a.p.label ? h('div', { class: 'gu-divider', role: 'separator' }, h('span', {}, str(a.p.label))) : h('hr', { class: 'gu-hr' });
    },
    Spacer(a) { return h('div', { class: 'gu-spacer', 'data-size': ['xs', 'sm', 'md', 'lg', 'xl'].includes(a.p.size) ? a.p.size : 'md', 'aria-hidden': 'true' }); },

    Header(a) {
      const img = mediaUrl(str(a.p.image));
      const kids = a.kids();
      return h('header', { class: 'gu-header', 'data-tone': tone(a.p.tone, 'neutral'), 'data-image': img ? '1' : '' },
        img ? h('img', { class: 'gu-header-img', src: img, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null,
        h('div', { class: 'gu-header-text' },
          a.p.eyebrow ? h('p', { class: 'gu-eyebrow' }, str(a.p.eyebrow)) : null,
          h('div', { class: 'gu-header-row' }, emoji(a.p.icon), h('h2', { class: 'gu-header-title' }, str(a.p.title)), a.p.badge ? h('span', { class: 'gu-badge', 'data-tone': 'accent' }, str(a.p.badge)) : null),
          a.p.subtitle ? h('p', { class: 'gu-header-sub' }, str(a.p.subtitle)) : null,
          kids.length ? h('div', { class: 'gu-header-extra' }, kids) : null));
    },
    Heading(a) {
      const level = clamp(Math.round(numOr(a.p.level, 2)), 1, 4);
      return h(`h${level + 2}`, { class: 'gu-heading', 'data-level': String(level) }, str(a.p.text));
    },
    Text(a) {
      return h('p', { class: 'gu-text', 'data-tone': a.p.tone && a.p.tone !== 'default' ? str(a.p.tone) : '', 'data-size': str(a.p.size || ''), 'data-weight': str(a.p.weight || ''), 'data-align': str(a.p.align || ''), 'data-mono': a.p.mono ? '1' : '' }, str(a.p.text));
    },
    Markdown(a) {
      const box = h('div', { class: 'gu-markdown aui-md' });
      try { Markdown.render(box, str(a.p.text)); } catch { box.textContent = str(a.p.text); }
      return box;
    },
    Badge(a) { return h('span', { class: 'gu-badge', 'data-tone': tone(a.p.tone) }, str(a.p.text)); },
    Alert(a) {
      const t = tone(a.p.tone, 'info');
      const ic = { success: 'circle-check', warning: 'triangle-alert', danger: 'circle-x' }[t] || 'info';
      return h('div', { class: 'gu-alert', 'data-tone': t, role: t === 'danger' || t === 'warning' ? 'alert' : 'note' }, icon(ic),
        h('div', { class: 'gu-alert-text' }, a.p.title ? h('p', { class: 'gu-alert-title' }, str(a.p.title)) : null, a.p.text ? h('p', {}, str(a.p.text)) : null));
    },
    Image(a) {
      const src = mediaUrl(str(a.p.src));
      const aspect = { square: '1 / 1', wide: '16 / 9', video: '16 / 9', portrait: '3 / 4' }[a.p.aspect] || '';
      const fallback = () => h('div', { class: 'gu-img-missing', role: 'img', 'aria-label': str(a.p.alt || 'Image unavailable') }, str(a.p.alt || 'Image unavailable'));
      const img = src ? h('img', { src, alt: str(a.p.alt), loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', style: aspect ? `aspect-ratio:${aspect}` : '', onerror: (e) => e.target.replaceWith(fallback()) }) : fallback();
      const href = httpsUrl(str(a.p.href));
      return h('figure', { class: 'gu-figure' }, href ? ext(href, img) : img, a.p.caption ? h('figcaption', {}, str(a.p.caption)) : null);
    },
    Link(a) {
      const href = linkUrl(str(a.p.href));
      if (!href) return h('span', { class: 'gu-text' }, str(a.p.label || a.p.href));
      return ext(href, [h('span', {}, str(a.p.label || href.replace(/^https?:\/\//, ''))), icon('external-link')], 'gu-link');
    },
    Code(a) {
      const code = str(a.p.code);
      const c = h('code', {});
      try { c.innerHTML = Markdown.highlight(code, str(a.p.language)); } catch { c.textContent = code; }
      const copy = h('button', { type: 'button', class: 'gu-icon-btn gu-code-copy', 'aria-label': 'Copy code', title: 'Copy' }, icon('copy'));
      copy.addEventListener('click', () => Promise.resolve(copyText(code)).then(() => toast('Copied', { type: 'success' })).catch(() => {}));
      return h('div', { class: 'gu-code-wrap' }, h('div', { class: 'gu-code-head' }, h('span', { class: 'gu-code-lang' }, str(a.p.language || 'code')), copy), h('pre', { class: 'gu-code', tabindex: '0' }, c));
    },

    Diagram(a) {
      const code = str(a.p.code).replace(/^```(?:mermaid)?\s*/i, '').replace(/```\s*$/, '').trim();
      const box = h('div', { class: 'gu-diagram aui-md' });
      if (!code) return notice('This diagram has no Mermaid code.', 'warning');
      try { Markdown.render(box, `\`\`\`mermaid\n${code}\n\`\`\``); } catch { box.replaceChildren(h('pre', { class: 'gu-code', tabindex: '0' }, h('code', {}, code))); }
      return h('figure', { class: 'gu-figure gu-diagram-fig' }, a.p.title ? h('figcaption', { class: 'gu-chart-title' }, str(a.p.title)) : null, box);
    },
    Icon(a) {
      const name = iconName(a.p.name);
      const size = ['sm', 'md', 'lg'].includes(a.p.size) ? a.p.size : 'md';
      const label = str(a.p.label || '');
      const kid = name ? icon(name) : Array.from(str(a.p.name)).slice(0, 2).join('') || '\u2022';
      return h('span', { class: 'gu-icon', 'data-size': size, 'data-tone': a.p.tone && a.p.tone !== 'default' ? tone(a.p.tone) : '', ...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' }) }, kid);
    },

    Facts(a) {
      const items = (Array.isArray(a.p.items) ? a.p.items : []).slice(0, 100);
      return h('dl', { class: 'gu-facts', 'data-cols': numOr(a.p.columns, 1) >= 2 ? '2' : '1' }, items.map((it) => h('div', { class: 'gu-fact' },
        h('dt', {}, str(isObj(it) ? it.label ?? it.name ?? '' : it), isObj(it) && it.hint ? h('span', { class: 'gu-fact-hint' }, str(it.hint)) : null), h('dd', {}, str(isObj(it) ? it.value ?? '' : '')))));
    },
    Stat(a) {
      const trend = ['up', 'down', 'flat'].includes(a.p.trend) ? a.p.trend : '';
      const good = a.p.good === 'down' ? 'down' : 'up';
      const sentiment = !trend || trend === 'flat' || a.p.good === 'neutral' ? 'neutral' : trend === good ? 'success' : 'danger';
      return h('div', { class: 'gu-stat' },
        h('p', { class: 'gu-stat-label' }, str(a.p.label)),
        h('p', { class: 'gu-stat-value' }, str(a.p.value)),
        a.p.delta != null && a.p.delta !== '' ? h('p', { class: 'gu-stat-delta', 'data-tone': sentiment },
          trend === 'up' ? icon('arrow-up') : trend === 'down' ? icon('arrow-down') : null, h('span', {}, str(a.p.delta)),
          sentiment !== 'neutral' ? h('span', { class: 'sr-only' }, sentiment === 'success' ? ' (better)' : ' (worse)') : null) : null,
        a.p.hint ? h('p', { class: 'gu-hint' }, str(a.p.hint)) : null);
    },
    Table(a) {
      const rows = (Array.isArray(a.p.rows) ? a.p.rows : []).slice(0, 500);
      let cols = (Array.isArray(a.p.columns) ? a.p.columns : []).map((c) => (isObj(c) ? { key: str(c.key ?? c.label), label: str(c.label ?? c.key), format: c.format, align: c.align } : { key: str(c), label: str(c) }));
      if (!cols.length && rows.length && isObj(rows[0])) cols = Object.keys(rows[0]).map((k) => ({ key: k, label: k }));
      const currency = /^[A-Z]{3}$/.test(str(a.p.currency)) ? a.p.currency : 'USD';
      const valueOf = (row, c, i) => (Array.isArray(row) ? row[i] : isObj(row) ? row[c.key] : i === 0 ? row : '');
      const cell = (val, c) => {
        if (c.format === 'date' && val != null && val !== '') {
          const d = new Date(typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val) ? `${val}T12:00:00` : val);
          if (!Number.isNaN(d.getTime())) return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        }
        if (typeof val === 'number') {
          if (c.format === 'currency') return fmtNum(val, { style: 'currency', currency });
          if (c.format === 'percent') return fmtNum(val, { style: 'percent', maximumFractionDigits: 1 });
          return fmtNum(val, { maximumFractionDigits: 2 });
        }
        if (typeof val === 'boolean') return val ? 'Yes' : 'No';
        return str(val);
      };
      const numeric = cols.map((c, i) => c.align === 'end' || c.align === 'right' || (c.align == null && rows.some((r) => typeof valueOf(r, c, i) === 'number')));
      const sortable = !!a.p.sortable && cols.length > 0;
      const sort = sortable ? a.local('sort', null) : null;
      let shown = rows;
      if (sort && cols[sort.col]) {
        const c = cols[sort.col];
        const key = (r) => { const x = valueOf(r, c, sort.col); if (typeof x === 'number') return x; if (c.format === 'date') { const t = Date.parse(x); if (Number.isFinite(t)) return t; } const n = typeof x === 'string' ? Number(x.replace(/[^0-9.+-]/g, '')) : NaN; return numeric[sort.col] && x !== '' && Number.isFinite(n) ? n : str(x).toLowerCase(); };
        shown = rows.map((r, i) => [r, i]).sort(([ra, ia], [rb, ib]) => {
          const ka = key(ra), kb = key(rb);
          const d = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb), undefined, { numeric: true });
          return (d || ia - ib) * (sort.dir === 'desc' ? -1 : 1);
        }).map(([r]) => r);
      }
      const head = (c, i) => {
        if (!sortable) return h('th', { scope: 'col', 'data-num': numeric[i] ? '1' : '' }, c.label);
        const dir = sort?.col === i ? sort.dir : '';
        const b = h('button', { type: 'button', class: 'gu-sort', 'data-gid': `${a.gid}s${i}` }, h('span', {}, c.label), icon(dir === 'asc' ? 'arrow-up' : dir === 'desc' ? 'arrow-down' : 'chevron-down'));
        b.addEventListener('click', () => a.setLocal('sort', { col: i, dir: dir === 'asc' ? 'desc' : 'asc' }));
        return h('th', { scope: 'col', 'data-num': numeric[i] ? '1' : '', 'aria-sort': dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none' }, b);
      };
      const table = h('table', { class: 'gu-table' },
        a.p.caption ? h('caption', {}, str(a.p.caption)) : null,
        h('thead', {}, h('tr', {}, cols.map(head))),
        h('tbody', {}, shown.map((row) => h('tr', {}, cols.map((c, i) => h(i === 0 ? 'th' : 'td', { ...(i === 0 ? { scope: 'row' } : {}), 'data-num': numeric[i] ? '1' : '' }, cell(valueOf(row, c, i), c)))))));
      return h('div', { class: 'gu-table-wrap', tabindex: '0', role: 'region', 'aria-label': str(a.p.caption || 'Table') }, table);
    },
    List(a) {
      const items = (Array.isArray(a.p.items) ? a.p.items : []).slice(0, 200);
      const variant = ['plain', 'divided', 'cards', 'check', 'bullet'].includes(a.p.variant) ? a.p.variant : 'divided';
      return h(a.p.ordered ? 'ol' : 'ul', { class: 'gu-list', 'data-variant': variant }, items.map((it) => {
        const o = isObj(it) ? it : { title: it };
        const img = mediaUrl(str(o.image));
        const href = httpsUrl(str(o.href ?? o.url));
        const done = o.done !== false;
        const lead = variant === 'check' ? icon(done ? 'circle-check' : 'circle')
          : img ? h('img', { class: 'gu-list-img', src: img, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() })
            : o.icon ? h('span', { class: 'gu-list-icon', 'aria-hidden': 'true' }, Array.from(str(o.icon)).slice(0, 2).join('')) : null;
        const body = [lead,
          h('span', { class: 'gu-list-text' }, h('span', { class: 'gu-list-title' }, str(o.title ?? o.text ?? o.label)), o.description ? h('span', { class: 'gu-muted gu-list-desc' }, str(o.description)) : null),
          o.meta != null && o.meta !== '' ? h('span', { class: 'gu-list-meta' }, str(o.meta)) : null,
          href ? icon('chevron-right') : null];
        return h('li', { 'data-done': variant === 'check' && done ? '1' : '' }, href ? ext(href, body, 'gu-list-link') : body);
      }));
    },
    Chart(a) {
      const p = a.p;
      const type = CHART_TYPES.includes(p.type) ? p.type : 'bar';
      const host = h('div', { class: 'gu-chart-host' });
      const box = h('figure', { class: 'gu-chart', 'data-type': type },
        p.title ? h('figcaption', { class: 'gu-chart-title' }, str(p.title), p.unit ? h('span', { class: 'gu-muted' }, ` (${str(p.unit)})`) : null) : null,
        host, chartTable(p));
      host.setAttribute('role', 'img');
      host.setAttribute('aria-label', `${str(p.title || 'Chart')}, ${type} chart. The data follows as a table.`);
      let lastW = 0;
      const draw = (w) => { lastW = w; host.replaceChildren(drawChart(p, w)); };
      draw(a.v.chartWidth || 320);
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver((entries) => {
          if (!host.isConnected) { ro.disconnect(); return; }
          const w = Math.round(entries[0]?.contentRect?.width || 0);
          if (w && Math.abs(w - lastW) > 2) { a.v.chartWidth = w; draw(w); }
        });
        ro.observe(host);
      }
      return box;
    },
    Progress(a) {
      const max = numOr(a.p.max, 100) || 100;
      const val = clamp(numOr(a.p.value, 0), 0, max);
      const pct = Math.round((val / max) * 100);
      return h('div', { class: 'gu-progress', 'data-tone': tone(a.p.tone, 'accent') },
        h('div', { class: 'gu-progress-head' }, h('span', {}, str(a.p.label || '')), a.p.showValue === false ? null : h('span', { class: 'gu-muted' }, `${pct}%`)),
        h('div', { class: 'gu-progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(val), 'aria-label': str(a.p.label || 'Progress') },
          h('div', { class: 'gu-progress-fill', style: `width:${pct}%` })));
    },
    Timeline(a) {
      const items = (Array.isArray(a.p.items) ? a.p.items : []).slice(0, 100);
      return h('ol', { class: 'gu-timeline' }, items.map((it) => {
        const o = isObj(it) ? it : { title: it };
        return h('li', { 'data-tone': tone(o.tone, 'neutral') }, h('span', { class: 'gu-tl-dot', 'aria-hidden': 'true' }),
          h('div', { class: 'gu-tl-body' }, o.time ? h('p', { class: 'gu-tl-time' }, str(o.time)) : null, h('p', { class: 'gu-tl-title' }, str(o.title ?? o.text)), o.description ? h('p', { class: 'gu-muted' }, str(o.description)) : null));
      }));
    },
    Steps(a) {
      const items = (Array.isArray(a.p.items) ? a.p.items : []).slice(0, 50);
      const current = a.p.current == null ? -1 : numOr(a.p.current, -1);
      return h('ol', { class: 'gu-steps' }, items.map((it, i) => {
        const o = isObj(it) ? it : { title: it };
        const status = ['done', 'current', 'pending', 'upcoming', 'error'].includes(o.status) ? (o.status === 'upcoming' ? 'pending' : o.status) : current < 0 ? 'pending' : i < current ? 'done' : i === current ? 'current' : 'pending';
        const sr = { done: ' (done)', error: ' (failed)', current: ' (current step)' }[status];
        return h('li', { 'data-status': status, ...(status === 'current' ? { 'aria-current': 'step' } : {}) },
          h('span', { class: 'gu-step-n', 'aria-hidden': 'true' }, status === 'done' ? icon('check') : status === 'error' ? icon('x') : String(i + 1)),
          h('div', { class: 'gu-step-body' }, h('p', { class: 'gu-step-title' }, str(o.title ?? o.text), sr ? h('span', { class: 'sr-only' }, sr) : null), o.description ? h('p', { class: 'gu-muted' }, str(o.description)) : null));
      }));
    },
    Map(a) {
      const pt = (m) => {
        if (!isObj(m)) return null;
        const la = numOr(m.latitude ?? m.lat, NaN); const lo = numOr(m.longitude ?? m.lon ?? m.lng, NaN);
        return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? { lat: la, lon: lo, label: m.label != null ? str(m.label) : m.name != null ? str(m.name) : '', detail: m.detail != null ? str(m.detail) : m.description != null ? str(m.description) : '' } : null;
      };
      const places = (Array.isArray(a.p.places) ? a.p.places : []).slice(0, 30).map(pt).filter(Boolean);
      const extra = (Array.isArray(a.p.markers) ? a.p.markers : []).slice(0, 30).map(pt).filter(Boolean);
      const centre = pt({ latitude: a.p.latitude, longitude: a.p.longitude, label: a.p.label });
      const all = [...(centre ? [centre] : []), ...places, ...extra];
      if (!all.length) return notice('This map has no valid location.', 'warning');
      const route = !!a.p.route && places.length > 1;
      // Fit every point when no zoom is given and there are several places.
      const fitZoom = () => {
        if (all.length < 2) return 13;
        for (let z = 16; z >= 3; z--) {
          const px = all.map((q) => worldPx(q.lat, q.lon, z));
          const w = Math.max(...px.map((q) => q[0])) - Math.min(...px.map((q) => q[0]));
          const hgt = Math.max(...px.map((q) => q[1])) - Math.min(...px.map((q) => q[1]));
          if (w <= 230 && hgt <= 150) return z;
        }
        return 3;
      };
      const z = clamp(Math.round(a.local('zoom', a.p.zoom != null && a.p.zoom !== '' ? numOr(a.p.zoom, 13) : fitZoom())), 3, 17);
      let lat; let lon;
      if (centre) ({ lat, lon } = centre);
      else {
        const px = all.map((q) => worldPx(q.lat, q.lon, z));
        const mx = (Math.min(...px.map((q) => q[0])) + Math.max(...px.map((q) => q[0]))) / 2;
        const my = (Math.min(...px.map((q) => q[1])) + Math.max(...px.map((q) => q[1]))) / 2;
        const sc = TILE * 2 ** z;
        lon = (mx / sc) * 360 - 180;
        lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * my) / sc))) * 180) / Math.PI;
      }
      const [cx, cy] = worldPx(lat, lon, z);
      const tiles = h('div', { class: 'gu-map-tiles', 'aria-hidden': 'true' });
      for (let ty = Math.floor((cy - 112) / TILE); ty <= Math.floor((cy + 112) / TILE); ty++) {
        if (ty < 0 || ty >= 2 ** z) continue;
        for (let tx = Math.floor((cx - 560) / TILE); tx <= Math.floor((cx + 560) / TILE); tx++) {
          tiles.append(h('img', { src: tileUrl(tx, ty, z), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false', referrerpolicy: 'no-referrer', style: `left:calc(50% + ${Math.round(tx * TILE - cx)}px);top:calc(50% + ${Math.round(ty * TILE - cy)}px)`, onerror: (e) => { e.target.style.visibility = 'hidden'; } }));
        }
      }
      const rel = (q) => { const [x, y] = worldPx(q.lat, q.lon, z); return [Math.round(x - cx), Math.round(y - cy)]; };
      if (route) {
        const pts = places.map((q) => rel(q).join(',')).join(' ');
        tiles.append(svg('svg', { class: 'gu-map-route', width: '1', height: '1' }, svg('polyline', { points: pts, class: 'gu-map-route-casing' }), svg('polyline', { points: pts, class: 'gu-map-route-line' })));
      }
      const seen = new Set();
      const names = [];
      const pin = (q, n) => {
        const k = `${q.lat.toFixed(5)},${q.lon.toFixed(5)}`; if (seen.has(k) && n == null) return; seen.add(k);
        if (q.label) names.push(q.label);
        const [x, y] = rel(q);
        tiles.append(h('span', { class: 'gu-map-pin', 'data-n': n == null ? '' : '1', style: `left:calc(50% + ${x}px);top:calc(50% + ${y}px)` },
          n != null ? h('span', { class: 'gu-map-pin-n' }, String(n)) : null,
          q.label && (n == null || places.length <= 6) ? h('span', { class: 'gu-map-pin-label' }, q.label.slice(0, 40)) : null));
      };
      if (centre && !places.some((q) => Math.abs(q.lat - centre.lat) < 1e-5 && Math.abs(q.lon - centre.lon) < 1e-5)) pin(centre);
      places.forEach((q, i) => pin(q, route ? i + 1 : null));
      extra.forEach((q) => pin(q));
      const zoomBtn = (d, ic, label) => {
        const b = h('button', { type: 'button', class: 'gu-icon-btn', 'aria-label': label, title: label, 'data-gid': `${a.gid}z${d}`, ...(z + d < 3 || z + d > 17 ? { disabled: true } : {}) }, icon(ic));
        b.addEventListener('click', () => a.setLocal('zoom', clamp(z + d, 3, 17)));
        return b;
      };
      const f = (x) => x.toFixed(5);
      const osm = `https://www.openstreetmap.org/?mlat=${f(lat)}&mlon=${f(lon)}#map=${z}/${f(lat)}/${f(lon)}`;
      const label = str(a.p.label || (places.length > 1 ? `${places.length} places` : (centre || all[0]).label || `${lat.toFixed(3)}, ${lon.toFixed(3)}`));
      const list = places.length ? h(route ? 'ol' : 'ul', { class: 'gu-map-places' }, places.map((q, i) => h('li', {},
        h('span', { class: 'gu-map-places-n', 'aria-hidden': 'true' }, route ? String(i + 1) : icon('map-pin')),
        h('span', { class: 'gu-list-text' }, h('span', { class: 'gu-list-title' }, q.label || `${q.lat.toFixed(3)}, ${q.lon.toFixed(3)}`), q.detail ? h('span', { class: 'gu-muted gu-list-desc' }, q.detail) : null)))) : null;
      return h('figure', { class: 'gu-map' },
        h('div', { class: 'gu-map-view', role: 'img', 'aria-label': `Map of ${label}${names.length > 1 ? ` with ${names.length} places${route ? ' joined by a route' : ''}: ${names.join(', ')}` : ''}` }, tiles),
        h('div', { class: 'gu-map-zoom' }, zoomBtn(1, 'plus', 'Zoom in'), zoomBtn(-1, 'circle-minus', 'Zoom out')),
        h('span', { class: 'gu-map-attr' }, '\u00A9 ', ext('https://www.openstreetmap.org/copyright', 'OpenStreetMap'), ' \u00A9 ', ext('https://carto.com/attributions', 'CARTO')),
        list,
        h('figcaption', { class: 'gu-map-caption' }, h('span', { class: 'gu-map-label' }, label), ext(osm, [h('span', {}, 'Open map'), icon('external-link')], 'gu-link')));
    },
    Carousel(a) {
      const items = (Array.isArray(a.p.items) ? a.p.items : []).slice(0, 30);
      return h('ul', { class: 'gu-carousel', tabindex: '0', 'aria-label': 'Carousel, scroll sideways for more' }, items.map((it) => {
        const o = isObj(it) ? it : { title: it };
        const img = mediaUrl(str(o.image ?? o.src));
        const href = httpsUrl(str(o.href ?? o.url));
        const inner = [img ? h('img', { src: img, alt: str(o.alt || ''), loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null,
          h('div', { class: 'gu-carousel-text' }, o.title ? h('p', { class: 'gu-carousel-title' }, str(o.title)) : null, o.subtitle || o.description || o.caption ? h('p', { class: 'gu-muted' }, str(o.subtitle ?? o.description ?? o.caption)) : null)];
        return h('li', { class: 'gu-carousel-item' }, href ? ext(href, inner) : inner);
      }));
    },
    Citations(a) {
      const items = (Array.isArray(a.p.items) ? a.p.items : []).slice(0, 50);
      return h('ol', { class: 'gu-citations' }, items.map((it, i) => {
        const o = isObj(it) ? it : { url: it };
        const href = linkUrl(str(o.url ?? o.href));
        let host = '';
        try { host = /^https?:/.test(href) ? new URL(href).hostname.replace(/^www\./, '') : ''; } catch { /* not a URL */ }
        const title = str(o.title || host || o.url || `Source ${i + 1}`);
        return h('li', {}, h('span', { class: 'gu-cite-n', 'aria-hidden': 'true' }, String(i + 1)),
          h('div', { class: 'gu-cite-body' }, href ? ext(href, title, 'gu-cite-title') : h('span', { class: 'gu-cite-title' }, title),
            host || o.source ? h('span', { class: 'gu-muted gu-cite-src' }, str(o.source || host)) : null, o.snippet ? h('p', { class: 'gu-cite-snippet' }, str(o.snippet)) : null));
      }));
    },
    Weather(a) {
      const data = isObj(a.p.data) ? a.p.data : findWeather(str(a.p.id));
      if (!data) return notice(a.p.id ? `The forecast "${str(a.p.id)}" isn't in this chat. Call get_weather first.` : 'No forecast to show.', 'warning');
      const units = isObj(data.units) ? data.units : {};
      const tu = str(units.temperature || '\u00B0C');
      const cur = isObj(data.current) ? data.current : {};
      const w = wmo(cur.weather_code ?? cur.code);
      const daily = Array.isArray(data.daily) ? data.daily : [];
      const days = clamp(Math.round(numOr(a.p.days, 7)), 1, 7);
      const deg = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? '\u2013' : `${Math.round(Number(x))}\u00B0`);
      const facts = [
        cur.apparent_temperature != null ? ['Feels like', `${Math.round(cur.apparent_temperature)}${tu}`] : null,
        cur.relative_humidity != null ? ['Humidity', `${Math.round(cur.relative_humidity)}%`] : null,
        cur.wind_speed != null ? ['Wind', `${Math.round(cur.wind_speed)} ${str(units.wind || 'km/h')}`] : null,
        cur.precipitation != null && Number(cur.precipitation) > 0 ? ['Rain now', `${cur.precipitation} ${str(units.precipitation || 'mm')}`] : null,
      ].filter(Boolean);
      const place = str(data.location?.name || data.name || '');
      const region = [data.location?.admin1, data.location?.country].filter(Boolean).map(str).join(', ');
      return h('div', { class: 'gu-weather' },
        h('div', { class: 'gu-weather-now' },
          h('span', { class: 'gu-weather-icon', 'aria-hidden': 'true' }, w.emoji),
          h('div', { class: 'gu-weather-main' },
            h('p', { class: 'gu-weather-place' }, place, region ? h('span', { class: 'gu-muted' }, ` ${region}`) : null),
            h('p', { class: 'gu-weather-temp' }, cur.temperature != null ? `${Math.round(cur.temperature)}${tu}` : '\u2013'),
            h('p', { class: 'gu-muted' }, w.label, daily[0] ? ` \u00B7 High ${deg(daily[0].max)}, low ${deg(daily[0].min)}` : ''))),
        facts.length ? h('dl', { class: 'gu-weather-facts' }, facts.map(([k, val]) => h('div', {}, h('dt', {}, k), h('dd', {}, val)))) : null,
        daily.length ? h('ol', { class: 'gu-weather-days', 'aria-label': 'Daily forecast' }, daily.slice(0, days).map((d, i) => {
          const dw = wmo(d.weather_code ?? d.code);
          return h('li', {}, h('span', { class: 'gu-wd-day' }, dayName(d.date, i)),
            h('span', { class: 'gu-wd-icon', title: dw.label, 'aria-hidden': 'true' }, dw.emoji), h('span', { class: 'sr-only' }, `${dw.label}, `),
            h('span', { class: 'gu-wd-rain' }, d.precipitation_probability != null ? `${Math.round(d.precipitation_probability)}%` : ''),
            h('span', { class: 'gu-wd-temps' }, h('span', { class: 'sr-only' }, 'high '), h('span', { class: 'gu-wd-max' }, deg(d.max)), h('span', { class: 'sr-only' }, ', low '), h('span', { class: 'gu-muted' }, deg(d.min))));
        })) : null,
        h('p', { class: 'gu-weather-src' }, ext('https://open-meteo.com/', 'Weather data by Open-Meteo')));
    },

    Button(a) {
      const variant = ['primary', 'secondary', 'outline', 'ghost', 'danger'].includes(a.p.variant) ? a.p.variant : 'secondary';
      const cls = { primary: 'btn-default', secondary: 'btn-outline gu-btn-secondary', outline: 'btn-outline', ghost: 'btn-ghost', danger: 'btn-destructive' }[variant];
      const b = h('button', { type: 'button', class: `btn ${cls}${a.p.size === 'sm' ? ' btn-sm' : ''} gu-btn${a.p.block ? ' gu-btn-block' : ''}`, 'data-gid': a.gid, ...(a.p.disabled ? { disabled: true } : {}) },
        a.p.icon ? emoji(a.p.icon) : null, h('span', {}, str(a.p.label || 'OK')));
      b.addEventListener('click', (e) => a.on('press', {}, e));
      return b;
    },
    Input(a) {
      const type = ['text', 'number', 'email', 'tel', 'url', 'date', 'time', 'datetime-local', 'search', 'password'].includes(a.p.inputType) ? a.p.inputType : 'text';
      const n = h('input', { class: 'input', type, 'data-gid': a.gid, autocomplete: 'off', ...(type === 'number' ? { inputmode: 'decimal' } : {}) });
      n.value = a.p.value == null ? '' : str(a.p.value);
      if (a.p.placeholder) n.placeholder = str(a.p.placeholder);
      for (const k of ['min', 'max', 'step']) if (a.p[k] != null) n.setAttribute(k, str(a.p[k]));
      n.required = !!a.p.required;
      const read = () => (type === 'number' ? (n.value === '' ? null : numOr(n.value, null)) : n.value);
      n.addEventListener('input', () => { n.removeAttribute('aria-invalid'); a.bind('value', read(), { lazy: true }); a.on('change', { value: read() }, null); });
      n.addEventListener('change', () => { a.bind('value', read()); });
      n.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !n.closest('form')) { e.preventDefault(); a.bind('value', read()); a.on('submit', { value: read() }, e); } });
      return field(a, n, a.p.label ? `${str(a.p.label)}${a.p.required ? ' *' : ''}` : '');
    },
    Textarea(a) {
      const n = h('textarea', { class: 'textarea', 'data-gid': a.gid, rows: String(clamp(Math.round(numOr(a.p.rows, 3)), 2, 12)) });
      n.value = a.p.value == null ? '' : str(a.p.value);
      if (a.p.placeholder) n.placeholder = str(a.p.placeholder);
      n.addEventListener('input', () => { a.bind('value', n.value, { lazy: true }); a.on('change', { value: n.value }, null); });
      n.addEventListener('change', () => { a.bind('value', n.value); });
      return field(a, n, str(a.p.label || ''));
    },
    Select(a) {
      const opts = options(a.p.options);
      const value = a.p.value == null ? '' : str(a.p.value);
      const known = opts.some((o) => o.value === value);
      const n = h('select', { class: 'select', 'data-gid': a.gid },
        !known || a.p.placeholder ? h('option', { value: '', disabled: true, ...(!known ? { selected: true } : {}) }, str(a.p.placeholder || 'Choose…')) : null,
        opts.map((o) => h('option', { value: o.value, ...(o.value === value ? { selected: true } : {}) }, o.label)));
      n.addEventListener('change', (e) => { a.bind('value', n.value); a.on('change', { value: n.value }, e); });
      return field(a, n, str(a.p.label || ''));
    },
    Checkbox(a) {
      const id = fieldId(a.gid);
      const n = h('input', { type: 'checkbox', class: 'gu-check', id, 'data-gid': a.gid, ...(C.truthy(a.p.checked) ? { checked: true } : {}) });
      n.addEventListener('change', (e) => { a.bind('checked', n.checked); a.on('change', { value: n.checked, checked: n.checked }, e); });
      return h('div', { class: 'gu-checkrow' }, n, h('label', { for: id, class: 'gu-checklabel' }, h('span', {}, str(a.p.label)), a.p.description ? h('span', { class: 'gu-muted' }, str(a.p.description)) : null));
    },
    Switch(a) {
      const id = fieldId(a.gid);
      const n = h('input', { type: 'checkbox', role: 'switch', class: 'switch', id, 'data-gid': a.gid, ...(C.truthy(a.p.checked) ? { checked: true } : {}) });
      n.addEventListener('change', (e) => { a.bind('checked', n.checked); a.on('change', { value: n.checked, checked: n.checked }, e); });
      return h('div', { class: 'gu-switchrow' }, h('label', { for: id, class: 'gu-switchlabel' }, str(a.p.label)), n);
    },
    RadioGroup(a) {
      const opts = options(a.p.options);
      const value = a.p.value == null ? '' : str(a.p.value);
      const name = fieldId(a.gid);
      return h('fieldset', { class: 'gu-radios' }, a.p.label ? h('legend', { class: 'gu-label' }, str(a.p.label)) : null,
        opts.map((o, i) => {
          const id = `${name}-${i}`;
          const r = h('input', { type: 'radio', name, id, value: o.value, class: 'gu-radio', 'data-gid': `${a.gid}#${i}`, ...(o.value === value ? { checked: true } : {}) });
          r.addEventListener('change', (e) => { if (r.checked) { a.bind('value', o.value); a.on('change', { value: o.value }, e); } });
          return h('div', { class: 'gu-checkrow' }, r, h('label', { for: id, class: 'gu-checklabel' }, h('span', {}, o.label), o.description ? h('span', { class: 'gu-muted' }, o.description) : null));
        }));
    },
    Slider(a) {
      const min = numOr(a.p.min, 0); const max = Math.max(min, numOr(a.p.max, 100)); const step = numOr(a.p.step, 1) || 1;
      const value = clamp(numOr(a.p.value, min), min, max);
      const unit = str(a.p.unit || '');
      const text = (x) => `${fmtNum(x)}${unit ? (unit.length > 2 ? ` ${unit}` : unit) : ''}`;
      const id = fieldId(a.gid);
      const out = h('output', { class: 'gu-slider-value', for: id }, text(value));
      const n = h('input', { type: 'range', class: 'gu-slider', id, min: String(min), max: String(max), step: String(step), 'data-gid': a.gid, 'aria-valuetext': text(value) });
      n.value = String(value);
      n.style.setProperty('--gu-fill', `${max > min ? ((value - min) / (max - min)) * 100 : 0}%`);
      n.addEventListener('input', () => {
        const x = Number(n.value);
        out.textContent = text(x); n.setAttribute('aria-valuetext', text(x));
        n.style.setProperty('--gu-fill', `${max > min ? ((x - min) / (max - min)) * 100 : 0}%`);
        a.bind('value', x, { lazy: true }); a.on('change', { value: x }, null);
      });
      n.addEventListener('change', () => a.bind('value', Number(n.value)));
      return h('div', { class: 'gu-field' }, h('div', { class: 'gu-slider-head' }, h('label', { class: 'gu-label', for: id }, str(a.p.label || '')), out), n);
    },
    Stepper(a) {
      const min = numOr(a.p.min, 0); const max = Math.max(min, numOr(a.p.max, 99)); const step = numOr(a.p.step, 1) || 1;
      const value = clamp(numOr(a.p.value, min), min, max);
      const unit = str(a.p.unit || '');
      const label = str(a.p.label || '');
      const set = (x, e) => { const next = clamp(+x.toFixed(6), min, max); a.bind('value', next); a.on('change', { value: next }, e); };
      const minus = h('button', { type: 'button', class: 'gu-icon-btn', 'aria-label': `Decrease ${label}`.trim(), 'data-gid': `${a.gid}-`, ...(value - step < min ? { disabled: true } : {}) }, icon('circle-minus'));
      const plus = h('button', { type: 'button', class: 'gu-icon-btn', 'aria-label': `Increase ${label}`.trim(), 'data-gid': `${a.gid}+`, ...(value + step > max ? { disabled: true } : {}) }, icon('plus'));
      minus.addEventListener('click', (e) => set(value - step, e));
      plus.addEventListener('click', (e) => set(value + step, e));
      return h('div', { class: 'gu-stepper', role: 'group', 'aria-label': label || 'Amount' }, h('span', { class: 'gu-label' }, label),
        h('div', { class: 'gu-stepper-ctl' }, minus, h('output', { class: 'gu-stepper-value', 'aria-live': 'polite' }, `${fmtNum(value)}${unit ? ` ${unit}` : ''}`), plus));
    },
    Form(a) {
      const submit = h('button', { type: 'submit', class: 'btn btn-default gu-btn', 'data-gid': `${a.gid}!` }, str(a.p.submitLabel || 'Submit'));
      const form = h('form', { class: 'gu-form', novalidate: '' },
        a.p.title ? h('h3', { class: 'gu-card-title' }, str(a.p.title)) : null,
        h('div', { class: 'gu-stack', 'data-dir': 'col', 'data-gap': 'sm' }, a.kids()),
        h('div', { class: 'gu-form-actions' }, submit));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const fields = [...form.querySelectorAll('input, select, textarea')];
        for (const f of fields) f.dispatchEvent(new Event('change'));
        const bad = fields.find((f) => !f.checkValidity());
        if (bad) { bad.setAttribute('aria-invalid', 'true'); bad.reportValidity?.(); bad.focus(); return; }
        a.on('submit', clone(a.v.spec.state), e);
      });
      return form;
    },
    ChoiceChips(a) {
      const opts = options(a.p.options);
      const multiple = !!a.p.multiple;
      const selected = new Set(multiple ? (Array.isArray(a.p.value) ? a.p.value.map(str) : []) : a.p.value == null ? [] : [str(a.p.value)]);
      const label = str(a.p.label || '');
      const lid = label ? fieldId(a.gid) : '';
      const chips = h('div', { class: 'gu-chips', role: 'group', ...(lid ? { 'aria-labelledby': lid } : {}) }, opts.map((o, i) => {
        const on = selected.has(o.value);
        const b = h('button', { type: 'button', class: 'gu-chip', 'aria-pressed': String(on), 'data-gid': `${a.gid}#${i}` }, on ? icon('check') : null, h('span', {}, o.label));
        b.addEventListener('click', (e) => {
          let next;
          if (multiple) { const s = new Set(selected); if (s.has(o.value)) s.delete(o.value); else s.add(o.value); next = opts.map((x) => x.value).filter((x) => s.has(x)); } else next = o.value;
          a.bind('value', next); a.on('change', { value: next }, e);
        });
        return b;
      }));
      return label ? h('div', { class: 'gu-field' }, h('span', { class: 'gu-label', id: lid }, label), chips) : chips;
    },
    DatePicker(a) {
      const mode = ['date', 'datetime', 'time'].includes(a.p.mode) ? a.p.mode : 'date';
      const type = mode === 'datetime' ? 'datetime-local' : mode;
      const n = h('input', { class: 'input gu-date', type, 'data-gid': a.gid });
      n.value = a.p.value == null ? '' : str(a.p.value);
      for (const k of ['min', 'max']) if (a.p[k] != null && a.p[k] !== '') n.setAttribute(k, str(a.p[k]));
      n.required = !!a.p.required;
      n.addEventListener('change', (e) => { n.removeAttribute('aria-invalid'); a.bind('value', n.value); a.on('change', { value: n.value }, e); });
      return field(a, n, a.p.label ? `${str(a.p.label)}${a.p.required ? ' *' : ''}` : '');
    },
    CheckboxGroup(a) {
      const opts = options(a.p.options);
      const checked = new Set((Array.isArray(a.p.value) ? a.p.value : []).map(str));
      const name = fieldId(a.gid);
      const done = opts.filter((o) => checked.has(o.value)).length;
      const pct = opts.length ? Math.round((done / opts.length) * 100) : 0;
      const progress = a.p.showProgress ? h('div', { class: 'gu-progress', 'data-tone': done === opts.length && opts.length ? 'success' : 'accent' },
        h('div', { class: 'gu-progress-head' }, h('span', { 'aria-live': 'polite' }, `${done} of ${opts.length} done`), h('span', { class: 'gu-muted' }, `${pct}%`)),
        h('div', { class: 'gu-progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(opts.length), 'aria-valuenow': String(done), 'aria-label': `${str(a.p.label || 'Checklist')} progress` },
          h('div', { class: 'gu-progress-fill', style: `width:${pct}%` }))) : null;
      return h('fieldset', { class: 'gu-radios gu-checkgroup' }, a.p.label ? h('legend', { class: 'gu-label' }, str(a.p.label)) : null, progress,
        opts.map((o, i) => {
          const id = `${name}-${i}`;
          const c = h('input', { type: 'checkbox', id, class: 'gu-check', 'data-gid': `${a.gid}#${i}`, ...(checked.has(o.value) ? { checked: true } : {}) });
          c.addEventListener('change', (e) => {
            const s = new Set(checked); if (c.checked) s.add(o.value); else s.delete(o.value);
            const next = opts.map((x) => x.value).filter((x) => s.has(x));
            a.bind('value', next); a.on('change', { value: next, option: o.value, checked: c.checked }, e);
          });
          return h('div', { class: 'gu-checkrow', 'data-done': checked.has(o.value) ? '1' : '' }, c, h('label', { for: id, class: 'gu-checklabel' }, h('span', {}, o.label), o.description ? h('span', { class: 'gu-muted' }, o.description) : null));
        }));
    },
    ListView(a) {
      const kids = a.kids();
      return h('div', { class: 'gu-listview-wrap' }, a.p.title ? h('h3', { class: 'gu-section-title' }, str(a.p.title)) : null,
        h('ul', { class: 'gu-listview' }, kids.map((k) => (k.tagName === 'LI' ? k : h('li', { class: 'gu-lv-row' }, k)))));
    },
    ListItem(a) {
      const img = mediaUrl(str(a.p.image));
      const href = httpsUrl(str(a.p.href));
      const sel = a.p.selected != null && C.truthy(a.p.selected);
      const press = a.has('press');
      const lead = img ? h('img', { class: 'gu-list-img', src: img, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() })
        : a.p.icon ? h('span', { class: 'gu-list-icon', 'aria-hidden': 'true' }, iconName(a.p.icon) ? icon(iconName(a.p.icon)) : Array.from(str(a.p.icon)).slice(0, 2).join('')) : null;
      const body = [lead,
        h('span', { class: 'gu-list-text' }, h('span', { class: 'gu-list-title' }, str(a.p.title)), a.p.description != null && a.p.description !== '' ? h('span', { class: 'gu-muted gu-list-desc' }, str(a.p.description)) : null),
        a.p.meta != null && a.p.meta !== '' ? h('span', { class: 'gu-list-meta' }, str(a.p.meta)) : null,
        sel ? icon('check') : press || href ? icon('chevron-right') : null];
      let inner;
      if (press) {
        inner = h('button', { type: 'button', class: 'gu-lv-btn', 'data-gid': a.gid, ...(a.p.selected != null ? { 'aria-pressed': String(sel) } : {}) }, body);
        inner.addEventListener('click', (e) => a.on('press', {}, e));
      } else if (href) inner = ext(href, body, 'gu-lv-btn');
      else inner = h('div', { class: 'gu-lv-static' }, body);
      return h('li', { class: 'gu-lv-row', 'data-selected': sel ? '1' : '' }, inner);
    },
  };

  /* ---------- tool cards and results ---------- */
  const treeArg = (args) => args.tree ?? args.ui ?? args.component ?? args.node ?? args.root;
  function specCard(part, status) {
    const args = isObj(part.args) ? part.args : {};
    const present = /present$/.test(part.toolName || '');
    const empty = present ? treeArg(args) == null : (args.patches ?? args.jsonl ?? args.ops ?? args.spec) == null;
    if (empty) return h('div', { class: 'gu-root gu-pending' }, h('p', { class: 'gu-hint' }, status?.type === 'running' ? 'Building the view…' : 'The agent sent an empty view.'));
    return ensureVersion(part).card();
  }

  function resultText(v) {
    const lines = [];
    const n = Object.keys(v.spec.elements || {}).length;
    lines.push(v.tool === 'present' ? `Shown to the user as "${v.title}" (${n} element${n === 1 ? '' : 's'}). Change it with edit_widget or a render_spec call with this title.` : `Rendered "${v.title}" version ${v.number} (${n} element${n === 1 ? '' : 's'}).`);
    if (v.patchErrors.length) {
      lines.push(`${v.patchErrors.length} patch line${v.patchErrors.length === 1 ? '' : 's'} skipped (the rest applied):`);
      for (const e of v.patchErrors.slice(0, 12)) lines.push(`- line ${e.line}: ${e.message}${e.text ? ` — ${e.text}` : ''}`);
    }
    if (v.issues.length) lines.push(C.formatIssues(v.issues));
    const user = v.userSummary();
    if (user) lines.push(`Values the user set (kept in this version): ${user}`);
    if (v.tool !== 'present') lines.push(`To change it, call render_spec with title "${v.title}" and only the patches that change it.`);
    return lines.join('\n');
  }

  const isFatal = (v) => !v.spec.root || !isObj(v.spec.elements?.[v.spec.root]);

  const TOOLS = [
    {
      name: 'render_spec',
      description: 'Show a native, themed UI in the chat from a flat JSON spec: dashboards, comparisons, plans, recipes that scale, budgets, checklists, forms, date pickers, tappable lists, sortable tables, charts, diagrams, maps and routes, forecasts. The app draws it with its own components in light and dark, fitted to a 320 px phone. Send `patches` as JSONL JSON Patch lines (root first, then state, then each element, parents before children) or a complete `spec`. Call it again with the SAME title and only the changed patches to update it; the new version keeps what the user typed. Call read_me(["spec"]) first for the format, the ' + C.COMPONENT_NAMES.length + ' components and $calc expressions. Returns issues to fix.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'snake_case name for this UI in the conversation, e.g. "trip_budget". Reuse it to update the same UI.' },
          patches: { type: 'string', description: 'RFC 6902 operations, one JSON object per line, e.g. {"op":"add","path":"/root","value":"main"}.' },
          spec: { type: 'object', description: 'A complete spec {root, elements, state}, instead of patches.' },
        },
        required: ['title'],
      },
      execute(args, ctx) {
        if (!isObj(args) || !String(args.title || '').trim()) throw new Error('title is required (a snake_case name for this UI).');
        if (args.patches == null && args.spec == null && args.jsonl == null && args.ops == null) throw new Error('Send patches (JSONL) or a complete spec.');
        const v = ensureVersion({ toolCallId: ctx?.toolCallId, toolName: 'render_spec', args }, ctx);
        const text = resultText(v);
        if (isFatal(v)) throw new Error(`Nothing could be drawn. ${text}`);
        return text;
      },
    },
    {
      name: 'present',
      description: 'Show display-only content in the chat as a nested component tree with no state: a summary card, facts, a table, a chart, a timeline, citations, a map, a forecast. Each node is {"type":"Card","props":{…},"children":[…]}; a string child becomes Text. Use render_spec instead when the user types or picks something, or the UI must update later. Components: read_me(["present"]).',
      inputSchema: {
        type: 'object',
        properties: {
          tree: { description: 'The root node, or an array of nodes stacked vertically.' },
          title: { type: 'string', description: 'Optional snake_case name.' },
        },
        required: ['tree'],
      },
      execute(args, ctx) {
        if (!isObj(args) || treeArg(args) == null) throw new Error('tree is required.');
        const v = ensureVersion({ toolCallId: ctx?.toolCallId, toolName: 'present', args }, ctx);
        const text = resultText(v);
        if (isFatal(v)) throw new Error(`Nothing could be shown. ${text}`);
        return text;
      },
    },
  ];

  function addTools(list, ui) {
    for (const t of list) {
      if (!UI_TOOLS.some((x) => x.name === t.name)) UI_TOOLS.push(t);
      if (ui) TOOLKIT[`ui__${t.name}`] = { ...(TOOLKIT[`ui__${t.name}`] || {}), ui };
    }
  }

  function install() {
    addTools(TOOLS, specCard);
    if (typeof ThreadRuntime === 'function' && !ThreadRuntime.prototype.__genuiCtxWrapped) {
      const take = ThreadRuntime.prototype.takeContext;
      ThreadRuntime.prototype.takeContext = function () {
        const base = take.call(this);
        return [takeModelContext(this), base].filter(Boolean).join('\n\n');
      };
      ThreadRuntime.prototype.__genuiCtxWrapped = true;
    }
    // Maps switch between light and dark tiles with the theme.
    let dark = isDark();
    new MutationObserver(() => {
      if (isDark() === dark) return;
      dark = isDark();
      for (const v of calls.values()) if (v.el?.isConnected && v.el.querySelector('.gu-map')) v.render();
    }).observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
  }

  return { install, modelContext, takeModelContext, addTools, ensureVersion, Version, calls, byTitle, latest, titleKey, chatId, rememberData, findWeather, parseData, Renderer, R, TOOLS, resultText, isFatal, notice, drawChart, userStore };
})();

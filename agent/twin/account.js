// The avatar in the app bar, its menu (Profile, Settings, Sign in / Sign out), and the Profile and Settings pages.
// There is no account system yet: the profile is LOCAL to this laptop (a name and a colour in localStorage), and the
// menu says so. "Sign in" sets up that local profile; "Sign out" forgets it. No passwords, nothing leaves the laptop.
import { goTo, onPage } from './pages.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const LOCAL_NOTE = 'Local profile on this laptop — accounts coming soon';
const COLOURS = [['#1b5a63', 'Teal'], ['#12233f', 'Navy'], ['#983a34', 'Cork'], ['#9c4c0c', 'Torch'], ['#191a16', 'Ink'], ['#0f3d44', 'Deep sea']];
const NAME_MAX = 40;
const GUEST = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.6 4-5.4 7.5-5.4s6.3 1.8 7.5 5.4"/></svg>';
const ICONS = {
  profile: GUEST,
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/></svg>',
  in: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l4-4-4-4M14 12H4"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M16 16l4-4-4-4M20 12H10"/></svg>',
};

/** @returns {{name: string, color: string} | null} the local profile, or null when signed out */
function load() {
  try {
    const p = JSON.parse(store.get('ody.profile') || 'null');
    if (!p || typeof p.name !== 'string' || !p.name.trim()) return null;
    const color = COLOURS.some(([c]) => c === p.color) ? p.color : COLOURS[0][0];
    return { name: p.name.trim().slice(0, NAME_MAX), color };
  } catch { return null; }
}
let profile = load();
const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => [...w][0].toUpperCase()).join('') || '?';
function toast(text) { if (typeof window.odyToast === 'function') window.odyToast(text); }

// ---------- avatar + menu ----------
const btn = $('profile-btn'), menu = $('profile-menu');
function paintAvatar(node, p = profile) {
  node.classList.toggle('guest', !p);
  node.style.setProperty('--av', p ? p.color : '');
  if (p) node.textContent = initials(p.name); else node.innerHTML = GUEST;   // static markup
}
function item(label, icon, fn) {
  const b = el('button'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.tabIndex = -1;
  b.innerHTML = ICONS[icon];   // static markup
  b.append(label);
  b.addEventListener('click', () => { closeMenu(false); fn(); });
  return b;
}
function buildMenu() {
  menu.replaceChildren();
  const who = el('div', 'menu-who'); const av = el('span', 'avatar'); av.setAttribute('aria-hidden', 'true'); paintAvatar(av);
  const txt = el('div'); txt.append(el('b', '', profile ? profile.name : 'Guest'), el('small', '', profile ? 'Local profile' : 'Not signed in'));
  who.append(av, txt);
  const items = [
    item('Profile', 'profile', () => goTo('profile', { focus: true })),
    item('Settings', 'settings', () => goTo('settings', { focus: true })),
    profile ? item('Sign out', 'out', signOut) : item('Sign in', 'in', () => { goTo('profile', { focus: true }); setTimeout(() => $('pf-name')?.focus(), 450); }),
  ];
  const rule = el('hr', 'rule'); rule.setAttribute('role', 'separator');
  menu.append(who, rule, items[0], items[1], items[2], el('p', 'menu-note', LOCAL_NOTE));
}
const menuItems = () => [...menu.querySelectorAll('[role=menuitem]')];
function openMenu() {
  buildMenu(); menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
  menuItems()[0]?.focus();
}
function closeMenu(refocus = true) {
  if (menu.hidden) return;
  menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
  if (refocus) btn.focus();
}
btn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
menu.addEventListener('keydown', e => {
  const list = menuItems(), i = list.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
  else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
  else if (e.key === 'End') { e.preventDefault(); list.at(-1)?.focus(); }
  else if (e.key === 'Tab') closeMenu(false);
  e.stopImmediatePropagation?.();
});
addEventListener('pointerdown', e => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu(false); });

// ---------- profile ----------
function save(p) {
  profile = p;
  store.set('ody.profile', p ? JSON.stringify(p) : null);
  paintAvatar(btn); renderProfile(); greet();
  btn.setAttribute('aria-label', p ? `Profile and settings (${p.name})` : 'Profile and settings');
}
function signOut() {
  const name = profile?.name;
  save(null);
  toast(`Signed out. ${name ? `${name}’s` : 'The'} local profile was removed from this laptop.`);
}
function renderProfile() {
  const card = $('profile-card'); if (!card) return;
  card.replaceChildren();
  const draft = { name: profile?.name || '', color: profile?.color || COLOURS[0][0] };
  const head = el('div', 'pf-head');
  const big = el('span', 'avatar big'); big.setAttribute('aria-hidden', 'true');
  const paintBig = () => paintAvatar(big, draft.name.trim() ? draft : null);
  paintBig();
  const ht = el('div');
  ht.append(el('h2', 't-sect', profile ? profile.name : 'Set up a local profile'),
    el('p', 'pf-note', profile ? LOCAL_NOTE : `${LOCAL_NOTE}. Pick a name and a colour; Ody uses them to greet you and on your avatar.`));
  head.append(big, ht);

  const f = el('form', 'pf-form'); f.autocomplete = 'off'; f.noValidate = true;
  const nf = el('div', 'field'); const nl = el('label', '', 'Name'); nl.htmlFor = 'pf-name';
  const ni = el('input'); ni.id = 'pf-name'; ni.type = 'text'; ni.maxLength = NAME_MAX; ni.value = draft.name; ni.placeholder = 'What should Ody call you?'; ni.autocomplete = 'nickname';
  const err = el('p', 'pf-err'); err.id = 'pf-err'; err.hidden = true; ni.setAttribute('aria-describedby', 'pf-err');
  ni.addEventListener('input', () => { draft.name = ni.value; err.hidden = true; ni.removeAttribute('aria-invalid'); paintBig(); });
  nf.append(nl, ni, err);
  const cf = el('fieldset', 'field pf-colours'); cf.append(el('legend', 'lbl', 'Avatar colour'));
  const sw = el('div', 'swatches');
  for (const [c, label] of COLOURS) {
    const id = `pf-c-${label.toLowerCase()}`;
    const r = el('input'); r.type = 'radio'; r.name = 'pf-colour'; r.id = id; r.value = c; r.checked = c === draft.color;
    r.addEventListener('change', () => { draft.color = c; paintBig(); });
    const l = el('label', 'swatch'); l.htmlFor = id; l.style.setProperty('--c', c); l.title = label; l.append(el('span', 'sr', label));
    sw.append(r, l);
  }
  cf.append(sw);
  const acts = el('div', 'pf-acts');
  const ok = el('button', 'btn', profile ? 'Save profile' : 'Sign in on this laptop'); ok.type = 'submit';
  acts.append(ok);
  if (profile) { const out = el('button', 'btn quiet', 'Sign out'); out.type = 'button'; out.addEventListener('click', signOut); acts.append(out); }
  f.append(nf, cf, acts);
  f.addEventListener('submit', e => {
    e.preventDefault();
    const name = ni.value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, NAME_MAX);
    if (!name) { err.textContent = 'Type a name first. It stays on this laptop.'; err.hidden = false; ni.setAttribute('aria-invalid', 'true'); ni.focus(); return; }
    const was = !!profile;
    save({ name, color: draft.color });
    toast(was ? 'Profile saved on this laptop.' : `Signed in as ${name} (local profile on this laptop).`);
  });
  card.append(head, el('hr', 'rule'), f);
}

// ---------- Home greeting ----------
function greet() {
  const g = $('main-greet'); if (!g) return;
  const h = new Date().getHours();
  const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  g.textContent = profile ? `${part}, ${profile.name}` : `${part}. Welcome aboard`;
}

// ---------- settings: default model, motion ----------
const PROVIDERS = [['gemini', 'Gemini'], ['claude', 'Claude'], ['openai', 'OpenAI-compatible']];
let ready = null;   // provider ids with a key, from Home's key rows ('ody:keys')
function renderProvider() {
  const sel = $('set-provider'); if (!sel) return;
  const cur = store.get('argos.provider') || '';
  sel.replaceChildren();
  const auto = el('option', '', 'Automatic: the first model with a key'); auto.value = ''; sel.append(auto);
  for (const [id, label] of PROVIDERS) {
    const o = el('option', '', ready && !ready.has(id) ? `${label} (no key yet)` : label); o.value = id; sel.append(o);
  }
  sel.value = PROVIDERS.some(([id]) => id === cur) ? cur : '';
}
$('set-provider')?.addEventListener('change', e => {
  const v = e.target.value;
  store.set('argos.provider', v || null);
  if (v) dispatchEvent(new CustomEvent('ody:provider', { detail: v }));
  toast(v ? `${PROVIDERS.find(([id]) => id === v)[1]} is now Argos’s default model.` : 'Argos picks the first model with a key.');
});
addEventListener('ody:keys', e => { const p = e.detail?.providers; if (Array.isArray(p)) ready = new Set(p.filter(x => x.ready).map(x => x.id)); renderProvider(); });
addEventListener('ody:provider', renderProvider);

const MOTION = [['system', 'Follow this laptop'], ['reduce', 'Reduce motion'], ['full', 'Full motion']];
function applyMotion() {
  const m = store.get('ody.motion') || 'system';
  const sysReduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.classList.toggle('reduce-motion', m === 'reduce' || (m === 'system' && sysReduce));
}
function renderLook() {
  const box = $('set-look'); if (!box) return;
  box.replaceChildren();
  const fs = el('fieldset', 'field seg'); fs.append(el('legend', 'lbl', 'Motion'));
  const seg = el('div', 'segs');
  const cur = store.get('ody.motion') || 'system';
  for (const [id, label] of MOTION) {
    const r = el('input'); r.type = 'radio'; r.name = 'set-motion'; r.id = `set-motion-${id}`; r.value = id; r.checked = id === cur;
    r.addEventListener('change', () => { store.set('ody.motion', id === 'system' ? null : id); applyMotion(); });
    const l = el('label', '', label); l.htmlFor = r.id; seg.append(r, l);
  }
  fs.append(seg);
  const theme = el('p', 't-body', 'Theme: Parchment. The 3D stage on Argo stays dark so the hologram reads clearly.');
  box.append(fs, theme);
}

applyMotion(); paintAvatar(btn); buildMenu(); renderProfile(); greet(); renderProvider(); renderLook();
if (profile) btn.setAttribute('aria-label', `Profile and settings (${profile.name})`);
onPage(p => { if (p === 'main') greet(); if (p === 'profile') renderProfile(); });

// for tests
window.odyAccount = { profile: () => profile, signOut, open: openMenu, close: closeMenu };

// ---------- Argo's call panel: docked at 1280 px and wider, a drawer below that ----------
const railBtn = $('rail-toggle'), argo = $('page-argo');
function setRail(open) {
  if (!railBtn || !argo) return;
  argo.classList.toggle('rail-open', open);
  railBtn.setAttribute('aria-expanded', String(open));
  railBtn.textContent = open ? 'Hide call panel' : 'Call panel';
}
railBtn?.addEventListener('click', () => setRail(!argo.classList.contains('rail-open')));
addEventListener('keydown', e => { if (e.key === 'Escape' && argo?.classList.contains('rail-open') && matchMedia('(max-width: 1279px)').matches) { setRail(false); railBtn.focus(); } });
$('stage')?.addEventListener('pointerdown', () => { if (argo?.classList.contains('rail-open')) setRail(false); });

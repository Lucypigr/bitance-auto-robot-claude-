// ⓘ 說明：滑鼠移上去／點擊（手機點擊）顯示白話解釋與常見誤解
import { GLOSSARY, hasTerm } from './glossary.js';
import { illustrationHtml } from './illustrations.js';

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function btn(key, ill) {
  const g = GLOSSARY[key];
  const title = g ? g.title : key;
  return `<button type="button" class="ibtn" data-term="${esc(key)}"${ill ? ` data-ill="${esc(ill)}"` : ''} aria-label="說明：${esc(title)}" aria-haspopup="true">ⓘ</button>`;
}

/** 產生「文字 + ⓘ」的 HTML */
export function term(key, label, ill) {
  if (!hasTerm(key)) console.warn('缺少名詞說明：', key);
  return `<span class="tw">${esc(label)}${btn(key, ill)}</span>`;
}

/** 把靜態 HTML 中的 [data-term] 元素補上 ⓘ 按鈕 */
export function decorate(root = document) {
  root.querySelectorAll('[data-term]:not(.ibtn):not(.tw)').forEach((el) => {
    if (el.querySelector(':scope > .ibtn')) return;
    el.classList.add('tw');
    el.insertAdjacentHTML('beforeend', btn(el.dataset.term));
  });
}

let pop;
let current = null;
let pinned = false;
let hideTimer = 0;
let showTimer = 0;

function ensurePop() {
  if (pop) return pop;
  pop = document.createElement('div');
  pop.id = 'info-pop';
  pop.setAttribute('role', 'tooltip');
  pop.hidden = true;
  document.body.appendChild(pop);
  pop.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  pop.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !pinned) scheduleHide(); });
  return pop;
}

function show(button, pin) {
  const key = button.dataset.term;
  const g = GLOSSARY[key];
  if (!g) return;
  const p = ensurePop();
  clearTimeout(hideTimer);
  p.innerHTML = `<div class="pop-title">${esc(g.title)}</div>
    ${illustrationHtml(button.dataset.ill || key)}
    <div class="pop-plain">${esc(g.plain)}</div>
    <div class="pop-caution"><b>⚠ 常見誤解／提醒</b><span>${esc(g.caution)}</span></div>
    <button type="button" class="pop-close" aria-label="關閉說明">關閉</button>`;
  p.hidden = false;
  current = button;
  pinned = !!pin;
  button.setAttribute('aria-describedby', 'info-pop');
  p.classList.toggle('pinned', pinned);
  place(button);
}

function place(button) {
  const p = pop;
  const r = button.getBoundingClientRect();
  const pw = Math.min(340, window.innerWidth - 16);
  p.style.width = pw + 'px';
  let left = r.left + r.width / 2 - pw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  p.style.left = left + window.scrollX + 'px';
  const ph = p.offsetHeight;
  let top = r.bottom + 8;
  if (top + ph > window.innerHeight - 8 && r.top - ph - 8 > 8) top = r.top - ph - 8;
  p.style.top = top + window.scrollY + 'px';
}

function hide() {
  if (!pop) return;
  pop.hidden = true;
  pinned = false;
  if (current) current.removeAttribute('aria-describedby');
  current = null;
}
function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, 180);
}

export function initInfo() {
  ensurePop();
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const b = e.target.closest && e.target.closest('.ibtn');
    if (!b) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => { if (!pinned) show(b, false); }, 120);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return;
    const b = e.target.closest && e.target.closest('.ibtn');
    if (!b) return;
    clearTimeout(showTimer);
    if (!pinned) scheduleHide();
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.ibtn');
    if (b) {
      e.preventDefault();
      e.stopPropagation();
      if (current === b && pinned) hide(); else show(b, true);
      return;
    }
    if (e.target.closest && e.target.closest('.pop-close')) { hide(); return; }
    if (pop && !pop.hidden && !pop.contains(e.target)) hide();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  document.addEventListener('focusin', (e) => {
    const b = e.target.closest && e.target.closest('.ibtn');
    if (b && !pinned) show(b, false);
  });
  window.addEventListener('resize', () => { if (current && !pop.hidden) place(current); });
  window.addEventListener('scroll', () => { if (current && !pop.hidden && !pinned) hide(); }, { passive: true });
}

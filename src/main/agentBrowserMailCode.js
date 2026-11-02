// browser_fill_mail_code: an agent reaches a page asking for a code a site sent by email. The agent
// asks, the person allows on a card, and Tessel reads the code from their connected mail, types it
// into the page, submits, and empties the field: one action, in one tool call, with every browser
// tool of every pane waiting behind it for at most 30 seconds. When the call has ended the other
// browser tools work as they always do.
//
// Why it is one action: an agent that controls a page can get at what the page holds, and nothing
// can hide that from it. Masking does not help: a mask over text an agent can put on the page answers
// its guesses. So there is no moment when an agent holds the page with the code in the field, and a
// one-time code that was submitted is spent.
//
// What stays out of the agent's reach:
// - The code stays in this process: from Gmail's answer to the page. It is on no card, in no answer,
//   log or error, and the answer is fixed fields.
// - Until the mail's card, the only outcome about the mail is "no clear code", so no sender hint
//   tells an agent what is in the person's mail.
// - The site is the page's real top-level origin, never the agent's word. The sender is compared with
//   it, and the mail's own words are on the card (mailCode.js).
//
// What it cannot do: a page can do what it likes with a code it was given, and if a site shows the code
// on a page, the agent can read it there: the card says so. A code the site did not take (submitted:
// unknown) may still be good. An agent allowed to read the same mail through tessel_apps can read the
// code there. And an agent with a shell runs as the person, who can read Tessel's files.
import crypto from 'crypto'
import { CliError } from './cliServer'
import { BrowserInputError, click, elementCenter, focusedField, isolatedWorld, navigationKey, pressKey, refuseIfPassword, rememberSecrets, resolveRef } from './agentBrowserInput'
import { checkSender, codePurpose, domainInfo, extractCode, fitsHint, hintFitsPage, httpsOrigin, mailCodeCard, parseFrom, subjectOf } from './mailCode'
import { seenLine } from './tesselApps/unseen'

// How far back a mail counts.
export const MAIL_WINDOW_MS = 15 * 60 * 1000
// Times a pane has Tessel read the mail, whatever came of it: counted before it is read.
export const MAIL_CODE_MAX = 5
export const MAIL_CODE_WINDOW_MS = 5 * 60 * 1000
// The same for one site, whichever panes ask.
export const ORIGIN_MAX = 8
export const ORIGIN_WINDOW_MS = 15 * 60 * 1000
// After a Deny: that site and that mail get no card, from any pane. After this many, nothing does.
export const DENY_MS = 15 * 60 * 1000
export const DENIES_MAX = 2
// After the last box, before Tessel submits: many forms go on by themselves. Then again before it
// empties a form that was sent: a page's script may read the field a moment after the event.
export const SETTLE_MS = 400
// How long Tessel watches for the page to take it.
export const SUBMIT_WAIT_MS = 8000
// How long a document Tessel could not confirm empty stays out of snapshots and screenshots.
export const HOLD_MS = 2 * 60 * 1000
// Tried again each HOLD_MS while it still holds something, and let go at this whatever it holds.
export const HOLD_MAX_MS = 10 * 60 * 1000
const POLL_MS = 150
// How often the watch asks the window whether a guest has come in.
const SHARE_CHECK_MS = 500
// The tools wait no longer than this for the action to end, even if a page never answers.
const LOCK_MAX_MS = 30 * 1000
// Of that, for emptying a field at the end, whatever the page does.
const CLEANUP_MS = 5000
// Of that, for browser commands of this page that are still running, whatever their answer said.
const COMMANDS_WAIT_MS = 10 * 1000
const CARD_TIMEOUT_MS = 5 * 60 * 1000
const MAX_ACCOUNTS = 5
const MAX_REASON = 200

const fail = (code, message) => new CliError(code, message)

const TYPE_IT = 'Ask the user to type the code into the page themselves; never ask them to tell it to you.'
const SHARED = `Refused: this project is shared in Live Share (or was, and the user has not written to you since), and a guest could read the page. ${TYPE_IT}`
const NO_CODE = `No mail with one clear code was found, and nothing was shown to the user. The mail may not have arrived: wait about 30 seconds and try again. If other mail came in since, pass "sender": the address or domain this site sends from. If it still fails: ${TYPE_IT}`
const CHANGED = 'The page changed since the user allowed this, so no code was typed. Read the page again with browser_snapshot, and ask again if it still wants the code.'
const CHANGED_AFTER = 'The page changed or closed while the code was being typed and submitted. Read it again with browser_snapshot before anything else.'
const NOT_FILLED = `Tessel could not fill the code into this field. ${TYPE_IT}`
const NOT_A_CODE_FIELD = `Tessel fills a code only into a field made for one: one the page marks as a one-time code, or labels as a code, or a row of one-character boxes; never a search box, a card's field or a field for something else. Give the ref of the code field (of the first box, for a row of boxes) from browser_snapshot. If this is it: ${TYPE_IT}`
const HELD = 'Tessel typed a code from the user\'s mail into this page and could not confirm the field is empty, so no snapshot or screenshot of this page is taken until it navigates away, closes or the field is empty, for at most 10 minutes.'
const RUNNING = 'Another browser command on this page is still running, so no code was typed. Try again when it has ended, or ask the user to type the code into the page themselves; never ask them to tell it to you.'
const SAID = {
  yes: 'The form was sent, or the page began to load. Read the page with browser_snapshot to see whether the code was accepted. If it was refused, do not ask again unless the user wants you to.',
  no: 'Tessel typed the code but could not submit the form. Ask the user to look at this page.',
  unknown: 'Tessel typed the code and tried to submit it, and did not see the form sent or the page load. Read the page with browser_snapshot. If it still asks for the code, pass the "button" ref of its submit button when you ask again, or ask the user to type it.'
}
const MAIL_FAILURES = {
  reconnect: ['reconnect', 'Gmail needs connecting again: the user does it in Tessel, Settings > Connections.'],
  signed_out: ['signed_out', 'The user is signed out of their Tessel account, which renews this connection: they sign in at Settings > Tessel account.'],
  not_connected: ['not_connected', 'Gmail is not connected in Tessel. The user connects it in Settings > Connections; until then, ask them to type the code into the page themselves.'],
  forbidden: ['forbidden', 'This connection may not read mail. The user can connect Gmail again in Tessel, Settings > Connections.']
}

// What runs on the element in Tessel's isolated world. Exported for the specs, which run them on a
// real DOM. A field: an input for text a person can see and change, not a password's. A box: such an
// input for one character, by its limit or its size. A row: four or more boxes close together in the
// page (a narrow pane can wrap them, so not by where they are drawn).
const FIELD_HELPERS = `
  const TYPES = new Set(['text', 'tel', 'number']);
  const attr = (e, name) => Element.prototype.getAttribute.call(e, name);
  const rect = (e) => e.getClientRects()[0];
  const usable = (e) => {
    if (String(e.tagName).toUpperCase() !== 'INPUT' || !TYPES.has(String(e.type).toLowerCase())) return false;
    if (e.disabled || e.readOnly) return false;
    if (/(^|\\s)(current|new)-password(\\s|$)/i.test(attr(e, 'autocomplete') || '')) return false;
    const r = rect(e);
    if (!r || r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(e);
    const dots = st.webkitTextSecurity || st.getPropertyValue('-webkit-text-security');
    return st.visibility !== 'hidden' && st.visibility !== 'collapse' && st.display !== 'none' && (!dots || dots === 'none');
  };
  const isBox = (e) => usable(e) && (e.maxLength === 1 || (e.maxLength < 0 && attr(e, 'size') === '1'));
  const rowOf = (e) => {
    if (!isBox(e)) return [];
    for (let up = e.parentElement, i = 0; up && i < 5; up = up.parentElement, i++) {
      const list = Array.from(up.querySelectorAll('input')).filter(isBox);
      if (list.length >= 4) return list;
    }
    return [];
  };
  const originOf = (raw) => {
    try {
      const u = new URL(raw, document.baseURI);
      return u.protocol === 'javascript:' ? null : u.origin;
    } catch (e) { return 'unknown'; }
  };
  const isGet = (value) => /^\\s*get\\s*$/i.test(value || '');`
// What says a field is for a code: whole phrases, in English and French. A bare "code" only as all of
// a label: "Issue title (code review)", "Sort code" or "Source code URL" say something else.
const CODE_WORDS = `
  const clean = (t) => String(t == null ? '' : t).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^\\p{L}\\p{N}]+/gu, ' ').trim().toLowerCase();
  const WHOLE = /^(?:(?:the|your|enter|le|votre|ton|entrez|entrer|saisissez|saisir) )*(?:code|otp|otc|totp|pin|nip|passcode|token|jeton|verification|v[ée]rification|security code|code de s[ée]curit[ée])$/;
  const PHRASE = new RegExp('(?:^| )(?:' + [
    'verification code', 'verify code', 'confirmation code', 'log ?in code', 'sign ?in code', 'auth(?:entication|enticator)? code', 'access code', 'temporary (?:code|password)',
    'one ?time (?:code|password|passcode|pin)', 'otp', 'otc', 'totp', 'mfa', '2fa', 'two factor', 'passcode', '\\\\d digit (?:code|number)', 'digit code',
    'enter (?:the |your |this )?code', 'code (?:we )?sent', 'sent (?:you )?a code', 'code from', 'email code',
    'code de v[ée]rification', 'code de confirmation', 'code de connexion', 'code d authentification', 'code d activation', 'code de validation', 'code [àa] usage unique', 'code unique', 'code temporaire',
    'mot de passe temporaire', 'mot de passe [àa] usage unique', '(?:entrez|entrer|saisissez|saisir|indiquez|indiquer) (?:le |votre |ce )?code', 'code (?:de s[ée]curit[ée] )?re[çc]u', 'code envoy[ée]', 'nip temporaire', '\\\\d chiffres'
  ].join('|') + ')(?: |$)');
  const NOT_THIS = /(?:^| )(?:guests?|meeting|r[ée]union|shared|partag\\S*|new user|nouvel utilisateur|set a|d[ée]finir|choose|choisir|redeem|sku|guess|comment|commentaire|promo\\S*|coupon|discount|gift|voucher|referr\\S*|invit\\S*|postal|post code|postcode|zip|zipcode|area code|country code|rabais|cadeau|parrain\\S*|search|recherche|query|qr|bar code|barcode|cvv\\d?|cvc\\d?|csc|captcha|sort code|swift|comment\\S*|title|titre|card number|card security|credit card|debit card|card code|carte de cr[ée]dit|carte bancaire|de la carte|on the back|au dos)(?: |$)/;
  const CARD_FIELD = /(?:^| )(?:card ?number|cc ?(?:num|number)|cvv\\d?|cvc\\d?|csc|expiry|exp date|credit card|debit card|num[ée]ro de carte)(?: |$)/;
  const OTHER_FIELD = /(?:^| )(?:phone|tel|telephone|mobile|zip|post|year|date|amount|qty|quantity|price|age|card|cc|q|search|message|note|title|comment|name)(?: |$)/;
  const NOT_BESIDE = /(?:^| )(?:e ?mail|courriel|user|username|login|reply|body|text|subject)(?: |$)/;`
export const FIELD_FN = `function (origin) {${FIELD_HELPERS}${CODE_WORDS}
  if (location.origin !== origin || location.protocol !== 'https:') return { ok: false, why: 'origin' };
  if (!this.isConnected || this.ownerDocument !== document) return { ok: false, why: 'field' };
  if (String(this.tagName).toUpperCase() === 'INPUT' && String(this.type).toLowerCase() === 'search') return { ok: false, why: 'search' };
  if (!usable(this)) return { ok: false, why: 'field' };
  if (this.closest('[role=search],search')) return { ok: false, why: 'search' };
  const form = this.form;
  const sends = [];
  let cardForm = false;
  if (form) {
    if (isGet(attr(form, 'method'))) return { ok: false, why: 'search' };
    const action = attr(form, 'action');
    // (A form with no action sends to the page itself, whatever a base element says.)
    sends.push(action ? originOf(action) : location.origin);
    const members = Array.from(Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'elements').get.call(form));
    // An image button is left out of form.elements, and Enter still presses it.
    const images = Array.from(document.querySelectorAll('input')).filter((e) => String(e.type).toLowerCase() === 'image' && e.form === form);
    for (const m of members.concat(images)) {
      if (isGet(attr(m, 'formmethod'))) return { ok: false, why: 'search' };
      const to = attr(m, 'formaction');
      if (to) sends.push(originOf(to));
      if (/(^|\\s)cc-/.test(String(attr(m, 'autocomplete') || '').toLowerCase()) || [attr(m, 'name'), m.id, attr(m, 'placeholder'), attr(m, 'aria-label')].some((t) => CARD_FIELD.test(clean(t)))) cardForm = true;
    }
  }
  const labelled = attr(this, 'aria-labelledby');
  const namedBy = labelled ? labelled.split(/\\s+/).map((id) => { const e = this.ownerDocument.getElementById(id); return e ? e.textContent : ''; }) : [];
  const labels = Array.from(this.labels || []).map((l) => l.textContent);
  const spoken = labels.concat(namedBy, [attr(this, 'aria-label'), attr(this, 'title')]).filter(Boolean);
  const placeholder = attr(this, 'placeholder');
  const names = [attr(this, 'name'), this.id].filter(Boolean);
  // A placeholder speaks only for a field with no label.
  const sources = (spoken.length ? spoken : [placeholder]).concat(names).map(clean).filter(Boolean);
  const words = sources.concat(clean(placeholder)).join(' ');
  const auto = String(attr(this, 'autocomplete') || '').toLowerCase();
  const other = NOT_THIS.test(words) || /(^|\\s)cc-/.test(auto);
  const boxes = rowOf(this).length;
  const named = sources.some((t) => WHOLE.test(t) || PHRASE.test(t));
  const says = (test) => sources.some((t) => test.test(t));
  // A number for a placeholder, as long as a code, on a field with no label saying what it is.
  const shaped = !spoken.length && /^[\\d\\s•·_xX-]+$/.test(placeholder || '') && /^\\d{4,8}$|^[•·_xX]{4,8}$/.test(String(placeholder).replace(/[\\s-]/g, '')) && !says(OTHER_FIELD);
  // The only field of a small block saying "Enter the code we sent you", made for a number or a set
  // length, and not saying what else it is.
  let beside = '';
  const numeric = /^(number|tel)$/i.test(this.type) || /^(numeric|decimal)$/i.test(attr(this, 'inputmode') || '') || this.maxLength > 0;
  if (!named && !shaped && numeric && !says(OTHER_FIELD) && !says(NOT_BESIDE)) {
    for (let up = form || this.parentElement, i = 0; up && i < 2 && !beside; up = form ? null : up.parentElement, i++) {
      const fields = Array.from(up.querySelectorAll('input,textarea,select')).filter((e) => e === this || usable(e) || String(e.tagName).toUpperCase() !== 'INPUT');
      if (fields.length !== 1) break;
      const near = clean(String(up.textContent || '').slice(0, 400));
      if (near && near.length <= 300 && PHRASE.test(near) && !NOT_THIS.test(near)) beside = String(up.textContent).replace(/\\s+/g, ' ').trim().slice(0, 200);
    }
  }
  // (One Tessel filled before took "off" for its autocomplete: this world alone remembers it.)
  const before = !!window.__tesselCodeFields && window.__tesselCodeFields.has(this);
  const codeLike = !cardForm && (before || ((/(^|\\s)one-time-code(\\s|$)/.test(auto) || boxes > 0 || named || shaped || !!beside) && !other));
  const label = String(labels[0] || namedBy[0] || attr(this, 'aria-label') || (shaped ? '' : placeholder) || beside || attr(this, 'name') || this.id || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  return { ok: true, type: String(this.type).toLowerCase(), maxLength: this.maxLength, boxes, sends, codeLike, label: boxes > 0 && !labels[0] && !attr(this, 'aria-label') ? '' : label };
}`
export const ROW_FN = `function () {${FIELD_HELPERS}
  return rowOf(this);
}`
// The button the agent named. With a form around the field, only a submit control of that form. With
// none, a button of this document that is in no other form and goes to no address (the card warns).
export const BUTTON_FN = `function (origin, field) {${FIELD_HELPERS}
  if (location.origin !== origin || !this.isConnected || this.ownerDocument !== document || !field || field.ownerDocument !== document) return { ok: false };
  const tag = String(this.tagName).toUpperCase();
  const type = String(this.type || '').toLowerCase();
  const r = rect(this);
  if (this.disabled || !r || r.width < 1 || r.height < 1) return { ok: false };
  if (isGet(attr(this, 'formmethod'))) return { ok: false };
  const label = String(this.textContent || this.value || attr(this, 'aria-label') || attr(this, 'title') || '').trim().slice(0, 200);
  const sends = attr(this, 'formaction') ? [originOf(attr(this, 'formaction'))] : [];
  if (field.form) {
    const submits = (tag === 'BUTTON' && type === 'submit') || (tag === 'INPUT' && (type === 'submit' || type === 'image'));
    if (!submits || this.form !== field.form) return { ok: false };
    return { ok: true, sends, label, formless: false };
  }
  if (this.form) return { ok: false };
  const href = tag === 'A' ? String(attr(this, 'href') || '').trim() : '';
  if (href && href !== '#' && !/^javascript:/i.test(href)) return { ok: false };
  const pressable = (tag === 'BUTTON' && type !== 'reset') || (tag === 'INPUT' && (type === 'submit' || type === 'button' || type === 'image')) || attr(this, 'role') === 'button' || (tag === 'A' && attr(this, 'role') === 'button');
  if (!pressable) return { ok: false };
  return { ok: true, sends, label, formless: true };
}`
// Emptied through the browser's own setter, and then its type changed and put back: the setter leaves
// the undo and redo history, and only that ends it (real Chromium, by hand and through the agent's keys).
const EMPTY_HELPER = `
  const emptyOne = (e) => {
    const proto = HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, '');
    const root = e.getRootNode();
    const had = root.activeElement === e;
    const type = Element.prototype.getAttribute.call(e, 'type');
    Element.prototype.setAttribute.call(e, 'type', 'hidden');
    if (type === null) Element.prototype.removeAttribute.call(e, 'type');
    else Element.prototype.setAttribute.call(e, 'type', type);
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, '');
    if (had) e.focus({ preventScroll: true });
  };`
// One box, in one go, so that no timer of the page runs between looking at the keyboard and typing:
// the keyboard on this very field, in this page, what it holds selected and replaced. Then no form
// restores it when someone comes back, and a page kept to come back to has it out when it is left.
export const TYPE_FN = `function (origin, piece) {${EMPTY_HELPER}
  if (location.origin !== origin || !this.isConnected) return { ok: false, why: 'origin' };
  this.focus({ preventScroll: true });
  if (this.getRootNode().activeElement !== this) return { ok: false, why: 'focus' };
  if (typeof this.select === 'function') this.select();
  const inserted = document.execCommand('insertText', false, piece);
  (window.__tesselCodeFields = window.__tesselCodeFields || new WeakSet()).add(this);
  Element.prototype.setAttribute.call(this, 'autocomplete', 'off');
  const field = this;
  window.addEventListener('pagehide', () => emptyOne(field), { once: true });
  return { ok: true, inserted: inserted === true };
}`
// While Tessel is at it (ms), this field's form: whether it was sent, and a form with no method kept
// from putting the code in the page's address when nothing of the page's own takes it first, as most
// sites' scripts do. At the very end of the event, so that those run first.
export const FORM_WATCH_FN = `function (ms) {
  const form = this.form;
  window.__tesselFormSent = false;
  if (!form) return true;
  const said = (e, name) => Element.prototype.getAttribute.call(e, name);
  const staysInBody = (value) => /^(?:post|dialog)$/i.test(value || '');
  const until = Date.now() + (Number(ms) || 0);
  const held = (event) => {
    if (Date.now() > until) return window.removeEventListener('submit', held);
    if (event.target !== form) return;
    // (As Chromium reads them: a submitter's formmethod counts as soon as it is there, an empty one is
    // GET, and neither is trimmed.)
    const by = event.submitter ? said(event.submitter, 'formmethod') : null;
    if (event.defaultPrevented || staysInBody(by !== null ? by : said(form, 'method'))) window.__tesselFormSent = true;
    else event.preventDefault();
  };
  window.__tesselFormWatch = held;
  window.addEventListener('submit', held);
  return true;
}`
export const FORM_WATCH_OFF_FN = `function () {
  if (window.__tesselFormWatch) window.removeEventListener('submit', window.__tesselFormWatch);
  window.__tesselFormWatch = null;
  return true;
}`
// The keyboard back on the field, for Enter.
export const FOCUS_FN = `function (origin) {
  if (location.origin !== origin || !this.isConnected) return false;
  this.focus({ preventScroll: true });
  return this.getRootNode().activeElement === this;
}`
// Empties this very element, whatever it holds now.
export const EMPTY_FN = `function () {${EMPTY_HELPER}
  emptyOne(this);
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`
const VALUE_FN = 'function () { return { connected: this.isConnected, value: String(this.value == null ? "" : this.value) } }'

// The sender the agent named: one word for Gmail's search, no operators of its own.
function senderHint(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const hint = String(raw).trim().toLowerCase()
  if (hint.length > 200 || !/^[a-z0-9._+-]+(?:@[a-z0-9.-]+)?$/.test(hint)) throw fail('invalid_argument', '"sender" is one address or domain, like "no-reply@shop.example" or "shop.example".')
  return hint
}

// The same page as the person allowed: origin, path and query.
function samePage(a, b) {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search
  } catch {
    return false
  }
}
// The site a request is about: what its Deny and its limit go by.
function siteOfHost(host) {
  const info = domainInfo(host)
  return info.domain || info.host
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// What the page may never answer: its answer, or this after that long.
function limited(work, ms, otherwise) {
  let timer
  const limit = new Promise((resolve) => (timer = setTimeout(resolve, ms, otherwise)))
  return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

// deps:
//   ask(method, params, opts)        the window
//   recentMail                       { accounts(), newest(account, { windowMs, sender, fits }) } (tesselApps)
//   pageAllowed(guest) -> bool       browser_login's own rule: not a Live Share guest's window, not a shared page, the browser's session
//   log                              { info, warn }
//   mailReadAllowed(pane) -> bool    this pane may read Gmail through tessel_apps: the card says so
//   timing                           { settleMs, submitWaitMs, pollMs, shareCheckMs, lockMs, cleanupMs, commandsMs } (specs)
export function createMailCode({ ask, recentMail = null, pageAllowed = () => false, log = null, now = () => Date.now(), mailReadAllowed = () => false, timing = {} }) {
  const settleMs = timing.settleMs ?? SETTLE_MS
  const submitWaitMs = timing.submitWaitMs ?? SUBMIT_WAIT_MS
  const pollMs = timing.pollMs ?? POLL_MS
  const shareCheckMs = timing.shareCheckMs ?? SHARE_CHECK_MS
  const lockMs = timing.lockMs ?? LOCK_MAX_MS
  const cleanupMs = timing.cleanupMs ?? CLEANUP_MS
  const commandsMs = timing.commandsMs ?? COMMANDS_WAIT_MS
  const uses = new Map() // pane -> times of its requests
  const siteUses = new Map() // site -> times of its requests
  const denied = new Map() // site -> until when it gets no card
  const deniedMails = new Map() // mail id -> until when it gets no card
  let denies = [] // times of the person's Denies
  const usedMails = new Map() // mail id -> { page, until }
  const waiting = new Set() // panes with a request going on
  const held = new Map() // guest id -> { ids, until, last, ... }: a document Tessel could not confirm empty
  const filling = new Map() // guest id with the action going on -> a promise of its end
  let lockTail = Promise.resolve()

  // A document Tessel could not confirm empty: out of snapshots and screenshots until it navigates
  // away or closes (a pushState does neither), or is emptied when its time comes, and at most
  // HOLD_MAX_MS whatever it holds then.
  async function refuseHeld(guest) {
    // (A page so slow that the lock ended before the action did.)
    if (filling.has(guest.id)) throw fail('page_held', HELD)
    const entry = held.get(guest.id)
    if (!entry) return
    if (now() < entry.until) throw fail('page_held', HELD)
    const sure = await limited(entry.attach(guest, entry.s).then((cdp) => emptyFields(cdp, entry.s, entry.ids)).catch(() => false), cleanupMs, false)
    if (!sure && now() < entry.last) {
      entry.until = Math.min(entry.last, now() + HOLD_MS)
      throw fail('page_held', HELD)
    }
    held.delete(guest.id)
    if (!sure && log) log.warn('agent-browser', 'a page Tessel could not confirm empty is read again: its time is up') // i18n-ignore log
  }
  function hold({ guest, id, s, attach }, ids) {
    const t = now()
    const entry = { ids, s, attach, until: t + HOLD_MS, last: t + HOLD_MAX_MS }
    held.set(id, entry)
    const end = () => {
      if (held.get(id) === entry) held.delete(id)
    }
    if (typeof guest.once === 'function') {
      guest.once('did-navigate', end)
      guest.once('destroyed', end)
    }
  }

  // --- The request ---------------------------------------------------------------------------------
  function counted(map, key, max, windowMs, what) {
    const t = now()
    const list = (map.get(key) || []).filter((x) => t - x < windowMs)
    if (list.length >= max) throw fail('rate_limited', `Too many requests for a mail code ${what}: at most ${max} in ${windowMs / 60000} minutes. Wait, or ask the user to type the code into the page themselves.`)
    list.push(t)
    map.set(key, list)
  }
  const DECLINED_BEFORE = `The user declined a mail code a moment ago: Tessel will not ask them again for ${Math.ceil(DENY_MS / 60000)} minutes. Do not try another way. If they want it, they type the code into the page themselves.`
  function refuseDenied(site) {
    const t = now()
    denies = denies.filter((at) => t - at < DENY_MS)
    if (denies.length >= DENIES_MAX) throw fail('denied', DECLINED_BEFORE)
    const until = denied.get(site)
    if (!until) return
    if (t >= until) denied.delete(site)
    else throw fail('denied', DECLINED_BEFORE)
  }

  // Refused outright while a guest could read the page. -> who is asking
  async function notShared(pane, guest) {
    if (guest.isDestroyed()) throw fail('page_changed', CHANGED)
    if (!pageAllowed(guest)) throw fail('shared', SHARED)
    const who = await ask('terminalTarget', { agent: pane, op: 'mailCodeInfo' })
    if (!who || typeof who !== 'object') throw fail('no_answer', 'Tessel\'s window did not answer: try again in a moment.')
    if (who.shared || who.sharedBefore || who.wroteLast || (Array.isArray(who.guests) && who.guests.length)) throw fail('shared', SHARED)
    return who
  }

  // Runs a function of ours on a node. -> what it returned
  async function onNode(cdp, s, backendNodeId, functionDeclaration, args = []) {
    const contextId = await isolatedWorld(cdp, s)
    const { object } = await cdp('DOM.resolveNode', { backendNodeId, executionContextId: contextId })
    if (!object || !object.objectId) throw new Error('No node with given id found')
    try {
      const r = await cdp('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, arguments: args.map((value) => ({ value })), returnByValue: true })
      return r && r.result ? r.result.value : undefined
    } finally {
      cdp('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {})
    }
  }
  const fieldInfo = async (cdp, s, id, origin) => (await onNode(cdp, s, id, FIELD_FN, [origin])) || { ok: false, why: 'field' }

  // What the form sends to: this site, as browser_login asks, its other hosts too.
  function staysOnSite(to, origin) {
    if (!to || to === origin) return true
    try {
      const domain = domainInfo(new URL(origin).hostname).domain
      return !!domain && new URL(to).protocol === 'https:' && domainInfo(new URL(to).hostname).domain === domain
    } catch {
      return false
    }
  }
  const formStays = (info, origin) => (info.sends || []).every((to) => staysOnSite(to, origin))

  // The row's boxes, by their backend ids.
  async function rowIds(cdp, s, backendNodeId) {
    const contextId = await isolatedWorld(cdp, s)
    const { object } = await cdp('DOM.resolveNode', { backendNodeId, executionContextId: contextId })
    if (!object || !object.objectId) return []
    const { result } = await cdp('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: ROW_FN, returnByValue: false })
    cdp('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {})
    if (!result || !result.objectId) return []
    const { result: props } = await cdp('Runtime.getProperties', { objectId: result.objectId, ownProperties: true })
    const ids = []
    for (const p of props || []) {
      if (!/^\d+$/.test(p.name) || !p.value || !p.value.objectId) continue
      const { node } = await cdp('DOM.describeNode', { objectId: p.value.objectId })
      if (node && node.backendNodeId) ids.push(node.backendNodeId)
    }
    cdp('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {})
    return ids
  }

  // Looks at the field and each of its boxes. -> { ids, info } or throws.
  async function lookAtFields(cdp, s, id, origin, whenWrong) {
    await rememberSecrets(cdp, s)
    await refuseIfPassword(cdp, id, s)
    const info = await fieldInfo(cdp, s, id, origin)
    if (!info.ok && info.why === 'origin') throw fail('page_changed', CHANGED)
    if (!info.ok && info.why === 'search') throw whenWrong('not_a_code_field', NOT_A_CODE_FIELD)
    if (!info.ok) throw whenWrong('not_a_text_field', 'A code goes only into a text field that is visible and enabled, not a password field: give the ref of the code field (of the first box, for a row of boxes) from browser_snapshot.')
    if (!info.codeLike) throw whenWrong('not_a_code_field', NOT_A_CODE_FIELD)
    if (!formStays(info, origin)) throw whenWrong('unsafe_form', 'The form around this field sends to another site, so Tessel does not fill a code into it. Ask the user to look at this page.')
    const ids = info.boxes > 0 ? await rowIds(cdp, s, id) : [id]
    for (const box of ids) {
      if (box === id) continue
      await refuseIfPassword(cdp, box, s)
      const other = await fieldInfo(cdp, s, box, origin)
      if (!other.ok || !formStays(other, origin)) throw whenWrong('unsafe_form', 'A box of this row is not one Tessel fills, or its form sends to another site. Ask the user to look at this page.')
    }
    return { ids, info }
  }
  async function lookAtButton(cdp, s, buttonId, fieldId, origin, whenWrong) {
    const contextId = await isolatedWorld(cdp, s)
    const button = await cdp('DOM.resolveNode', { backendNodeId: buttonId, executionContextId: contextId })
    const field = await cdp('DOM.resolveNode', { backendNodeId: fieldId, executionContextId: contextId })
    if (!button.object || !field.object) throw whenWrong('page_changed', CHANGED)
    try {
      const r = await cdp('Runtime.callFunctionOn', { objectId: button.object.objectId, functionDeclaration: BUTTON_FN, arguments: [{ value: origin }, { objectId: field.object.objectId }], returnByValue: true })
      const info = (r && r.result && r.result.value) || { ok: false }
      if (!info.ok || !formStays(info, origin)) throw whenWrong('unsafe_button', 'Tessel presses only the submit button of the form around this field, one that sends to this site. Give that button\'s ref, or leave "button" out for Enter.')
      return info
    } finally {
      cdp('Runtime.releaseObject', { objectId: button.object.objectId }).catch(() => {})
      cdp('Runtime.releaseObject', { objectId: field.object.objectId }).catch(() => {})
    }
  }

  // Before any mail is read: is this a field a code can go in? -> the elements, as they are now: the
  // person's yes is for these and no others, so nothing later looks for them again.
  async function checkField({ guest, s, pane, attach }, ref, buttonRef, origin) {
    const cdp = await attach(guest, s)
    if (s.refMap && s.refOwner !== pane) throw new BrowserInputError('stale_ref', 'Another agent read this page since your snapshot: call browser_snapshot again.')
    const inFrame = (name) => {
      const peek = s.refMap && typeof name === 'string' ? s.refMap.get(name.startsWith('@') ? name : `@${name}`) : null
      return !!peek && !!(peek.session || peek.frameId)
    }
    if (inFrame(ref) || inFrame(buttonRef)) throw fail('field_in_frame', `This field is in a frame of the page. Tessel only fills a code into the page itself. ${TYPE_IT}`)
    const entry = await resolveRef(cdp, s, ref)
    const id = entry.backendDOMNodeId
    const { info } = await lookAtFields(cdp, s, id, origin, fail)
    let button = null
    if (buttonRef) {
      const pressed = await resolveRef(cdp, s, buttonRef)
      const look = await lookAtButton(cdp, s, pressed.backendDOMNodeId, id, origin, fail)
      button = { id: pressed.backendDOMNodeId, label: look.label, formless: look.formless === true }
    }
    return { id, navKey: await navigationKey(cdp), label: info.label || '', isRow: info.boxes > 0, button }
  }

  // The newest mail among the connected accounts. -> { account, message } or null
  async function newestMail(accounts, sender) {
    let best = null
    let failure = null
    // With a sender named, the first of the last few that is really from it: Gmail's search also
    // takes display names, so a mail merely called that does not stand in the way.
    const fits = sender ? (message) => {
      const froms = (Array.isArray(message?.payload?.headers) ? message.payload.headers : []).filter((h) => h && typeof h.name === 'string' && h.name.toLowerCase() === 'from')
      return froms.length === 1 && fitsHint(parseFrom(froms[0].value), sender)
    } : null
    for (const account of accounts.slice(0, MAX_ACCOUNTS)) {
      try {
        const message = await recentMail.newest(account, { windowMs: MAIL_WINDOW_MS, sender, fits })
        if (message && (!best || Number(message.internalDate) > Number(best.message.internalDate))) best = { account, message }
      } catch (err) {
        failure = failure || err
      }
    }
    if (!best && failure) {
      const known = Object.hasOwn(MAIL_FAILURES, failure.code) ? MAIL_FAILURES[failure.code] : null
      throw known ? fail(known[0], known[1]) : fail('mail_unavailable', 'Tessel could not read the mail just now. Try again in a moment, or ask the user to type the code into the page themselves.')
    }
    return best
  }

  // The person's answer. Stop on the page's badge, or the agent's call going away, end the card too.
  async function askPerson({ s, pane, signal }, card) {
    const cardId = crypto.randomUUID()
    let cancel
    const stopped = new Promise((_resolve, reject) => (cancel = reject))
    stopped.catch(() => {})
    let onAbort
    const aborted = new Promise((_resolve, reject) => {
      onAbort = () => reject(fail('cancelled', 'The request was cancelled.'))
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
    })
    aborted.catch(() => {})
    if (!s.cancels) s.cancels = new Set()
    s.cancels.add(cancel)
    try {
      const asked = ask('terminalTarget', { agent: pane, op: 'approve', terminal: `mailcode:${pane}`, card: { ...card, cardId } }, { timeoutMs: CARD_TIMEOUT_MS })
      // (Its answer may come after the race is over.)
      asked.catch(() => {})
      return await Promise.race([asked, aborted, stopped])
    } catch (err) {
      ask('terminalTarget', { agent: pane, op: 'expire', cardId }).catch(() => {})
      if (err && err.code === 'timeout') throw fail('approval_timeout', 'The user did not answer in time.')
      throw err
    } finally {
      s.cancels.delete(cancel)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  // What the fields hold now. -> whether it is the code ('ok'), not it ('other'), or the page moved
  // on, as some do when the last box is filled ('gone'). A page may format what it holds.
  async function readBack(cdp, s, ids, code) {
    let kept = ''
    try {
      for (const id of ids) {
        const v = await onNode(cdp, s, id, VALUE_FN)
        if (!v || v.connected === false) return 'gone'
        kept += v.value
      }
    } catch {
      return 'gone'
    }
    return kept.replace(/[\s.-]/g, '').toLowerCase() === code.toLowerCase() ? 'ok' : 'other'
  }

  // Empties what was filled, by the elements themselves, whatever they hold now, and nothing else.
  // -> true when each is known to be empty or gone with its document.
  async function emptyFields(cdp, s, ids) {
    let sure = true
    for (const id of ids) {
      try {
        await onNode(cdp, s, id, EMPTY_FN)
        const after = await onNode(cdp, s, id, VALUE_FN)
        if (after && after.connected !== false && after.value) sure = false
      } catch (err) {
        if (!/no node|not found|could not find|cannot find|context/i.test(String(err && err.message))) sure = false
      }
    }
    return sure
  }

  // The whole of it, with every browser tool waiting: type, submit, watch, empty. A failure is one
  // outcome, whatever it was, and the fields were emptied before it is said. Whatever the page, a Stop
  // or a page closing do, it ends within the lock, and past its time nothing reaches the page.
  // -> { submitted: 'yes' | 'no' | 'unknown', emptied }
  async function fillAndSubmit(ctx, field, code, origin, url, stillMine) {
    const { guest, id, s, pane, attach, frameList } = ctx
    let ended
    filling.set(id, new Promise((resolve) => (ended = resolve)))
    // (A capture or a snapshot begun before this and ending after is dropped: agentBrowser.js.)
    s.fills = (s.fills || 0) + 1
    const actionMs = lockMs - cleanupMs
    const deadline = Date.now() + actionMs
    let over = false
    const inTime = () => {
      if (over || Date.now() > deadline) throw fail('could_not_fill', NOT_FILLED)
    }
    const stillFine = () => {
      inTime()
      stillMine()
      if (!samePage(guest.getURL(), url)) throw fail('page_changed', CHANGED)
    }
    let cdp = null
    let ids = null
    let typing = false
    let pressed = false
    let navigating = false
    let committed = false
    let onNavigation = null
    const onCommit = () => (committed = true)
    let emptied = true
    const formSent = async () => {
      try {
        const contextId = await isolatedWorld(cdp, s)
        const r = await cdp('Runtime.evaluate', { expression: '!!window.__tesselFormSent', contextId, returnByValue: true })
        return !!r && !!r.result && r.result.value === true
      } catch {
        return false
      }
    }
    const taken = async () => navigating || (await formSent())
    const moved = () => guest.isDestroyed() || !samePage(guest.getURL(), url)
    const work = async () => {
      stillFine()
      cdp = await attach(guest, s)
      // Commands whose answer ran out of time and that still run: nothing overlaps this.
      const running = ctx.running()
      if (running.length && !(await limited(Promise.allSettled(running).then(() => true), commandsMs, false))) throw fail('busy', RUNNING)
      inTime()
      if ((await navigationKey(cdp)) !== field.navKey || !samePage(guest.getURL(), url)) throw fail('page_changed', CHANGED)
      const looked = await lookAtFields(cdp, s, field.id, origin, () => fail('could_not_fill', NOT_FILLED)).catch((err) => {
        if (err instanceof CliError) throw err
        if (err instanceof BrowserInputError) throw fail('could_not_fill', NOT_FILLED)
        // The element itself is gone: another one in its place is not what the person allowed.
        throw fail('page_changed', CHANGED)
      })
      const found = looked.ids
      const pieces = found.length > 1 ? [...code] : [code]
      if (pieces.length !== found.length) throw fail('could_not_fill', NOT_FILLED)
      if (found.length === 1 && looked.info.maxLength >= 0 && looked.info.maxLength < code.length) throw fail('could_not_fill', NOT_FILLED)
      if (looked.info.type === 'number' && !/^\d+$/.test(code)) throw fail('could_not_fill', NOT_FILLED)
      if (field.button) await lookAtButton(cdp, s, field.button.id, field.id, origin, () => fail('could_not_fill', NOT_FILLED))

      inTime()
      ids = found
      typing = true
      // A navigation of the page itself that begins from here on: not one already going, which a stalled
      // image can look like.
      onNavigation = (details, _url, isInPlace, isMainFrame) => {
        const main = details && details.isMainFrame !== undefined ? details.isMainFrame : isMainFrame
        const inPlace = details && details.isSameDocument !== undefined ? details.isSameDocument : isInPlace
        if (main && !inPlace) navigating = true
      }
      if (typeof guest.on === 'function') {
        guest.on('did-start-navigation', onNavigation)
        guest.on('did-navigate', onCommit)
      }
      await onNode(cdp, s, ids[0], FORM_WATCH_FN, [lockMs]).catch(() => null)
      for (let i = 0; i < ids.length; i++) {
        stillFine()
        const done = await onNode(cdp, s, ids[i], TYPE_FN, [origin, pieces[i]])
        if (!done || done.ok !== true) throw done && done.why === 'origin' ? fail('page_changed', CHANGED) : fail('could_not_fill', NOT_FILLED)
        if (!done.inserted) {
          // A page the browser will not insert into by that command: the keyboard, if it is still there.
          const focus = await focusedField(cdp, s, frameList(s))
          inTime()
          if (typeof guest.insertText !== 'function' || focus.none || focus.secret || focus.opaque || focus.remote || focus.backendNodeId !== ids[i]) throw fail('could_not_fill', NOT_FILLED)
          await guest.insertText(pieces[i])
        }
      }
      inTime()
      const reading = moved() || navigating ? 'gone' : await readBack(cdp, s, ids, code)
      if (reading === 'other') throw fail('could_not_fill', NOT_FILLED)
      // Sharing that began in the meantime: nobody gets to see it go.
      await notShared(pane, guest)
      stillMine()
      // Many forms go on by themselves at the last box.
      await sleep(settleMs)
      if (await taken()) return { submitted: 'yes' }
      // It went without saying so: nothing to press, and nothing known.
      if (moved() || (await readBack(cdp, s, ids, code)) !== 'ok') return { submitted: 'unknown' }
      stillFine()
      await notShared(pane, guest)
      try {
        if (field.button) {
          inTime()
          pressed = true
          await click(cdp, field.button.id, { at: () => elementCenter(cdp, field.button.id) })
        } else {
          await onNode(cdp, s, ids[ids.length - 1], FOCUS_FN, [origin])
          inTime()
          pressed = true
          await pressKey(cdp, 'Enter', typeof guest.sendInputEvent === 'function' ? (ev) => guest.sendInputEvent(ev) : null, s, frameList(s))
        }
      } catch (err) {
        if (err instanceof CliError) throw err
        return { submitted: 'no' }
      }
      const until = Math.min(Date.now() + submitWaitMs, deadline)
      let asked = Date.now()
      while (!over && Date.now() < until) {
        await sleep(pollMs)
        // A guest let in during the wait: emptied and refused, like one before it.
        stillMine()
        if (Date.now() - asked >= shareCheckMs) {
          asked = Date.now()
          await notShared(pane, guest)
        }
        if (await taken()) {
          // A page's script may read the field a moment after the event.
          await sleep(settleMs)
          return { submitted: 'yes' }
        }
        if (moved() || (await readBack(cdp, s, ids, code)) !== 'ok') return { submitted: 'unknown' }
      }
      return { submitted: 'unknown' }
    }
    // What ends it without waiting for the page: its time, the person's Stop, the page closing.
    const late = fail('could_not_fill', NOT_FILLED)
    let timer
    let stop
    const ending = new Promise((_resolve, reject) => {
      stop = reject
      timer = setTimeout(reject, actionMs, late)
    })
    const onClosed = () => stop(fail('page_changed', CHANGED))
    if (!s.cancels) s.cancels = new Set()
    s.cancels.add(stop)
    if (typeof guest.once === 'function') guest.once('destroyed', onClosed)
    try {
      const running = work()
      // (Still waiting on the page when one of those ended it: it stops at its next look at the time.)
      running.catch(() => {})
      return await Promise.race([running, ending])
    } catch (err) {
      if (err === late && pressed) return { submitted: 'unknown' }
      // ("No code was typed" is no longer so.)
      if (typing && err instanceof CliError && err.code === 'page_changed') throw fail('page_changed', CHANGED_AFTER)
      if (err instanceof CliError && err.code !== 'page_error') throw err
      if (err instanceof BrowserInputError && err.code === 'stale_ref') throw fail('page_changed', CHANGED)
      throw fail('could_not_fill', NOT_FILLED)
    } finally {
      over = true
      clearTimeout(timer)
      s.cancels.delete(stop)
      if (typeof guest.removeListener === 'function') {
        guest.removeListener('destroyed', onClosed)
        if (onNavigation) guest.removeListener('did-start-navigation', onNavigation)
        guest.removeListener('did-navigate', onCommit)
      }
      if (typing) {
        onNode(cdp, s, ids[0], FORM_WATCH_OFF_FN).catch(() => null)
        emptied = await limited(emptyFields(cdp, s, ids).catch(() => false), cleanupMs, false)
        // (A page closing fails that a moment before it says it has closed.)
        if (!emptied && !guest.isDestroyed()) await sleep(50)
        // (A page that went on is gone, and what it held with it.)
        if (!emptied && !guest.isDestroyed() && !committed) {
          hold(ctx, ids)
          if (log) log.warn('agent-browser', `a code could not be confirmed gone from a page on ${origin}: no screenshot or snapshot of it until it goes, for at most 10 minutes`) // i18n-ignore log
        } else emptied = true
        if (log) log.info('agent-browser', `a code from the user's mail was typed on ${origin}`) // i18n-ignore log
      }
      ctx.emptied = emptied
      filling.delete(id)
      ended()
    }
  }

  // Every browser tool of every pane waits behind this, from the moment it is asked for. (Its limit
  // is a last resort: the action ends itself within it.)
  function withLock(fn) {
    const before = lockTail
    let release
    lockTail = new Promise((resolve) => (release = resolve))
    return before.then(() => {
      const limit = setTimeout(release, lockMs + 1000)
      if (typeof limit.unref === 'function') limit.unref()
      const run = fn()
      const done = () => {
        clearTimeout(limit)
        release()
      }
      run.then(done, done)
      return run
    })
  }
  // (Until no lock is left: another may have begun while this one ended.)
  async function whenFree() {
    for (let tail; tail !== lockTail; ) {
      tail = lockTail
      await tail
    }
  }
  const whenEnded = (id) => filling.get(id) || Promise.resolve()

  // ctx: { guest, s, pane, page, agent, args, signal, inPage(fn), inAction(fn), running(), attach(guest, s), frameList(s), allowed(guest), controlled() }
  async function request(ctx) {
    const { guest, pane, args, signal, inPage, inAction, allowed } = ctx
    // (A page that closed cannot be asked for it any more.)
    ctx.id = guest.id
    const raw = seenLine(String(args.reason == null ? '' : args.reason).slice(0, 4000))
    const reason = raw.length > MAX_REASON ? `${raw.slice(0, MAX_REASON)}…` : raw
    if (!reason) throw fail('invalid_argument', 'Give "reason": one sentence for the user on why you need this code, in the language they write to you in.')
    if (typeof args.ref !== 'string') throw fail('invalid_argument', 'Give "ref": the code field\'s ref from browser_snapshot (of the first box, for a row of boxes).')
    if (args.button !== undefined && typeof args.button !== 'string') throw fail('invalid_argument', '"button" is the ref of the form\'s submit button from browser_snapshot.')
    const sender = senderHint(args.sender)
    const cancelledNow = () => {
      if (signal && signal.aborted) throw fail('cancelled', 'The request was cancelled.')
    }
    cancelledNow()
    if (waiting.has(pane)) throw fail('busy', 'You already have a request for a mail code going on: wait for its answer.')
    waiting.add(pane)
    try {
      const accounts = recentMail ? recentMail.accounts() : []
      if (!accounts.length) throw fail(...MAIL_FAILURES.not_connected)
      const who = await notShared(pane, guest)
      // The site: the browser's word, never the agent's.
      const url = guest.getURL()
      const origin = httpsOrigin(url)
      if (!origin) throw fail('https_required', 'Tessel fills a code only into an https page.')
      const host = new URL(origin).hostname
      if (host.startsWith('[')) throw fail('https_required', 'Tessel does not fill a code into a page at a bare IPv6 address.')
      if (!hintFitsPage(sender, host)) throw fail('sender_not_this_site', `"sender" must be this page's own site. A code from another site does not belong on this page. ${TYPE_IT}`)
      const site = siteOfHost(host)
      refuseDenied(site)
      const field = await inPage(() => checkField(ctx, args.ref, args.button, origin))
      cancelledNow()

      counted(uses, pane, MAIL_CODE_MAX, MAIL_CODE_WINDOW_MS, 'from one agent')
      counted(siteUses, site, ORIGIN_MAX, ORIGIN_WINDOW_MS, 'on one site')
      const found = await newestMail(accounts, sender)
      cancelledNow()
      if (!found) throw fail('no_clear_code', NO_CODE)
      const at = Number(found.message.internalDate)
      if (!Number.isFinite(at) || Math.max(0, now() - at) > MAIL_WINDOW_MS) throw fail('no_clear_code', NO_CODE)
      const check = checkSender(found.message, host, found.account, new URL(origin).port)
      if (!fitsHint(check.sender, sender)) throw fail('no_clear_code', NO_CODE)
      const extracted = extractCode(found.message)
      const { code } = extracted
      if (!code) throw fail('no_clear_code', NO_CODE)
      // One mail is for one page: a code someone expected for another agent's sign-in stays out of here.
      const pageKey = (() => {
        const u = new URL(url)
        return `${u.origin}${u.pathname}`
      })()
      const mailId = typeof found.message.id === 'string' ? found.message.id : null
      const t = now()
      for (const [id, use] of usedMails) if (use.until <= t) usedMails.delete(id)
      for (const [id, until] of deniedMails) if (until <= t) deniedMails.delete(id)
      if (mailId && deniedMails.has(mailId)) throw fail('denied', DECLINED_BEFORE)
      if (mailId && usedMails.has(mailId) && usedMails.get(mailId).page !== pageKey) throw fail('no_clear_code', NO_CODE)

      // The page may have gone on while the mail was read.
      if (!samePage(guest.getURL(), url)) throw fail('page_changed', CHANGED)
      const onHost = typeof who.onHost === 'string' && who.onHost ? who.onHost.slice(0, 100) : null
      const subject = subjectOf(found.message)
      const purpose = codePurpose({ subject, around: extracted.around, url })
      const mailCode = mailCodeCard({ url, check, subject, arrivedAt: at, account: found.account, code, fieldLabel: field.label, isRow: field.isRow, buttonLabel: field.button ? field.button.label : '', buttonFormless: !!(field.button && field.button.formless), context: extracted.context, purpose })
      mailCode.mailReadAllowed = mailReadAllowed(pane) === true
      // Each time, and nothing is kept of the answer.
      const answer = await askPerson(ctx, { kind: 'mailCode', command: '', own: false, explanation: reason, goal: '', info: null, disclaimers: [], actions: [], onHost, mailCode })
      cancelledNow()
      if (!answer || answer.allow !== true) {
        // (A card nobody answered is no Deny.)
        if (answer && !answer.timedOut) {
          denied.set(site, now() + DENY_MS)
          denies.push(now())
          if (mailId) deniedMails.set(mailId, now() + DENY_MS)
        }
        throw fail('denied', 'The user declined this. Do not ask again unless they do, and do not try another way.')
      }

      // Everything again: it may all have changed while the card was up.
      await notShared(pane, guest)
      const stillMine = () => {
        cancelledNow()
        if (guest.isDestroyed()) throw fail('page_changed', CHANGED)
        allowed(guest)
        if (!pageAllowed(guest)) throw fail('shared', SHARED)
      }
      stillMine()
      if (!samePage(guest.getURL(), url)) throw fail('page_changed', CHANGED)
      ctx.controlled()
      if (mailId) usedMails.set(mailId, { page: pageKey, until: now() + DENY_MS })
      const { submitted } = await inAction(() => withLock(() => fillAndSubmit(ctx, field, code, origin, url, stillMine))).catch(async (err) => {
        // Whatever else went wrong, this is said too. (A Stop answers before it has ended.)
        await whenEnded(ctx.id)
        if (err && ctx.emptied === false) err.message = `${err.message} ${HELD}`
        throw err
      })
      const emptied = ctx.emptied !== false
      return { text: JSON.stringify({ ok: true, submitted, emptied, note: emptied ? SAID[submitted] : `${SAID[submitted]} ${HELD}` }) }
    } finally {
      waiting.delete(pane)
    }
  }

  return { request, refuseHeld, busy: (guestId) => filling.has(guestId), whenFree, whenEnded }
}

// browser_fill_mail_code: what Tessel itself reads in a mail, in the main process, for a site's
// page: whether the mail's sender is the page's site, the one code it holds, what it seems to
// confirm, and what the person's card says. Nothing here goes to an agent. No Electron here, so it
// stays testable in Node.
import { domainToASCII, domainToUnicode } from 'node:url'
import { parse as parseHost } from 'tldts'
import { htmlToText } from './tesselApps/shared'
import { BLANK_LETTERS, seenLine, withoutUnseen } from './tesselApps/unseen'
import { t } from './i18n'

const words = (text) => new Set(text.trim().split(/\s+/))
// What stands for a code wherever one was seen: always the same, so it says nothing of its length.
export const MASK = '•••'

// --- Whose domain is this -------------------------------------------------------------------------
// The Public Suffix List (tldts), its private section included: a name under a service whose
// customers each get one (github.io) belongs to nobody in particular. A host the list does not know
// has no registrable domain, so it never matches and the person gets the warning card.
//
// And hosts the list leaves out, where anyone gets a page under the same domain, or a form on the
// company's own host: the domain says nothing about who wrote that page.
export const SHARED_HOSTS = words(`
  github.io githubusercontent.com gitlab.io bitbucket.io pages.dev workers.dev vercel.app now.sh netlify.app netlify.com
  herokuapp.com onrender.com fly.dev railway.app azurewebsites.net azurestaticapps.net cloudapp.net windows.net
  sharepoint.com onmicrosoft.com forms.office.com forms.microsoft.com onedrive.live.com
  amazonaws.com cloudfront.net elasticbeanstalk.com awsapprunner.com amplifyapp.com
  appspot.com web.app firebaseapp.com run.app cloudfunctions.net googleusercontent.com blogspot.com forms.gle
  sites.google.com docs.google.com drive.google.com script.google.com forms.google.com groups.google.com colab.research.google.com
  myshopify.com shopifypreview.com wixsite.com wixstudio.com weebly.com wordpress.com squarespace.com webflow.io
  framer.app framer.website notion.site carrd.co glitch.me repl.co replit.app replit.dev readthedocs.io surge.sh
  ngrok.io ngrok.app ngrok.dev ngrok-free.app ngrok-free.dev trycloudflare.com loca.lt serveo.net
  duckdns.org no-ip.org no-ip.com ddns.net dyndns.org hopto.org freeddns.org
  typeform.com jotform.com surveymonkey.com airtable.com calendly.com cal.com tally.so paperform.co
  zohopublic.com hubspotpagebuilder.com mailchimpsites.com canva.site gumroad.com substack.com medium.com tumblr.com
`)
// Services that give each customer a host of their choosing under their own name: no host under them
// says whose it is, "login" or "secure" included. The bare domain is the service's.
const TENANT_DOMAINS = words(`
  zendesk.com okta.com oktapreview.com service-now.com atlassian.net slack.com zoom.us kajabi.com freshdesk.com freshservice.com
  force.com salesforce.com onelogin.com auth0.com teamwork.com harvestapp.com webex.com bitrix24.com teachable.com thinkific.com bamboohr.com myworkdayjobs.com
  monday.com pagerduty.com odoo.com egnyte.com sharefile.com zohodesk.com sentry.io box.com clickup.com jumpcloud.com
`)
// The few hosts people really sign in on that the rule on labels below would warn of, those services' too.
const KNOWN_SIGN_IN_HOSTS = words('id.apple.com appleid.apple.com dash.cloudflare.com dashboard.stripe.com signin.aws.amazon.com login.salesforce.com id.atlassian.com auth.openai.com')

// host -> { host (lower case, ASCII), domain (or null), why (null, 'unknown', 'shared'), notPlain }
export function domainInfo(raw) {
  const given = String(raw == null ? '' : raw).trim().toLowerCase().replace(/\.$/, '')
  const host = given ? domainToASCII(given) : ''
  const nothing = (why, notPlain = false) => ({ host, domain: null, why, notPlain })
  if (!host || host.length > 253 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return nothing('unknown', /[^\x20-\x7e]/.test(given) || /(?:^|\.)xn--/.test(given))
  const labels = host.split('.')
  if (labels.some((l) => l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return nothing('unknown')
  const notPlain = labels.some((l) => l.startsWith('xn--'))
  // Each ending of the host, from its whole self down.
  for (let i = 0; i < labels.length - 1; i++) {
    const ending = labels.slice(i).join('.')
    if (SHARED_HOSTS.has(ending) || (i > 0 && TENANT_DOMAINS.has(ending) && !KNOWN_SIGN_IN_HOSTS.has(host))) return nothing('shared', notPlain)
  }
  const found = parseHost(host, { allowPrivateDomains: true })
  if (found.isIp) return nothing('unknown', notPlain)
  if (found.isPrivate) return nothing('shared', notPlain)
  // Not under a suffix the list knows, or the suffix itself ("co.uk").
  if (!found.isIcann || !found.domain) return nothing('unknown', notPlain)
  return { host, domain: found.domain, why: null, notPlain }
}

// One owner whose mail and sign-in live on different domains.
const SAME_OWNER = [['claude.ai', 'anthropic.com'], ['slack.com', 'slackhq.com'], ['facebook.com', 'facebookmail.com'], ['live.com', 'microsoft.com', 'microsoftonline.com'], ['amazon.com', 'signin.aws']]
export const sameOwner = (a, b) => !!a && !!b && (a === b || SAME_OWNER.some((set) => set.includes(a) && set.includes(b)))

// What a site calls the host people sign in on. Anything else under a domain may be a customer's
// (tenant.okta.com) or a forgotten service's: the domain alone does not say it is the one the mail means.
const SIGN_IN_LABELS = words('www login signin account accounts')
function signInHost(info) {
  if (!info.domain) return false
  if (info.host === info.domain || KNOWN_SIGN_IN_HOSTS.has(info.host)) return true
  return info.host.slice(0, -info.domain.length - 1).split('.').every((label) => SIGN_IN_LABELS.has(label))
}

// What a domain looks like at a glance: letters that pass for each other, the same.
const glance = (domain) => domain.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[1i|]/g, 'l').replace(/0/g, 'o').replace(/5/g, 's').replace(/-/g, '')
// One letter added, dropped or changed.
function oneEditApart(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1)
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}
export const looksLike = (a, b) => !!a && !!b && a !== b && (glance(a) === glance(b) || oneEditApart(a, b))

// --- Who sent it ----------------------------------------------------------------------------------
// One From value -> { address, domain }, or null when it is not plainly one address. Read the way a
// mail program reads it: what is in quotes or in a comment is a name, whatever it looks like, so
// "bank@bank.example" <someone@evil.example> is someone@evil.example.
export function parseFrom(value) {
  const s = String(value == null ? '' : value)
  if (s.length > 2000) return null
  let outside = ''
  let angle = null
  let angles = 0
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (depth) {
      if (c === '\\') i++
      else if (c === '(') depth++
      else if (c === ')') depth--
      continue
    }
    if (c === '"') {
      i++
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1
      if (i >= s.length) return null
      continue
    }
    if (c === '(') {
      depth = 1
      continue
    }
    if (c === '<') {
      angles++
      const stop = s.indexOf('>', i)
      if (stop < 0) return null
      angle = s.slice(i + 1, stop)
      i = stop
      continue
    }
    // More than one mailbox, or a group: not one sender.
    if (c === ',' || c === ';') return null
    outside += c
  }
  if (depth || angles > 1) return null
  const address = (angle === null ? outside : angle).trim()
  if (address.length > 320 || address.includes('=?') || !/^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+$/.test(address)) return null
  const at = address.lastIndexOf('@')
  const domain = domainToASCII(address.slice(at + 1).toLowerCase().replace(/\.$/, ''))
  if (!domain) return null
  return { address: `${address.slice(0, at).toLowerCase()}@${domain}`, domain }
}

// A message's headers with this name, in the message's order.
const headerValues = (message, name) => (Array.isArray(message?.payload?.headers) ? message.payload.headers : []).filter((h) => h && typeof h.name === 'string' && h.name.toLowerCase() === name).map((h) => String(h.value == null ? '' : h.value))
export const subjectOf = (message) => headerValues(message, 'subject')[0] || ''

// One Authentication-Results value -> { server, results: [{ method, result, props }] }, or null when
// it cannot be read for sure. A sender's words sit inside it (an envelope address is repeated in a
// comment), so a stray quote or parenthesis, or any of ; ( ) inside quotes, can make something else
// look like a result. Comments are out first: "(google.com: dmarc=pass)" in one is not a result.
function parseAuthResults(value) {
  const text = String(value).slice(0, 8000)
  if ((text.match(/"/g) || []).length % 2 === 1) return null
  if ([...text.matchAll(/"[^"]*"/g)].some((m) => /[;()\s]/.test(m[0]))) return null
  let plain = ''
  let depth = 0
  let quoted = false
  for (const c of text) {
    if (quoted) {
      if (c === '"') quoted = false
      plain += c
    } else if (depth) {
      if (c === '(') depth++
      else if (c === ')') depth--
    } else if (c === '(') depth = 1
    else if (c === ')') return null
    else {
      if (c === '"') quoted = true
      plain += c
    }
  }
  if (depth || quoted) return null
  // (No ";" in quotes by now: each one splits two results.)
  const [head, ...rest] = plain.split(';')
  const results = []
  for (const part of rest) {
    const tokens = part.trim().split(/\s+/)
    const first = /^([a-z0-9-]+)=([a-z]+)$/i.exec(tokens[0] || '')
    // Not a result, so a ";" came from somewhere else.
    if (!first && tokens[0]) return null
    if (!first) continue
    const props = {}
    for (const token of tokens.slice(1)) {
      const eq = token.indexOf('=')
      if (eq <= 0) continue
      const name = token.slice(0, eq).toLowerCase()
      // Gmail says each once: a second one was put there.
      if (Object.hasOwn(props, name)) return null
      props[name] = token.slice(eq + 1).replace(/^"|"$/g, '').toLowerCase()
    }
    results.push({ method: first[1].toLowerCase(), result: first[2].toLowerCase(), props })
  }
  return { server: head.trim().split(/\s+/)[0].toLowerCase(), results }
}
const afterAt = (value) => String(value || '').slice(String(value || '').lastIndexOf('@') + 1).replace(/\.$/, '')

// What Gmail itself found about the From line's domain: 'pass', 'fail' or 'none' (nothing to go on).
// Only the first Authentication-Results in the message can be Gmail's: it adds its own above what
// the sender wrote, and a sender can write one too, even naming mx.google.com. A mail Gmail fetched
// from elsewhere may have none of Gmail's own, so there the first says nothing.
export function authVerdict(message, fromDomain) {
  const first = headerValues(message, 'authentication-results')[0]
  if (!first || !fromDomain || headerValues(message, 'x-gmail-fetch-info').length) return 'none'
  const parsed = parseAuthResults(first)
  if (!parsed || parsed.server !== 'mx.google.com') return 'none'
  const { results } = parsed
  const owner = domainInfo(fromDomain).domain
  const aligned = (domain) => !!domain && (owner ? domainInfo(domain).domain === owner : domain === fromDomain)
  const of = (method) => results.filter((r) => r.method === method)
  const dmarc = of('dmarc')
  // Gmail says each once: a second one was put there.
  if (dmarc.length > 1 || of('spf').length > 1) return 'none'
  if (dmarc.some((r) => ['fail', 'temperror', 'permerror'].includes(r.result))) return 'fail'
  if (dmarc.some((r) => r.result === 'pass' && aligned(r.props['header.from']))) return 'pass'
  // Signed by the From line's own domain: nothing else proves as much.
  if (of('dkim').some((r) => r.result === 'pass' && (r.props['header.d'] || r.props['header.i']) && (!r.props['header.d'] || aligned(r.props['header.d'])) && (!r.props['header.i'] || aligned(afterAt(r.props['header.i']))))) return 'pass'
  if ([...of('dkim'), ...of('spf')].some((r) => ['fail', 'softfail', 'permerror'].includes(r.result))) return 'fail'
  if (of('spf').some((r) => r.result === 'pass' && aligned(afterAt(r.props['smtp.mailfrom'])))) return 'pass'
  return 'none'
}

// One address the way Gmail reads it: case does not count, nor a +tag, nor dots in a Gmail address.
function mailbox(address) {
  const at = address.lastIndexOf('@')
  let local = address.slice(0, at).toLowerCase().split('+')[0]
  let domain = address.slice(at + 1).toLowerCase()
  if (domain === 'googlemail.com') domain = 'gmail.com'
  if (domain === 'gmail.com') local = local.replace(/\./g, '')
  return `${local}@${domain}`
}
const addressesIn = (value) => String(value).slice(0, 4000).match(/[^\s<>,;:"()]+@[^\s<>,;:"()]+/g) || []
// Is this mail addressed to this account? A site's code for someone else, passed on, is not.
function namesAccount(message, account) {
  if (!account || !String(account).includes('@')) return true
  const want = mailbox(String(account))
  return ['to', 'delivered-to'].every((name) => {
    const values = headerValues(message, name)
    return !values.length || values.some((value) => addressesIn(value).some((address) => mailbox(address) === want))
  })
}

// The page's host against the mail's sender. -> { match, page, sender (or null), problems }: match
// only when the page is the From line's site, on the host it signs people in on, Gmail confirms that
// From line, and all of it is plain ASCII; anything in doubt is a problem the card names.
export function checkSender(message, pageHost, account = null, port = '') {
  const page = domainInfo(pageHost)
  const problems = []
  if (port) problems.push('pagePort')
  if (page.why === 'shared') problems.push('pageShared')
  else if (!page.domain) problems.push('pageUnknown')
  if (page.notPlain) problems.push('pageNotPlain')
  if (!namesAccount(message, account)) problems.push('notForAccount')
  const froms = headerValues(message, 'from')
  const parsed = froms.length === 1 ? parseFrom(froms[0]) : null
  if (!parsed) return { match: false, page, sender: null, problems: [...problems, 'fromUnreadable'] }
  const info = domainInfo(parsed.domain)
  const sender = { ...parsed, info }
  if (info.why === 'shared') problems.push('senderShared')
  else if (!info.domain) problems.push('senderUnknown')
  if (info.notPlain) problems.push('senderNotPlain')
  if (/[^\x20-\x7e]/.test(parsed.address.slice(0, parsed.address.lastIndexOf('@')))) problems.push('senderLocalNotPlain')
  const verdict = authVerdict(message, parsed.domain)
  if (verdict === 'fail') problems.push('authFailed')
  else if (verdict === 'none') problems.push('authMissing')
  const same = page.host === info.host || sameOwner(page.domain, info.domain)
  if (!same) problems.push('different')
  if (!same && looksLike(page.domain || page.host, info.domain || info.host)) problems.push('lookAlike')
  // Answers go elsewhere than the sender: another domain than the one the code seems to come from.
  const replyTo = headerValues(message, 'reply-to').map(parseFrom).filter(Boolean)
  if (replyTo.some((other) => other.domain !== parsed.domain && !sameOwner(domainInfo(other.domain).domain, info.domain))) problems.push('replyToOther')
  // tenant.okta.com and mail from okta.com: the same domain, and perhaps not the same customer.
  if (same && page.host !== info.host && page.domain && !signInHost(page)) problems.push('pageSubHost')
  return { match: !problems.length && same, page, sender, problems }
}

// Whether a mail's address fits the sender the agent named: its address, or its domain or above.
export function fitsHint(sender, hint) {
  if (!hint) return true
  if (!sender) return false
  if (hint.includes('@')) return sender.address === hint
  return sender.domain === hint || sender.domain.endsWith(`.${hint}`)
}

// The sender the agent named is this page's site: asking by name for another site's mail, on this
// page, is the attack.
export function hintFitsPage(hint, pageHost) {
  if (!hint) return true
  const page = domainInfo(pageHost)
  const named = domainInfo(hint.includes('@') ? hint.slice(hint.lastIndexOf('@') + 1) : hint)
  if (page.domain && named.domain) return sameOwner(page.domain, named.domain)
  return page.host === named.host || page.host.endsWith(`.${named.host}`)
}

// --- What a person sees of a mail's HTML ----------------------------------------------------------
const isBlank = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'
const isLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
// Only A to Z: places found in the lower-case text are used in the text itself.
const asciiLower = (text) => text.replace(/[A-Z]/g, (c) => c.toLowerCase())
const VOID_TAGS = words('area base br col embed hr img input link meta param source track wbr')
// What they hold is never read as tags.
const RAW_TAGS = words('script style title textarea xmp iframe noembed noframes')
// Not shown, or not what a mail says now.
const HIDDEN_TAGS = words('template noscript object applet audio video canvas svg math map datalist select frameset del s strike')

// Numbers in a page's text: &#49; and &#x31; are "1".
function decodeRefs(text) {
  return text.replace(/&#(?:x([0-9a-f]{1,6})|(\d{1,7}));?/gi, (_all, hex, dec) => {
    const code = hex ? parseInt(hex, 16) : Number(dec)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  })
}

// Does this style attribute keep what it applies to out of sight? -> true, false, or 'size' when
// only by a font size of nothing, which what is inside can set again (MJML mails all do).
function hiddenStyle(raw) {
  let style = decodeRefs(String(raw).slice(0, 4000)).toLowerCase()
  for (let open = style.indexOf('/*'); open >= 0; open = style.indexOf('/*', open)) {
    const close = style.indexOf('*/', open + 2)
    style = close < 0 ? style.slice(0, open) : `${style.slice(0, open)}${style.slice(close + 2)}`
  }
  let noSize = false
  let cut = false
  let tiny = false
  for (const declaration of style.replace(/\s+/g, '').replace(/!important/g, '').split(';')) {
    const colon = declaration.indexOf(':')
    if (colon <= 0) continue
    const name = declaration.slice(0, colon)
    const value = declaration.slice(colon + 1)
    if (name === 'display' && value === 'none') return true
    if (name === 'visibility' && (value === 'hidden' || value === 'collapse')) return true
    if (name === 'mso-hide' && value === 'all') return true
    if (name === 'opacity' && parseFloat(value) === 0) return true
    if (name === 'font-size' && parseFloat(value) <= 1) tiny = true
    if (name === 'font' && /^0[a-z%]*(?:\/|$)/.test(value)) tiny = true
    if (name === 'color' && (value === 'transparent' || /^rgba\(.*,0(?:\.0+)?\)$/.test(value))) return true
    if (['text-indent', 'left', 'top', 'margin-left', 'margin-top'].includes(name) && /^-\d{3,}/.test(value)) return true
    if (name === 'clip' && value.startsWith('rect(0')) return true
    if (['height', 'max-height', 'width', 'max-width'].includes(name) && parseFloat(value) === 0) noSize = true
    if (name === 'overflow' && value === 'hidden') cut = true
  }
  return (noSize && cut) || (tiny ? 'size' : false)
}
// Does anything right inside this set a size that shows? Only so far: this runs for each such tag.
function resetsSize(s, from) {
  for (const m of s.slice(from, from + 8192).matchAll(/font(?:-size)?\s*:\s*(\d*\.?\d+)\s*(px|pt|em|rem|%)?/gi)) if (Number(m[1]) > (m[2] && !/^p/i.test(m[2]) ? 0 : 1)) return true
  return false
}

// One tag, read the way a browser does: its attributes in turn with their quotes, the first of a
// name counting. -> { name, closing, end, style, hidden }, or null when the text ends first.
function tagAt(s, open) {
  const n = s.length
  let at = open + 1
  const closing = s[at] === '/'
  if (closing) at++
  const begin = at
  while (at < n && !isBlank(s[at]) && s[at] !== '/' && s[at] !== '>') at++
  const name = asciiLower(s.slice(begin, at))
  let style = null
  let hidden = false
  while (true) {
    while (at < n && (isBlank(s[at]) || s[at] === '/')) at++
    if (at >= n) return null
    if (s[at] === '>') return { name, closing, end: at + 1, style, hidden }
    const from = at
    at++
    while (at < n && !isBlank(s[at]) && s[at] !== '/' && s[at] !== '>' && s[at] !== '=') at++
    const attribute = asciiLower(s.slice(from, at))
    while (at < n && isBlank(s[at])) at++
    let value = ''
    if (s[at] === '=') {
      at++
      while (at < n && isBlank(s[at])) at++
      const quote = s[at]
      if (quote === '"' || quote === "'") {
        const stop = s.indexOf(quote, at + 1)
        if (stop < 0) return null
        value = s.slice(at + 1, stop)
        at = stop + 1
      } else {
        const start = at
        while (at < n && !isBlank(s[at]) && s[at] !== '>') at++
        value = s.slice(start, at)
      }
    }
    if (attribute === 'style' && style === null) style = value
    if (attribute === 'hidden') hidden = true
    if (attribute === 'aria-hidden' && value.trim().toLowerCase() === 'true') hidden = true
  }
}

// Where a word comes next, each looked for forward only: anyone can send a mail with thousands of
// comments, and looking again from each would take the main process minutes.
function forwardSearch(s) {
  const seen = new Map()
  return (word, from) => {
    const known = seen.get(word)
    if (known !== undefined && (known < 0 || known >= from)) return known
    const found = s.indexOf(word, from)
    seen.set(word, found)
    return found
  }
}

// Where a comment that starts at `open` ends, as a browser ends it, or -1.
function commentEnd(s, open, next) {
  if (s[open + 4] === '>') return open + 5
  if (s.startsWith('->', open + 4)) return open + 6
  const plain = next('-->', open + 4)
  const bang = next('--!>', open + 4)
  if (plain < 0 && bang < 0) return -1
  if (bang < 0 || (plain >= 0 && plain < bang)) return plain + 3
  return bang + 4
}

// Past the end of the element this tag opens: same-named tags counted, what is raw jumped over. A
// mail that never closes it hides the rest: then there is less to read, never more.
function elementEnd(s, lower, tag, next) {
  if (RAW_TAGS.has(tag.name)) {
    const stop = lower.indexOf(`</${tag.name}`, tag.end)
    if (stop < 0) return s.length
    const closed = s.indexOf('>', stop)
    return closed < 0 ? s.length : closed + 1
  }
  let depth = 1
  let at = tag.end
  while (at < s.length) {
    const open = s.indexOf('<', at)
    if (open < 0) return s.length
    if (s.startsWith('<!--', open)) {
      const end = commentEnd(s, open, next)
      if (end < 0) return s.length
      at = end
      continue
    }
    const first = s[open + 1]
    if (first !== '/' && !isLetter(first || '')) {
      at = open + 1
      continue
    }
    const inner = tagAt(s, open)
    if (!inner) return s.length
    at = inner.end
    if (!inner.closing && RAW_TAGS.has(inner.name)) {
      at = elementEnd(s, lower, inner, next)
      continue
    }
    if (inner.name !== tag.name) continue
    depth += inner.closing ? -1 : 1
    if (!depth) return at
  }
  return s.length
}

// A mail's HTML without what it keeps out of sight by an attribute or its own style, or inside
// tags that show nothing. A stylesheet's class is not followed (white text on white is not found
// either): a mail can always say what it likes, and a second code found there only makes the mail
// refused. One pass forward over a bounded text: anyone can send a mail, and this runs in the main
// process.
export function visibleHtml(html) {
  const s = String(html || '')
  const lower = asciiLower(s)
  const next = forwardSearch(s)
  let out = ''
  let at = 0
  while (at < s.length) {
    const open = s.indexOf('<', at)
    if (open < 0) {
      out += s.slice(at)
      break
    }
    out += s.slice(at, open)
    if (s.startsWith('<!--', open)) {
      const end = commentEnd(s, open, next)
      if (end < 0) break
      at = end
      continue
    }
    const first = s[open + 1]
    if (first === '!' || first === '?') {
      const stop = s.indexOf('>', open + 2)
      if (stop < 0) break
      at = stop + 1
      continue
    }
    if (first !== '/' && !isLetter(first || '')) {
      out += '<'
      at = open + 1
      continue
    }
    const tag = tagAt(s, open)
    if (!tag) break
    const styled = !tag.closing && tag.style !== null ? hiddenStyle(tag.style) : false
    const hides = !tag.closing && (RAW_TAGS.has(tag.name) || HIDDEN_TAGS.has(tag.name) || tag.hidden || styled === true || (styled === 'size' && !resetsSize(s, tag.end)))
    if (hides) {
      at = VOID_TAGS.has(tag.name) ? tag.end : elementEnd(s, lower, tag, next)
      out += ' '
      continue
    }
    // (A link's target is not what the mail says: no attribute of it goes on.)
    out += tag.name === 'a' ? (tag.closing ? '</a>' : '<a>') : s.slice(open, tag.end)
    at = tag.end
  }
  return out
}

// --- The one code in a mail -----------------------------------------------------------------------
// A mail this long is not a code's mail, and reading it stays bounded.
const MAX_TEXT = 64 * 1024
// All its parts together, in base64: under what the text conversion would cut.
const MAX_TOTAL = 340 * 1024
const MAX_PARTS = 20
const MAX_DEPTH = 10

// The mail's own text: never an attachment, nor a mail forwarded inside it (someone else's code).
export function mailBodies(payload) {
  const plain = []
  const html = []
  let parts = 0
  let total = 0
  let tooLong = false
  const walk = (part, depth) => {
    if (!part) return
    if (depth > MAX_DEPTH || ++parts > MAX_PARTS) {
      tooLong = true
      return
    }
    const type = String(part.mimeType || '').toLowerCase()
    if (type === 'message/rfc822' || part.filename) return
    const data = part.body?.data
    if (data && (type === 'text/plain' || type === 'text/html')) {
      total += String(data).length
      if (total > MAX_TOTAL) tooLong = true
      else (type === 'text/plain' ? plain : html).push(Buffer.from(String(data), 'base64url').toString('utf8'))
    }
    for (const child of Array.isArray(part.parts) ? part.parts : []) walk(child, depth + 1)
  }
  walk(payload, 0)
  return { plain, html, tooLong }
}

// A code a person is sent stands alone. A reply, a list's mail or a forward holds what someone else
// wrote or received: a stranger's number, or another person's code.
const THREAD_HEADERS = ['in-reply-to', 'references', 'list-id']
const PASSED_ON_SUBJECT = /^\s*(?:re|ré|aw|sv|fw|fwd|tr|wg)\s*[:：]/iu
const PASSED_ON_TEXT = [
  /^[ \t]*-{2,}[ \t]*(?:forwarded message|original message|message transféré|message original|message d['’]origine)/imu,
  /^[ \t]*begin forwarded message/imu,
  /^[ \t]*[>›»]/mu,
  /^[ \t]*(?:on\s.{1,120}\swrote|le\s.{1,120}\sa écrit)[ \t]*:[ \t]*$/imu,
  /^[ \t]*(?:from|de)[ \t]*:.{0,200}\n+[ \t]*(?:sent|date|envoyé)[ \t]*:/imu
]
const QUOTED_HTML = /<blockquote\b|gmail_quote/i

// Words for a code, in English and French (NIP is what Quebec calls a PIN). Whole words only.
const KEYWORD = /(?<![\p{L}\p{N}])(?:(?:pass)?codes?|otp|pin|nip|2fa|tokens?|jetons?|temporary password|mot de passe unique|one[- ]time|usage unique|two[- ]factor|deux facteurs|authentication|authenticate|authentification|authentifier|verification number|num[ée]ro de v[ée]rification|verification|vérification|verify|v[ée]rifier|v[ée]rifiez|mot de passe temporaire)(?![\p{L}\p{N}])/giu
// What says a number on its own line is the code: not a verb, a word for the code itself.
const CODE_WORD = /(?<![\p{L}\p{N}])(?:(?:pass)?codes?|otp|pin|nip|tokens?|jetons?|temporary password|mot de passe temporaire|mot de passe unique)(?![\p{L}\p{N}])/iu
// A code, but not one to sign in with.
const NOT_THAT_CODE = /(?<![\p{L}\p{N}])(?:(?:promo|promotional|discount|coupon|gift|voucher|referral|invite|invitation|booking(?: confirmation)?|door|reference|customer|client|employee|member|event(?: access)?|alarm|locker|pickup|zip|postal|area|country|error|status|source|qr|bar|tracking|product|dress|sort|swift|tax|dial|exit|http) codes?|frais de v[ée]rification|verification (?:fee|charge)s?|codes? (?:promo\p{L}*|postal|postaux|rabais|de rabais|d['’]erreur|d['’]invitation|de r[ée]duction|cadeau|source|barres?|pays|r[ée]gion|de parrainage|de suivi|produit|qr))(?![\p{L}\p{N}])/giu
// A line about one of these has no sign-in code, and a line someone wrote has theirs, not the site's.
const OFF_LINE = /(?<![\p{L}\p{N}])(?:promo|coupon|discount|rabais|checkout|carte[- ]cadeau|gift card|wi-?fi|cvv|cvc|de la carte|door|porte|says|dit que|(?:commented|wrote|said|replied|shared|a comment[ée]|a écrit|a dit|a répondu|a partagé|vous a invité)(?![\p{L}\p{N}])[^.!?]*:)(?![\p{L}\p{N}])/iu
// "Your code is aB3xY9": right behind such a word, any letters count.
const RIGHT_AFTER = /(?:(?:pass)?code|otp|pin|nip|token|jeton|v[ée]rification)[^\p{L}\p{N}]*(?:(?:is|est)[^\p{L}\p{N}]*)?$/iu
const KEY_WORDS = words('code codes passcode otp pin nip token tokens jeton jetons 2fa verification vérification verify vérifier vérifiez authentication authentification')
// All that may stand between such a word and its code, in one sentence: nothing that says what else
// the number might be. Fewer than that and a mail with no code would get a guess.
const CONNECTORS = words(`
  is are was your the this a an old one time temporary security verification login log sign signin in on access authentication confirmation
  to for use enter following below here s it please continue complete verify account email mail e address password passcode digit digits 4 5 6 7 8 9 10
  you requested page app application
  est était votre vos le la les ce cette de du d l à pour utilisez entrez saisissez suivant ci dessous voici temporaire sécurité
  connexion accès vérification authentification validation activation unique usage compte courriel adresse continuer compléter mot passe chiffre chiffres vous connecter
  demandé demandée dans sur par
`)
const MAX_BETWEEN = 4
const MAX_SAID = 8
const MAX_GAP = 80
const CLAUSE_ENDS = /[.!?;,…](?:\s|$)/u
// A number right behind one of these is that thing's number.
const OTHER_NUMBER = words('order commande invoice facture ref reference référence ticket account compte customer client dossier case booking reservation réservation tracking suivi tel telephone téléphone phone mobile cell cellulaire fax sms call appelez appeler transaction receipt reçu recu member membre year année room suite apt unit unité ext poste zip box')
// Says only that a number follows: it depends on what comes before.
const JUST_NUMBER = words('no nº n num number numéro numero id')
const UNIT_AFTER = words('usd cad eur gbp chf dollar dollars euro euros km kg mb gb go ko mo mn min minutes sec seconds secondes hours heures jours days ans years')
const UNIT_BEFORE = words('usd cad eur gbp chf')
const isWordChar = (c) => !!c && /[\p{L}\p{N}]/u.test(c)
const JOINS = '-/.,:=_\\'
const wordsOf = (text) => (text.match(/[\p{L}\p{N}]+/gu) || []).map((word) => word.toLowerCase())

// A word that is an address: what is in it is not a code ("?token=A1B2C3", "A1B2@site.example").
function linkish(word) {
  return word.length > 200 || word.includes('://') || word.includes('@') || /^[(<[]?(?:www\.|mailto:.|tel:.|sms:.)/i.test(word) || (word.includes('?') && word.includes('=')) || /\.[a-z]{2,}\//i.test(word)
}
// Letters no one sees, by name: "48&zwnj;2913" is one number, on screen and here.
const UNSEEN_NAMES = /&(?:zwnj|zwj|shy|lrm|rlm|wj|nobreak|zerowidthspace)(?:;|(?![a-z0-9]))/gi
function cleanLines(text) {
  return withoutUnseen(decodeRefs(String(text).replace(UNSEEN_NAMES, '')).replace(BLANK_LETTERS, ' '))
    .normalize('NFC')
    .replace(/\p{M}/gu, '')
    .replace(/\p{Cc}/gu, (c) => (c === '\n' || c === '\r' || c === '\t' ? c : ''))
    .replace(/\p{Zs}/gu, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.split(/[ \t]+/).filter((word) => word && !linkish(word)).join(' '))
    .filter(Boolean)
}

// Where this line's words for a code are.
function keywordsIn(line) {
  if (OFF_LINE.test(line)) return []
  const open = line.replace(NOT_THAT_CODE, (found) => ' '.repeat(found.length))
  return [...open.matchAll(KEYWORD)].map((m) => ({ start: m.index, end: m.index + m[0].length }))
}

// Two groups of the same size: "123 456", "123-456", "ABC-123" (one code, without its separator).
function groupOf(a, separator, b) {
  if (a.length !== b.length) return null
  if ((separator === ' ' || separator === '-') && /^\d{3,5}$/.test(a) && /^\d{3,5}$/.test(b)) return `${a}${b}`
  if (separator === '-' && /^[A-Z0-9]{3,5}$/.test(a) && /^[A-Z0-9]{3,5}$/.test(b) && /\d/.test(a + b)) return `${a}${b}`
  return null
}
const isDate = (v) => /^(?:19|20)\d\d$/.test(v) || /^(?:19|20)\d\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(v) || /^(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])(?:19|20)\d\d$/.test(v)

// Does this value have the shape of a code, here?
function codeShaped(value, right) {
  if (value.length < 4 || value.length > 10 || !/\d/.test(value) || !/^[A-Za-z0-9]+$/.test(value) || isDate(value)) return false
  // A word and a number: WELCOME10, SAVE2026.
  if (/^[A-Za-z]{4,}\d+$|^\d+[A-Za-z]{4,}$/.test(value)) return false
  if (/^\d+$/.test(value)) return true
  if (/^[A-Z0-9]+$/.test(value)) return right || value.replace(/\D/g, '').length >= 2
  return right
}

// Is this piece of the line part of something else: a phone number, a price, a date, an address?
function partOfSomething(line, tokens, first, last) {
  const start = tokens[first].index
  const end = tokens[last].index + tokens[last].text.length
  const before = line[start - 1] || ''
  const before2 = line[start - 2] || ''
  const after = line[end] || ''
  const after2 = line[end + 1] || ''
  if (before && '#$€£¥+'.includes(before)) return true
  if (before && JOINS.includes(before) && isWordChar(before2) && !(before === ':' && !/\d/.test(before2))) return true
  if (after && '$€£¥%'.includes(after)) return true
  if (after === ' ' && after2 && '$€£¥%'.includes(after2)) return true
  if (after && JOINS.includes(after) && isWordChar(after2)) return true
  const prev = tokens[first - 1]
  const next = tokens[last + 1]
  const digits = /^\d+$/
  const spaced = (a, b) => line.slice(a.index + a.text.length, b.index) === ' '
  if (/^[\d]+$/.test(tokens[first].text) && prev && spaced(prev, tokens[first]) && digits.test(prev.text)) return true
  if (/^[\d]+$/.test(tokens[last].text) && next && spaced(tokens[last], next) && digits.test(next.text)) return true
  if (next && spaced(tokens[last], next) && UNIT_AFTER.has(next.text.toLowerCase())) return true
  if (prev && spaced(prev, tokens[first]) && UNIT_BEFORE.has(prev.text.toLowerCase())) return true
  // The words right before it, in the same clause, say what it is.
  let onlyNumber = false
  for (let i = first - 1; i >= 0 && i >= first - 3; i--) {
    if (/[,.;!?]/.test(line.slice(tokens[i].index + tokens[i].text.length, tokens[i + 1].index))) break
    const word = tokens[i].text.toLowerCase()
    if (KEY_WORDS.has(word)) return false
    // ("Enter this code to verify your account: 482913": its sentence has already said what it is.)
    if (OTHER_NUMBER.has(word)) return !(/^(?:account|compte)$/.test(word) && /^[^\p{L}\p{N}]*:/u.test(line.slice(tokens[i].index + word.length, tokens[i + 1].index)) && keywordsIn(line.slice(Math.max(0, tokens[i].index - MAX_GAP), tokens[i].index).split(/[.!?;]/u).at(-1)).length > 0)
    if (JUST_NUMBER.has(word)) onlyNumber = true
  }
  return onlyNumber
}

const connector = (word) => CONNECTORS.has(word) || KEY_WORDS.has(word)
// Is a word for a code tied to this value: in one sentence, with next to nothing between them?
function tiedToKeyword(line, keywords, start, end) {
  return keywords.some((k) => {
    const first = k.end <= start
    if (!first && k.start < end) return false
    // (Looked at only when close: anyone can send one long line of these, and this runs in the main process.)
    if ((first ? start - k.end : k.start - end) > MAX_GAP) return false
    const between = first ? line.slice(k.end, start) : line.slice(end, k.start)
    if (CLAUSE_ENDS.test(between)) return false
    const list = wordsOf(between)
    if (list.length <= MAX_BETWEEN && list.every(connector)) return true
    // "Your code for Acme is 482913", "Use this code to sign in to your Acme account: 482913": at most one
    // name, written as one, and then something that says the value comes next.
    if (first && list.length <= MAX_SAID && /(?:(?<![\p{L}\p{N}])(?:is|est)|:)[^\p{L}\p{N}]*$/u.test(between)) {
      const others = (between.match(/[\p{L}\p{N}]+/gu) || []).filter((word) => !connector(word.toLowerCase()))
      if (!others.length || (others.length === 1 && /^\p{Lu}/u.test(others[0]))) return true
    }
    // "482913 is your Facebook code": a value saying what it is first leaves room for one name.
    return !first && list.length <= 5 && /^(?:is|est)$/.test(list[0] || '') && /^(?:your|votre)$/.test(list[1] || '') && list.slice(2).filter((word) => !connector(word)).length <= 1
  })
}
// A line next to a number alone on its own, about the code itself, close to that number.
const namesCode = (line, words_) => !!line && !OFF_LINE.test(line) && CODE_WORD.test(words_.join(' ')) && keywordsIn(line).length > 0

// What a person would read in the mail around the code: its line, and up to three other lines
// closest to it, without what every code mail adds.
const ASIDE = /(?<![\p{L}\p{N}])(?:if you|if this|si vous|si ce|never|jamais|do not share|don['’]t share|ne partagez|didn['’]t|ignore|expires?|expire|unsubscribe|privacy|terms|hello|hi|bonjour|thanks|thank you|merci|regards|cordialement)(?![\p{L}\p{N}])/iu
const isMenu = (line) => /\s[|•·]\s/u.test(line)
function contextOf(lines, n, also) {
  const rest = lines.map((line, i) => ({ line, i })).filter(({ line, i }) => i !== n && i !== also && !isMenu(line) && !ASIDE.test(line))
  rest.sort((a, b) => Math.abs(a.i - n) - Math.abs(b.i - n))
  const keep = new Set([n, also, ...rest.slice(0, 3).map(({ i }) => i)])
  return lines.filter((_line, i) => keep.has(i))
}

// The codes on these lines: found (value -> where it was).
function codesOn(lines, found) {
  const keywords = lines.map(keywordsIn)
  for (let n = 0; n < lines.length && found.size < 2; n++) {
    const line = lines[n]
    const tokens = [...line.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ text: m[0], index: m.index }))
    const wordChars = tokens.reduce((sum, token) => sum + token.text.length, 0)
    for (let i = 0; i < tokens.length && found.size < 2; i++) {
      const next = tokens[i + 1]
      const group = next ? groupOf(tokens[i].text, line.slice(tokens[i].index + tokens[i].text.length, next.index), next.text) : null
      const first = i
      const last = group ? i + 1 : i
      const value = group || tokens[i].text
      const start = tokens[first].index
      const end = tokens[last].index + tokens[last].text.length
      i = last
      if (!codeShaped(value, RIGHT_AFTER.test(line.slice(Math.max(0, start - 40), start))) || partOfSomething(line, tokens, first, last)) continue
      const tied = tiedToKeyword(line, keywords[n], start, end)
      const alone = wordChars === value.length
      const above = n > 0 ? lines[n - 1] : ''
      const below = n + 1 < lines.length ? lines[n + 1] : ''
      const beside = alone && (namesCode(above, wordsOf(above).slice(-8)) || namesCode(below, wordsOf(below).slice(0, 8)))
      if (tied || beside) {
        const fromAbove = beside && !tied && namesCode(above, wordsOf(above).slice(-8))
        found.set(value, {
          line: beside && !tied ? (fromAbove ? `${above} ${line}` : `${line} ${below}`) : line,
          lines,
          n,
          also: beside && !tied ? (fromAbove ? n - 1 : n + 1) : n
        })
      }
    }
  }
}

// message: Gmail's message (format=full). -> { code, line, around, context }, or { refused: 'none' |
// 'several' | 'passedOn' }. Taken only when it is clear: one distinct value, tied to a word for a code
// in one sentence, in what the mail shows. line: where the mail says it; around: the mail's lines;
// context: those a person would read around the code. For the card, and never for an agent.
export function extractCode(message) {
  const subjectRaw = subjectOf(message)
  if (THREAD_HEADERS.some((name) => headerValues(message, name).length) || PASSED_ON_SUBJECT.test(subjectRaw)) return { refused: 'passedOn' }
  const { plain, html, tooLong } = mailBodies(message?.payload)
  if (tooLong) return { refused: 'none' }
  if (html.some((part) => QUOTED_HTML.test(part))) return { refused: 'passedOn' }
  const bodies = [...plain, ...html.map((part) => htmlToText(visibleHtml(part)))]
  if (bodies.reduce((sum, text) => sum + text.length, 0) > MAX_TEXT) return { refused: 'none' }
  if (bodies.some((text) => PASSED_ON_TEXT.some((mark) => mark.test(text)))) return { refused: 'passedOn' }
  const subject = cleanLines(subjectRaw).join(' ').slice(0, 1000)
  const found = new Map()
  const subjectLines = subject ? [subject] : []
  const bodyLines = bodies.map(cleanLines)
  if (subject) codesOn(subjectLines, found)
  for (const lines of bodyLines) codesOn(lines, found)
  if (found.size === 1) {
    const [[code, where]] = [...found]
    // All the mail says, wherever the code was: a subject alone says nothing of what it is for.
    const said = [...new Set(bodyLines.flat())]
    const context = where.lines === subjectLines ? contextOf([subject, ...said], 0, 0) : contextOf(where.lines, where.n, where.also)
    return { code, line: where.line, around: said.slice(0, 300), context }
  }
  return { refused: found.size ? 'several' : 'none' }
}

// --- What a code may confirm -----------------------------------------------------------------------
// Words that add a warning. Their absence says nothing: a mail can say anything, and many sites use one
// template for everything. So nothing here ever makes a card calmer.
const whole = (body) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'iu')
const SOME_WORDS = "(?:[\\p{L}\\p{N}'’.,-]+\\s+){0,3}"
const PURPOSES = [
  ['payment', whole(`payments?|pay|paying|purchases?|checkout|transfers?|wire|transactions?|invoices?|billing|send\\s+money|withdraw|withdrawals?|payees?|beneficiar(?:y|ies)|refunds?|(?:daily|spending|transfer|withdrawal)\\s+limits?|limits?\\s+change|raise\\s+${SOME_WORDS}limits?|(?<!in\\s)orders?|3-?d[\\s-]*secure|3ds|send(?:ing)?\\s+${SOME_WORDS}(?:btc|eth|usdt|bitcoin|ether|crypto\\p{L}*)|(?:sell|selling|sale\\s+of|buy|buying|purchase\\s+of|trade|trading)\\s+${SOME_WORDS}(?:shares?|stocks?)|merchant|cards?\\s+ending|(?:link|linking|add|adding|connect|connecting)\\s+${SOME_WORDS}(?:bank|bank\\s+accounts?)|bank\\s+accounts?|paiements?|payer|achats?|virements?|transferts?|factures?|facturation|retraits?|retirer|b[ée]n[ée]ficiaires?|plafonds?|commandes?|rembours\\p{L}*|(?:envoyer|envoi\\s+de)\\s+${SOME_WORDS}(?:btc|eth|bitcoin|crypto\\p{L}*)|(?:vendre|vente\\s+d['’]|vente\\s+de\\s+|acheter|achat\\s+de\\s+)\\s*${SOME_WORDS}actions?|commer[çc]ant|cartes?\\s+se\\s+terminant|(?:lier|associer|ajouter)\\s+${SOME_WORDS}(?:banque|compte\\s+bancaire)|compte\\s+bancaire`)],
  ['device', whole(`(?:link|linking|pair|pairing|add|adding|register|registering|connect|connecting|activate|activating|associer|ajouter|relier|jumeler|activer)\\s+${SOME_WORDS}(?:devices?|tvs?|appareils?|t[ée]l[ée]viseurs?)|(?:devices?|appareils?)\\s+(?:link|pair|add|activate|activation|code)|(?:on|sur|from|à\\s+partir\\s+d['’])\\s+(?:your|the|votre|un|une|another|other|an\\s+other)\\s+(?:other\\s+|autre\\s+)?(?:tv|television|t[ée]l[ée]viseur|console)|(?:another|other)\\s+devices?|autre\\s+appareil`)],
  ['closing', whole(`(?:delete|deleting|close|closing|remove|removing|deactivate|deactivating|cancel|cancelling|terminate|terminating)\\s+${SOME_WORDS}(?:accounts?|profiles?|subscriptions?|organi[sz]ations?|repositor(?:y|ies)|repos?|projects?|workspaces?)|accounts?\\s+(?:deletion|closure|removal)|(?:delete|close)\\s+your|(?:supprimer|suppression|fermer|fermeture|d[ée]sactiver|d[ée]sactivation|r[ée]silier|r[ée]siliation)\\s+${SOME_WORDS}(?:comptes?|profils?|abonnements?|d[ée]p[ôo]ts?|projets?)`)],
  ['protection', whole(`(?:disable|disabling|turn(?:ing)?\\s+off|stop|stopping|remove|removing|deactivate|deactivating|d[ée]sactiver|d[ée]sactivation|supprimer|retirer)\\s+${SOME_WORDS}(?:two[- ]factor|2fa|mfa|authentication|authentification|deux\\s+facteurs|double\\s+authentification|protection|alerts?|notifications?|alertes?)`)],
  ['reset', whole(`reset|recover|recovery|forgot|forgotten|unlock|r[ée]initialis\\p{L}*|r[ée]cup[ée]r\\p{L}*|oubli[ée]|password\\s+change|chang(?:e|ing)\\s+${SOME_WORDS}passwords?|new\\s+passwords?|(?:modifi\\p{L}*|chang\\p{L}*)\\s+${SOME_WORDS}mot\\s+de\\s+passe|changement\\s+de\\s+mot\\s+de\\s+passe|nouveau\\s+mot\\s+de\\s+passe`)],
  ['consent', whole(`authori[sz]e|authori[sz]ation|authori[sz]ing|consent|oauth|grant(?:ing)?\\s+access|allow\\s+access|third[- ]party|autoris\\p{L}*|consentement|accorder\\s+l['’]acc[eè]s|(?:new|create|creating|add|adding|generate|generating|issue|issuing)\\s+${SOME_WORDS}(?:api\\s+keys?|api\\s+tokens?|access\\s+tokens?|tokens?|ssh\\s+keys?|administrators?|admins?|owners?|webhooks?)|(?:api\\s+(?:key|token))\\s+was\\s+requested|(?:nouvel\\p{L}*|cr[ée]er|ajouter|g[ée]n[ée]rer)\\s+${SOME_WORDS}(?:cl[ée]s?\\s+api|jetons?|administrateurs?|propri[ée]taires?)|passkeys?|cl[ée]s?\\s+d['’]acc[eè]s|security\\s+keys?|cl[ée]s?\\s+de\\s+s[ée]curit[ée]|trust\\s+this\\s+(?:browser|device|computer)|(?:faire\\s+confiance|fier)\\s+[àa]\\s+(?:ce|cet)\\s+(?:navigateur|appareil|ordinateur)|export\\p{L}*|(?:reveal|revealing|show|view)\\s+${SOME_WORDS}(?:secret|private|recovery|seed)|secret\\s+keys?|private\\s+keys?|recovery\\s+phrase|seed\\s+phrase|cl[ée]s?\\s+(?:secr[èe]tes?|priv[ée]es?)|phrase\\s+de\\s+r[ée]cup[ée]ration|delegat\\p{L}*|d[ée]l[ée]gu\\p{L}*|invit\\p{L}*`)],
  ['email', whole(`(?:chang\\p{L}*|updat\\p{L}*|modif\\p{L}*|new|nouvel\\p{L}*|add|adding|ajouter)\\s+${SOME_WORDS}(?:e-?mails?|courriels?|adresses?|phones?|t[ée]l[ée]phones?|num[ée]ros?)|(?:settings|profile|r[ée]glages|param[èe]tres)\\s+(?:e-?mails?|courriels?|phone)`)]
]
// In an address: what a device's sign-in calls itself. (GitHub's "verified device" is its sign-in.)
const DEVICE_PATH = whole('(?<!verified\\s)device|devicelogin|deviceauth|remoteconnect|usercode|activate|link')
// What every code mail adds, and the one place it may name such things: "If you did not ask for this,
// reset your password". Only a denial: "If you want to confirm the transfer" is the mail's point.
const DENIAL = /(?<![\p{L}\p{N}])(?:(?:if you (?:did not|didn['’]t|have not|haven['’]t|weren['’]t|were not|do not|don['’]t)|if this (?:wasn['’]t|was not|isn['’]t|is not)|si vous ne|never|jamais|do not share|don['’]t share|ne partagez)(?![\p{L}\p{N}])|si vous n['’]|si ce n['’])/iu
const notDenial = (line) => String(line).split(/(?<=[.!?…])\s+/u).filter((sentence) => sentence && !DENIAL.test(sentence))
// An address's words, not its values (those are whatever a link said).
function pathWords(url) {
  try {
    const at = new URL(url)
    const names = [...new Set([...at.searchParams.keys()])].join(' ')
    let path = at.pathname
    try {
      path = decodeURIComponent(path)
    } catch {
      // as it is
    }
    return `${path} ${names}`.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  } catch {
    return ''
  }
}
// -> 'payment' | 'device' | 'closing' | 'protection' | 'reset' | 'consent' | 'email', or null when none
// of those words is there, which says nothing. An amount anywhere in the mail is what it is asking about.
export function codePurpose({ subject = '', around = [], url = '' } = {}) {
  const lines = [subject, ...around]
  if (lines.some((line) => AMOUNT.test(String(line)))) return 'payment'
  const path = pathWords(url)
  if (DEVICE_PATH.test(path)) return 'device'
  const said = lines.flatMap(notDenial).join('\n')
  for (const [kind, found] of PURPOSES) if (found.test(`${said}\n${path}`)) return kind
  return null
}

// --- Keeping a code off a card ----------------------------------------------------------------------
// The code wherever it is written: any case, other widths of its characters, percent-encoded, and up
// to three other characters between two of its own.
function codePattern(code) {
  const one = (c) => `(?:${c}|${String.fromCodePoint(c.codePointAt(0) + 0xfee0)}|%${c.charCodeAt(0).toString(16)})`
  return new RegExp([...String(code)].filter((c) => /[A-Za-z0-9]/.test(c)).map(one).join('(?:[^\\p{L}\\p{N}]|%[0-9a-f]{2}){0,3}'), 'giu')
}
// Every word holding a number out.
export const hideNumbers = (text) => String(text == null ? '' : text).replace(/[\p{L}\p{N}]+/gu, (word) => (/\p{N}/u.test(word) ? MASK : word))
export function scrubCode(text, code) {
  return code ? String(text == null ? '' : text).replace(codePattern(code), MASK) : String(text == null ? '' : text)
}

const AMOUNT = /((?:[$€£¥]\s?\d[\d\s.,]{0,20}\d|\d[\d\s.,]{0,20}\s?(?:[$€£¥]|(?:usd|usdt|usdc|cad|eur|gbp|chf|btc|eth)(?![\p{L}\p{N}]))))/iu
// On a card: on one line, with nothing that hides or turns text around, and numbers in character
// references read, since a mail can write its code that way.
const shownLine = (value) => seenLine(decodeRefs(String(value == null ? '' : value)))
// A mail's subject as a card shows it: the code out, and every other number with it, since what is
// a code in a subject cannot be told with certainty; but for an amount, which says what this is for.
export function shownSubject(subject, code, max = 120) {
  const line = scrubCode(shownLine(String(subject == null ? '' : subject).slice(0, 4000)), code)
    .split(AMOUNT)
    .map((piece, i) => (i % 2 ? piece : piece.replace(/[\p{L}\p{N}]+/gu, (word) => (/\p{N}/u.test(word) && (word.length >= 4 || word.replace(/\P{N}/gu, '').length >= 3) ? MASK : word))))
    .join('')
  return line.length > max ? `${line.slice(0, max)}…` : line
}

// A host for a card: its end says whose it is, and what it really is when it is not plain letters.
function shownHost(info) {
  const cut = info.host.length > 80 ? `…${info.host.slice(-79)}` : info.host
  if (!info.notPlain) return cut
  return `${cut} (${domainToUnicode(info.host).slice(-60)}) ${t('main.mailCode.notPlain', '[not plain ASCII]')}`
}
const shortLine = (value, max) => {
  const line = shownLine(value)
  return line.length > max ? `${line.slice(0, max)}…` : line
}
// An address for a card: as it is, references not read, and the end that says whose it is always there.
function shownAddress(address, code) {
  const at = address.lastIndexOf('@')
  const local = scrubCode(seenLine(address.slice(0, at)), code)
  const domain = address.slice(at + 1)
  return `${local.length > 40 ? `${local.slice(0, 40)}…` : local}@${domain.length > 80 ? `…${domain.slice(-79)}` : domain}`
}
// The mail's own sentence for a card: the code out and every other number with it, but for an
// amount, which says what this is for.
export function shownMailLine(line, code, max = 160) {
  const text = scrubCode(shownLine(String(line == null ? '' : line).slice(0, 2000)), code)
  const masked = text.split(AMOUNT).map((piece, i) => (i % 2 ? piece : hideNumbers(piece))).join('')
  return masked.length > max ? `${masked.slice(0, max)}…` : masked
}
// A page's address for a card: its path, and only the names of what follows it (a link's values are
// whatever the link's author wrote).
function shownPath(url) {
  const path = shortLine(url.pathname, 80)
  const names = [...new Set([...url.searchParams.keys()])].slice(0, 6).map((name) => shortLine(name, 24))
  return `${path === '/' && !names.length ? '' : path}${names.length ? `?${names.join('&')}` : ''}` // i18n-ignore
}

// What the card shows, in the person's language. Never the code.
// -> { match, site, lines, accountLine, arrivedAt, warnings }
export function mailCodeCard({ url, check, subject, arrivedAt, account, code, fieldLabel = '', isRow = false, buttonLabel = '', buttonFormless = false, context = [], purpose = null }) {
  const { page, sender } = check
  const at = new URL(url)
  const site = `${at.protocol}//${shownHost(page)}${at.port ? ` (port ${at.port})` : ''}${shownPath(at)}` // i18n-ignore
  const pageName = page.domain || page.host
  const senderName = sender ? sender.info.domain || sender.info.host : ''
  const address = sender ? shownAddress(sender.address, code) : t('main.mailCode.unreadable', '(could not be read)')
  const subjectLine = shownSubject(subject, code)
  const field = shortLine(fieldLabel, 80)
  const mailLines = context.map((line) => shownMailLine(line, code)).filter(Boolean)
  const lines = [
    t('main.mailCode.site', 'Site: {{value}}', { value: site }),
    field ? t('main.mailCode.field', 'Field (words from the page, not from Tessel): {{value}}', { value: field }) : isRow ? t('main.mailCode.fieldBoxes', 'Field: a row of boxes') : t('main.mailCode.fieldMarked', 'Field: the one the page marks as a one-time code'),
    buttonLabel ? t('main.mailCode.button', 'Then Tessel presses (words from the page, not from Tessel): {{value}}', { value: shortLine(buttonLabel, 80) }) : t('main.mailCode.enter', 'Then Tessel presses: Enter'),
    t('main.mailCode.from', 'From: {{value}}', { value: sender && sender.info.notPlain ? `${address} ${t('main.mailCode.notPlain', '[not plain ASCII]')}` : address }),
    t('main.mailCode.subject', 'Subject (words from outside, not from Tessel): {{value}}', { value: subjectLine || t('main.mailCode.noSubject', '(none)') }),
    ...(mailLines.length ? [t('main.mailCode.mailSays', 'The mail says (its own words, numbers hidden): {{value}}', { value: mailLines.join(' / ') })] : [])
  ]
  const saying = {
    different: () => t('main.mailCode.different', 'The mail comes from {{sender}}, but this page is {{site}}. A code one site sent, typed into another, can give that other site your account.', { sender: senderName, site: pageName }),
    lookAlike: () => t('main.mailCode.lookAlike', '{{site}} and {{sender}} look almost the same, but they are not the same address.', { sender: senderName, site: pageName }),
    fromUnreadable: () => t('main.mailCode.fromUnreadable', 'The mail\'s From line is not plainly one address, so Tessel cannot tell who sent it.'),
    authFailed: () => t('main.mailCode.authFailed', 'Gmail\'s checks failed for this mail: it may not really come from {{sender}}.', { sender: senderName }),
    authMissing: () => t('main.mailCode.authMissing', 'Gmail\'s checks do not confirm that this mail really comes from {{sender}}.', { sender: senderName }),
    pageShared: () => t('main.mailCode.pageShared', 'Anyone can put a page on {{host}}: its address does not say who wrote this one.', { host: page.host }),
    pageUnknown: () => t('main.mailCode.pageUnknown', 'Tessel cannot tell who owns {{host}}, so it cannot compare it with the sender.', { host: page.host }),
    pageSubHost: () => t('main.mailCode.pageSubHost', 'This page is on {{host}}, and the mail comes from {{sender}}. On some services anyone can have a page under the same name, so this may not be the site the mail means.', { host: page.host, sender: sender ? sender.info.host : '' }),
    senderShared: () => t('main.mailCode.senderShared', 'Anyone can send mail from {{host}}: its address does not say who sent this one.', { host: sender.info.host }),
    senderUnknown: () => t('main.mailCode.senderUnknown', 'Tessel cannot tell who owns {{host}}, so it cannot compare it with the page.', { host: sender.info.host }),
    pagePort: () => t('main.mailCode.pagePort', 'This page is on port {{port}}, not the usual one for a site: another program may be answering there.', { port: at.port }),
    pageNotPlain: () => t('main.mailCode.pageNotPlain', 'This page\'s address has letters outside plain ASCII: they can imitate another address.'),
    senderNotPlain: () => t('main.mailCode.senderNotPlain', 'The sender\'s address has letters outside plain ASCII: they can imitate another address.'),
    senderLocalNotPlain: () => t('main.mailCode.senderLocalNotPlain', 'The sender\'s name before the @ has letters outside plain ASCII: read the part after the @.'),
    replyToOther: () => t('main.mailCode.replyToOther', 'Answers to this mail go to another domain than the one it comes from.'),
    notForAccount: () => t('main.mailCode.notForAccount', 'This mail is not addressed to {{account}}: it may be someone else\'s code, passed on to you.', { account: shortLine(account, 120) })
  }
  const purposes = {
    payment: () => t('main.mailCode.purposePayment', 'The mail or the page speaks of a payment, an order or a transfer: this code may confirm that.'),
    device: () => t('main.mailCode.purposeDevice', 'The mail or the page speaks of linking a device: this code may confirm that.'),
    closing: () => t('main.mailCode.purposeClosing', 'The mail or the page speaks of deleting or closing something: this code may confirm that.'),
    protection: () => t('main.mailCode.purposeProtection', 'The mail or the page speaks of turning off a protection: this code may confirm that.'),
    reset: () => t('main.mailCode.purposeReset', 'The mail or the page speaks of changing a password or recovering the account: this code may confirm that.'),
    consent: () => t('main.mailCode.purposeConsent', 'The mail or the page speaks of giving something access to the account: this code may confirm that.'),
    email: () => t('main.mailCode.purposeEmail', 'The mail or the page speaks of adding or changing an email or a phone: this code may confirm that.')
  }
  const warnings = [
    ...(purpose && Object.hasOwn(purposes, purpose) ? [purposes[purpose]()] : []),
    ...check.problems.map((problem) => saying[problem]()),
    ...(buttonFormless ? [t('main.mailCode.buttonFormless', 'This field has no form around it, so the button Tessel presses can do anything on this page.')] : [])
  ]
  return {
    match: check.match === true && warnings.length === 0,
    site: pageName,
    lines,
    accountLine: t('main.mailCode.account', 'Mail account: {{value}}', { value: shortLine(account, 120) }),
    arrivedAt: Number(arrivedAt) || 0,
    warnings
  }
}

// The page's address when it is a site one signs in to: https, nothing else in front of the host.
export function httpsOrigin(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null
  } catch {
    return null
  }
}

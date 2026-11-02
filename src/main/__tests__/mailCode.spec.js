// @vitest-environment node
// browser_fill_mail_code, what Tessel reads in a mail: whose domain it is, whether Gmail confirms
// the sender, the one code in it (with hostile mails), and what a card says of it.
import { describe, it, expect } from 'vitest'
import { authVerdict, checkSender, codePurpose, domainInfo, extractCode, fitsHint, hintFitsPage, httpsOrigin, looksLike, mailCodeCard, hideNumbers, parseFrom, sameOwner, scrubCode, shownMailLine, shownSubject, visibleHtml, MASK, SHARED_HOSTS } from '../mailCode'

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url')
const AUTH_OK = (domain) => `mx.google.com; dkim=pass header.i=@${domain} header.s=s1 header.b=abc; spf=pass (google.com: domain of a@${domain} designates 192.0.2.1 as permitted sender) smtp.mailfrom=a@${domain}; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=${domain}`
const headers = (list) => list.map(([name, value]) => ({ name, value }))
function mail({ subject = 'Hello', text = null, html = null, from = 'no-reply@fernhill-shop.com', auth = AUTH_OK('fernhill-shop.com'), extraHeaders = [] } = {}) {
  const parts = []
  if (text !== null) parts.push({ mimeType: 'text/plain', body: { data: b64(text) } })
  if (html !== null) parts.push({ mimeType: 'text/html', body: { data: b64(html) } })
  return {
    id: 'm1',
    internalDate: '1000',
    payload: {
      mimeType: 'multipart/alternative',
      headers: headers([...(auth ? [['Authentication-Results', auth]] : []), ['From', from], ['Subject', subject], ...extraHeaders]),
      parts
    }
  }
}
const code = (m) => extractCode(m).code
const refused = (m) => extractCode(m).refused

describe('whose domain a host is', () => {
  it('finds what one owner registers', () => {
    for (const [host, domain] of [
      ['shop.fernhill-shop.com', 'fernhill-shop.com'],
      ['a.b.c.fernhill-shop.com', 'fernhill-shop.com'],
      ['FERNHILL-SHOP.COM.', 'fernhill-shop.com'],
      ['login.quillmarket.ca', 'quillmarket.ca'],
      ['quillmarket.qc.ca', 'quillmarket.qc.ca'],
      ['www.quillmarket.qc.ca', 'quillmarket.qc.ca'],
      ['shop.quillmarket.co.uk', 'quillmarket.co.uk'],
      ['quillmarket.fr', 'quillmarket.fr'],
      ['quillmarket.gouv.fr', 'quillmarket.gouv.fr'],
      ['a.quillmarket.com.au', 'quillmarket.com.au'],
      // Where the short table once had no answer: the real list knows them.
      ['www.twitch.tv', 'twitch.tv'],
      ['www.sbab.se', 'sbab.se'],
      ['fernhill.it', 'fernhill.it'],
      ['hdfc.bank.in', 'hdfc.bank.in']
    ])
      expect(domainInfo(host).domain, host).toBe(domain)
  })

  it('a public suffix is nobody\'s, and a suffix it cannot place is treated as unknown, never guessed', () => {
    for (const host of ['co.uk', 'com', 'qc.ca', 'uk.com', 'fernhill.nosuchtld', 'a.fernhill.nosuchtld', 'localhost', '192.0.2.1', '[::1]', '', 'a..b.com', '-bad-.com', 'fernhill.example']) {
      const info = domainInfo(host)
      expect(info.domain, host).toBe(null)
    }
  })

  it('the list\'s private section: a name under a service belongs to nobody in particular', () => {
    for (const host of ['fernhill.uk.com', 'a.fernhill.uk.com', 'evil.github.io', 'x.myshopify.com', 'x.herokuapp.com']) {
      expect(domainInfo(host).domain, host).toBe(null)
      expect(domainInfo(host).why, host).toBe('shared')
    }
    // Not guessed either way: a hostname that is an address has no owner.
    expect(domainInfo('1.2.3.4').domain).toBe(null)
  })

  it('one owner on two domains, and only the ones it knows', () => {
    expect(sameOwner('claude.ai', 'anthropic.com')).toBe(true)
    expect(sameOwner('slackhq.com', 'slack.com')).toBe(true)
    expect(sameOwner('facebook.com', 'facebookmail.com')).toBe(true)
    expect(sameOwner('live.com', 'microsoftonline.com')).toBe(true)
    expect(sameOwner('claude.ai', 'slack.com')).toBe(false)
    expect(sameOwner('', 'slack.com')).toBe(false)
    expect(sameOwner(null, null)).toBe(false)
  })

  it('a host where anyone can have a page has no owner to compare', () => {
    expect(SHARED_HOSTS.size).toBeGreaterThan(40)
    for (const shared of SHARED_HOSTS) {
      for (const host of [shared, `tenant.${shared}`, `a.tenant.${shared}`]) {
        const info = domainInfo(host)
        expect(info.domain, host).toBe(null)
        expect(info.why, host).toBe('shared')
      }
    }
  })

  it('names what is not plain ASCII: punycode and raw letters alike', () => {
    expect(domainInfo('xn--fernhil-9ve.com').notPlain).toBe(true) // not even valid punycode
    expect(domainInfo('xn--bcher-kva.com').notPlain).toBe(true)
    const raw = domainInfo('fаrnhill.com') // a Cyrillic a
    expect(raw.notPlain).toBe(true)
    expect(raw.host).toBe(raw.host.toLowerCase())
    expect(raw.host).toMatch(/^xn--/)
    expect(domainInfo('farnhill.com').notPlain).toBe(false)
  })

  it('tells look-alikes', () => {
    expect(looksLike('larkspurbank1.com', 'larkspurbankl.com')).toBe(true)
    expect(looksLike('rnarblewood.com', 'marblewood.com')).toBe(true)
    expect(looksLike('g00dfern.com', 'goodfern.com')).toBe(true)
    expect(looksLike('fernhilll.com', 'fernhill.com')).toBe(true)
    expect(looksLike('fernhill.com', 'fernhill.com')).toBe(false)
    expect(looksLike('larkspurbank.com', 'tomatoes.com')).toBe(false)
  })

  it('takes only an https page, with nothing before its host', () => {
    expect(httpsOrigin('https://a.example:8443/x?y#z')).toBe('https://a.example:8443')
    expect(httpsOrigin('http://a.example/')).toBe(null)
    expect(httpsOrigin('https://me:pw@a.example/')).toBe(null)
    expect(httpsOrigin('about:blank')).toBe(null)
    expect(httpsOrigin('nonsense')).toBe(null)
  })
})

describe('a From line', () => {
  it('reads the real address, not what its name says', () => {
    expect(parseFrom('Shop <no-reply@shop.example>').address).toBe('no-reply@shop.example')
    expect(parseFrom('no-reply@SHOP.example').address).toBe('no-reply@shop.example')
    expect(parseFrom('"bank@bank.example" <someone@evil.example>').domain).toBe('evil.example')
    expect(parseFrom('bank@bank.example <someone@evil.example>').domain).toBe('evil.example')
    expect(parseFrom('someone@evil.example (<bank@bank.example>)').domain).toBe('evil.example')
    expect(parseFrom('"quoted \\" <bank@bank.example>" <someone@evil.example>').domain).toBe('evil.example')
  })

  it('refuses what is not plainly one address', () => {
    for (const bad of ['', 'nobody', 'a@evil.example, b@bank.example', '<a@evil.example> <b@bank.example>', 'list: a@evil.example;', '"never closed <a@b.example>', '(never closed a@b.example', '<@route:a@evil.example>', '=?utf-8?Q?x?=@bank.example', 'a@', '@bank.example']) expect(parseFrom(bad), bad).toBe(null)
  })

  it('fits the sender the agent named, by address or domain', () => {
    const sender = parseFrom('no-reply@mail.shop.example')
    expect(fitsHint(sender, null)).toBe(true)
    expect(fitsHint(sender, 'no-reply@mail.shop.example')).toBe(true)
    expect(fitsHint(sender, 'shop.example')).toBe(true)
    expect(fitsHint(sender, 'mail.shop.example')).toBe(true)
    expect(fitsHint(sender, 'hop.example')).toBe(false)
    expect(fitsHint(sender, 'other@shop.example')).toBe(false)
    expect(fitsHint(null, 'shop.example')).toBe(false)
  })
})

describe('the sender the agent names', () => {
  it('must be this page\'s own site', () => {
    expect(hintFitsPage(null, 'login.quillmarket.com')).toBe(true)
    expect(hintFitsPage('quillmarket.com', 'login.quillmarket.com')).toBe(true)
    expect(hintFitsPage('no-reply@mail.quillmarket.com', 'login.quillmarket.com')).toBe(true)
    expect(hintFitsPage('anthropic.com', 'claude.ai')).toBe(true)
    expect(hintFitsPage('bank.com', 'bank-verify.com')).toBe(false)
    expect(hintFitsPage('no-reply@bank.com', 'bank-verify.com')).toBe(false)
    expect(hintFitsPage('site.example', 'login.site.example')).toBe(true)
    expect(hintFitsPage('other.example', 'login.site.example')).toBe(false)
  })
})

describe('what Gmail found about the sender', () => {
  const verdict = (auth, domain = 'fernhill-shop.com') => authVerdict(mail({ auth }), domain)
  it('passes on DMARC, or on a signature or SPF of that very domain', () => {
    expect(verdict(AUTH_OK('fernhill-shop.com'))).toBe('pass')
    expect(verdict('mx.google.com; dkim=pass header.i=@mail.fernhill-shop.com')).toBe('pass')
    expect(verdict('mx.google.com; dkim=pass header.d=fernhill-shop.com')).toBe('pass')
    expect(verdict('mx.google.com; spf=pass smtp.mailfrom=bounce@fernhill-shop.com')).toBe('pass')
  })

  it('a failure fails, whatever else it says', () => {
    expect(verdict('mx.google.com; dkim=pass header.i=@fernhill-shop.com; dmarc=fail header.from=fernhill-shop.com')).toBe('fail')
    expect(verdict('mx.google.com; spf=softfail smtp.mailfrom=a@fernhill-shop.com')).toBe('fail')
    expect(verdict('mx.google.com; dkim=fail header.i=@fernhill-shop.com; spf=pass smtp.mailfrom=a@fernhill-shop.com')).toBe('fail')
  })

  it('a pass for another domain says nothing about this one', () => {
    expect(verdict('mx.google.com; dkim=pass header.i=@mailhouse-fern.com; spf=pass smtp.mailfrom=a@mailhouse-fern.com')).toBe('none')
    expect(verdict('mx.google.com; dmarc=pass header.from=evil-fern.com')).toBe('none')
  })

  it('what a comment says is not a result', () => {
    expect(verdict('mx.google.com; spf=none (dmarc=pass header.from=fernhill-shop.com) smtp.mailfrom=a@mailhouse-fern.com')).toBe('none')
  })

  it('a sender\'s words inside the header cannot pass for a result', () => {
    const forged = [
      // One of ; ( ) inside quotes.
      'mx.google.com; spf=softfail smtp.mailfrom="a;dmarc=pass header.from=bank.com;b"@evil.example; dmarc=fail header.from=bank.com',
      // A stray quote.
      'mx.google.com; spf=pass (domain of a"b@evil.example) smtp.mailfrom=x@evil.example; dmarc=pass header.from=bank.com',
      // A parenthesis never closed hides the rest, one closed too soon opens it.
      'mx.google.com; dkim=pass header.i=@bank.com(.evil.example; dmarc=fail header.from=bank.com',
      'mx.google.com; spf=pass (a)b;dmarc=pass header.from=bank.com;c((d@evil.example) smtp.mailfrom=x@evil.example',
      'mx.google.com; spf=pass a)b; dmarc=pass header.from=bank.com',
      // Gmail says it once.
      'mx.google.com; dmarc=pass header.from=bank.com; dmarc=none header.from=evil.example',
      // A ";" that does not start a result.
      'mx.google.com; dkim=pass header.i=@bank.com;x=y.evil.example header.s=s'
    ]
    forged.push(
      // Whitespace in quotes: a sender's words as a property of their own.
      'mx.google.com; spf=pass smtp.mailfrom="x smtp.mailfrom=a@bank.com y"@evil.example',
      'mx.google.com; spf=pass smtp.mailfrom="x y"@bank.com',
      // A signature's two names for its domain, not agreeing.
      'mx.google.com; dkim=pass header.i=@evil.example header.d=bank.com',
      // The same property twice.
      'mx.google.com; spf=pass smtp.mailfrom=a@evil.example smtp.mailfrom=a@bank.com',
      'mx.google.com; dkim=pass header.i=@evil.example header.i=@bank.com',
      'mx.google.com; dmarc=pass header.from=evil.example header.from=bank.com'
    )
    for (const value of forged) expect(authVerdict({ payload: { headers: headers([['Authentication-Results', value]]) } }, 'bank.com'), value).toBe('none')
  })

  it('a mail Gmail fetched from elsewhere: nothing in it can be Gmail\'s word', () => {
    const value = AUTH_OK('bank.com')
    expect(authVerdict({ payload: { headers: headers([['Authentication-Results', value]]) } }, 'bank.com')).toBe('pass')
    expect(authVerdict({ payload: { headers: headers([['Authentication-Results', value], ['X-Gmail-Fetch-Info', 'a@b.example 1 pop.b.example 995 a']]) } }, 'bank.com')).toBe('none')
  })

  it('a pass counts on a domain no list knows, by the very host', () => {
    const value = 'mx.google.com; dmarc=pass header.from=shop.example'
    expect(authVerdict({ payload: { headers: headers([['Authentication-Results', value]]) } }, 'shop.example')).toBe('pass')
    expect(authVerdict({ payload: { headers: headers([['Authentication-Results', value]]) } }, 'other.example')).toBe('none')
  })

  it('only the first header can be Gmail\'s: one the sender wrote below it counts for nothing', () => {
    const forged = 'mx.google.com; dmarc=pass header.from=larkspurbank.com'
    const real = 'mx.google.com; dmarc=fail header.from=larkspurbank.com'
    const m = mail({ from: 'x@larkspurbank.com', auth: real, extraHeaders: [['Authentication-Results', forged]] })
    expect(authVerdict(m, 'larkspurbank.com')).toBe('fail')
    // A header that does not name Gmail: nothing to go on.
    expect(authVerdict(mail({ from: 'x@larkspurbank.com', auth: 'mail.evil-fern.com; dmarc=pass header.from=larkspurbank.com' }), 'larkspurbank.com')).toBe('none')
    expect(authVerdict(mail({ auth: null }), 'fernhill-shop.com')).toBe('none')
  })
})

describe('comparing a mail\'s sender with a page', () => {
  it('a confirmed sender of the same registrable domain is a match, subdomains included', () => {
    expect(checkSender(mail(), 'fernhill-shop.com').match).toBe(true)
    const m = mail({ from: 'no-reply@mail.quillmarket.com', auth: AUTH_OK('mail.quillmarket.com') })
    const c = checkSender(m, 'login.quillmarket.com')
    expect(c.match).toBe(true)
    expect(c.problems).toEqual([])
  })

  it('the attack: a real code from the bank, on another site', () => {
    const m = mail({ from: 'alerts@larkspurbank.com', auth: AUTH_OK('larkspurbank.com') })
    const c = checkSender(m, 'evil-fern.com')
    expect(c.match).toBe(false)
    expect(c.problems).toContain('different')
    // The bank's name in the page's own address changes nothing.
    expect(checkSender(m, 'larkspurbank.com.evil-fern.com').match).toBe(false)
  })

  it('one owner\'s mail and sign-in on two domains is a match, with no false warning', () => {
    const on = (from, auth, page) => checkSender(mail({ from, auth: AUTH_OK(auth) }), page)
    expect(on('no-reply@mail.anthropic.com', 'mail.anthropic.com', 'claude.ai')).toMatchObject({ match: true, problems: [] })
    expect(on('feedback@slackhq.com', 'slackhq.com', 'slack.com')).toMatchObject({ match: true, problems: [] })
    expect(on('no-reply@twitch.tv', 'twitch.tv', 'www.twitch.tv')).toMatchObject({ match: true, problems: [] })
    expect(on('no-reply@sbab.se', 'sbab.se', 'www.sbab.se')).toMatchObject({ match: true, problems: [] })
  })

  it('a customer\'s page on a service: the same domain, and not said to be the same owner', () => {
    const on = (from, auth, page) => checkSender(mail({ from, auth: AUTH_OK(auth) }), page)
    for (const [from, auth, page] of [
      ['notifications@accounts.dev', 'accounts.dev', 'funny-cat-12.accounts.dev'],
      ['alerts@bank.com', 'bank.com', 'my.bank.com'],
      ['alerts@bank.com', 'bank.com', 'id.bank.com'],
      ['alerts@bank.com', 'bank.com', 'secure.bank.com'],
      ['alerts@bank.com', 'bank.com', 'auth.bank.com'],
      ['alerts@bank.com', 'bank.com', 'sso.bank.com'],
      ['no-reply@accounts.google.com', 'accounts.google.com', 'calendar.google.com'],
      ['receipts@stripe.com', 'stripe.com', 'buy.stripe.com'],
      ['alerts@bank.com', 'bank.com', 'old-campaign.bank.com']
    ]) {
      const check = on(from, auth, page)
      expect(check.match, page).toBe(false)
      expect(check.problems, page).toContain('pageSubHost')
    }
    // What a site calls its sign-in host, and the sender's own host, are fine.
    for (const page of ['bank.com', 'www.bank.com', 'login.bank.com', 'accounts.bank.com', 'account.bank.com', 'signin.bank.com']) expect(on('alerts@bank.com', 'bank.com', page).match, page).toBe(true)
    expect(on('a@mail.bank.com', 'mail.bank.com', 'mail.bank.com').match).toBe(true)
    // Services where each customer gets a host: none under them says whose it is.
    for (const [from, auth, page] of [
      ['noreply@okta.com', 'okta.com', 'dev-1234567.okta.com'],
      ['noreply@okta.com', 'okta.com', 'id.okta.com'],
      ['noreply@okta.com', 'okta.com', 'login.okta.com'],
      ['support@zendesk.com', 'zendesk.com', 'my.zendesk.com'],
      ['support@zendesk.com', 'zendesk.com', 'login.zendesk.com'],
      ['support@victimco.zendesk.com', 'victimco.zendesk.com', 'attacker.zendesk.com'],
      ['support@victimco.zendesk.com', 'victimco.zendesk.com', 'victimco.zendesk.com'],
      ['victimco@service-now.com', 'service-now.com', 'dev123456.service-now.com'],
      ['a@service-now.com', 'service-now.com', 'my.service-now.com'],
      ['a@slack.com', 'slack.com', 'secure.slack.com'],
      ['a@atlassian.net', 'atlassian.net', 'my.atlassian.net'],
      ['a@zoom.us', 'zoom.us', 'secure.zoom.us'],
      ['a@kajabi.com', 'kajabi.com', 'my.kajabi.com'],
      ['a@monday.com', 'monday.com', 'sso.monday.com'],
      ['a@pagerduty.com', 'pagerduty.com', 'login.pagerduty.com'],
      ['a@odoo.com', 'odoo.com', 'auth.odoo.com'],
      ['a@egnyte.com', 'egnyte.com', 'sso.egnyte.com'],
      ['a@sharefile.com', 'sharefile.com', 'sso.sharefile.com'],
      ['a@zohodesk.com', 'zohodesk.com', 'login.zohodesk.com'],
      ['a@sentry.io', 'sentry.io', 'login.sentry.io'],
      ['a@box.com', 'box.com', 'login.box.com'],
      ['a@clickup.com', 'clickup.com', 'sso.clickup.com'],
      ['a@jumpcloud.com', 'jumpcloud.com', 'login.jumpcloud.com'],
      ['noreply@salesforce.com', 'salesforce.com', 'attacker-dev-ed.develop.my.salesforce.com']
    ]) {
      const check = on(from, auth, page)
      expect(check.match, page).toBe(false)
      expect(check.problems, page).toContain('pageShared')
    }
    // The service itself, and the few known hosts people really sign in on.
    for (const [from, auth, page] of [
      ['a@slack.com', 'slack.com', 'slack.com'],
      ['a@zoom.us', 'zoom.us', 'zoom.us'],
      ['appleid@id.apple.com', 'id.apple.com', 'id.apple.com'],
      ['appleid@id.apple.com', 'id.apple.com', 'appleid.apple.com'],
      ['a@notify.cloudflare.com', 'notify.cloudflare.com', 'dash.cloudflare.com'],
      ['a@stripe.com', 'stripe.com', 'dashboard.stripe.com'],
      ['no-reply@signin.aws', 'signin.aws', 'signin.aws.amazon.com'],
      ['a@salesforce.com', 'salesforce.com', 'login.salesforce.com'],
      ['noreply@tm.openai.com', 'tm.openai.com', 'auth.openai.com']
    ])
      expect(on(from, auth, page).match, page).toBe(true)
    // Known shared sites the list leaves out.
    for (const page of ['airtable.com', 'calendly.com']) expect(on(`a@${page}`, page, page).problems, page).toContain('pageShared')
  })

  it('another port on the same host warns: another program may be answering there', () => {
    const m = mail({ from: 'a@fernhill-shop.com' })
    expect(checkSender(m, 'fernhill-shop.com').match).toBe(true)
    const check = checkSender(m, 'fernhill-shop.com', null, '8443')
    expect(check.match).toBe(false)
    expect(check.problems).toContain('pagePort')
  })

  it('answers going to another domain warn', () => {
    const m = (replyTo) => mail({ extraHeaders: [['Reply-To', replyTo]] })
    expect(checkSender(m('someone@fernhill-shop.com'), 'fernhill-shop.com').match).toBe(true)
    expect(checkSender(m('Support <help@fernhill-shop.com>'), 'fernhill-shop.com').match).toBe(true)
    const check = checkSender(m('collector@evil-fern.com'), 'fernhill-shop.com')
    expect(check.match).toBe(false)
    expect(check.problems).toContain('replyToOther')
  })

  it('a mail addressed to someone else warns: a code passed on is not this person\'s', () => {
    const m = (to, deliveredTo) => mail({ extraHeaders: [...(to ? [['To', to]] : []), ...(deliveredTo ? [['Delivered-To', deliveredTo]] : [])] })
    const problems = (message) => checkSender(message, 'fernhill-shop.com', 'j.doe@gmail.com').problems
    expect(problems(m('attacker@fernhill-mail.com', 'jdoe@gmail.com'))).toContain('notForAccount')
    expect(problems(m('J.Doe@gmail.com', 'jdoe+x@gmail.com'))).not.toContain('notForAccount')
    expect(problems(m('"Jay" <jdoe@googlemail.com>', null))).not.toContain('notForAccount')
    expect(problems(m(null, null))).not.toContain('notForAccount')
    // No account known: nothing to say.
    expect(checkSender(m('attacker@fernhill-mail.com', null), 'fernhill-shop.com').problems).not.toContain('notForAccount')
  })

  it('a name before the @ outside plain ASCII warns', () => {
    const c = checkSender(mail({ from: 'no-reply＠bank.com@evil.example', auth: AUTH_OK('evil.example') }), 'evil.example')
    expect(c.problems).toContain('senderLocalNotPlain')
  })

  it('a look-alike is no match, and said to be one', () => {
    const c = checkSender(mail({ from: 'alerts@larkspurbankl.com', auth: AUTH_OK('larkspurbankl.com') }), 'larkspurbank1.com')
    expect(c.match).toBe(false)
    expect(c.problems).toEqual(expect.arrayContaining(['different', 'lookAlike']))
  })

  it('a non-ASCII host is never a match, even on itself', () => {
    const c = checkSender(mail({ from: 'a@xn--bcher-kva.com', auth: AUTH_OK('xn--bcher-kva.com') }), 'xn--bcher-kva.com')
    expect(c.match).toBe(false)
    expect(c.problems).toEqual(expect.arrayContaining(['pageNotPlain', 'senderNotPlain']))
  })

  it('a host anyone can use is no match, even on itself', () => {
    const shared = [...SHARED_HOSTS][0]
    const c = checkSender(mail({ from: `a@evil.${shared}`, auth: AUTH_OK(`evil.${shared}`) }), `evil.${shared}`)
    expect(c.match).toBe(false)
    expect(c.problems).toEqual(expect.arrayContaining(['pageShared', 'senderShared']))
    // A form anyone can make on a company's own host, and a real code from that company.
    const formHost = [...SHARED_HOSTS].find((h) => h.split('.').length === 3)
    const company = formHost.split('.').slice(1).join('.')
    const forms = checkSender(mail({ from: `no-reply@accounts.${company}`, auth: AUTH_OK(`accounts.${company}`) }), formHost)
    expect(forms.match).toBe(false)
    expect(forms.problems).toContain('pageShared')
  })

  it('a suffix it cannot place is no match, even on itself', () => {
    const c = checkSender(mail({ from: 'a@shop.nosuchtld', auth: AUTH_OK('shop.nosuchtld') }), 'shop.nosuchtld')
    expect(c.match).toBe(false)
    expect(c.problems).toEqual(expect.arrayContaining(['pageUnknown', 'senderUnknown']))
    expect(checkSender(mail({ from: 'a@fernhill.co.uk', auth: AUTH_OK('fernhill.co.uk') }), 'quillmarket.co.uk').match).toBe(false)
  })

  it('failed or missing authentication is no match, even from the page\'s own domain', () => {
    const failed = checkSender(mail({ from: 'a@quillmarket.com', auth: 'mx.google.com; dmarc=fail header.from=quillmarket.com' }), 'quillmarket.com')
    expect(failed.match).toBe(false)
    expect(failed.problems).toEqual(['authFailed'])
    const missing = checkSender(mail({ from: 'a@quillmarket.com', auth: null }), 'quillmarket.com')
    expect(missing.match).toBe(false)
    expect(missing.problems).toEqual(['authMissing'])
  })

  it('a From line it cannot read, or two of them, is no match', () => {
    const one = checkSender(mail({ from: 'a@quillmarket.com, b@evil.example', auth: AUTH_OK('quillmarket.com') }), 'quillmarket.com')
    expect(one.match).toBe(false)
    expect(one.problems).toContain('fromUnreadable')
    const two = checkSender(mail({ from: 'a@quillmarket.com', auth: AUTH_OK('quillmarket.com'), extraHeaders: [['From', 'b@evil.example']] }), 'quillmarket.com')
    expect(two.match).toBe(false)
    expect(two.problems).toContain('fromUnreadable')
  })
})

describe('the one code in a mail', () => {
  it('finds a clear code, in English and in French, as the mail writes it', () => {
    expect(code(mail({ text: 'Your verification code is 482913. It expires in 10 minutes.' }))).toBe('482913')
    expect(code(mail({ text: 'Votre code de vérification est : 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Votre code à usage unique : 4829' }))).toBe('4829')
    expect(code(mail({ text: 'Votre NIP temporaire est 4829' }))).toBe('4829')
    expect(code(mail({ text: 'OTP: 48291307' }))).toBe('48291307')
    expect(code(mail({ text: 'Your login code:\n\n482913\n\nThanks' }))).toBe('482913')
    expect(code(mail({ text: '482913\n\nis your code' }))).toBe('482913')
    expect(code(mail({ text: 'code: 482 913' }))).toBe('482913')
    expect(code(mail({ text: 'code: 482-913' }))).toBe('482913')
    expect(code(mail({ text: 'Your code is ABC-123.' }))).toBe('ABC123')
    expect(code(mail({ text: 'Your code is A7K2QX' }))).toBe('A7K2QX')
    expect(code(mail({ text: 'Your code is aB3xY9' }))).toBe('aB3xY9')
    expect(code(mail({ subject: '482913 is your verification code', text: 'Hello' }))).toBe('482913')
    expect(code(mail({ text: 'Here is your verification code.\n\n482913\n\nBye' }))).toBe('482913')
    expect(code(mail({ text: '482913 is your Facebook confirmation code' }))).toBe('482913')
    expect(code(mail({ text: 'Please enter the following code to log in: 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Your Amazon OTP is 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Enter 482913 to verify' }))).toBe('482913')
    expect(code(mail({ text: 'Your one-time password is 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Votre code de validation : 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Votre code de validation est 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Votre code de vérification Apple est : 482913' }))).toBe('482913')
    expect(code(mail({ text: "Votre code d'activation : 482913" }))).toBe('482913')
    expect(code(mail({ text: 'Votre code à 6 chiffres : 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Entrez le code suivant pour vous connecter : 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Your code for Acme is 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Your sign-in code for Acme is 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Use this code to log in to Acme: 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Enter the following code to verify your email address: 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Votre code de connexion Acme est 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Utilisez ce code pour vous connecter à Acme : 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Use this code to sign in to your Acme account: 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Enter this code to verify your account: 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Here is the code you requested: 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Bonjour Jean, voici le code demandé : 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Please enter this code on the sign-in page: 482913' }))).toBe('482913')
    expect(code(mail({ text: "Saisissez ce code dans l'application : 482913" }))).toBe('482913')
    expect(code(mail({ text: 'Votre code de vérification par e-mail : 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Your token is 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Votre jeton de sécurité : 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Your temporary password is 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Votre mot de passe unique est 482913' }))).toBe('482913')
    expect(code(mail({ html: '<p>Your code is <b>482913</b></p>' }))).toBe('482913')
    expect(code(mail({ text: 'Your code is 4829130123' }))).toBe('4829130123')
  })

  it('the same code said several times is one code', () => {
    expect(code(mail({ subject: 'Code 482913', text: 'Your code is 482913', html: '<p>Your code: 482 913</p>' }))).toBe('482913')
  })

  it('no number near such a word: nothing', () => {
    expect(refused(mail({ text: 'Your invoice 482913 is ready.' }))).toBe('none')
    expect(refused(mail({ text: 'Hello, see you at 1530 on the bridge.' }))).toBe('none')
    expect(refused(mail({ text: 'Your code is on its way.' }))).toBe('none')
    expect(refused(mail({ html: '<img alt="code 482913" src="x.png">' }))).toBe('none')
    expect(refused(mail({}))).toBe('none')
    expect(refused({})).toBe('none')
  })

  it('too short or too long is not a code', () => {
    expect(refused(mail({ text: 'code 123' }))).toBe('none')
    expect(refused(mail({ text: 'code 12345678901' }))).toBe('none')
    expect(refused(mail({ text: 'code 4111111111111111' }))).toBe('none')
  })

  it('several candidates: refused, never a guess', () => {
    expect(refused(mail({ text: 'Your code is 482913. Your old code was 771122.' }))).toBe('several')
    expect(refused(mail({ text: 'Use code 111111 or code 222222 or code 333333 or code 444444' }))).toBe('several')
    // Each part of the mail says something else.
    expect(refused(mail({ text: 'Your code is 111111', html: '<p>Your code is 222222</p>' }))).toBe('several')
    // A word in another sentence says nothing of a number: the one tied to it is the code.
    expect(code(mail({ text: 'Use code 482913 to sign in. Quote 998877 if you need help.' }))).toBe('482913')
    // A stranger's number next to the real one, in a clause of its own.
    expect(refused(mail({ text: 'Hello code 999999 order, 482913 is your code' }))).toBe('several')
  })

  it('unsure refuses: a number merely close to such a word is no code', () => {
    for (const text of [
      'Your verification is complete. Flight 4829 departs today.',
      'Votre vérification est terminée. Vol 4829 à destination de Paris.',
      'Please verify your email. Our office: 1500 Sherbrooke Street West, Montreal.',
      'Vérifiez votre adresse. Nos bureaux : 1500 rue Sherbrooke Ouest, Montréal.',
      'Veuillez vérifier votre courriel, 1500 boul. René-Lévesque',
      'Verify your email. Montreal QC H3B2Y5',
      'Verified purchase. Item 482913',
      'Votre vérification : contrat 482913',
      'Verification of parcel 482913',
      'Vérification du colis 482913',
      'Numéro de série vérifié 482913',
      '2FA enabled on device 123456',
      'Code of conduct updated, section 1234',
      'Verification fee 1299',
      'Frais de vérification 1299',
      'Verify before 1700 today',
      'Your code expires in 1440 mn',
      'Votre code expire dans 3600 s',
      'You earned 2500 points with your verification',
      "Si vous n'avez pas demandé ce code, contactez-nous au 5145550123",
      'If you did not request this code, contact us at 5145550123',
      'Did not ask for a code? WhatsApp 5145550123',
      'Your code of 1234 is not valid anymore',
      'You entered a wrong code 3 times. Attempt id 88231',
      'Your PIN was changed on 11 2026 at 1530',
      'Votre NIP a été modifié à 1530',
      'Verify your number 5145550199',
      'Jane says the code is 999999',
      'Your verification status is 1234',
      'Code Conduct 1234',
      'Your code for review 482913',
      'Your code for two people and more words than a name is 482913',
      'The code of conduct has 482913',
      'Account: 482913',
      'Your code was sent. Account: 482913',
      'Your account number is 482913'
    ])
      expect(refused(mail({ text })), text).toBe('none')
  })

  it('another kind of code, or someone\'s words about one, is no code', () => {
    for (const text of [
      'Use code WELCOME10 at checkout for 10% off',
      'Use code SAVE2026 today',
      'Utilisez le code rabais ETE2026 pour 20 % de rabais',
      'Votre code de bienvenue : BIENVENUE10',
      'Your booking confirmation code ABC123',
      'Gift card code 1234-5678',
      'Votre carte-cadeau, code 482913',
      'Wi-Fi access code 482913',
      'Door code 4829',
      'Le code de la porte est 4829',
      'Code de sécurité 4829 de la carte',
      'Promo: code 482913',
      'Reference code 482913',
      'Your customer code is 482913.',
      'Your employee code is 482913.',
      'Your event access code is 4829. Doors open at 7.',
      'Your alarm code is 4829',
      'Your locker code is 4829',
      'Your pickup code is 4829',
      'Bob commented: Your verification code is 999999',
      'Marie vous a invité: code de vérification 999999. Voir le document.'
    ])
      expect(refused(mail({ text })), text).toBe('none')
  })

  it('a subject saying "code" does not make a bare number in the body one', () => {
    for (const [subject, text] of [['Verify your email', 'Click the link below.\n\n1500\nRue Sherbrooke'], ['Your code', 'Merci\n\n514\n5550123\n'], ['Your verification', 'Your order\nA1B2C3\n'], ['Please verify your order', 'Item\n482913\nQuantity 2'], ['Your verification code', 'Hello,\n\n482913\n\nBye']]) expect(refused(mail({ subject, text })), text).toBe('none')
  })

  it('a reply, a list\'s mail or a forward holds what someone else wrote: refused', () => {
    for (const name of ['In-Reply-To', 'References', 'List-Id']) expect(refused(mail({ text: 'Your code is 482913', extraHeaders: [[name, '<a@b.example>']] })), name).toBe('passedOn')
    for (const subject of ['Re: Your verification code is 999999', 'RE : code 999999', 'Fwd: Your code', 'Fwd： Your code', 'FW: Your code', 'Tr : Votre code', 'TR: Votre code']) expect(refused(mail({ subject, text: 'Your code is 482913' })), subject).toBe('passedOn')
    for (const text of ['Thanks!\n\nOn Mon, a@b wrote:\n> Your code is 111111', '> Your code is 111111', '› Your code is 111111', '» Votre code est 111111', 'See below\n\n---------- Forwarded message ---------\nYour code is 482913', 'Begin forwarded message:\nYour code is 482913', '-----Message d\'origine-----\nVotre code est 482913', 'De : a@b.example\nEnvoyé : lundi\nVotre code est 482913']) expect(refused(mail({ text })), text).toBe('passedOn')
    for (const html of ['<p>Thanks</p><blockquote>Your code is 111111</blockquote>', '<p>Your new code is 222222</p><div class="gmail_quote">Your code is 111111</div>']) expect(refused(mail({ html })), html).toBe('passedOn')
  })

  it('a number with letters no one sees inside is the whole number, never a part', () => {
    for (const html of ['<p>code 48&zwnj;2913</p>', '<p>code 48&shy;2913</p>', '<p>code 4829&zwj;13</p>', '<p>code 48&#8203;2913</p>']) expect(code(mail({ html })), html).toBe('482913')
    for (const text of ['code 48\ufe0f2913', 'code 48\u034f2913', 'code 48\u000b2913', 'code 48\u00002913', 'code 482913\u0301']) expect(code(mail({ text })), text).toBe('482913')
  })

  it('a link\'s target is not what the mail says', () => {
    expect(refused(mail({ html: '<p>Your code <a href="999999">here</a></p>' }))).toBe('none')
    expect(code(mail({ html: '<p>Your code is <a href="https://x.example/999999">482913</a></p>' }))).toBe('482913')
  })

  it('says where it found it, for the card', () => {
    const got = extractCode(mail({ text: 'Hello\nUse this to pay $120.00.\nYour code is 482913\nThanks' }))
    expect(got.code).toBe('482913')
    expect(got.line).toBe('Your code is 482913')
    expect(got.around).toContain('Use this to pay $120.00.')
    expect(got.context).toEqual(['Use this to pay $120.00.', 'Your code is 482913'])
    expect(extractCode(mail({ text: 'Your login code:\n\n482913\n\nThanks' })).line).toBe('Your login code: 482913')
  })

  it('all its parts together have a limit, and what is past it is too much, not left out', () => {
    const big = { mimeType: 'text/html', body: { data: b64('x'.repeat(240 * 1024)) } }
    expect(refused({ payload: { mimeType: 'multipart/mixed', headers: [], parts: [big, big, { mimeType: 'text/plain', body: { data: b64('Your code is 482913') } }] } })).toBe('none')
    const many = Array.from({ length: 30 }, () => ({ mimeType: 'text/plain', body: { data: b64('x') } }))
    expect(refused({ payload: { mimeType: 'multipart/mixed', headers: [], parts: [{ mimeType: 'text/plain', body: { data: b64('Your code is 482913') } }, ...many] } })).toBe('none')
  })

  it('a phone number is not a code', () => {
    for (const phone of ['+1 514 555 0123', '(514) 555-0123', '514-555-0123', '555-0123', '1-800-555-0123', 'call 5145550123', 'tel: 5145550123', 'Téléphone 5145550123', '514.555.0123']) {
      expect(refused(mail({ text: `Your code will come soon. Questions? ${phone}` })), phone).toBe('none')
      expect(code(mail({ text: `Your code is 482913. Questions? ${phone}` })), phone).toBe('482913')
    }
  })

  it('a date or a year is not a code', () => {
    for (const date of ['2026-11-01', '01/11/2026', '11/01/2026', '01.11.2026', 'November 1, 2026', '20261101', '01112026', '2026']) {
      expect(refused(mail({ text: `This code request was made on ${date}.` })), date).toBe('none')
      expect(code(mail({ text: `Your code is 482913, requested on ${date}.` })), date).toBe('482913')
    }
    expect(code(mail({ text: 'Your code is 482913 at 12:30' }))).toBe('482913')
  })

  it('a price or a quantity is not a code', () => {
    for (const price of ['$1299', '1299$', '1299 $', '1,299.00 $', '1299.50', '€1299', 'CAD 1299', '1299 USD', '1299%', '1000 seconds', '5000 km']) {
      expect(refused(mail({ text: `Use this code to pay ${price} today.` })), price).toBe('none')
      expect(code(mail({ text: `Your code is 482913. Total ${price}` })), price).toBe('482913')
    }
  })

  it('another thing\'s number is not a code', () => {
    for (const other of ['Order #482913', 'Order number 482913', 'Invoice 482913', 'Facture 482913', 'Commande no 482913', 'Reference: 482913', 'Ticket 482913', 'Case 482913', 'Account 482913', 'Customer ID 482913', 'Numéro de dossier 482913']) expect(refused(mail({ text: `Your verification is done. ${other}` })), other).toBe('none')
    expect(code(mail({ text: 'Your order number 771122 is ready. Your verification code is 482913' }))).toBe('482913')
    expect(code(mail({ text: 'Your verification number 482913' }))).toBe('482913')
  })

  it('a code of something else is not a code to sign in with', () => {
    for (const other of ['Promo code 20OFF20', 'Use discount code 482913', 'Your code promo : 482913', 'Code postal H3B 2Y5', 'zip code 90210', 'area code 514', 'Error code 5001', 'code d\'erreur 5001', 'QR code 482913', 'Source code 1234']) expect(refused(mail({ text: other })), other).toBe('none')
  })

  it('what is in a link or an address is not a code', () => {
    expect(refused(mail({ text: 'Open https://shop.example/verify?code=482913 to verify.' }))).toBe('none')
    expect(refused(mail({ text: 'Open shop.example/verify/482913?code=1 to verify.' }))).toBe('none')
    expect(refused(mail({ html: '<a href="https://shop.example/v?code=482913">verify your code</a>' }))).toBe('none')
    expect(refused(mail({ text: 'Your code question goes to code482913@shop.example.' }))).toBe('none')
    expect(code(mail({ html: 'Your code is 482913 <a href="https://shop.example/v?token=771122">or click</a>' }))).toBe('482913')
    expect(code(mail({ text: 'Your code is 482913 <https://shop.example/v?token=771122>' }))).toBe('482913')
  })

  it('only the mail\'s own words: no attachment, nor a mail forwarded inside it', () => {
    const m = mail({ text: 'See the attachment.' })
    m.payload.parts.push({ mimeType: 'text/plain', filename: 'codes.txt', body: { data: b64('code 111111') } })
    m.payload.parts.push({ mimeType: 'message/rfc822', parts: [{ mimeType: 'text/plain', body: { data: b64('Your code is 222222') } }] })
    expect(refused(m)).toBe('none')
  })

  it('text in other digits, and numbers in character references, do not get past it', () => {
    expect(refused(mail({ text: 'code １２３４５６' }))).toBe('none')
    expect(refused(mail({ text: 'code ٤٨٢٩١٣' }))).toBe('none')
    expect(code(mail({ html: 'Your code is &#52;&#56;&#50;&#57;&#49;&#51;' }))).toBe('482913')
    expect(code(mail({ text: 'code 4​8​2​9​1​3' }))).toBe('482913')
  })

  it('the text of all its parts counts together', () => {
    const m = mail({ text: `code 482913 ${'x '.repeat(20000)}`, html: `<p>${'x '.repeat(20000)}</p>` })
    expect(refused(m)).toBe('none')
  })

  it('a code mail is short: an endless one is refused, and stays quick', () => {
    expect(refused(mail({ text: `code 482913 ${'x '.repeat(40000)}` }))).toBe('none')
    expect(refused(mail({ text: `code 482913 ${'a'.repeat(600 * 1024)}` }))).toBe('none')
    const started = Date.now()
    expect(code(mail({ text: `${'code 1234 a '.repeat(5000)}` }))).toBe('1234')
    refused(mail({ text: `${'1234 a '.repeat(9000)}` }))
    refused(mail({ html: `${'<div style="display:none">'.repeat(9000)}` }))
    refused(mail({ html: `${'<a '.repeat(20000)}` }))
    refused(mail({ html: `${'<!--'.repeat(20000)}` }))
    refused(mail({ html: `${'<!---->'.repeat(45000)}` }))
    refused(mail({ html: `${'<!-- x -->'.repeat(30000)}` }))
    refused(mail({ html: `${'<style></style>'.repeat(25000)}` }))
    refused(mail({ html: `${'<div style="display:none"></div>'.repeat(10000)}` }))
    refused(mail({ html: `<span style="${'a:b;'.repeat(90000)}">x</span>` }))
    refused(mail({ text: `${'9'.repeat(60000)}@` }))
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe('what is hidden in a mail', () => {
  const hidden = (style) => `<p>Your code is coming.</p><span style="${style}">Your code is 999999</span>`
  it('a code the mail keeps out of sight is not read', () => {
    for (const style of ['display:none', 'DISPLAY : NONE !important', 'display:/* x */none', 'visibility:hidden', 'opacity:0', 'opacity:0.0', 'font-size:0', 'font-size:0px', 'font-size:1px', 'font:0/0 a', 'mso-hide:all', 'color:transparent', 'color:rgba(0,0,0,0)', 'text-indent:-9999px', 'position:absolute;left:-5000px', 'max-height:0;overflow:hidden', 'height:0px;width:0;overflow:hidden', 'display&#58;none']) expect(refused(mail({ html: hidden(style) })), style).toBe('none')
    for (const tag of ['<span hidden>Your code is 999999</span>', '<span aria-hidden="true">Your code is 999999</span>', '<template>Your code is 999999</template>', '<noscript>Your code is 999999</noscript>', '<textarea>Your code is 999999</textarea>', '<title>Your code is 999999</title>', '<style>/* code 999999 */</style>', '<script>var code = 999999</script>', '<!-- Your code is 999999 -->', '<del>Your code is 999999</del>', '<div hidden><div>Your code is 999999</div></div>']) expect(refused(mail({ html: `<p>Hello</p>${tag}` })), tag).toBe('none')
  })

  it('a hidden decoy does not stop the visible code, and does not replace it', () => {
    expect(code(mail({ html: `<p>Your code is 482913</p>${hidden('display:none')}` }))).toBe('482913')
    expect(code(mail({ html: `<div style="display:none"><div>code 999999</div></div><p>Your code is 482913</p>` }))).toBe('482913')
    expect(code(mail({ html: `<span style='font-size:0'>code 111111</span> Your code is 482913 <span style=display:none>code 222222</span>` }))).toBe('482913')
    // The same code in the hidden preheader mail often has: fine too.
    expect(code(mail({ html: `<div style="display:none">Your code is 482913</div><p>Your code is 482913</p>` }))).toBe('482913')
  })

  it('a hidden block never closed hides the rest: less to read, never more', () => {
    expect(refused(mail({ html: '<div style="display:none">code 999999<p>Your code is 482913</p>' }))).toBe('none')
  })

  it('an attribute that only talks about hiding hides nothing', () => {
    expect(code(mail({ html: '<p title="display:none" data-style="display:none">Your code is 482913</p>' }))).toBe('482913')
    expect(code(mail({ html: '<p style="color:#333;font-size:14px;display:block">Your code is 482913</p>' }))).toBe('482913')
  })

  it('leaves what is shown as it is', () => {
    expect(visibleHtml('<p>a</p><b style="display:none">b</b><i>c</i>')).toBe('<p>a</p> <i>c</i>')
    expect(visibleHtml('if a < b')).toBe('if a < b')
  })
})

describe('a code only in the subject', () => {
  const on = (subject, over) => {
    const got = extractCode(mail({ subject, ...over }))
    expect(got.code).toBe('482913')
    return { got, purpose: codePurpose({ subject, around: got.around, url: 'https://bank.com/verify' }) }
  }
  it('what the body says still warns', () => {
    expect(on('Your code is 482913', { text: 'Confirm the transfer of funds to ACME Ltd.' }).purpose).toBe('payment')
    expect(on('Your code is 482913', { text: 'Hello,\nYou are sending $5,000 to ACME Ltd.' }).purpose).toBe('payment')
    expect(on('Your code is 482913', { text: 'Enter it to permanently delete your account.' }).purpose).toBe('closing')
    expect(on('Votre code est 482913', { html: '<p>Confirmez le virement à ACME.</p>' }).purpose).toBe('payment')
    expect(on('Your code is 482913', { text: 'Thanks for using Quill.' }).purpose).toBe(null)
  })
  it('and reaches the card, after the subject', () => {
    const { got } = on('Your code is 482913', { text: 'Hello,\nConfirm the transfer of funds to ACME Ltd.\nSign in to review.\nHelp | Privacy' })
    expect(got.context[0]).toBe('Your code is 482913')
    expect(got.context).toContain('Confirm the transfer of funds to ACME Ltd.')
    expect(got.context).not.toContain('Help | Privacy')
    expect(got.context.length).toBeLessThanOrEqual(4)
  })
  it('a code in one part: the words of the other count too', () => {
    const got = extractCode(mail({ text: 'Confirm the transfer of funds to ACME.', html: '<p>Your code is 482913</p>' }))
    expect(got.code).toBe('482913')
    expect(codePurpose({ subject: 'Hello', around: got.around, url: 'https://bank.com/verify' })).toBe('payment')
  })
})

describe('what anyone can send stays quick', () => {
  it('the same code on thousands of lines', () => {
    const started = Date.now()
    expect(extractCode(mail({ text: 'code\n1234\n'.repeat(6300) })).code).toBe('1234')
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('a mail that keeps its text in a size of nothing', () => {
  it('reads what is inside that sets the size again, as every MJML mail does', () => {
    const mjml = (inner) => `<div style="font-size:0"><div style="font-size:16px;line-height:1.5">${inner}</div></div>`
    expect(code(mail({ html: mjml('Your verification code is 482913') }))).toBe('482913')
    expect(code(mail({ html: `<td style="font-size:0px"><table><tr><td style="font:14px Arial">Your code is 482913</td></tr></table></td>` }))).toBe('482913')
    expect(code(mail({ html: `<div style="font-size:0"><span style="font-size:1.2em">Your code is 482913</span></div>` }))).toBe('482913')
  })
  it('and still not what stays in it', () => {
    expect(refused(mail({ html: '<div style="font-size:0">Your code is 999999</div><p>Hello</p>' }))).toBe('none')
    expect(refused(mail({ html: '<div style="font-size:1px">Your code is 999999</div>' }))).toBe('none')
    expect(refused(mail({ html: '<div style="font-size:0"><span style="font-size:0">Your code is 999999</span></div>' }))).toBe('none')
    expect(code(mail({ html: '<div style="font-size:0">Your code is 999999</div><p>Your code is 482913</p>' }))).toBe('482913')
  })
  it('stays quick', () => {
    const started = Date.now()
    refused(mail({ html: '<div style="font-size:0">'.repeat(9000) }))
    refused(mail({ html: `${'<div style="font-size:0">'.repeat(4000)}<p style="font-size:9px">x</p>` }))
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe('what a code may confirm stays quick on what anyone can send', () => {
  it('long lines of digits, words or sentences', () => {
    const started = Date.now()
    for (const line of ['1 '.repeat(30000), 'new '.repeat(15000), `new ${'a'.repeat(60000)}`, '$1 '.repeat(20000), 'change '.repeat(9000), 'a. '.repeat(20000)]) codePurpose({ subject: line, around: [line, line], url: 'https://bank.com/login' })
    hideNumbers('a'.repeat(2000000))
    shownMailLine('1 '.repeat(30000), '482913')
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe('what a code may confirm: words that add a warning, and nothing else', () => {
  const on = (path, over = {}) => codePurpose({ subject: 'Your verification code', around: ['Your verification code is 482913'], url: `https://bank.com${path}`, ...over })
  const ofMail = (subject, text, path = '/verify') => {
    const got = extractCode(mail({ subject, text }))
    expect(got.code, text).toBeTruthy()
    return codePurpose({ subject, around: got.around, url: `https://bank.com${path}` })
  }

  it('no such word: nothing, and no word ever says it is a sign-in', () => {
    expect(on('/verify')).toBe(null)
    expect(on('/login/verify')).toBe(null)
    expect(on('/sessions/verified-device')).toBe(null)
    expect(on('/verify', { subject: 'Your sign-in code' })).toBe(null)
    expect(on('/login', { subject: 'Your sign-in code', around: ['Use this code to sign in: 482913'] })).toBe(null)
    expect(on('/verify', { around: ['In order to continue, enter this code'] })).toBe(null)
  })

  it('the page\'s address says, whatever the mail\'s template', () => {
    expect(on('/devices/link?device=ATTACKER_TV')).toBe('device')
    expect(on('/oauth/authorize?client_id=attacker')).toBe('consent')
    expect(on('/account/recover?flow=ATTACKER_FLOW')).toBe('reset')
    expect(on('/settings/email?new=attacker@evil.example')).toBe('email')
    expect(on('/checkout/confirm?to=attacker')).toBe('payment')
    for (const path of ['/device', '/login/device', '/o/oauth2/device/usercode', '/common/oauth2/deviceauth', '/oauth20_remoteconnect.srf', '/activate', '/usercode', '/link']) expect(on(path), path).toBe('device')
  })

  it('words a query\'s values hold are not looked at: anyone writes those', () => {
    expect(on('/login?next=checkout')).toBe(null)
  })

  it('the mail\'s subject and any line say, in English and French', () => {
    for (const [subject, text, kind] of [
      ['Your security code', 'Use code 482913 to approve the transfer of $5,000 to ACME Ltd. If you did not request this, sign in to your account and contact us.', 'payment'],
      ['Withdrawal confirmation', 'Confirm your withdrawal of 0.5 BTC with this code: 482913\nLog in to review.', 'payment'],
      ['Your code', 'Your withdrawal verification code is 482913. Log in to your account to review your session.', 'payment'],
      ['Your verification code', 'Use the verification code 482913 to permanently delete your account. Log in to cancel.', 'closing'],
      ['Fermeture de votre compte', 'Entrez ce code pour fermer votre compte :\n482913\nConnexion requise pour annuler.', 'closing'],
      ['Your code', 'Your verification code to disable two-factor authentication is 482913.', 'protection'],
      ['New API key', 'Enter this code to create a new API key:\n482913\nSign in to see it.', 'consent'],
      ['New admin', 'Enter this code to add a new administrator:\n482913\nSign in to review.', 'consent'],
      ['Password change', 'Enter this code to change your password:\n482913\nSign in to review.', 'reset'],
      ['Changement de mot de passe', 'Entrez ce code pour modifier votre mot de passe :\n482913\nConnexion.', 'reset'],
      ['New payee', 'Enter this code to add a new payee:\n482913\nSign in to review.', 'payment'],
      ['Nouveau bénéficiaire', 'Entrez ce code pour ajouter un bénéficiaire :\n482913\nConnexion.', 'payment'],
      ['Virement Interac', 'Votre code :\n482913\nConnexion à AccèsD.', 'payment'],
      ['Raise your daily limit to $10,000', 'Enter this code:\n482913\nSign in to review.', 'payment'],
      ['Your verification code', 'A new API token was requested for your account.\nIt will have full access.\nWe need to check it is you.\nEnter this code:\n482913\nSign in to review.', 'consent'],
      ['Your verification code', 'Hello,\nWe received a request to send $5,000 to ACME Ltd from your account.\nFor your protection we need to check it is you.\nPlease enter the code:\n482913\nSign in | Help', 'payment'],
      // The review's list.
      ['Login code', 'Your login code is 482913. Use it to confirm your order.', 'payment'],
      ['Votre code de connexion', 'Nous devons confirmer votre commande de 3 articles.\nVotre code de connexion :\n482913', 'payment'],
      ['Your 2FA code', 'Confirm sending 0.5 BTC to bc1qxy.\nYour 2FA code:\n482913', 'payment'],
      ['Your code', 'To sell shares of ACME, your code is 482913', 'payment'],
      ['Your code', '3-D Secure check. Your code is 482913', 'payment'],
      ['Your code', 'Please confirm the sale of 100 shares of ACME.\nYour code:\n482913', 'payment'],
      ['Votre code', 'Confirmez la vente de 100 actions.\nVotre code :\n482913', 'payment'],
      ['Your code', 'Merchant: ACME Store\nCard ending in 4242\nYour code:\n482913', 'payment'],
      ['Votre code', 'Commerçant : ACME\nCarte se terminant par 4242\nVotre code :\n482913', 'payment'],
      ['Your code', 'Enter this code on your TV to sign in:\n482913', 'device'],
      ['Your code', 'Sign in on another device with this code:\n482913', 'device'],
      ['Votre code', 'Pour vous connecter sur un autre appareil, votre code est 482913', 'device'],
      ['Your code', 'A copy of all your data will be exported and sent to you.\nYour code:\n482913', 'consent'],
      ['Votre code', 'Une copie de toutes vos données sera exportée.\nVotre code :\n482913', 'consent'],
      ['Your code', 'To add a passkey, your code is 482913', 'consent'],
      ['Your code', 'To add a security key, your code is 482913', 'consent'],
      ['Your code', 'To add a phone number, your code is 482913', 'email'],
      ['Your code', 'To turn off alerts, your code is 482913', 'protection'],
      ['Your code', 'To trust this browser, your code is 482913', 'consent'],
      ['Your code', 'To export your data, your code is 482913', 'consent'],
      ['Your code', 'To reveal your secret key, your code is 482913', 'consent'],
      ['Your code', 'To delegate access, your code is 482913', 'consent'],
      ['Your code', 'To accept the invite, your code is 482913', 'consent'],
      ['Your code', 'To link your bank account, your code is 482913', 'payment'],
      ['Your code', 'To delete this repository, your code is 482913', 'closing'],
      ['Your code', 'To request a refund, your code is 482913', 'payment'],
      ['Votre code', 'Pour désactiver les alertes, votre code est 482913', 'protection'],
      ['Votre code', 'Pour obtenir un remboursement, votre code est 482913', 'payment']
    ])
      expect(ofMail(subject, text), text).toBe(kind)
  })

  it('amounts and such words count in "if you" sentences and menu lines too', () => {
    expect(ofMail('Your code', 'If you want to confirm the transfer of $5,000 to ACME, your code is 482913')).toBe('payment')
    expect(ofMail('Your code', 'If you want to confirm the transfer to ACME, your code is 482913')).toBe('payment')
    expect(ofMail('Your code', 'Your code is 482913\nPayment | $5,000 | ACME')).toBe('payment')
    expect(ofMail('Your code', 'Your code is 482913\nPayment | ACME | Help')).toBe('payment')
    // A mail's denial is the one thing that may name them without meaning them.
    expect(ofMail('Your code', 'Your code is 482913\nIf you did not ask for this, reset your password.')).toBe(null)
    expect(ofMail('Votre code', "Votre code est 482913\nSi vous n'avez pas fait cette demande, réinitialisez votre mot de passe.")).toBe(null)
    expect(ofMail('Your code', 'Your code is 482913. We will never ask you for a payment.')).toBe(null)
    // But not an amount, wherever it is.
    expect(ofMail('Your code', 'Your code is 482913\nIf you did not send $5,000, call us.')).toBe('payment')
  })
})

describe('what a card shows', () => {
  const URL_ = 'https://login.quillmarket.com/verify?next=https%3A%2F%2Fx&session=abc'
  const card = (over = {}) => {
    const m = mail({ from: 'no-reply@quillmarket.com', auth: AUTH_OK('quillmarket.com'), subject: 'Your code is 482913', text: 'Your code is 482913' })
    return mailCodeCard({ url: URL_, check: checkSender(m, 'login.quillmarket.com'), subject: 'Your code is 482913', arrivedAt: 12345, account: 'me@gmail.example', code: '482913', fieldLabel: 'Sign-in code', context: ['Your code is 482913'], ...over })
  }

  it('names the page with its path, the field, the button, the sender, the subject, the mail\'s words and the account', () => {
    const c = card()
    expect(c.match).toBe(true)
    expect(c.warnings).toEqual([])
    expect(c.site).toBe('quillmarket.com')
    expect(c.arrivedAt).toBe(12345)
    const all = c.lines.join('\n')
    // The path, and of what follows it only the names.
    expect(all).toContain('https://login.quillmarket.com/verify?next&session')
    expect(all).not.toContain('abc')
    expect(all).toContain('Field (words from the page, not from Tessel): Sign-in code')
    expect(all).toContain('Then Tessel presses: Enter')
    expect(all).toContain('no-reply@quillmarket.com')
    expect(all).toContain('words from outside')
    expect(all).toContain(`The mail says (its own words, numbers hidden): Your code is ${MASK}`)
    expect(all).not.toMatch(/speaks of signing|cannot tell/)
    expect(c.accountLine).toContain('me@gmail.example')
    expect(card({ buttonLabel: 'Verify' }).lines.join('\n')).toContain('Then Tessel presses (words from the page, not from Tessel): Verify')
    expect(card({ fieldLabel: '', isRow: true }).lines.join('\n')).toContain('Field: a row of boxes')
    expect(card({ fieldLabel: '' }).lines.join('\n')).toContain('marks as a one-time code')
    expect(card({ url: 'https://login.quillmarket.com:8443/' }).lines[0]).toContain('8443')
  })

  it('shows what a person would read in the mail: the code\'s line and up to three others, numbers hidden', () => {
    const got = extractCode(mail({ subject: 'Hello', text: 'Hello Bob,\nWe got a request from your account.\nIt came from a new place.\nUse this code:\n\n482913\n\nThis code expires in 10 minutes.\nIf you did not ask for this, ignore it.\nHelp | Privacy | Terms\nOrder 771122 was shipped.\nThanks!' }))
    expect(got.code).toBe('482913')
    expect(got.context).toEqual(['We got a request from your account.', 'It came from a new place.', 'Use this code:', '482913', 'Order 771122 was shipped.'].filter((line) => got.context.includes(line)))
    expect(got.context).toContain('482913')
    expect(got.context).toContain('Use this code:')
    expect(got.context).not.toContain('If you did not ask for this, ignore it.')
    expect(got.context).not.toContain('Help | Privacy | Terms')
    expect(got.context.length).toBeLessThanOrEqual(5)
    const line = card({ context: got.context }).lines.find((l) => l.startsWith('The mail says'))
    expect(line).not.toContain('482913')
    expect(line).toContain('Use this code')
  })

  it('warns of a formless button, and of an answer going elsewhere', () => {
    const c = card({ buttonLabel: 'Go', buttonFormless: true })
    expect(c.match).toBe(false)
    expect(c.warnings.join(' ')).toContain('no form around it')
    const m = mail({ from: 'no-reply@quillmarket.com', auth: AUTH_OK('quillmarket.com'), extraHeaders: [['Reply-To', 'x@evil-fern.com']] })
    expect(card({ check: checkSender(m, 'login.quillmarket.com') }).warnings.join(' ')).toContain('another domain')
  })

  it('never the code, wherever the mail wrote it', () => {
    const all = (c) => [...c.lines, ...c.warnings].join('\n')
    expect(all(card())).not.toMatch(/482\s*913/)
    for (const subject of ['482913', '482 913 is your code', 'Code: 482-913', 'Code 4​8​2​9​1​3', '&#52;&#56;&#50;&#57;&#49;&#51;', 'Your code 4 8 2 9 1 3']) expect(all(card({ subject })), subject).not.toMatch(/4\D{0,3}8\D{0,3}2\D{0,3}9\D{0,3}1\D{0,3}3/)
    // In the sender's address too.
    const m = mail({ from: 'otp-482913@quillmarket.com', auth: AUTH_OK('quillmarket.com') })
    expect(all(card({ check: checkSender(m, 'login.quillmarket.com') }))).not.toContain('482913')
    expect(all(card({ check: checkSender(m, 'login.quillmarket.com') }))).toContain(`otp-${MASK}@quillmarket.com`)
  })

  it('a subject: cut, on one line, its other numbers out', () => {
    expect(shownSubject(`${'x'.repeat(300)}`, '482913').length).toBeLessThanOrEqual(121)
    expect(shownSubject('a\r\nb‮c', '482913')).toBe('a bc')
    expect(shownSubject('Your order 771122 (2FA) A7K2QX', '482913')).toBe(`Your order ${MASK} (2FA) ${MASK}`)
    // An amount stays: it says what this is for.
    expect(shownSubject('Confirm your payment of $2,000.00 to ACME', '482913')).toBe('Confirm your payment of $2,000.00 to ACME')
    expect(shownSubject('Confirm transfer of 4999 CAD: 482913', '482913')).toBe(`Confirm transfer of 4999 CAD: ${MASK}`)
  })

  it('the mail\'s line: the code and every other number out, an amount kept', () => {
    expect(shownMailLine('Your code is 482913, order 771122', '482913')).toBe(`Your code is ${MASK}, order ${MASK}`)
    expect(shownMailLine('Confirm the transfer of $2,500.00 with 482913', '482913')).toBe(`Confirm the transfer of $2,500.00 with ${MASK}`)
    expect(shownMailLine('Paiement de 1 200,50 $ : 482913', '482913')).toBe(`Paiement de 1 200,50 $ : ${MASK}`)
    expect(shownMailLine('Send 300 CAD: 482 913', '482913')).toBe(`Send 300 CAD: ${MASK}`)
    expect(shownMailLine(`a\r\nb‮c ${'x'.repeat(300)}`, '482913').length).toBeLessThanOrEqual(161)
  })

  it('what the code may confirm is on it, first, and not a match; no such word says nothing', () => {
    for (const [purpose, words] of [['payment', 'payment'], ['device', 'device'], ['reset', 'recovering'], ['closing', 'closing'], ['protection', 'turning off'], ['consent', 'access'], ['email', 'email or a phone']]) {
      const c = card({ purpose })
      expect(c.match, purpose).toBe(false)
      expect(c.warnings[0], purpose).toContain(words)
    }
    expect(card({ purpose: null }).warnings).toEqual([])
    expect(card({ purpose: null }).match).toBe(true)
  })

  it('an address always shows whose it is, and its references are not read', () => {
    const line = (from) => card({ check: checkSender(mail({ from, auth: AUTH_OK('evil.example') }), 'login.quillmarket.com') }).lines.find((l) => l.startsWith('From:'))
    expect(line(`${'a'.repeat(300)}@evil.example`)).toContain('…@evil.example')
    expect(line('noreply&#64bank.com&#32aaaa@evil.example')).toContain('noreply&#64bank.com&#32aaaa@evil.example')
  })

  it('says plainly when they do not match, with both domains', () => {
    const m = mail({ from: 'alerts@larkspurbank.com', auth: AUTH_OK('larkspurbank.com') })
    const c = mailCodeCard({ url: 'https://www.evil-fern.com/', check: checkSender(m, 'www.evil-fern.com'), subject: 'x', arrivedAt: 1, account: 'me@gmail.example', code: '482913' })
    expect(c.match).toBe(false)
    expect(c.site).toBe('evil-fern.com')
    expect(c.warnings.join(' ')).toContain('larkspurbank.com')
    expect(c.warnings.join(' ')).toContain('evil-fern.com')
  })

  it('names the host of a customer\'s page, and an address that is someone else\'s', () => {
    const m = mail({ from: 'noreply@okta.com', auth: AUTH_OK('okta.com'), extraHeaders: [['To', 'other@gmail.com']] })
    const c = mailCodeCard({ url: 'https://dev-1.okta.com/', check: checkSender(m, 'dev-1.okta.com', 'me@gmail.com'), subject: 'x', arrivedAt: 1, account: 'me@gmail.com', code: '482913' })
    expect(c.warnings.join(' ')).toContain('dev-1.okta.com')
    expect(c.warnings.join(' ')).toContain('me@gmail.com')
  })

  it('says what a non-ASCII host really is', () => {
    const m = mail({ from: 'a@xn--bcher-kva.com', auth: AUTH_OK('xn--bcher-kva.com') })
    const c = mailCodeCard({ url: 'https://xn--bcher-kva.com/', check: checkSender(m, 'xn--bcher-kva.com'), subject: 'x', arrivedAt: 1, account: 'me@gmail.example', code: '482913' })
    expect(c.lines[0]).toContain('xn--bcher-kva.com')
    expect(c.lines[0]).toContain('bücher.com')
    expect(c.lines[0]).toContain('not plain ASCII')
    expect(c.lines.find((l) => l.startsWith('From:'))).toContain('not plain ASCII')
    expect(c.warnings.join(' ')).toContain('outside plain ASCII')
  })

  it('an unreadable From line has a card too', () => {
    const m = mail({ from: 'a@b.example, c@d.example' })
    const c = mailCodeCard({ url: 'https://quillmarket.com/', check: checkSender(m, 'quillmarket.com'), subject: 'x', arrivedAt: 1, account: 'me@gmail.example', code: '482913' })
    expect(c.lines.find((l) => l.startsWith('From:'))).toContain('could not be read')
    expect(c.warnings.join(' ')).toContain('From line')
  })
})

describe('scrubbing a text', () => {
  it('the code however it is written', () => {
    for (const text of ['482913', 'code 482913 ok', '482 913', '482-913', '4 8 2 9 1 3', '4-8-2-9-1-3', '482 - 913', '482/913', '482|913', '482,913', '482:913', '482​913', '４８２９１３', '%34%38%32%39%31%33', '4%2D8%2D2%2D9%2D1%2D3']) expect(scrubCode(text, '482913'), text).not.toMatch(/(?:4|４|%34)\D{0,9}(?:8|８|%38)/)
    expect(scrubCode('a7k2qx', 'A7K2QX')).toBe(MASK)
    expect(scrubCode('nothing here', '482913')).toBe('nothing here')
    expect(scrubCode('x', null)).toBe('x')
  })

  it('only the whole of it: a piece is said as it is', () => {
    for (const text of ['4', '48', '4829', '48291', '82913']) expect(scrubCode(text, '482913'), text).toBe(text)
  })

  it('says nothing of how long it was', () => {
    expect(scrubCode('1234', '1234')).toBe(scrubCode('1234567890', '1234567890'))
  })
})

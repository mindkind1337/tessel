// browser_fill_mail_code: the scripts Tessel runs in a page, on a real DOM, one case at a time.
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { BUTTON_FN, EMPTY_FN, FIELD_FN, FOCUS_FN, FORM_WATCH_FN, FORM_WATCH_OFF_FN, ROW_FN, TYPE_FN } from '../agentBrowserMailCode'

const ORIGIN = 'https://login.quillmarket.com'
function page(html, url = `${ORIGIN}/verify`) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url, runScripts: 'outside-only' })
  const proto = dom.window.HTMLElement.prototype
  proto.getClientRects = function () {
    if (this.hasAttribute('data-invisible')) return []
    return [{ width: Number(this.getAttribute('data-width')) || (this.maxLength === 1 ? 40 : 200), height: 30, top: Number(this.getAttribute('data-top')) || 10 }]
  }
  Object.defineProperty(proto, 'innerText', {
    get() {
      return this.textContent
    }
  })
  // (jsdom has no such command.) What a browser does: over the selection, at the focused field.
  dom.window.document.execCommand = (name, _ui, text) => {
    const el = dom.window.document.activeElement
    if (name !== 'insertText' || !el || !('value' in el)) return false
    el.setRangeText?.(text, el.selectionStart ?? 0, el.selectionEnd ?? 0, 'end')
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    return true
  }
  return {
    window: dom.window,
    document: dom.window.document,
    run: (fn, el, ...args) => dom.window.eval(`(${fn})`).apply(el, args)
  }
}
const info = (html, id = 'c', origin = ORIGIN) => {
  const p = page(html)
  return p.run(FIELD_FN, p.document.getElementById(id), origin)
}

describe('a field a code can go in', () => {
  it('takes the plain kinds of input', () => {
    for (const type of ['', 'type=text', 'type=tel', 'type=number', 'type=TEL', 'type=nonsense']) expect(info(`<input id=c ${type}>`).ok, type).toBe(true)
  })

  it('says what fits', () => {
    expect(info('<input id=c maxlength=6 type=tel>')).toMatchObject({ ok: true, maxLength: 6, type: 'tel', boxes: 0, sends: [] })
    expect(info('<input id=c>').maxLength).toBe(-1)
  })

  it('refuses every other kind', () => {
    for (const html of ['<input id=c type=password>', '<input id=c type=email>', '<input id=c type=url>', '<input id=c type=hidden>', '<input id=c type=submit>', '<input id=c type=file>', '<input id=c type=checkbox>', '<input id=c type=date>', '<textarea id=c></textarea>', '<select id=c></select>', '<div id=c></div>', '<button id=c></button>']) expect(info(html).ok, html).toBe(false)
  })

  it('refuses what a person could not use', () => {
    for (const html of ['<input id=c disabled>', '<input id=c readonly>', '<input id=c data-invisible>', '<input id=c data-width=0.5>', '<input id=c style="visibility:hidden">', '<input id=c style="display:none">', '<input id=c autocomplete="current-password">', '<input id=c autocomplete="username new-password">']) expect(info(html).ok, html).toBe(false)
    // Drawn over boxes of the page's own: invisible but usable, as some code fields are.
    expect(info('<input id=c style="opacity:0">').ok).toBe(true)
  })

  it('refuses another origin, and a page that is not https', () => {
    expect(info('<input id=c>', 'c', 'https://evil-fern.com')).toEqual({ ok: false, why: 'origin' })
    const p = page('<input id=c>', 'http://login.quillmarket.com/')
    expect(p.run(FIELD_FN, p.document.getElementById('c'), 'http://login.quillmarket.com')).toEqual({ ok: false, why: 'origin' })
  })

  it('refuses a field no longer in the page', () => {
    const p = page('<input id=c>')
    const el = p.document.getElementById('c')
    el.remove()
    expect(p.run(FIELD_FN, el, ORIGIN)).toEqual({ ok: false, why: 'field' })
  })

  it('refuses a field of another document', () => {
    const p = page('<input id=c>')
    const other = p.document.implementation.createHTMLDocument('x')
    other.body.innerHTML = '<input id=c>'
    expect(p.run(FIELD_FN, other.getElementById('c'), ORIGIN)).toEqual({ ok: false, why: 'field' })
  })

  it('says where its form sends, by the attribute, whatever an input names itself', () => {
    expect(info('<form><input id=c></form>').sends).toEqual([ORIGIN])
    expect(info('<form action="/check"><input id=c></form>').sends).toEqual([ORIGIN])
    expect(info('<form action="https://evil-fern.com/take"><input id=c></form>').sends).toEqual(['https://evil-fern.com'])
    expect(info('<form action="https://evil-fern.com/take"><input id=c><input name=action value="/check"></form>').sends).toContain('https://evil-fern.com')
    expect(info('<form action="javascript:void(0)"><input id=c></form>').sends).toEqual([null])
  })

  it('a relative action goes where a base element says, and a form with no action to the page', () => {
    const base = (form) => {
      const p = page(`<base href="https://evil-fern.com/">${form}`)
      return p.run(FIELD_FN, p.document.getElementById('c'), ORIGIN).sends
    }
    expect(base('<form action="/take"><input id=c></form>')).toEqual(['https://evil-fern.com'])
    expect(base('<form><input id=c></form>')).toEqual([ORIGIN])
  })

  it('an image button counts: Enter presses it though form.elements leaves it out', () => {
    expect(info('<form action="/check"><input id=c><input type=image src=x formaction="https://evil-fern.com/take"></form>').sends).toEqual([ORIGIN, 'https://evil-fern.com'])
    expect(info('<form id=f action="/check"><input id=c></form><input type=image form=f src=x formaction="https://evil-fern.com/take">').sends).toEqual([ORIGIN, 'https://evil-fern.com'])
    expect(info('<form id=f action="/check"><input id=c></form><form id=g><input type=image src=x formaction="https://evil-fern.com/take"></form>').sends).toEqual([ORIGIN])
    expect(info('<form action="/check"><input id=c name=code><input type=image src=x formmethod=get></form>')).toEqual({ ok: false, why: 'search' })
  })

  it('a button of the form that sends elsewhere counts', () => {
    expect(info('<form action="/check"><input id=c><button formaction="https://evil-fern.com/take">Go</button></form>').sends).toEqual([ORIGIN, 'https://evil-fern.com'])
  })
})

describe('a field made for a code', () => {
  const like = (html, id = 'c') => info(html, id).codeLike

  it('the page marks it, or labels it, in English or French', () => {
    for (const html of [
      '<input id=c autocomplete=one-time-code>',
      '<input id=c name=otp>',
      '<input id=c autocomplete=off name=otp>',
      '<input id=c name=verificationCode>',
      '<input id=c name=mfa_token_code>',
      '<input id=c name=mfaCode>',
      '<input id=c name=otc aria-label="Code">',
      '<input id=c name=code>',
      '<input id=c placeholder="Enter the code">',
      '<input id=c aria-label="Code de vérification">',
      '<input id=c placeholder="Saisissez votre NIP">',
      '<input id=c placeholder="Your PIN">',
      '<label for=c>Code</label><input id=c>',
      '<label for=c>Verification code</label><input id=c>',
      '<label for=c>Code à usage unique</label><input id=c>',
      '<label for=c>Sign-in code</label><input id=c>',
      '<label for=c>Passcode</label><input id=c>',
      '<label for=c>NIP</label><input id=c>',
      '<label for=c>Mot de passe temporaire</label><input id=c>',
      '<label for=c>6-digit number</label><input id=c name=challenge>',
      '<label for=c>Security code</label><input id=c>',
      '<label for=c>Entrer le code</label><input id=c>',
      '<label for=c>Saisir le code</label><input id=c>',
      '<label for=c>Jeton</label><input id=c>',
      '<label for=c>Token</label><input id=c>',
      '<label for=c>Ton code</label><input id=c>',
      '<label for=c>Verification</label><input id=c>',
      '<label for=c>Code de sécurité reçu par courriel</label><input id=c>',
      '<input id=c placeholder="XXXXXX">',
      '<label>Authentication code <input id=c></label>',
      '<span id=l>One-time passcode</span><input id=c aria-labelledby=l>',
      '<input id=c placeholder="Enter the code sent to your email">',
      '<input id=c name=token aria-label="Enter the 6-digit code">',
      // "card" and "area" as words of a sentence about a code.
      '<label for=c>Enter the code we sent to your card holder address</label><input id=c>',
      '<label for=c>Enter the code sent to your email area</label><input id=c>',
      // A number for a placeholder.
      '<input id=c name=token placeholder="123456">',
      '<input id=c placeholder="000 000">',
      // The only field, made for a number or a set length, beside words saying what it is for.
      '<p>Enter the code we sent you</p><input id=c name=token>',
      '<p>Enter the code we sent you</p><input id=c name=answer maxlength=6>',
      '<p>Enter the code we sent you</p><input id=c name=answer type=number>',
      '<p>We sent a code to j***@gmail.com</p><input id=c name=x1 maxlength=6>',
      '<form><p>Entrez le code reçu par courriel</p><input id=c name=x1 inputmode=numeric><button>OK</button></form>'
    ])
      expect(like(html), html).toBe(true)
    expect(like(`<div>${[0, 1, 2, 3, 4, 5].map((i) => `<input id=b${i} maxlength=1>`).join('')}</div>`, 'b0')).toBe(true)
  })

  it('never a field for something else, whatever word for a code it holds', () => {
    for (const html of [
      '<input id=c>',
      '<input id=c name=q>',
      '<input id=c name=title placeholder="Title">',
      '<input id=c name=display_name>',
      '<input id=c name=note>',
      '<label for=c>Issue title (code review)</label><input id=c name=title>',
      '<input id=c name=t placeholder="Bug in code">',
      '<input id=c aria-label="Comment on this code" name=comment>',
      '<input id=c placeholder="Add a comment about the verification" name=c1>',
      '<label for=c>Postcode</label><input id=c name=postcode>',
      '<label for=c>Post code</label><input id=c name=post_code>',
      '<label for=c>Security code (3 digits on the back)</label><input id=c name=cvnum maxlength=4>',
      '<label for=c>Sort code</label><input id=c name=sort>',
      '<label for=c>SWIFT code</label><input id=c>',
      '<label for=c>Tax code</label><input id=c>',
      '<label for=c>Offer code</label><input id=c>',
      '<label for=c>Reference code</label><input id=c>',
      '<label for=c>Employee code</label><input id=c>',
      '<label for=c>Product code</label><input id=c>',
      '<label for=c>Source code URL</label><input id=c>',
      '<label for=c>Code name</label><input id=c>',
      '<input id=c placeholder="Find code" name=q1>',
      '<input id=c placeholder="Filter code" name=q1>',
      '<label for=c>Email confirmation</label><input id=c name=email_confirmation>',
      '<input id=c name=password_confirmation placeholder="Confirm password">',
      '<label for=c>Verify your email</label><input id=c name=verify_email>',
      '<label for=c>Verified buyer name</label><input id=c>',
      '<input id=c name=authenticity_note>',
      '<input id=c placeholder="Promo code">',
      '<input id=c name=coupon_code>',
      '<input id=c name=zipcode>',
      '<input id=c placeholder="Postal code">',
      '<input id=c placeholder="Code postal">',
      '<input id=c placeholder="Search code">',
      '<input id=c name=invite_code>',
      '<input id=c placeholder="Card security code">',
      '<input id=c autocomplete=cc-csc name=code>',
      '<input id=c placeholder="Country code">',
      '<input id=c placeholder="Code rabais">',
      '<label for=c>Gift card code</label><input id=c>',
      '<label for=c>Area code</label><input id=c>',
      // A number for a placeholder that says what else it is.
      '<input id=c name=phone placeholder="5145550">',
      '<input id=c name=zip placeholder="12345">',
      // A page's own autocomplete, or a row of boxes, does not say more than its words.
      '<input id=c autocomplete=one-time-code aria-label="Comment">',
      '<label for=c>Promo code</label><input id=c autocomplete=one-time-code>',
      `<label for=c>Coupon</label><input id=c maxlength=1 name=coupon0>${'<input maxlength=1>'.repeat(5)}`,
      `<input id=c maxlength=1 aria-label="Letter 1 of your guess">${'<input maxlength=1>'.repeat(5)}`,
      // What a person sets, and hands out.
      '<label for=c>Access code for your guests</label><input id=c>',
      '<label for=c>Passcode for this meeting</label><input id=c>',
      '<label for=c>Set a passcode for the shared link</label><input id=c>',
      '<label for=c>Temporary password for the new user</label><input id=c>',
      '<label for=c>Enter code</label><input id=c name=redeem>',
      '<input id=c aria-label="Code" name=sku placeholder="Code">',
      // A placeholder does not speak for a field with a label.
      '<label for=c>Your name</label><input id=c name=x1 placeholder="Enter the code">',
      '<label for=c>Your age</label><input id=c name=x1 placeholder="123456">',
      // A card's form.
      '<form><label for=c>Security code</label><input id=c><input autocomplete=cc-number></form>',
      '<form><label for=c>Code</label><input id=c><input name=cardNumber></form>',
      '<input id=c name=cvv2 placeholder="Code">',
      '<form><input id=c autocomplete=one-time-code><input name=cvv></form>',
      // Beside such words, but not made for a number or a length, or saying what else it is.
      '<p>Enter the code we sent you</p><input id=c name=answer>',
      '<p>Enter the code we sent you</p><input id=c name=email maxlength=6>',
      '<p>Enter the code we sent you</p><input id=c name=user maxlength=6>',
      '<p>Enter the code we sent you</p><input id=c name=reply maxlength=6>',
      '<p>Enter the code we sent you</p><input id=c name=body maxlength=6>',
      '<p>Enter the code we sent you</p><input id=c name=text maxlength=6>',
      '<p>Enter the code we sent you</p><input id=c name=token2 maxlength=6><input name=other>',
      '<p>Enter the code we sent you</p><input id=c name=title maxlength=6>',
      '<p>Enter the code we sent you</p><input id=c name=q maxlength=6>',
      // Narrow inputs in a row are not boxes.
      `<div>${Array.from({ length: 6 }, (_, i) => `<input ${i ? '' : 'id=c'} name=qty${i} data-width=60>`).join('')}</div>`,
      `<div>${Array.from({ length: 4 }, (_, i) => `<input ${i ? '' : 'id=c'} name=cc${i} maxlength=4 data-width=60 placeholder="Card">`).join('')}</div>`
    ])
      expect(like(html), html).toBe(false)
  })

  it('never a search box, however it is labelled', () => {
    for (const html of ['<input id=c type=search autocomplete=one-time-code>', '<form role=search><input id=c name=code></form>', '<div role=search><input id=c name=code></div>', '<search><input id=c name=code></search>', '<form method=get><input id=c name=code></form>', '<form method=GET><input id=c name=code></form>', '<form><input id=c name=code><button formmethod=get>Go</button></form>']) {
      const got = info(html)
      expect(got.ok, html).toBe(false)
    }
    expect(info('<form method=get><input id=c name=code></form>').why).toBe('search')
    // A form that says nothing about its method: most sites' own scripts take those.
    expect(info('<form><input id=c name=code></form>').ok).toBe(true)
  })

  it('says what its label is, for the card', () => {
    expect(info('<label for=c>Sign-in code</label><input id=c>').label).toBe('Sign-in code')
    expect(info('<input id=c aria-label="Code">').label).toBe('Code')
    expect(info('<input id=c placeholder="Code">').label).toBe('Code')
    expect(info('<input id=c name=otp>').label).toBe('otp')
    expect(info('<div><input id=b0 maxlength=1><input maxlength=1><input maxlength=1><input maxlength=1></div>', 'b0').label).toBe('')
  })
})

describe('the button the agent names', () => {
  const button = (html, id = 'go', origin = ORIGIN) => {
    const p = page(html)
    return p.run(BUTTON_FN, p.document.getElementById(id), origin, p.document.getElementById('c'))
  }

  it('with a form, only a submit control of that form', () => {
    expect(button('<form><input id=c><button id=go>Verify</button></form>')).toEqual({ ok: true, sends: [], label: 'Verify', formless: false })
    expect(button('<form><input id=c><input id=go type=submit value=Send></form>')).toMatchObject({ ok: true, label: 'Send', formless: false })
    expect(button('<form><input id=c><input id=go type=image alt=x></form>').ok).toBe(true)
    expect(button('<form id=f><input id=c></form><button id=go form=f>Out of it, of it</button>').ok).toBe(true)
    expect(button('<form><input id=c><button id=go formaction="https://evil-fern.com/take">Go</button></form>').sends).toEqual(['https://evil-fern.com'])
    for (const html of [
      '<form><input id=c></form><button id=go>Delete my account</button>',
      '<form><input id=c></form><a id=go href="/logout">Out</a>',
      '<form><input id=c><a id=go href="/logout" role=button>Out</a></form>',
      '<form><input id=c><button id=go type=button>Other</button></form>',
      '<form><input id=c><button id=go type=reset>Clear</button></form>',
      '<form><input id=c><div id=go role=button>Div</div></form>',
      '<form><input id=c></form><form><button id=go>Other form</button></form>',
      '<form><input id=c><button id=go disabled>Go</button></form>',
      '<form><input id=c><button id=go data-invisible>Go</button></form>',
      '<form><input id=c><button id=go formmethod=get>Go</button></form>'
    ])
      expect(button(html).ok, html).toBe(false)
    expect(button('<form><input id=c><button id=go>Go</button></form>', 'go', 'https://evil-fern.com').ok).toBe(false)
  })

  it('with none, a button of the page that is in no other form and goes to no address, said to be so', () => {
    expect(button('<input id=c><button id=go>Continue</button>')).toMatchObject({ ok: true, formless: true })
    expect(button('<input id=c><div id=go role=button>Continue</div>')).toMatchObject({ ok: true, formless: true })
    expect(button('<input id=c><a id=go href="#" role=button>Continue</a>')).toMatchObject({ ok: true, formless: true })
    for (const html of [
      '<input id=c><a id=go href="/next">Go on</a>',
      '<input id=c><a id=go href="/next" role=button>Go on</a>',
      '<input id=c><a id=go href="https://evil-fern.com/take">Go</a>',
      '<input id=c><form><button id=go>In another form</button></form>',
      '<input id=c><button id=go type=reset>Clear</button>',
      '<input id=c><p id=go>Text</p>',
      '<input id=c><input id=go type=text>'
    ])
      expect(button(html).ok, html).toBe(false)
  })
})

describe('a row of boxes', () => {
  const boxes = (n, extra = 'maxlength=1') => Array.from({ length: n }, (_, i) => `<input id=b${i} ${extra}>`).join('')
  const row = (html, id = 'b0') => {
    const p = page(html)
    const list = p.run(ROW_FN, p.document.getElementById(id))
    return list.map((e) => e.id)
  }

  it('is four or more boxes close together, from any of them', () => {
    expect(row(`<div>${boxes(6)}</div>`)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5'])
    expect(row(`<div>${boxes(6)}</div>`, 'b3')).toHaveLength(6)
    expect(row(`<div>${boxes(4)}</div>`)).toHaveLength(4)
    expect(info(`<div>${boxes(6)}</div>`, 'b0').boxes).toBe(6)
  })

  it('finds boxes each in a wrapper of its own', () => {
    const wrapped = Array.from({ length: 6 }, (_, i) => `<div><span><input id=b${i} maxlength=1></span></div>`).join('')
    expect(row(`<form>${wrapped}</form>`)).toHaveLength(6)
  })

  it('knows a box by a limit of one, or a size of one: never only by how narrow it is', () => {
    expect(row(`<div>${boxes(6, 'size=1')}</div>`)).toHaveLength(6)
    expect(row(`<div>${boxes(6, 'data-width=40')}</div>`)).toEqual([])
    expect(row(`<div>${boxes(6, 'maxlength=2')}</div>`)).toEqual([])
    expect(row(`<div>${boxes(6, 'data-width=200')}</div>`)).toEqual([])
    expect(row(`<div>${boxes(6, 'maxlength=6 size=1')}</div>`)).toEqual([])
  })

  it('is not three boxes, nor a lone narrow field', () => {
    expect(row(`<div>${boxes(3)}</div>`)).toEqual([])
    expect(row('<input id=b0 size=1>')).toEqual([])
  })

  it('stays one row when a narrow pane wraps it', () => {
    const wrapped = `<div><input id=b0 maxlength=1><input maxlength=1><input maxlength=1><input maxlength=1 data-top=200><input maxlength=1 data-top=200><input maxlength=1 data-top=200></div>`
    expect(row(wrapped)).toHaveLength(6)
  })

  it('the nearest group: another row further out is not counted', () => {
    const two = `<form><div>${boxes(6)}</div><div>${Array.from({ length: 6 }, () => '<input maxlength=1>').join('')}</div></form>`
    expect(row(two)).toHaveLength(6)
  })

  it('leaves out what is not a box: an email field, a box turned off', () => {
    expect(row(`<form><input id=e type=email data-width=40>${boxes(4)}<input maxlength=1 disabled></form>`)).toHaveLength(4)
  })
})

describe('typing one box', () => {
  it('in this page, on this field, over what it held, and no form brings it back', () => {
    const p = page('<input id=c value="old" autocomplete=one-time-code>')
    const el = p.document.getElementById('c')
    expect(p.run(TYPE_FN, el, ORIGIN, '482913')).toEqual({ ok: true, inserted: true })
    expect(el.value).toBe('482913')
    expect(el.getAttribute('autocomplete')).toBe('off')
    expect(p.document.activeElement).toBe(el)
  })

  it('leaves the field empty when the page is left', () => {
    const p = page('<input id=c>')
    const el = p.document.getElementById('c')
    p.run(TYPE_FN, el, ORIGIN, '482913')
    p.window.dispatchEvent(new p.window.Event('pagehide'))
    expect(el.value).toBe('')
  })

  it('types nothing on another origin, in a field gone, or when the keyboard does not stay there', () => {
    const p = page('<input id=c><input id=d>')
    const el = p.document.getElementById('c')
    expect(p.run(TYPE_FN, el, 'https://evil-fern.com', '482913')).toEqual({ ok: false, why: 'origin' })
    el.addEventListener('focus', () => p.document.getElementById('d').focus())
    expect(p.run(TYPE_FN, el, ORIGIN, '482913')).toEqual({ ok: false, why: 'focus' })
    expect(p.document.getElementById('d').value).toBe('')
    expect(el.value).toBe('')
    el.remove()
    expect(p.run(TYPE_FN, el, ORIGIN, '482913')).toEqual({ ok: false, why: 'origin' })
  })
})

describe('around the typing', () => {
  it('the keyboard back on the field', () => {
    const p = page('<input id=c><input id=d>')
    const el = p.document.getElementById('c')
    p.document.getElementById('d').focus()
    expect(p.run(FOCUS_FN, el, ORIGIN)).toBe(true)
    expect(p.document.activeElement).toBe(el)
    expect(p.run(FOCUS_FN, el, 'https://evil-fern.com')).toBe(false)
  })

  it('emptied by the element itself, whatever it holds, as a person typing would', () => {
    const p = page('<input id=c value="482x913">')
    const el = p.document.getElementById('c')
    let heard = 0
    el.addEventListener('input', () => heard++)
    expect(p.run(EMPTY_FN, el)).toBe(true)
    expect(el.value).toBe('')
    expect(heard).toBe(1)
  })

  it('its type goes to hidden and back, which is what ends the undo history, and nothing else changes', () => {
    for (const [html, type] of [['<input id=c type=tel>', 'tel'], ['<input id=c type=number>', 'number'], ['<input id=c>', null]]) {
      const p = page(html)
      const el = p.document.getElementById('c')
      el.value = type === 'number' ? '482913' : '482x913'
      el.focus()
      const seen = []
      const real = p.window.Element.prototype.setAttribute
      p.window.Element.prototype.setAttribute = function (name, value) {
        if (name === 'type') seen.push(value)
        return real.call(this, name, value)
      }
      p.run(EMPTY_FN, el)
      p.window.Element.prototype.setAttribute = real
      expect(seen[0], html).toBe('hidden')
      expect(el.getAttribute('type'), html).toBe(type)
      expect(el.value, html).toBe('')
      // The keyboard stays where it was.
      expect(p.document.activeElement, html).toBe(el)
    }
    // Not on the keyboard: it does not take it.
    const p = page('<input id=c><input id=d>')
    p.document.getElementById('d').focus()
    p.run(EMPTY_FN, p.document.getElementById('c'))
    expect(p.document.activeElement.id).toBe('d')
  })

  it('leaving the page empties it the same way', () => {
    const p = page('<input id=c type=tel>')
    const el = p.document.getElementById('c')
    p.run(TYPE_FN, el, ORIGIN, '482913')
    const seen = []
    const real = p.window.Element.prototype.setAttribute
    p.window.Element.prototype.setAttribute = function (name, value) {
      if (name === 'type') seen.push(value)
      return real.call(this, name, value)
    }
    p.window.dispatchEvent(new p.window.Event('pagehide'))
    p.window.Element.prototype.setAttribute = real
    expect(seen).toEqual(['hidden', 'tel'])
    expect(el.value).toBe('')
  })

  it('a field Tessel filled before still counts as one for a code, its autocomplete now off', () => {
    const p = page('<input id=c autocomplete=one-time-code>')
    const el = p.document.getElementById('c')
    p.run(TYPE_FN, el, ORIGIN, '482913')
    expect(el.getAttribute('autocomplete')).toBe('off')
    expect(p.run(FIELD_FN, el, ORIGIN).codeLike).toBe(true)
  })

  const submitting = (html, handler = null) => {
    const p = page(html)
    const form = p.document.querySelector('form')
    if (handler) form.addEventListener('submit', handler)
    p.run(FORM_WATCH_FN, p.document.getElementById('c'), 60000)
    const event = new p.window.Event('submit', { bubbles: true, cancelable: true })
    form.dispatchEvent(event)
    return { stopped: event.defaultPrevented, sent: p.window.__tesselFormSent }
  }
  it('what the person submits later is theirs: the hold ends with the action, or at its time', () => {
    const p = page('<form><input id=c name=code></form>')
    const form = p.document.querySelector('form')
    const send = () => {
      const event = new p.window.Event('submit', { bubbles: true, cancelable: true })
      form.dispatchEvent(event)
      return event.defaultPrevented
    }
    p.run(FORM_WATCH_FN, p.document.getElementById('c'), 60000)
    expect(send()).toBe(true)
    p.run(FORM_WATCH_OFF_FN, p.document.getElementById('c'))
    expect(send()).toBe(false)
    p.run(FORM_WATCH_FN, p.document.getElementById('c'), -1)
    expect(send()).toBe(false)
  })
  it('a form that would put it in the address does not go, and does not count as sent', () => {
    expect(submitting('<form><input id=c name=code></form>')).toEqual({ stopped: true, sent: false })
    expect(submitting('<form method=nonsense><input id=c name=code></form>')).toEqual({ stopped: true, sent: false })
  })
  it('a submitter\'s formmethod counts as soon as it is there, as Chromium reads it (real Chromium: an empty one is GET, and nothing is trimmed)', () => {
    const go = (html) => {
      const p = page(html)
      const form = p.document.querySelector('form')
      p.run(FORM_WATCH_FN, p.document.getElementById('c'), 60000)
      const event = new p.window.Event('submit', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'submitter', { value: p.document.querySelector('button') })
      form.dispatchEvent(event)
      return { stopped: event.defaultPrevented, sent: p.window.__tesselFormSent }
    }
    const held = { stopped: true, sent: false }
    const goes = { stopped: false, sent: true }
    expect(go('<form method=post><input id=c><button formmethod="">Go</button></form>')).toEqual(held)
    expect(go('<form method=post><input id=c><button formmethod=" post ">Go</button></form>')).toEqual(held)
    expect(go('<form method=post><input id=c><button formmethod=nonsense>Go</button></form>')).toEqual(held)
    expect(go('<form method=" post "><input id=c><button>Go</button></form>')).toEqual(held)
    expect(go('<form method=post><input id=c><button>Go</button></form>')).toEqual(goes)
    expect(go('<form><input id=c><button formmethod=POST>Go</button></form>')).toEqual(goes)
    expect(go('<form><input id=c><button formmethod=dialog>Go</button></form>')).toEqual(goes)
  })
  it('a form that sends it in its body goes and counts, and one the page\'s script takes is the page\'s', () => {
    expect(submitting('<form method=post><input id=c name=code></form>')).toEqual({ stopped: false, sent: true })
    expect(submitting('<form method=dialog><input id=c name=code></form>')).toEqual({ stopped: false, sent: true })
    let ran = false
    const taken = submitting('<form><input id=c name=code></form>', (e) => {
      ran = true
      e.preventDefault()
    })
    expect(ran).toBe(true)
    expect(taken).toEqual({ stopped: true, sent: true })
  })
})

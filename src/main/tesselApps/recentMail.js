// browser_fill_mail_code: the newest mail of the last minutes, read by Tessel for itself with the
// person's own token. It never goes to an agent, nor through tessel_apps' tool table, which an
// agent can name. A failure says what kind it is, and none of what Gmail said.
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const CALL_MS = 15 * 1000
const WITH_SENDER = 5

const failed = (code) => Object.assign(new Error(code), { code })

export function createRecentMail({ connections, fetchFn = fetch, now = () => Date.now() }) {
  async function call(account, url) {
    const got = await connections.access('google', account)
    const ask = (token) => fetchFn(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(CALL_MS) })
    let res
    try {
      res = await ask(got.token)
      if (res.status === 401) res = await ask(await got.refreshed())
    } catch (err) {
      if (err && err.code) throw err
      throw failed('offline')
    }
    if (!res.ok) throw failed(res.status === 403 ? 'forbidden' : res.status === 429 ? 'rate_limited' : 'failed')
    return res.json()
  }

  return {
    // The connected accounts, by address.
    accounts: () => connections.list().filter((c) => c.service === 'google').map((c) => c.account),
    // One account's newest mail in the last windowMs (Gmail's own message, format=full), or null.
    // What the person received: not what they sent, nor spam or trash, which Gmail leaves out.
    // sender: an address or domain, already checked to be one word. fits(message): with a sender, the
    // newest of the last few that really is from it (Gmail's search also takes display names).
    async newest(account, { windowMs, sender = null, fits = null }) {
      const since = Math.floor((now() - windowMs) / 1000)
      const q = [`after:${since}`, '-in:sent', '-in:drafts', ...(sender ? [`from:${sender}`] : [])].join(' ')
      const found = await call(account, `${GMAIL}/messages?${new URLSearchParams({ q, maxResults: sender ? String(WITH_SENDER) : '1' })}`)
      const list = Array.isArray(found.messages) ? found.messages : []
      for (const { id } of list) {
        const message = await call(account, `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`)
        if (!fits || fits(message)) return message
      }
      return null
    }
  }
}

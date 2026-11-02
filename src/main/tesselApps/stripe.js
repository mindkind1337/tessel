import { bad, count, createCall, cut, pathId, query, text } from './shared'

// tessel_apps: Stripe, read only, and only GET: the app's permissions are all *_read, so its token can
// neither move money nor change anything, and there is no tool that asks it to. One fixed host.
const API = 'https://api.stripe.com/v1'
// What can be listed and read, each with the permission the app asks for (the manifest is in
// tessel-server: connect-apps/stripe/stripe-app.json): customer_read, charge_read, invoice_read,
// subscription_read, payment_intent_read, product_read, plan_read, payout_read, dispute_read. Only
// these words reach an address.
const KINDS = new Set(['customers', 'charges', 'invoices', 'subscriptions', 'payment_intents', 'products', 'prices', 'payouts', 'disputes'])
const BY_CUSTOMER = new Set(['charges', 'invoices', 'subscriptions', 'payment_intents'])
const kindOf = (args) => {
  const kind = text(args.kind, 'kind', { required: true, max: 40 })
  if (!KINDS.has(kind)) throw bad(`"kind" is one of: ${[...KINDS].join(', ')}.`)
  return kind
}
// What must not reach an agent even in the account's own data: what confirms a payment, and links
// that open an invoice, a receipt or a payment page to anyone who has them, with no sign-in.
const NEVER_SHOWN = new Set(['client_secret', 'secret', 'hosted_invoice_url', 'invoice_pdf', 'receipt_url', 'hosted_voucher_url', 'next_action', 'url_token'])
const OPEN_PAGE = /^https?:\/\/(?:[a-z0-9-]+\.)*stripe\.com\//i
const withoutSecrets = (key, value) => (NEVER_SHOWN.has(key) || (typeof value === 'string' && (OPEN_PAGE.test(value) || value.includes('_secret_'))) ? undefined : value)
const shown = (value) => cut(JSON.stringify(value, withoutSecrets, 1))

export function createStripeTools({ connections, fetchFn = fetch }) {
  const call = createCall({ connections, provider: 'stripe', name: 'Stripe', hosts: ['api.stripe.com'], fetchFn })
  return {
    stripe_list: {
      service: 'stripe',
      async run(args) {
        const kind = kindOf(args)
        const found = await call(args.account, `${API}/${kind}?${query({ limit: count(args.max, 10, 100), customer: BY_CUSTOMER.has(kind) ? text(args.customer, 'customer', { max: 200 }) : undefined, email: kind === 'customers' ? text(args.email, 'email', { max: 320 }) : undefined })}`)
        const items = found.data || []
        return items.length ? `${items.map(shown).join('\n\n')}${found.has_more ? '\n\n[there are more: ask for a narrower list]' : ''}` : 'Nothing found.'
      }
    },
    stripe_read: {
      service: 'stripe',
      async run(args) {
        return shown(await call(args.account, `${API}/${kindOf(args)}/${pathId(args.id, 'id')}`))
      }
    },
    stripe_balance: {
      service: 'stripe',
      async run(args) {
        // The balance of the account itself: balance_read.
        return shown(await call(args.account, `${API}/balance`))
      }
    }
  }
}

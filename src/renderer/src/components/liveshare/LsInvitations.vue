<script setup>
// Live Share: the invitations of this share, one row each (main's access
// model; LiveShareDialog's context runs the calls). A row says what it is
// called, whether it lets people in (Live, Used up, Blocked; No expiry said
// too), when it stops, how often it was used and how many came in with it,
// what it offers (one chip), and copies its code (not while it lets no one
// in). Opened: the code (shortened; the whole of it in its tooltip and on
// the clipboard) and a message with it, what it offers, why it is blocked or
// used up, and Edit, New code (same label, projects and rights; the old code
// stops working), Duplicate and Revoke (asked first, offering to remove the
// people who joined with it). Edit puts the form in the same place; New
// invitation opens the same form as a row of its own, on top.
import { ref, computed, nextTick, inject, watch } from 'vue'
import { Copy, Check, Pencil, CopyPlus, RefreshCw, Trash2, Plus, MessageSquareText, AlertTriangle } from 'lucide-vue-next'
import LsInviteEditor from './LsInviteEditor.vue'
import RightsChip from './RightsChip.vue'
import { invitesOf, inviteName, inviteExpiry, inviteExpiryShort, inviteUses, inviteUsesShort, inviteJoinedShort, inviteBlockedText, shortCode } from '../../liveShareAccess'
import { rightsShort } from '../../liveShareRights'
import { t } from '../../i18n'

const MAX_INVITES = 20

const ctx = inject('lsDialog')
const invites = computed(() => invitesOf(ctx.host.value))
const full = computed(() => invites.value.length >= MAX_INVITES)
// The invitation opened, and 'new' or the id of the one being changed (its
// row open too).
const openId = ref(null)
const editing = ref(null)
const revoking = ref(null)
const removePeople = ref(false)
const copied = ref('')
let copiedTimer = 0
const root = ref(null)

// An invitation gone while it was open, changed or revoked (it expired, or
// was revoked elsewhere): its row closes.
watch(invites, (list) => {
  const here = (id) => list.some((x) => x.id === id)
  if (editing.value && editing.value !== 'new' && !here(editing.value)) editing.value = null
  if (revoking.value && !here(revoking.value)) revoking.value = null
  if (openId.value && !here(openId.value)) openId.value = null
})

const focusIn = (selector) => nextTick(() => root.value?.querySelector(selector)?.focus())
const isOpen = (inv) => openId.value === inv.id

function toggle(inv) {
  if (isOpen(inv)) {
    openId.value = null
    if (editing.value === inv.id) editing.value = null
  } else {
    openId.value = inv.id
    if (editing.value !== 'new') editing.value = null
  }
  revoking.value = null
}
function startNew() {
  if (full.value) return ctx.error(t('liveShare.error.full', 'You can have up to {{max}} invitations at once. Revoke one first.', { max: MAX_INVITES }))
  revoking.value = null
  editing.value = 'new'
}
function startEdit(inv) {
  revoking.value = null
  openId.value = inv.id
  editing.value = inv.id
}
function cancelEdit() {
  const id = editing.value
  editing.value = null
  focusIn(id && id !== 'new' ? `[data-test="ls-invite-edit-${id}"]` : '[data-test="ls-invite-new"]') // i18n-ignore
}

async function create({ spec }) {
  const r = await ctx.run('invite:new', () => ctx.api.createInvite(spec))
  if (!r || !r.ok) return
  editing.value = null
  ctx.notice(t('liveShare.invite.created', 'Invitation ready: copy its code and send it.'))
  if (r.invite) focusIn(`[data-test="ls-invite-copy-${r.invite.id}"]`) // i18n-ignore
}
async function save(inv, { spec, applyRemovals, applyAdditions }) {
  const r = await ctx.run(`invite:${inv.id}`, () => ctx.api.updateInvite({ id: inv.id, patch: spec, applyRemovals, applyAdditions })) // i18n-ignore
  if (!r || !r.ok) return
  editing.value = null
  const n = Number.isInteger(r.applied) ? r.applied : 0
  ctx.notice(
    n === 0
      ? t('liveShare.invite.saved', 'Saved.')
      : n === 1
        ? t('liveShare.invite.savedApplied', 'Saved, and changed for {{count}} person.', { count: n })
        : t('liveShare.invite.savedApplied', 'Saved, and changed for {{count}} people.', { count: n })
  )
  focusIn(`[data-test="ls-invite-edit-${inv.id}"]`) // i18n-ignore
}
async function duplicate(inv) {
  if (full.value) return ctx.error(t('liveShare.error.full', 'You can have up to {{max}} invitations at once. Revoke one first.', { max: MAX_INVITES }))
  const r = await ctx.run(`invite:${inv.id}:dup`, () => ctx.api.duplicateInvite({ id: inv.id })) // i18n-ignore
  if (!r || !r.ok || !r.invite) return
  ctx.notice(t('liveShare.invite.duplicated', 'Copy made, with a code of its own: give it a label.'))
  openId.value = r.invite.id
  editing.value = r.invite.id
}
async function rotate(inv) {
  const r = await ctx.run(`invite:${inv.id}:rotate`, () => ctx.api.rotateInvite({ id: inv.id })) // i18n-ignore
  if (!r || !r.ok) return
  ctx.notice(t('liveShare.invite.rotated', '“{{label}}” has a new code: send it again. The old code no longer lets anyone in.', { label: inviteName(inv) }))
  focusIn(`[data-test="ls-invite-copy-${inv.id}"]`) // i18n-ignore
}
function askRevoke(inv) {
  editing.value = null
  removePeople.value = false
  revoking.value = inv.id
  focusIn(`[data-test="ls-invite-revoke-cancel-${inv.id}"]`) // i18n-ignore
}
function cancelRevoke(inv) {
  revoking.value = null
  focusIn(`[data-test="ls-invite-revoke-${inv.id}"]`) // i18n-ignore
}
async function revoke(inv) {
  const remove = !!removePeople.value && inv.joined > 0
  const r = await ctx.run(`invite:${inv.id}:revoke`, () => ctx.api.revokeInvite({ id: inv.id, removePeople: remove })) // i18n-ignore
  revoking.value = null
  if (!r || !r.ok) return
  const n = Number.isInteger(r.removed) ? r.removed : 0
  ctx.notice(
    n === 0
      ? t('liveShare.invite.revoked', '“{{label}}” is revoked: its code no longer lets anyone in.', { label: inviteName(inv) })
      : n === 1
        ? t('liveShare.invite.revokedRemoved', '“{{label}}” is revoked, and {{count}} person who joined with it was removed.', { label: inviteName(inv), count: n })
        : t('liveShare.invite.revokedRemoved', '“{{label}}” is revoked, and {{count}} people who joined with it were removed.', { label: inviteName(inv), count: n })
  )
  focusIn('[data-test="ls-invite-new"]')
}

// Copy works only while the code lets people in (as in the Overview).
const canCopy = (inv) => !!inv.code && inv.state === 'live'
async function copy(inv, message) {
  if (!canCopy(inv)) return
  const text = message ? t('liveShare.invite.message', 'Join my Tessel Live Share: in Tessel, open Live Share, then Join, and paste this code: {{code}}', { code: inv.code }) : inv.code
  if (!(await ctx.copy(text))) return
  copied.value = `${inv.id}:${message ? 'message' : 'code'}` // i18n-ignore
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = ''), 1500)
}
const isCopied = (inv, message) => copied.value === `${inv.id}:${message ? 'message' : 'code'}` // i18n-ignore
const copyTitle = (inv) => (canCopy(inv) ? '' : inviteBlockedText(inv) || t('liveShare.invite.codeNotReady', 'The code is not ready yet'))

// The row: its state, and "Expires 14:37 · 1/3 used · 2 in".
function stateTag(inv) {
  if (inv.state === 'blocked') return { cls: 'tag-danger', text: t('liveShare.invite.badgeBlocked', 'Blocked') }
  if (inv.state === 'used') return { cls: 'tag-warn', text: t('liveShare.invite.badgeUsed', 'Used up') }
  if (inviteExpiryShort(inv, ctx.now.value).expired) return { cls: 'tag-off', text: t('liveShare.invite.expired', 'Expired') }
  return { cls: 'tag-ok', text: t('liveShare.invite.badgeLive', 'Live') }
}
function summaryOf(inv) {
  const e = inviteExpiryShort(inv, ctx.now.value)
  return [...(e.never ? [] : [e.text]), inviteUsesShort(inv), inviteJoinedShort(inv)].join(' · ')
}
const projectsText = (inv) => {
  const names = (inv.projects || []).map(ctx.projectName).filter(Boolean)
  const list = names.length ? names.join(', ') : t('liveShare.invite.noProject', 'no project')
  return inv.later ? t('liveShare.invite.projectsLater', '{{list}}, and projects shared later', { list }) : list
}
const joinedText = (inv) =>
  inv.joined === 1 ? t('liveShare.invite.joined', '{{count}} person in with it', { count: 1 }) : t('liveShare.invite.joined', '{{count}} people in with it', { count: inv.joined || 0 })
const revokeLabel = (inv) =>
  inv.joined === 1
    ? t('liveShare.invite.revokeRemove', 'Also remove the {{count}} person who joined with it', { count: 1 })
    : t('liveShare.invite.revokeRemove', 'Also remove the {{count}} people who joined with it', { count: inv.joined })
</script>

<template>
  <section ref="root" class="lsd-section" data-test="ls-invitations" :aria-label="t('liveShare.section.invites', 'Invitations')">
    <div class="lsd-section-head">
      <p class="lsd-intro">
        {{ t('liveShare.invite.intro', 'One invitation per person or group: each has its own code, projects and rights. Everyone still waits for your yes.') }}
        {{ t('liveShare.invite.endsWithShare', 'Codes stop working when you stop sharing; trusted people get in with any new code.') }}
      </p>
      <button type="button" class="confirm-btn ls-small" :disabled="full || editing === 'new'" :title="full ? t('liveShare.error.full', 'You can have up to {{max}} invitations at once. Revoke one first.', { max: 20 }) : ''" data-test="ls-invite-new" @click="startNew">
        <Plus :size="13" aria-hidden="true" /> {{ t('liveShare.invite.new', 'New invitation') }}
      </button>
    </div>

    <p v-if="!invites.length && editing !== 'new'" class="lsd-empty" data-test="ls-invites-empty">{{ t('liveShare.invite.empty', 'No invitation yet. Make one to let someone ask to join.') }}</p>

    <ul v-if="invites.length || editing === 'new'" class="sl-list lsv-list">
      <!-- New invitation: a row of its own, open on the form. -->
      <li v-if="editing === 'new'" class="sl-item open" data-test="ls-invite-new-item">
        <div class="sl-row ls-row ls-row-static">
          <span class="ls-row-inner">
            <span class="sl-row-icon lsv-new-icon"><Plus :size="15" aria-hidden="true" /></span>
            <span class="sl-row-main"><span class="sl-row-name">{{ t('liveShare.invite.newTitle', 'New invitation') }}</span></span>
          </span>
        </div>
        <div class="sl-details lsv-details">
          <LsInviteEditor flat :projects="ctx.shared.value" :busy="ctx.busy('invite:new')" :now="ctx.now.value" @submit="create" @cancel="cancelEdit" />
        </div>
      </li>

      <li v-for="inv in invites" :key="inv.id" class="sl-item" :class="{ open: isOpen(inv) }" :data-test="'ls-invite-' + inv.id">
        <div class="sl-row ls-row">
          <button type="button" class="ls-row-inner ls-row-toggle" :aria-expanded="isOpen(inv)" :aria-controls="'lsv-details-' + inv.id" :data-test="'ls-invite-toggle-' + inv.id" @click="toggle(inv)">
            <span class="sl-row-main">
              <span class="sl-row-top">
                <span class="sl-row-name">{{ inviteName(inv) }}</span>
                <span class="tag" :class="stateTag(inv).cls" data-test="ls-invite-state">{{ stateTag(inv).text }}</span>
                <span v-if="inviteExpiryShort(inv, ctx.now.value).never" class="tag tag-warn" data-test="ls-invite-never">{{ t('liveShare.invite.noExpiry', 'No expiry') }}</span>
              </span>
              <span class="sl-row-desc" data-test="ls-invite-summary">{{ summaryOf(inv) }}</span>
            </span>
            <span class="sl-row-meta"><RightsChip :rights="inv.rights || {}" /></span>
            <svg class="sl-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <span class="sl-actions">
            <button type="button" class="confirm-btn ls-small primary" :disabled="!canCopy(inv)" :title="copyTitle(inv)" :data-test="'ls-invite-copy-' + inv.id" @click="copy(inv, false)">
              <Check v-if="isCopied(inv, false)" :size="13" aria-hidden="true" />
              <Copy v-else :size="13" aria-hidden="true" />
              {{ isCopied(inv, false) ? t('liveShare.share.copied', 'Copied') : t('liveShare.invite.copy', 'Copy') }}
            </button>
          </span>
        </div>

        <div v-if="isOpen(inv)" :id="'lsv-details-' + inv.id" class="sl-details lsv-details" role="region" :aria-label="inviteName(inv)">
          <LsInviteEditor v-if="editing === inv.id" flat :invite="inv" :projects="ctx.shared.value" :busy="ctx.busy('invite:' + inv.id)" :now="ctx.now.value" @submit="(e) => save(inv, e)" @cancel="cancelEdit" />
          <template v-else>
            <div class="sl-sub-foot">
              <span class="sl-sub-path">
                <code class="sl-path lsv-code" :title="inv.code || ''" :aria-label="t('liveShare.invite.codeLabel', 'Code of {{label}}', { label: inviteName(inv) })" :data-test="'ls-invite-code-' + inv.id">{{ inv.code ? shortCode(inv.code) : t('liveShare.invite.codeNotReady', 'The code is not ready yet') }}</code>
              </span>
              <span class="sl-actions">
                <button type="button" class="confirm-btn ls-small" :disabled="!canCopy(inv)" :title="canCopy(inv) ? t('liveShare.invite.copyMessageTitle', 'The code with a line saying how to join') : copyTitle(inv)" :data-test="'ls-invite-copy-message-' + inv.id" @click="copy(inv, true)">
                  <Check v-if="isCopied(inv, true)" :size="13" aria-hidden="true" />
                  <MessageSquareText v-else :size="13" aria-hidden="true" />
                  {{ isCopied(inv, true) ? t('liveShare.share.copied', 'Copied') : t('liveShare.invite.copyMessage', 'Copy message') }}
                </button>
              </span>
            </div>
            <p class="sl-details-desc lsv-offers" v-text="t('liveShare.invite.offers', 'Offers: {{projects}}. Can: {{rights}}.', { projects: projectsText(inv), rights: rightsShort(inv.rights) })"></p>
            <p class="lsv-facts" :class="{ warn: inviteExpiry(inv, ctx.now.value).never }">
              <span data-test="ls-invite-expiry">{{ inviteExpiry(inv, ctx.now.value).text }}</span>
              <span aria-hidden="true">·</span>
              <span data-test="ls-invite-uses">{{ inviteUses(inv) }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ joinedText(inv) }}</span>
            </p>
            <div v-if="inviteBlockedText(inv)" class="set-callout warn lsv-callout" role="note" data-test="ls-invite-blocked">
              <AlertTriangle :size="14" aria-hidden="true" />
              <span class="set-callout-text">{{ inviteBlockedText(inv) }}</span>
            </div>

            <div v-if="revoking === inv.id" class="lsd-confirm" role="group" :aria-label="t('liveShare.invite.revokeTitle', 'Revoke “{{label}}”?', { label: inviteName(inv) })" :data-test="'ls-invite-revoke-confirm-' + inv.id" @keydown.escape.stop.prevent="cancelRevoke(inv)">
              <p class="lsd-confirm-text" v-text="t('liveShare.invite.revokeText', 'Revoke “{{label}}”? Its code stops letting anyone in.', { label: inviteName(inv) })"></p>
              <label v-if="inv.joined > 0" class="lsd-check" :data-test="'ls-invite-revoke-remove-' + inv.id">
                <input v-model="removePeople" type="checkbox" />
                <span>{{ revokeLabel(inv) }}</span>
              </label>
              <p v-if="inv.joined > 0 && !removePeople" class="lsd-hint">{{ t('liveShare.invite.revokeKeep', 'They stay in, and can come back by themselves.') }}</p>
              <div class="lsd-actions">
                <button type="button" class="confirm-btn ls-small" :data-test="'ls-invite-revoke-cancel-' + inv.id" @click="cancelRevoke(inv)">{{ t('liveShare.cancel', 'Cancel') }}</button>
                <button type="button" class="confirm-btn ls-small primary danger" :disabled="ctx.busy('invite:' + inv.id + ':revoke')" :data-test="'ls-invite-revoke-yes-' + inv.id" @click="revoke(inv)">
                  {{ t('liveShare.invite.revoke', 'Revoke') }}
                </button>
              </div>
            </div>
            <div v-else class="lsd-actions start">
              <button type="button" class="confirm-btn ls-small" :data-test="'ls-invite-edit-' + inv.id" @click="startEdit(inv)"><Pencil :size="12" aria-hidden="true" /> {{ t('liveShare.invite.edit', 'Edit') }}</button>
              <button
                type="button"
                class="confirm-btn ls-small"
                :disabled="ctx.busy('invite:' + inv.id + ':rotate')"
                :title="t('liveShare.invite.rotateTitle', 'A new code with the same label, projects and rights: the old code stops working, people already in stay')"
                :data-test="'ls-invite-rotate-' + inv.id"
                @click="rotate(inv)"
              >
                <RefreshCw :size="12" aria-hidden="true" /> {{ t('liveShare.invite.rotate', 'New code') }}
              </button>
              <button type="button" class="confirm-btn ls-small" :disabled="full || ctx.busy('invite:' + inv.id + ':dup')" :data-test="'ls-invite-duplicate-' + inv.id" @click="duplicate(inv)">
                <CopyPlus :size="12" aria-hidden="true" /> {{ t('liveShare.invite.duplicate', 'Duplicate') }}
              </button>
              <button type="button" class="confirm-btn ls-small danger" :data-test="'ls-invite-revoke-' + inv.id" @click="askRevoke(inv)"><Trash2 :size="12" aria-hidden="true" /> {{ t('liveShare.invite.revoke', 'Revoke') }}</button>
            </div>
          </template>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.lsv-new-icon {
  display: inline-flex;
  color: var(--accent);
}
.lsv-details {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-left: 16px;
}
.lsv-code {
  color: var(--text);
  font-size: 11.5px;
}
.lsv-offers {
  margin: 0;
}
.lsv-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 6px;
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
}
.lsv-facts.warn > span:first-child {
  color: var(--warn);
}
.lsv-callout {
  margin: 0;
}
</style>

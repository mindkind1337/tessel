<script setup>
// The toolbar bell: the notification inbox (notificationsStore.js). A click on
// an entry opens its pane; each entry can be marked read or unread.
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { notifications, unreadCount, setRead, markAllRead, clearNotifications } from '../notificationsStore'
import { formatWhen } from '../../../shared/activity'
import { t } from '../i18n'

const emit = defineEmits(['focus-pane'])
const open = ref(false)
const root = ref(null)

function onDocDown(e) {
  if (open.value && root.value && !root.value.contains(e.target)) open.value = false
}
onMounted(() => document.addEventListener('pointerdown', onDocDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocDown, true))

function openEntry(n) {
  setRead(n.id, true)
  open.value = false
  if (n.paneId) emit('focus-pane', n.paneId)
}
</script>

<template>
  <div ref="root" class="notif-wrap">
    <button
      class="tb-icon"
      :class="{ on: open }"
      :title="unreadCount ? t('app.notifications.unread', 'Notifications: {{count}} unread', { count: unreadCount }) : t('app.notifications.title', 'Notifications')"
      :aria-label="t('app.notifications.title', 'Notifications')"
      :aria-expanded="open"
      data-test="notif-bell"
      @click="open = !open"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 2.2a3.8 3.8 0 00-3.8 3.8v2.3L3 10.6h10l-1.2-2.3V6A3.8 3.8 0 008 2.2zM6.5 12.4a1.6 1.6 0 003 0"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
      </svg>
      <span v-if="unreadCount" class="notif-badge" data-test="notif-count">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
    </button>
    <div v-if="open" class="notif-menu" role="dialog" :aria-label="t('app.notifications.title', 'Notifications')">
      <div class="notif-head">
        <span>{{ t('app.notifications.title', 'Notifications') }}</span>
        <span class="notif-head-actions">
          <button class="exit-btn" :disabled="!unreadCount" @click="markAllRead">{{ t('app.notifications.markAllRead', 'Mark all read') }}</button>
          <button class="exit-btn" :disabled="!notifications.length" @click="clearNotifications">{{ t('app.notifications.clear', 'Clear') }}</button>
        </span>
      </div>
      <p v-if="!notifications.length" class="notif-empty">{{ t('app.notifications.empty', 'Nothing yet. When an agent finishes, hits its limit or needs you, it shows here.') }}</p>
      <div
        v-for="n in notifications"
        :key="n.id"
        class="notif-item"
        :class="[n.kind, { unread: !n.read }]"
        data-test="notif-item"
      >
        <button class="notif-main" @click="openEntry(n)">
          <span class="notif-dot" aria-hidden="true"></span>
          <span class="notif-text">
            <span class="notif-title">{{ n.title }}</span>
            <span v-if="n.body" class="notif-body">{{ n.body }}</span>
          </span>
          <span class="notif-when">{{ formatWhen(n.at) }}</span>
        </button>
        <button class="notif-toggle" :title="n.read ? t('app.notifications.markUnread', 'Mark unread') : t('app.notifications.markRead', 'Mark read')" @click="setRead(n.id, !n.read)">
          {{ n.read ? t('app.notifications.unreadShort', 'Unread') : t('app.notifications.readShort', 'Read') }}
        </button>
      </div>
    </div>
  </div>
</template>

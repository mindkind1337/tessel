import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { notifications, unreadCount, addNotification, setRead, readForPane, markAllRead, clearNotifications } from '../notificationsStore'
import NotificationsMenu from '../components/NotificationsMenu.vue'

describe('notification inbox', () => {
  beforeEach(() => clearNotifications())

  it('keeps entries, newest first; read and unread; opening a pane reads its entries', () => {
    addNotification({ kind: 'done', title: 'Codex finished', paneId: 'p1' })
    addNotification({ kind: 'limit', title: 'Claude hit its limit', paneId: 'p2' })
    expect(notifications.map((n) => n.title)).toEqual(['Claude hit its limit', 'Codex finished'])
    expect(unreadCount.value).toBe(2)
    readForPane('p1')
    expect(unreadCount.value).toBe(1)
    setRead(notifications[1].id, false) // mark unread again
    expect(unreadCount.value).toBe(2)
    markAllRead()
    expect(unreadCount.value).toBe(0)
  })

  it('one entry for a burst from the same pane (5 s), kept across reloads', () => {
    addNotification({ kind: 'done', title: 'A', paneId: 'p1' })
    addNotification({ kind: 'done', title: 'A again', paneId: 'p1' })
    expect(notifications).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('tessel.notifications'))[0].title).toBe('A again')
  })

  it('the bell shows the unread count; a click on an entry opens its pane and reads it', async () => {
    addNotification({ kind: 'alert', title: 'Codex needs you', body: 'approval', paneId: 'p9' })
    const w = mount(NotificationsMenu, { attachTo: document.body })
    expect(w.find('[data-test="notif-count"]').text()).toBe('1')
    await w.find('[data-test="notif-bell"]').trigger('click')
    await w.find('[data-test="notif-item"] .notif-main').trigger('click')
    expect(w.emitted('focus-pane')).toEqual([['p9']])
    expect(unreadCount.value).toBe(0)
    w.unmount()
  })
})

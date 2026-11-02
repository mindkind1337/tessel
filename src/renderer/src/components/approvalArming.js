// The Allow buttons of an agent's approval cards (AgentCommandApproval.vue,
// AgentAccountApproval.vue): a click or a key meant for something else must
// never allow. They are not usable for ARM_MS after the card shows, and
// again after the window comes back to the front; a mouse click counts only
// when the button itself was pressed (pointerdown) after the card showed,
// never a press that began on something else, a card closed meanwhile
// included. The keyboard needs no press: the focus starts on Refuse / Skip.
import { ref, onMounted, onUnmounted } from 'vue'

export const ARM_MS = 750

// armMs: 0 for tests (armed at once).
export function useApprovalArming(armMs = ARM_MS) {
  const armed = ref(armMs <= 0)
  let timer = null
  let pressed = null
  function arm() {
    clearTimeout(timer)
    pressed = null
    if (armMs <= 0) {
      armed.value = true
      return
    }
    armed.value = false
    timer = setTimeout(() => (armed.value = true), armMs)
  }
  onMounted(() => {
    arm()
    window.addEventListener('focus', arm)
  })
  onUnmounted(() => {
    clearTimeout(timer)
    window.removeEventListener('focus', arm)
  })
  // @pointerdown on an Allow button. A press while it is not armed counts for nothing, even released later.
  function press(event) {
    pressed = armed.value && event && event.currentTarget ? event.currentTarget : null
  }
  // May this click (on an Allow button) allow?
  function mayAllow(event) {
    if (!armed.value) return false
    // A mouse click (detail > 0): pressed on this very button.
    if (event && event.detail > 0) {
      const ok = !!pressed && pressed === event.currentTarget
      pressed = null
      return ok
    }
    return true
  }
  return { armed, press, mayAllow }
}

// A card that opened by itself while someone goes on writing: a letter, a space or an Enter on it
// is not an answer. back() returns the keyboard at once, so the key reaches what they were writing
// in, and park() puts the card away in the toolbar. A click on the card says they mean to use it,
// and so does having opened it themselves (chosen). Tab alone does not: someone can press it for
// another reason (Shift+Tab is an agent's mode key), so after it a letter still parks the card, an
// Enter only counts a moment after the focus got there, and the focus never wraps from the refusing
// button round to the strongest one. denyOnly(element): on such a card, until it is clicked or opened
// on purpose, an Enter does nothing unless it is on the refusing button.
export function typingGuard({ chosen = false, back, park, settleMs = ARM_MS, now = () => Date.now(), denyOnly = null }) {
  let meant = chosen
  let tabbedAt = 0
  return {
    pointer() {
      meant = true
    },
    // May Tab go round from one end of the card to the other?
    mayWrap: () => meant,
    key(event) {
      if (meant) return
      if (event.key === 'Tab') {
        tabbedAt = now()
        return
      }
      const tag = event.target && event.target.tagName
      if (tag === 'TEXTAREA' || tag === 'INPUT') return
      // (AltGr reads as Ctrl and Alt together: that is a letter.)
      const letter = String(event.key).length === 1 && !event.metaKey && !!event.ctrlKey === !!event.altKey
      if (event.key === 'Enter' && tabbedAt) {
        if (now() - tabbedAt >= settleMs && (!denyOnly || denyOnly(event.target))) return
        event.preventDefault()
        event.stopPropagation()
        return
      }
      // A space on a button presses it too. Never by accident: it still puts the card away below, and
      // the button the Tab reached stays unpressed. On a deny-only card the same rule as Enter.
      if (event.key === ' ' && tabbedAt) {
        if (denyOnly && now() - tabbedAt >= settleMs && denyOnly(event.target)) return
        event.preventDefault()
        if (denyOnly) {
          event.stopPropagation()
          return
        }
      }
      if (event.key !== 'Enter' && !letter) return
      back()
      park()
    }
  }
}

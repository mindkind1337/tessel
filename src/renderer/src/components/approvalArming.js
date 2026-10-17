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
  // @pointerdown on an Allow button.
  function press(event) {
    pressed = event && event.currentTarget ? event.currentTarget : null
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

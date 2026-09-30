import { DOMWrapper, flushPromises } from '@vue/test-utils'
export async function selectOptions(trigger) {
  await trigger.trigger('click')
  const list = document.getElementById(trigger.attributes('aria-controls'))
  if (!list) throw new Error('Select did not open')
  const options = [...list.querySelectorAll('[role="option"]')].map((el) => new DOMWrapper(el))
  await trigger.trigger('keydown', { key: 'Escape' })
  return options
}
export async function setSelectValue(trigger, value) {
  await trigger.trigger('click')
  const list = document.getElementById(trigger.attributes('aria-controls'))
  const option = [...(list?.querySelectorAll('[role="option"]') || [])].find(
    (el) => el.dataset.value === String(value)
  )
  if (!option) throw new Error(`Missing select value: ${value}`)
  await new DOMWrapper(option).trigger('pointerdown')
  await new DOMWrapper(option).trigger('click')
  await flushPromises()
}

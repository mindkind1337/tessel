import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ImageViewer from '../components/ImageViewer.vue'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('image viewer', () => {
  let previousApi
  afterEach(() => {
    window.shellApi = previousApi
  })

  it('shows the image; click for full size; Esc or a click beside it closes; Open in viewer', async () => {
    previousApi = window.shellApi
    const opened = []
    window.shellApi = { openImageExternally: (f) => opened.push(f) }
    const wrapper = mount(ImageViewer, { props: { src: PNG, title: 'Image #42', file: 'C:\\tmp\\tessel-paste\\a.png' }, attachTo: document.body })
    expect(wrapper.get('img').attributes('src')).toBe(PNG)
    expect(wrapper.text()).toContain('Image #42')
    await wrapper.get('img').trigger('click')
    expect(wrapper.get('.imgview-stage').classes()).toContain('full')
    await wrapper.findAll('button').find((b) => b.text() === 'Open in viewer').trigger('click')
    expect(opened).toEqual(['C:\\tmp\\tessel-paste\\a.png'])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.get('.imgview-backdrop').trigger('mousedown')
    expect(wrapper.emitted('close')).toHaveLength(2)
    wrapper.unmount()
  })

  it('no file: no "Open in viewer"', () => {
    const wrapper = mount(ImageViewer, { props: { src: PNG } })
    expect(wrapper.findAll('button').some((b) => b.text() === 'Open in viewer')).toBe(false)
    wrapper.unmount()
  })
})

// The static primitives (after Orca's components/ui/{button,badge,card,
// progress,collapsible}.tsx, shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.).
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Progress
} from '../ui/index.js'

afterEach(() => document.body.replaceChildren())

describe('Button', () => {
  it('renders a button with the default variant and size', () => {
    const wrapper = mount(Button, { slots: { default: 'Send' } })
    expect(wrapper.element.tagName).toBe('BUTTON')
    expect(wrapper.attributes('data-slot')).toBe('button')
    expect(wrapper.attributes('data-variant')).toBe('default')
    expect(wrapper.attributes('data-size')).toBe('default')
    expect(wrapper.classes()).toEqual(['nc-ui-button', 'nc-ui-button--default', 'nc-ui-button--size-default'])
  })

  it.each(['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'])('variant %s', (variant) => {
    const wrapper = mount(Button, { props: { variant } })
    expect(wrapper.classes()).toContain(`nc-ui-button--${variant}`)
    expect(wrapper.attributes('data-variant')).toBe(variant)
  })

  it.each(['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm', 'icon-lg'])('size %s', (size) => {
    const wrapper = mount(Button, { props: { size } })
    expect(wrapper.classes()).toContain(`nc-ui-button--size-${size}`)
    expect(wrapper.attributes('data-size')).toBe(size)
  })

  it('passes attributes, classes and listeners to the element', async () => {
    let clicks = 0
    const wrapper = mount(Button, {
      props: { variant: 'ghost', size: 'icon-sm' },
      attrs: { type: 'button', 'aria-label': 'Attach file', class: 'extra', disabled: true, onClick: () => clicks++ }
    })
    expect(wrapper.attributes('aria-label')).toBe('Attach file')
    expect(wrapper.attributes('type')).toBe('button')
    expect(wrapper.attributes('disabled')).toBeDefined()
    expect(wrapper.classes()).toContain('extra')
    const enabled = mount(Button, { attrs: { onClick: () => clicks++ } })
    await enabled.trigger('click')
    expect(clicks).toBe(1)
  })

  it('asChild puts the button classes on its child', () => {
    const wrapper = mount({
      components: { Button },
      template: '<Button as-child variant="link"><a href="#x" class="own">Open</a></Button>'
    })
    const a = wrapper.find('a')
    expect(a.exists()).toBe(true)
    expect(wrapper.find('button').exists()).toBe(false)
    expect(a.classes()).toEqual(expect.arrayContaining(['own', 'nc-ui-button', 'nc-ui-button--link']))
    expect(a.attributes('data-slot')).toBe('button')
    expect(a.attributes('href')).toBe('#x')
  })

  it('as renders another element', () => {
    const wrapper = mount(Button, { props: { as: 'span' } })
    expect(wrapper.element.tagName).toBe('SPAN')
  })
})

describe('Badge', () => {
  it.each(['default', 'secondary', 'dot', 'destructive', 'outline', 'ghost', 'link', 'hostContext'])(
    'variant %s',
    (variant) => {
      const wrapper = mount(Badge, { props: { variant }, slots: { default: 'Skill' } })
      expect(wrapper.element.tagName).toBe('SPAN')
      expect(wrapper.attributes('data-slot')).toBe('badge')
      expect(wrapper.attributes('data-variant')).toBe(variant)
      expect(wrapper.classes()).toEqual(['nc-ui-badge', `nc-ui-badge--${variant}`])
    }
  )

  it('asChild', () => {
    const wrapper = mount({ components: { Badge }, template: '<Badge as-child><a href="#">x</a></Badge>' })
    expect(wrapper.find('a').classes()).toContain('nc-ui-badge')
  })
})

describe('Card', () => {
  it('renders the slots with their data-slot', () => {
    const wrapper = mount({
      components: { Card, CardHeader, CardTitle, CardContent },
      template: '<Card class="c"><CardHeader><CardTitle>T</CardTitle></CardHeader><CardContent>B</CardContent></Card>'
    })
    expect(wrapper.find('[data-slot="card"]').classes()).toEqual(['nc-ui-card', 'c'])
    expect(wrapper.find('[data-slot="card-header"] [data-slot="card-title"]').text()).toBe('T')
    expect(wrapper.find('[data-slot="card-content"]').text()).toBe('B')
  })
})

describe('Progress', () => {
  it('exposes the value to assistive tech and moves the indicator', () => {
    const wrapper = mount(Progress, { props: { value: 40 }, attrs: { 'aria-label': 'Context' } })
    expect(wrapper.attributes('role')).toBe('progressbar')
    expect(wrapper.attributes('aria-valuenow')).toBe('40')
    expect(wrapper.attributes('aria-valuemin')).toBe('0')
    expect(wrapper.attributes('aria-valuemax')).toBe('100')
    expect(wrapper.attributes('aria-valuetext')).toBe('40%')
    expect(wrapper.attributes('data-state')).toBe('loading')
    expect(wrapper.attributes('aria-label')).toBe('Context')
    expect(wrapper.find('[data-slot="progress-indicator"]').attributes('style')).toContain('translateX(-60%)')
  })

  it('complete and indeterminate states', () => {
    expect(mount(Progress, { props: { value: 100 } }).attributes('data-state')).toBe('complete')
    const none = mount(Progress, { props: { value: null } })
    expect(none.attributes('data-state')).toBe('indeterminate')
    expect(none.attributes('aria-valuenow')).toBeUndefined()
  })
})

describe('Collapsible', () => {
  const template = `
    <Collapsible v-model:open="open" class="root">
      <CollapsibleTrigger class="trigger">Tasks</CollapsibleTrigger>
      <CollapsibleContent><p class="body">List</p></CollapsibleContent>
    </Collapsible>`

  it('toggles from its trigger, with aria-expanded / aria-controls / data-state', async () => {
    const wrapper = mount({
      components: { Collapsible, CollapsibleTrigger, CollapsibleContent },
      data: () => ({ open: false }),
      template
    })
    const trigger = wrapper.find('button.trigger')
    expect(trigger.attributes('type')).toBe('button')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(trigger.attributes('data-state')).toBe('closed')
    expect(wrapper.find('.body').exists()).toBe(false)

    await trigger.trigger('click')
    expect(wrapper.vm.open).toBe(true)
    expect(trigger.attributes('aria-expanded')).toBe('true')
    const content = wrapper.find('[data-slot="collapsible-content"]')
    expect(trigger.attributes('aria-controls')).toBe(content.attributes('id'))
    expect(content.attributes('data-state')).toBe('open')
    expect(wrapper.find('.root').attributes('data-state')).toBe('open')
    expect(wrapper.find('.body').exists()).toBe(true)
  })

  it('works uncontrolled with defaultOpen, and asChild', async () => {
    const wrapper = mount({
      components: { Collapsible, CollapsibleTrigger, CollapsibleContent },
      template: `<Collapsible default-open>
        <CollapsibleTrigger as-child><div class="row" role="button">x</div></CollapsibleTrigger>
        <CollapsibleContent><p class="body">List</p></CollapsibleContent>
      </Collapsible>`
    })
    expect(wrapper.find('.body').exists()).toBe(true)
    await wrapper.find('.row').trigger('click')
    expect(wrapper.find('.body').exists()).toBe(false)
    expect(wrapper.find('.row').attributes('data-state')).toBe('closed')
  })

  it('a click listener that prevents default keeps it closed', async () => {
    const wrapper = mount({
      components: { Collapsible, CollapsibleTrigger, CollapsibleContent },
      template: `<Collapsible>
        <CollapsibleTrigger @click="(e) => e.preventDefault()">x</CollapsibleTrigger>
        <CollapsibleContent><p class="body">List</p></CollapsibleContent>
      </Collapsible>`
    })
    await wrapper.find('button').trigger('click')
    expect(wrapper.find('.body').exists()).toBe(false)
  })
})

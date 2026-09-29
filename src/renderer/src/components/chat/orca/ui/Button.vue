<script setup>
// After Orca's components/ui/button.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Button: shadcn's button.
 * Props: variant 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost'
 *   | 'link' (default 'default'); size 'default' | 'xs' | 'sm' | 'lg' | 'icon'
 *   | 'icon-xs' | 'icon-sm' | 'icon-lg' (default 'default'); as (element or
 *   component, default 'button'); asChild (the single slot child becomes the
 *   button: it gets the classes and data attributes).
 * Everything else (type, disabled, aria-*, @click…) goes to the element.
 * Icons: a direct svg gets 16px (12px in xs / icon-xs) unless its class
 * contains "size-" (e.g. class="nc-size-3"), like the reference's
 * [&_svg:not([class*='size-'])]:size-4.
 * The element: templateRef.value.$el.
 * <Button variant="ghost" size="icon-sm" :aria-label="label" @click="attach"><Plus /></Button>
 * <Button as-child variant="link"><a :href="url">{{ text }}</a></Button>
 */
import { computed } from 'vue'
import { Primitive } from './primitive.js'
import './ui.css'

const props = defineProps({
  variant: { type: String, default: 'default' },
  size: { type: String, default: 'default' },
  as: { type: [String, Object, Function], default: 'button' },
  asChild: { type: Boolean, default: false }
})

const classes = computed(() => [
  'nc-ui-button',
  `nc-ui-button--${props.variant}`, // i18n-ignore
  `nc-ui-button--size-${props.size}` // i18n-ignore
])
</script>

<template>
  <Primitive
    :as="as"
    :as-child="asChild"
    data-slot="button"
    :data-variant="variant"
    :data-size="size"
    :class="classes"
  >
    <slot />
  </Primitive>
</template>

<style>
.nc-ui-button {
  box-sizing: border-box;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0;
  border: 0 solid transparent;
  border-radius: 6px;
  background-color: transparent;
  color: inherit;
  cursor: pointer;
  font-family: inherit;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  letter-spacing: inherit;
  text-align: center;
  text-decoration: none;
  text-transform: none;
  white-space: nowrap;
  transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
  outline: none;
}
.nc-ui-button:focus-visible {
  border-color: var(--nc-ring);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--nc-ring) 50%, transparent);
}
.nc-ui-button:disabled {
  pointer-events: none;
  opacity: 0.5;
}
.nc-ui-button[aria-invalid='true'] {
  border-color: var(--nc-destructive);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--nc-destructive) 40%, transparent);
}
.nc-ui-button svg {
  pointer-events: none;
  flex-shrink: 0;
}
.nc-ui-button svg:not([class*='size-']) {
  width: 16px;
  height: 16px;
}

/* Variants (Tessel's themes are dark: the reference's dark: values). */
.nc-ui-button--default {
  background-color: var(--nc-primary);
  color: var(--nc-primary-foreground);
}
.nc-ui-button--destructive {
  background-color: color-mix(in srgb, var(--nc-destructive) 60%, transparent);
  color: #fff;
}
.nc-ui-button--destructive:focus-visible {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--nc-destructive) 40%, transparent);
}
.nc-ui-button--outline {
  border-width: 1px;
  border-color: var(--nc-input);
  background-color: color-mix(in srgb, var(--nc-input) 30%, transparent);
  color: var(--nc-foreground);
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
}
.nc-ui-button--secondary {
  background-color: var(--nc-secondary);
  color: var(--nc-secondary-foreground, var(--nc-foreground));
}
.nc-ui-button--link {
  color: var(--nc-primary);
  text-underline-offset: 4px;
}
@media (hover: hover) {
  .nc-ui-button--default:hover {
    background-color: color-mix(in srgb, var(--nc-primary) 90%, transparent);
  }
  .nc-ui-button--destructive:hover {
    background-color: color-mix(in srgb, var(--nc-destructive) 90%, transparent);
  }
  .nc-ui-button--outline:hover {
    border-color: color-mix(in srgb, var(--nc-muted-foreground) 35%, transparent);
    background-color: color-mix(in srgb, var(--nc-input) 50%, transparent);
    color: var(--nc-accent-foreground);
  }
  .nc-ui-button--secondary:hover {
    background-color: color-mix(in srgb, var(--nc-secondary) 80%, transparent);
  }
  .nc-ui-button--ghost:hover {
    background-color: color-mix(in srgb, var(--nc-accent) 50%, transparent);
    color: var(--nc-accent-foreground);
  }
  .nc-ui-button--link:hover {
    text-decoration: underline;
  }
}

/* Sizes. */
.nc-ui-button--size-default {
  height: 36px;
  padding: 8px 16px;
}
.nc-ui-button--size-default:has(> svg) {
  padding-left: 12px;
  padding-right: 12px;
}
.nc-ui-button--size-xs {
  height: 24px;
  gap: 4px;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 12px;
  line-height: 16px;
}
.nc-ui-button--size-xs:has(> svg) {
  padding-left: 6px;
  padding-right: 6px;
}
.nc-ui-button--size-xs svg:not([class*='size-']),
.nc-ui-button--size-icon-xs svg:not([class*='size-']) {
  width: 12px;
  height: 12px;
}
.nc-ui-button--size-sm {
  height: 32px;
  gap: 6px;
  border-radius: 6px;
  padding: 0 12px;
}
.nc-ui-button--size-sm:has(> svg) {
  padding-left: 10px;
  padding-right: 10px;
}
.nc-ui-button--size-lg {
  height: 40px;
  border-radius: 6px;
  padding: 0 24px;
}
.nc-ui-button--size-lg:has(> svg) {
  padding-left: 16px;
  padding-right: 16px;
}
.nc-ui-button--size-icon {
  width: 36px;
  height: 36px;
  padding: 0;
}
.nc-ui-button--size-icon-xs {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  padding: 0;
}
.nc-ui-button--size-icon-sm {
  width: 32px;
  height: 32px;
  padding: 0;
}
.nc-ui-button--size-icon-lg {
  width: 40px;
  height: 40px;
  padding: 0;
}
</style>

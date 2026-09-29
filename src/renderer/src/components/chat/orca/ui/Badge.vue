<script setup>
// After Orca's components/ui/badge.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Badge: a small pill (span).
 * Props: variant 'default' | 'secondary' | 'dot' | 'destructive' | 'outline'
 *   | 'ghost' | 'link' | 'hostContext' (default 'default'); asChild (the slot
 *   child becomes the badge, e.g. an <a>).
 * A direct svg child is 12px.
 * <Badge variant="secondary" class="skill"><Package aria-hidden="true" />{{ label }}</Badge>
 */
import { computed } from 'vue'
import { Primitive } from './primitive.js'

const props = defineProps({
  variant: { type: String, default: 'default' },
  asChild: { type: Boolean, default: false }
})

const classes = computed(() => ['nc-ui-badge', `nc-ui-badge--${props.variant}`]) // i18n-ignore
</script>

<template>
  <Primitive as="span" :as-child="asChild" data-slot="badge" :data-variant="variant" :class="classes">
    <slot />
  </Primitive>
</template>

<style>
.nc-ui-badge {
  box-sizing: border-box;
  display: inline-flex;
  width: fit-content;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 4px;
  overflow: hidden;
  border-radius: 9999px;
  border: 1px solid transparent;
  padding: 2px 8px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  white-space: nowrap;
  transition: color 150ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-ui-badge:focus-visible {
  border-color: var(--nc-ring);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--nc-ring) 50%, transparent);
}
.nc-ui-badge[aria-invalid='true'] {
  border-color: var(--nc-destructive);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--nc-destructive) 40%, transparent);
}
.nc-ui-badge > svg {
  pointer-events: none;
  width: 12px;
  height: 12px;
}

/* Variants (Tessel's themes are dark: the reference's dark: values). */
.nc-ui-badge--default {
  background-color: var(--nc-primary);
  color: var(--nc-primary-foreground);
}
.nc-ui-badge--secondary {
  background-color: var(--nc-secondary);
  color: var(--nc-secondary-foreground, var(--nc-foreground));
}
.nc-ui-badge--dot {
  border-color: rgb(255 255 255 / 0.2);
  background-color: var(--nc-secondary);
  color: var(--nc-foreground);
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
}
.nc-ui-badge--destructive {
  background-color: color-mix(in srgb, var(--nc-destructive) 60%, transparent);
  color: #fff;
}
.nc-ui-badge--destructive:focus-visible {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--nc-destructive) 40%, transparent);
}
.nc-ui-badge--outline {
  border-color: var(--nc-border);
  color: var(--nc-foreground);
}
.nc-ui-badge--link {
  color: var(--nc-primary);
  text-underline-offset: 4px;
}
/* The quiet chip naming the machine a workspace runs on. */
.nc-ui-badge--hostContext {
  height: 16px;
  border-radius: 4px;
  border-color: color-mix(in srgb, var(--nc-border) 50%, transparent);
  background-color: color-mix(in srgb, var(--nc-accent) 80%, transparent);
  padding-left: 6px;
  padding-right: 6px;
  font-size: 10px;
  line-height: 1;
  color: var(--nc-muted-foreground);
}
/* [a&]:hover:… — only when the badge is a link. */
@media (hover: hover) {
  a.nc-ui-badge--default:hover {
    background-color: color-mix(in srgb, var(--nc-primary) 90%, transparent);
  }
  a.nc-ui-badge--secondary:hover {
    background-color: color-mix(in srgb, var(--nc-secondary) 90%, transparent);
  }
  a.nc-ui-badge--destructive:hover {
    background-color: color-mix(in srgb, var(--nc-destructive) 90%, transparent);
  }
  a.nc-ui-badge--outline:hover,
  a.nc-ui-badge--ghost:hover {
    background-color: var(--nc-accent);
    color: var(--nc-accent-foreground);
  }
  a.nc-ui-badge--link:hover {
    text-decoration: underline;
  }
}
</style>

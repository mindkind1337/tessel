// Placement maths of the floating primitives (what Radix Popper gives
// Orca's shadcn/ui components, MIT, Copyright (c) 2026 Lovecast Inc.).
import { describe, expect, it } from 'vitest'
import { computeFloatingPosition } from '../ui/floating.js'

const viewport = { width: 1000, height: 800 }
const anchor = { left: 400, top: 400, width: 100, height: 20 }
const size = { width: 200, height: 100 }

describe('computeFloatingPosition', () => {
  it('places each side with the offset and centres by default', () => {
    expect(computeFloatingPosition({ anchor, size, side: 'bottom', sideOffset: 4, viewport })).toMatchObject({
      x: 350,
      y: 424,
      side: 'bottom',
      align: 'center'
    })
    expect(computeFloatingPosition({ anchor, size, side: 'top', sideOffset: 4, viewport })).toMatchObject({ x: 350, y: 296 })
    expect(computeFloatingPosition({ anchor, size, side: 'left', sideOffset: 8, viewport })).toMatchObject({ x: 192, y: 360 })
    expect(computeFloatingPosition({ anchor, size, side: 'right', sideOffset: 8, viewport })).toMatchObject({ x: 508, y: 360 })
  })

  it('aligns start / end along the side', () => {
    expect(computeFloatingPosition({ anchor, size, side: 'top', align: 'start', viewport }).x).toBe(400)
    expect(computeFloatingPosition({ anchor, size, side: 'top', align: 'end', viewport }).x).toBe(300)
    expect(computeFloatingPosition({ anchor, size, side: 'right', align: 'start', viewport }).y).toBe(400)
  })

  it('flips to the other side when it does not fit', () => {
    const nearTop = { left: 400, top: 10, width: 100, height: 20 }
    const placed = computeFloatingPosition({ anchor: nearTop, size, side: 'top', sideOffset: 4, viewport })
    expect(placed.side).toBe('bottom')
    expect(placed.y).toBe(34)
    const nearRight = { left: 900, top: 400, width: 50, height: 20 }
    expect(computeFloatingPosition({ anchor: nearRight, size, side: 'right', viewport }).side).toBe('left')
  })

  it('flips only when the other side overflows less', () => {
    const tall = { width: 200, height: 900 }
    expect(computeFloatingPosition({ anchor, size: tall, side: 'bottom', viewport }).side).toBe('top')
    expect(computeFloatingPosition({ anchor: { ...anchor, top: 100 }, size: tall, side: 'bottom', viewport }).side).toBe('bottom')
  })

  it('shifts along the other axis to stay inside the viewport (with collision padding)', () => {
    const nearLeft = { left: 0, top: 400, width: 20, height: 20 }
    expect(computeFloatingPosition({ anchor: nearLeft, size, side: 'top', viewport }).x).toBe(0)
    expect(computeFloatingPosition({ anchor: nearLeft, size, side: 'top', collisionPadding: 8, viewport }).x).toBe(8)
    const nearRight = { left: 990, top: 400, width: 10, height: 20 }
    expect(computeFloatingPosition({ anchor: nearRight, size, side: 'bottom', viewport }).x).toBe(800)
  })

  it('reports the room left, the arrow offset and the transform origin', () => {
    const placed = computeFloatingPosition({ anchor, size, side: 'top', align: 'end', sideOffset: 4, viewport })
    expect(placed.availableHeight).toBe(396)
    expect(placed.arrowOffset).toBe(150)
    expect(placed.transformOrigin).toBe('100% 100%')
  })

  it('avoidCollisions false keeps the requested placement', () => {
    const nearTop = { left: 0, top: 10, width: 100, height: 20 }
    const placed = computeFloatingPosition({ anchor: nearTop, size, side: 'top', avoidCollisions: false, viewport })
    expect(placed.side).toBe('top')
    expect(placed.x).toBe(-50)
  })
})

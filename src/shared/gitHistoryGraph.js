// The Commits section's graph, ported from Orca's source control (MIT,
// Copyright (c) 2026 Lovecast Inc.): shared/git-history-graph.ts,
// shared/git-history-types.ts, shared/git-history-ref-display.ts and
// sync/git-history-graph-svg.tsx (its path geometry). Pure: ScmHistoryPanel.vue
// draws what it returns. Orca's incoming / outgoing boundary rows are not
// drawn (Tessel shows ahead / behind on the branch line instead).
//
// A history item (main's scmHistory): { id, parentIds, subject, message,
// displayId, author, timestamp, references: [{ id, name, revision, category }] }

export const GIT_HISTORY_REF_COLOR = 'git-graph-ref'
export const GIT_HISTORY_REMOTE_REF_COLOR = 'git-graph-remote-ref'
export const GIT_HISTORY_BASE_REF_COLOR = 'git-graph-base-ref'
export const GIT_HISTORY_LANE_COLORS = ['git-graph-lane-1', 'git-graph-lane-2', 'git-graph-lane-3', 'git-graph-lane-4', 'git-graph-lane-5']

const rotate = (i, n) => ((i % n) + n) % n
const cloneNode = (n) => ({ id: n.id, color: n.color })

function labelColor(item, colorMap) {
  for (const ref of item.references || []) {
    const c = colorMap.get(ref.id)
    if (c !== undefined) return c
  }
  return undefined
}

export function compareGitHistoryRefs(a, b, currentRef, remoteRef, baseRef) {
  const order = (ref) => {
    if (currentRef && ref.id === currentRef.id) return 1
    if (remoteRef && ref.id === remoteRef.id) return 2
    if (baseRef && ref.id === baseRef.id) return 3
    if (ref.color !== undefined) return 4
    return 99
  }
  return order(a) - order(b)
}

export function buildDefaultGitHistoryColorMap({ currentRef, remoteRef, baseRef } = {}) {
  const m = new Map()
  if (currentRef) m.set(currentRef.id, GIT_HISTORY_REF_COLOR)
  if (remoteRef) m.set(remoteRef.id, GIT_HISTORY_REMOTE_REF_COLOR)
  if (baseRef) m.set(baseRef.id, GIT_HISTORY_BASE_REF_COLOR)
  return m
}

// -> [{ historyItem, inputSwimlanes, outputSwimlanes, kind: 'HEAD'|'node' }]
export function buildGitHistoryViewModels(items, colorMap = new Map(), currentRef, remoteRef, baseRef) {
  let colorIndex = -1
  const viewModels = []
  let byId = null
  for (const item of items || []) {
    const kind = currentRef && item.id === currentRef.revision ? 'HEAD' : 'node'
    const prev = viewModels[viewModels.length - 1]
    const inputSwimlanes = (prev ? prev.outputSwimlanes : []).map(cloneNode)
    const outputSwimlanes = []
    let firstParentAdded = false
    if (item.parentIds.length > 0) {
      for (const node of inputSwimlanes) {
        if (node.id === item.id) {
          if (!firstParentAdded) {
            outputSwimlanes.push({ id: item.parentIds[0], color: labelColor(item, colorMap) ?? node.color })
            firstParentAdded = true
          }
          continue
        }
        outputSwimlanes.push(cloneNode(node))
      }
    }
    for (let i = firstParentAdded ? 1 : 0; i < item.parentIds.length; i++) {
      let color
      if (i === 0) color = labelColor(item, colorMap)
      else {
        if (!byId) {
          byId = new Map()
          for (const c of items) if (!byId.has(c.id)) byId.set(c.id, c)
        }
        const parent = byId.get(item.parentIds[i])
        color = parent ? labelColor(parent, colorMap) : undefined
      }
      if (!color) {
        colorIndex = rotate(colorIndex + 1, GIT_HISTORY_LANE_COLORS.length)
        color = GIT_HISTORY_LANE_COLORS[colorIndex]
      }
      outputSwimlanes.push({ id: item.parentIds[i], color })
    }
    const references = (item.references || [])
      .map((ref) => {
        let color = colorMap.get(ref.id)
        if (colorMap.has(ref.id) && color === undefined) {
          const inputIndex = inputSwimlanes.findIndex((n) => n.id === item.id)
          const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length
          color =
            circleIndex < outputSwimlanes.length
              ? outputSwimlanes[circleIndex].color
              : circleIndex < inputSwimlanes.length
                ? inputSwimlanes[circleIndex].color
                : GIT_HISTORY_REF_COLOR
        }
        return { ...ref, color }
      })
      .sort((a, b) => compareGitHistoryRefs(a, b, currentRef, remoteRef, baseRef))
    viewModels.push({ historyItem: { ...item, references }, kind, inputSwimlanes, outputSwimlanes })
  }
  return viewModels
}

export function getGitHistoryItemLaneIndex(vm) {
  const i = vm.inputSwimlanes.findIndex((n) => n.id === vm.historyItem.id)
  return i !== -1 ? i : vm.inputSwimlanes.length
}

function findLastNodeIndex(nodes, id) {
  for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].id === id) return i
  return -1
}

// --- The row's SVG (git-history-graph-svg.tsx) ------------------------------------
export const SWIMLANE_HEIGHT = 24
const SWIMLANE_WIDTH = 11
const SWIMLANE_CURVE_RADIUS = 5
const SWIMLANE_NODE_Y = SWIMLANE_HEIGHT / 2
export const CIRCLE_RADIUS = 3.5
export const CIRCLE_STROKE_WIDTH = 1.5

export const graphColor = (color) => `var(--${color})`

// -> { width, paths: [{ key, d, color }], cx, cy, circleColor, isMerge }
export function gitHistoryGraphGeometry(vm) {
  const item = vm.historyItem
  const input = vm.inputSwimlanes
  const output = vm.outputSwimlanes
  const inputIndex = input.findIndex((n) => n.id === item.id)
  const circleIndex = getGitHistoryItemLaneIndex(vm)
  const circleColor =
    circleIndex < output.length ? output[circleIndex].color : circleIndex < input.length ? input[circleIndex].color : GIT_HISTORY_REF_COLOR
  const W = SWIMLANE_WIDTH
  const H = SWIMLANE_HEIGHT
  const R = SWIMLANE_CURVE_RADIUS
  const paths = []
  let outIndex = 0
  for (let index = 0; index < input.length; index++) {
    const color = input[index].color
    if (input[index].id === item.id) {
      if (index !== circleIndex) {
        paths.push({
          key: `base-${input[index].id}`,
          color,
          d: [`M ${W * (index + 1)} 0`, `A ${W} ${W} 0 0 1 ${W * index} ${SWIMLANE_NODE_Y}`, `H ${W * (circleIndex + 1)}`].join(' ')
        })
      } else outIndex++
      continue
    }
    if (outIndex < output.length && input[index].id === output[outIndex].id) {
      if (index === outIndex) paths.push({ key: `vertical-${input[index].id}`, color, d: `M ${W * (index + 1)} 0 V ${H}` })
      else
        paths.push({
          key: `shift-${input[index].id}-${output[outIndex].id}`,
          color,
          d: [
            `M ${W * (index + 1)} 0`,
            'V 6',
            `A ${R} ${R} 0 0 1 ${W * (index + 1) - R} ${H / 2}`,
            `H ${W * (outIndex + 1) + R}`,
            `A ${R} ${R} 0 0 0 ${W * (outIndex + 1)} ${H / 2 + R}`,
            `V ${H}`
          ].join(' ')
        })
      outIndex++
    }
  }
  for (let i = 1; i < item.parentIds.length; i++) {
    const parentId = item.parentIds[i]
    const p = findLastNodeIndex(output, parentId)
    if (p === -1) continue
    paths.push({
      key: `merge-parent-${parentId}`,
      color: output[p].color,
      d: [`M ${W * p} ${H / 2}`, `A ${W} ${W} 0 0 1 ${W * (p + 1)} ${H}`, `M ${W * p} ${H / 2}`, `H ${W * (circleIndex + 1)}`].join(' ')
    })
  }
  if (inputIndex !== -1) paths.push({ key: 'into-node', color: input[inputIndex].color, d: `M ${W * (circleIndex + 1)} 0 V ${H / 2}` })
  if (item.parentIds.length > 0) paths.push({ key: 'out-of-node', color: circleColor, d: `M ${W * (circleIndex + 1)} ${H / 2} V ${H}` })
  return {
    width: W * (Math.max(input.length, output.length, 1) + 1),
    height: H,
    paths,
    cx: W * (circleIndex + 1),
    cy: SWIMLANE_NODE_Y,
    circleColor,
    isMerge: item.parentIds.length > 1
  }
}

// --- Ref pills (git-history-ref-display.ts) ----------------------------------------
function splitRemoteBranchName(name) {
  const i = name.indexOf('/')
  if (i <= 0 || i === name.length - 1) return null
  return { remoteName: name.slice(0, i), branchName: name.slice(i + 1) }
}
const ambiguousRemoteRef = (name) => name.split('/').length > 2

// origin/feature is dropped when the local feature sits on the same commit.
export function dedupeRemoteTrackingRefs(refs, { preserveRefIds = [] } = {}) {
  const locals = new Set(refs.filter((r) => r.category === 'branches').map((r) => r.name))
  if (!locals.size) return [...refs]
  const preserve = new Set(preserveRefIds)
  const counts = new Map()
  for (const r of refs) {
    if (r.category !== 'remote branches' || ambiguousRemoteRef(r.name)) continue
    const s = splitRemoteBranchName(r.name)
    if (s && locals.has(s.branchName)) counts.set(s.branchName, (counts.get(s.branchName) || 0) + 1)
  }
  return refs.filter((r) => {
    if (r.category !== 'remote branches' || preserve.has(r.id) || ambiguousRemoteRef(r.name)) return true
    const s = splitRemoteBranchName(r.name)
    if (!s || !locals.has(s.branchName)) return true
    return counts.get(s.branchName) !== 1
  })
}

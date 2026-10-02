// Join command steps so each runs only if the previous one succeeded, in the
// syntax of the shell that will run them. Windows PowerShell 5.1 has no `&&`,
// so it gets `a; if ($?) { b }`.
export function chainCommands(steps, shellId) {
  const list = (Array.isArray(steps) ? steps : [steps])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
  if (list.length <= 1) return list[0] || ''
  if (shellId === 'powershell') {
    return list.reduceRight((rest, step) => (rest ? `${step}; if ($?) { ${rest} }` : step), '')
  }
  // cmd, PowerShell 7, Git Bash and WSL all understand &&.
  return list.join(' && ')
}

// Human-readable version for tooltips and lists.
export function describeSteps(steps) {
  return (Array.isArray(steps) ? steps : [steps]).filter(Boolean).join(', then ')
}

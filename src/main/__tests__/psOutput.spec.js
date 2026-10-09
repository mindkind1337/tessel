// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { cleanPsOutput } from '../psOutput'

describe('cleanPsOutput', () => {
  it('drops the CLIXML progress records after a native error and keeps its text', () => {
    const codex =
      "Caused by: OAuth token exchange failed: The 'redirect_uri' from this request does not match the one from the authorize request.\r\n"
    const clixml =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>'
    expect(cleanPsOutput(codex + clixml)).toBe(
      "Caused by: OAuth token exchange failed: The 'redirect_uri' from this request does not match the one from the authorize request."
    )
  })

  it('keeps PowerShell error records, decoded', () => {
    const text =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">codex : not found &amp; gone_x000D__x000A_</S><S S="Error">    + CategoryInfo : ObjectNotFound_x000D__x000A_</S></Objs>'
    expect(cleanPsOutput(text)).toBe('codex : not found & gone\n    + CategoryInfo : ObjectNotFound')
  })

  it('drops a block cut off at the end, and leaves plain text alone', () => {
    expect(cleanPsOutput('fine\n#< CLIXML\n<Objs Version="1.1.0.1"><Obj S="progress"')).toBe('fine')
    expect(cleanPsOutput('just text\n')).toBe('just text\n')
    expect(cleanPsOutput(null)).toBe('')
  })
})

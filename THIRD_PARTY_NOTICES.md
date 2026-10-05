# Third-party notices

Tessel includes or adapts the third-party material identified below. The original
copyright and permission notices are reproduced in full. Tessel's own license is
provided separately in [LICENSE](LICENSE).

## Orca

The Stats & Usage interface, related usage-report implementations, provider
visibility rules and subscription-quota collectors contain code and designs
adapted from Orca by Lovecast Inc.

- Project: https://github.com/stablyai/orca
- Reference revision: `433986fa3be37911a0f13f7ffd454b831b87a64c` (package version `1.4.214`)
- Referenced source: `src/renderer/src/components/stats`, related usage store and
  settings navigation, `src/main/claude-usage` / `src/main/codex-usage`,
  `src/main/rate-limits` (Gemini, Kimi, Cursor, Grok, OpenCode Go, MiniMax), and
  `src/renderer/src/components/status-bar/status-bar-provider-visibility.ts`;
  the SSH client (Tessel's `src/main/ssh`) adapts `src/main/ssh` (connection,
  sign-in ladder, known_hosts matching, host key decision and store)
- License source: https://github.com/stablyai/orca/blob/433986fa3be37911a0f13f7ffd454b831b87a64c/LICENSE

```text
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Lucide icons and Feather-derived portions

The Stats & Usage interface uses Lucide icons through `lucide-vue-next` version
`0.577.0`, matching the icon version in Orca's reference lockfile (`lucide-react`
`0.577.0`). Both packages declare the ISC license. The installed Vue package's
complete license also retains the MIT notice for portions derived from Feather,
reproduced below with the ISC notice.

- Project: https://github.com/lucide-icons/lucide
- Reference version: `0.577.0`
- Package metadata: `node_modules/lucide-vue-next/package.json`
- Installed license: `node_modules/lucide-vue-next/LICENSE`
- License source: https://github.com/lucide-icons/lucide/blob/0.577.0/LICENSE

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2026 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2026.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The MIT License (MIT) (for portions derived from Feather)

Copyright (c) 2013-2026 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## html-to-image

The Stats & Usage sharing feature uses `html-to-image` version `1.11.13` to
capture the share card as an image. The notice below is copied from the installed
package's license.

- Project: https://github.com/bubkoo/html-to-image
- Reference version: `1.11.13`
- Package metadata: `node_modules/html-to-image/package.json`
- Installed license: `node_modules/html-to-image/LICENSE`

```text
MIT License

Copyright (c) 2017-2025 W.Y.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Visual Studio Code

The agents' terminal tools (run_in_terminal, get_terminal_output,
send_to_terminal, kill_terminal, terminal_last_command, terminal_selection),
their command auto-approval rules, command line analysis, end-of-command
detection, input and secret prompt detection, output handling and the agent
terminals' shell integration are adapted from Visual Studio Code by Microsoft
Corporation.

- Project: https://github.com/microsoft/vscode
- Reference revision: `2dca67a07aba`
- Referenced source: `src/vs/workbench/contrib/terminalContrib/chatAgentTools`
  (tools, `commandLineAnalyzer/autoApprove`, `executeStrategy`,
  `tools/monitoring/outputMonitor.ts`, `outputHelpers.ts`,
  `runInTerminalHelpers.ts`, `common/terminalChatAgentToolsConfiguration.ts`),
  `src/vs/platform/terminal/common/autoApprove`,
  `src/vs/platform/terminal/common/xterm/shellIntegrationAddon.ts` and
  `src/vs/workbench/contrib/terminal/common/scripts` (shell integration);
  in Tessel: `src/main/agentTerminal.js`, `src/shared/terminalRules.js`,
  `src/shared/terminalOutput.js`, `src/renderer/src/agentTerminal` and
  `src/renderer/src/components/AgentCommandApproval.vue`
- License source: https://github.com/microsoft/vscode/blob/2dca67a07aba/LICENSE.txt

```text
MIT License

Copyright (c) 2015 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

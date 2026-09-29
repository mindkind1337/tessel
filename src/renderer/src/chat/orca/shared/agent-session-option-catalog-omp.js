/*
 * MIT License
 *
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { hasFlag } from "./agent-cli-flag-detection.js";
import { parseOmpModelList } from "./omp-model-list-probe.js";
function parseOmpCatalogModels(stdout) {
    return parseOmpModelList(stdout).map((model)=>({
            ...model,
            options: []
        }));
}
export const OMP_SESSION_OPTION_CATALOG = {
    models: [],
    modelApply: {
        launchArgs: (value)=>[
                '--model',
                String(value)
            ],
        agentArgsOverride: (tokens)=>hasFlag(tokens, [
                '--model'
            ]),
        midSession: {
            kind: 'command',
            build: (value)=>`/orca-model ${String(value)}` // i18n-ignore
        }
    },
    discoveredModelsAreAuthoritative: true,
    listModels: {
        command: 'omp models --json',
        parse: parseOmpCatalogModels
    }
};

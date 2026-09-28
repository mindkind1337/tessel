// Monaco, the editor of VS Code, set up once for Tessel's editor panes. Loaded
// only when an editor pane opens (loadMonaco.js), so Tessel's start does not
// carry it. Set up like Orca's monaco-setup.ts (MIT, Copyright (c) 2026
// Lovecast Inc.): its language workers bundled with the app (Vite ?worker),
// and the TypeScript / JavaScript diagnostics off.
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

globalThis.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  }
}

// Why (Orca): the worker cannot resolve the project's imports, so semantic
// checks report a long tail of false errors; syntax checks are noisy in the
// inline diff too. Colours (tokenization) stay.
const diagnostics = { noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true }
const ts = monaco.typescript
if (ts && ts.typescriptDefaults) {
  ts.typescriptDefaults.setDiagnosticsOptions(diagnostics)
  ts.javascriptDefaults.setDiagnosticsOptions(diagnostics)
  // .tsx / .jsx share the 'typescript' / 'javascript' ids: JSX allowed.
  ts.typescriptDefaults.setCompilerOptions({ ...ts.typescriptDefaults.getCompilerOptions(), jsx: ts.JsxEmit.Preserve })
  ts.javascriptDefaults.setCompilerOptions({ ...ts.javascriptDefaults.getCompilerOptions(), jsx: ts.JsxEmit.Preserve })
}

export { monaco }

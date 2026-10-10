const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const crypto = require("crypto");
const os = require("os");
const net = require("net");

const server = new Server(
  {
    name: "skills-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const TOOLS = [
  {
    name: "web_search",
    description: "Search the web for current information",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        numResults: { type: "number", description: "Number of results (default: 8)", default: 8 },
      },
      required: ["query"],
    },
  },
  {
    name: "file_read",
    description: "Read a file from the filesystem",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to file" },
        offset: { type: "number", description: "Line number to start from (1-indexed)", default: 1 },
        limit: { type: "number", description: "Maximum lines to read", default: 2000 },
      },
      required: ["filePath"],
    },
  },
  {
    name: "file_write",
    description: "Write content to a file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to file" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["filePath", "content"],
    },
  },
  {
    name: "file_edit",
    description: "Edit a file by replacing text",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to file" },
        oldString: { type: "string", description: "Text to replace" },
        newString: { type: "string", description: "Replacement text" },
        replaceAll: { type: "boolean", description: "Replace all occurrences", default: false },
      },
      required: ["filePath", "oldString", "newString"],
    },
  },
  {
    name: "file_glob",
    description: "Find files matching a glob pattern",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g., **/*.js)" },
        path: { type: "string", description: "Directory to search in", default: process.cwd() },
      },
      required: ["pattern"],
    },
  },
  {
    name: "file_grep",
    description: "Search file contents with regex",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern" },
        path: { type: "string", description: "Directory to search in", default: process.cwd() },
        include: { type: "string", description: "File pattern to include (e.g., *.js)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "git_status",
    description: "Get git status",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path", default: process.cwd() },
      },
    },
  },
  {
    name: "git_diff",
    description: "Get git diff",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path", default: process.cwd() },
        staged: { type: "boolean", description: "Show staged changes", default: false },
      },
    },
  },
  {
    name: "git_log",
    description: "Get git log",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path", default: process.cwd() },
        limit: { type: "number", description: "Number of commits", default: 10 },
      },
    },
  },
  {
    name: "git_commit",
    description: "Create a git commit",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path", default: process.cwd() },
        message: { type: "string", description: "Commit message" },
        files: { type: "array", items: { type: "string" }, description: "Files to stage" },
      },
      required: ["message"],
    },
  },
  {
    name: "azure_cli",
    description: "Run Azure CLI commands",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Azure CLI command (e.g., 'az group list')" },
        timeout: { type: "number", description: "Timeout in ms", default: 120000 },
      },
      required: ["command"],
    },
  },
  {
    name: "docker_run",
    description: "Run Docker commands",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Docker command (e.g., 'docker ps')" },
        timeout: { type: "number", description: "Timeout in ms", default: 120000 },
      },
      required: ["command"],
    },
  },
  {
    name: "shell_exec",
    description: "Execute shell commands",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute" },
        workdir: { type: "string", description: "Working directory", default: process.cwd() },
        timeout: { type: "number", description: "Timeout in ms", default: 120000 },
      },
      required: ["command"],
    },
  },
  {
    name: "npm_install",
    description: "Run npm install",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Package directory", default: process.cwd() },
        production: { type: "boolean", description: "Install production only", default: false },
      },
    },
  },
  {
    name: "npm_run",
    description: "Run npm script",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Script name" },
        path: { type: "string", description: "Package directory", default: process.cwd() },
      },
      required: ["script"],
    },
  },
  {
    name: "python_exec",
    description: "Execute Python code",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Python code to execute" },
        workdir: { type: "string", description: "Working directory", default: process.cwd() },
        timeout: { type: "number", description: "Timeout in ms", default: 60000 },
      },
      required: ["code"],
    },
  },
  {
    name: "http_request",
    description: "Make HTTP requests",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to request" },
        method: { type: "string", description: "HTTP method", default: "GET", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] },
        headers: { type: "object", description: "Request headers" },
        body: { type: "string", description: "Request body" },
        timeout: { type: "number", description: "Timeout in ms", default: 30000 },
      },
      required: ["url"],
    },
  },
  {
    name: "json_query",
    description: "Query JSON with jq-like syntax",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to JSON file" },
        query: { type: "string", description: "jq-style query (e.g., '.items[].name')" },
      },
      required: ["filePath", "query"],
    },
  },
  {
    name: "yaml_parse",
    description: "Parse YAML file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to YAML file" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "toml_parse",
    description: "Parse TOML file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to TOML file" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "zip_create",
    description: "Create zip archive",
    inputSchema: {
      type: "object",
      properties: {
        outputPath: { type: "string", description: "Output zip file path" },
        files: { type: "array", items: { type: "string" }, description: "Files to include" },
        cwd: { type: "string", description: "Working directory", default: process.cwd() },
      },
      required: ["outputPath", "files"],
    },
  },
  {
    name: "zip_extract",
    description: "Extract zip archive",
    inputSchema: {
      type: "object",
      properties: {
        zipPath: { type: "string", description: "Path to zip file" },
        outputDir: { type: "string", description: "Output directory" },
      },
      required: ["zipPath", "outputDir"],
    },
  },
  {
    name: "tar_create",
    description: "Create tar archive",
    inputSchema: {
      type: "object",
      properties: {
        outputPath: { type: "string", description: "Output tar file path" },
        files: { type: "array", items: { type: "string" }, description: "Files to include" },
        cwd: { type: "string", description: "Working directory", default: process.cwd() },
        gzip: { type: "boolean", description: "Compress with gzip", default: true },
      },
      required: ["outputPath", "files"],
    },
  },
  {
    name: "tar_extract",
    description: "Extract tar archive",
    inputSchema: {
      type: "object",
      properties: {
        tarPath: { type: "string", description: "Path to tar file" },
        outputDir: { type: "string", description: "Output directory" },
      },
      required: ["tarPath", "outputDir"],
    },
  },
  {
    name: "pdf_extract",
    description: "Extract text from PDF",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to PDF file" },
        pages: { type: "array", items: { type: "number" }, description: "Page numbers (1-indexed), empty = all" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "image_info",
    description: "Get image metadata",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to image file" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "base64_encode",
    description: "Encode to base64",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Text or file path to encode" },
        isFile: { type: "boolean", description: "Whether input is a file path", default: false },
      },
      required: ["input"],
    },
  },
  {
    name: "base64_decode",
    description: "Decode from base64",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Base64 string to decode" },
        outputFile: { type: "string", description: "Optional output file path" },
      },
      required: ["input"],
    },
  },
  {
    name: "hash_file",
    description: "Compute file hash",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to file" },
        algorithm: { type: "string", description: "Hash algorithm", enum: ["md5", "sha1", "sha256", "sha512"], default: "sha256" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "env_get",
    description: "Get environment variable",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Variable name" },
      },
      required: ["name"],
    },
  },
  {
    name: "env_set",
    description: "Set environment variable",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Variable name" },
        value: { type: "string", description: "Variable value" },
      },
      required: ["name", "value"],
    },
  },
  {
    name: "process_list",
    description: "List running processes",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by name" },
      },
    },
  },
  {
    name: "port_scan",
    description: "Scan local ports",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Host to scan", default: "localhost" },
        ports: { type: "array", items: { type: "number" }, description: "Ports to check" },
      },
    },
  },
  {
    name: "antigravity_skills_list",
    description: "List available antigravity skills",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter: words that must all appear in the skill's name or description (optional)" },
        limit: { type: "number", description: "Max skills to return (default 50, max 300)", default: 50 },
        offset: { type: "number", description: "Skip this many matches, for paging (default 0)", default: 0 },
      },
    },
  },
  {
    name: "antigravity_skill_load",
    description: "Load an antigravity skill by name",
    inputSchema: {
      type: "object",
      properties: {
        skillName: { type: "string", description: "Skill directory name" },
      },
      required: ["skillName"],
    },
  },
  {
    name: "antigravity_agents_list",
    description: "List available antigravity agent personas",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "antigravity_workflows_list",
    description: "List available antigravity workflow commands",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "antigravity_rules_get",
    description: "Get antigravity behavior rules",
    inputSchema: {
      type: "object",
      properties: {
        ruleFile: { type: "string", description: "Rule file name (optional)" },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// DuckDuckGo's HTML results page (its JSON "instant answer" API returns no
// results for ordinary queries).
async function handleWebSearch(args) {
  try {
    const n = Math.max(1, Math.min(Number(args.numResults) || 8, 25));
    const response = await axios.get("https://html.duckduckgo.com/html/", {
      params: { q: args.query },
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) skills-mcp" },
      timeout: 15000,
    });
    const html = String(response.data || "");
    const strip = (t) =>
      t
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
    const realUrl = (href) => {
      const m = /[?&]uddg=([^&]+)/.exec(href);
      return m ? decodeURIComponent(m[1]) : href.startsWith("//") ? `https:${href}` : href;
    };
    const results = [];
    const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets = [];
    let s;
    while ((s = snippetRe.exec(html))) snippets.push(strip(s[1]));
    let m;
    let i = 0;
    while ((m = linkRe.exec(html)) && results.length < n) {
      const url = realUrl(m[1]);
      const snippet = snippets[i++] || "";
      if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
      results.push({ title: strip(m[2]), url, snippet });
    }
    if (!results.length) return { content: [{ type: "text", text: `No results for "${args.query}".` }] };
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Web search error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
}

async function handleFileRead(args) {
  try {
    const content = fs.readFileSync(args.filePath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, (args.offset || 1) - 1);
    const end = Math.min(lines.length, start + (args.limit || 2000));
    const selected = lines.slice(start, end).map((line, i) => `${start + i + 1}: ${line}`).join("\n");
    return {
      content: [{ type: "text", text: selected }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `File read error: ${error.message}` }],
      isError: true,
    };
  }
}

async function handleFileWrite(args) {
  try {
    fs.mkdirSync(path.dirname(args.filePath), { recursive: true });
    fs.writeFileSync(args.filePath, args.content, "utf-8");
    return {
      content: [{ type: "text", text: `File written: ${args.filePath}` }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `File write error: ${error.message}` }],
      isError: true,
    };
  }
}

async function handleFileEdit(args) {
  try {
    const content = fs.readFileSync(args.filePath, "utf-8");
    let newContent;
    if (args.replaceAll) {
      newContent = content.split(args.oldString).join(args.newString);
    } else {
      if (!content.includes(args.oldString)) {
        throw new Error("oldString not found in content");
      }
      newContent = content.replace(args.oldString, args.newString);
    }
    fs.writeFileSync(args.filePath, newContent, "utf-8");
    return {
      content: [{ type: "text", text: `File edited: ${args.filePath}` }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `File edit error: ${error.message}` }],
      isError: true,
    };
  }
}

async function handleFileGlob(args) {
  try {
    const glob = require("glob");
    const files = glob.sync(args.pattern, { cwd: args.path || process.cwd(), absolute: true });
    return {
      content: [{ type: "text", text: files.join("\n") }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Glob error: ${error.message}` }],
      isError: true,
    };
  }
}

// Pure JS: Windows has no grep on node's PATH (every search answered "No
// matches found"), and building a shell command from the pattern was injectable.
async function handleFileGrep(args) {
  try {
    const glob = require("glob");
    const root = args.path || process.cwd();
    let re;
    try {
      re = new RegExp(args.pattern);
    } catch (e) {
      return { content: [{ type: "text", text: `Grep error: bad regex: ${e.message}` }], isError: true };
    }
    const MAX_MATCHES = 500;
    const MAX_FILE = 5 * 1024 * 1024;
    const files = fs.statSync(root).isFile()
      ? [root]
      : glob.sync(args.include ? `**/${args.include}` : "**/*", {
          cwd: root,
          absolute: true,
          nodir: true,
          ignore: ["**/node_modules/**", "**/.git/**"],
        });
    const out = [];
    for (const f of files) {
      let text;
      try {
        if (fs.statSync(f).size > MAX_FILE) continue;
        text = fs.readFileSync(f, "utf-8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue; // binary
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
        if (re.test(lines[i])) out.push(`${f}:${i + 1}:${lines[i].slice(0, 300)}`);
      }
      if (out.length >= MAX_MATCHES) break;
    }
    if (!out.length) return { content: [{ type: "text", text: "No matches found" }] };
    const more = out.length >= MAX_MATCHES ? `\n(stopped at ${MAX_MATCHES} matches)` : "";
    return { content: [{ type: "text", text: out.join("\n") + more }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Grep error: ${error.message}` }], isError: true };
  }
}

async function handleGitCommand(args, command) {
  try {
    const output = execSync(`git ${command}`, {
      cwd: args.path || process.cwd(),
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 10,
    });
    return { content: [{ type: "text", text: output }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Git error: ${error.message}` }],
      isError: true,
    };
  }
}

async function handleShellExec(args) {
  try {
    const output = execSync(args.command, {
      cwd: args.workdir || process.cwd(),
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 10,
      timeout: args.timeout || 120000,
    });
    return { content: [{ type: "text", text: output }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Shell error: ${error.message}` }],
      isError: true,
    };
  }
}

async function handleAzureCli(args) {
  const cmd = args.command.trim().startsWith("az ") ? args.command : `az ${args.command}`;
  return handleShellExec({ command: cmd, timeout: args.timeout });
}

async function handleDocker(args) {
  const cmd = args.command.trim().startsWith("docker ") ? args.command : `docker ${args.command}`;
  return handleShellExec({ command: cmd, timeout: args.timeout });
}

async function handleNpmInstall(args) {
  const cmd = `npm install${args.production ? " --production" : ""}`;
  return handleShellExec({ command: cmd, workdir: args.path });
}

async function handleNpmRun(args) {
  return handleShellExec({ command: `npm run ${args.script}`, workdir: args.path });
}

async function handlePythonExec(args) {
  try {
    const tmpFile = path.join(os.tmpdir(), `mcp-python-${Date.now()}.py`);
    fs.writeFileSync(tmpFile, args.code, "utf-8");
    const output = execSync(`python "${tmpFile}"`, {
      cwd: args.workdir || process.cwd(),
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 10,
      timeout: args.timeout || 60000,
    });
    fs.rmSync(tmpFile, { force: true });
    return { content: [{ type: "text", text: output }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Python error: ${error.message}` }], isError: true };
  }
}

async function handleHttpRequest(args) {
  try {
    const response = await axios({
      method: args.method || "GET",
      url: args.url,
      headers: args.headers || {},
      data: args.body,
      timeout: args.timeout || 30000,
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ status: response.status, headers: response.headers, data: response.data }, null, 2) }],
    };
  } catch (error) {
    return { content: [{ type: "text", text: `HTTP error: ${error.message}` }], isError: true };
  }
}

async function handleJsonQuery(args) {
  try {
    const content = fs.readFileSync(args.filePath, "utf-8");
    const data = JSON.parse(content);
    const query = args.query;

    function evaluate(data, query) {
      if (query === ".") return data;
      if (!/^\.(?:[A-Za-z_][A-Za-z0-9_]*|\[\d*\])(?:\[\d*\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(query))
        throw new Error("Unsupported query syntax");
      const tokens = query.slice(1).match(/[A-Za-z_][A-Za-z0-9_]*|\[\d*\]/g);
      let values = [data], expanded = false;
      for (const token of tokens) {
        if (token === "[]") {
          expanded = true;
          values = values.flatMap(value => {
            if (!Array.isArray(value)) throw new Error("[] requires an array");
            return value;
          });
        } else if (token.startsWith("[")) {
          const index = Number(token.slice(1, -1));
          values = values.map(value => Array.isArray(value) ? value[index] ?? null : null);
        } else {
          values = values.map(value => value !== null && typeof value === "object" &&
            Object.prototype.hasOwnProperty.call(value, token) ? value[token] : null);
        }
      }
      return expanded ? values : values[0] ?? null;
    }

    const result = evaluate(data, query);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `JSON query error: ${error.message}` }], isError: true };
  }
}

async function handleYamlParse(args) {
  try {
    const yaml = require("js-yaml");
    const content = fs.readFileSync(args.filePath, "utf-8");
    const data = yaml.load(content);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `YAML parse error: ${error.message}` }], isError: true };
  }
}

async function handleTomlParse(args) {
  try {
    const toml = require("@iarna/toml");
    const content = fs.readFileSync(args.filePath, "utf-8");
    const data = toml.parse(content);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `TOML parse error: ${error.message}` }], isError: true };
  }
}

async function handleZipCreate(args) {
  try {
    const AdmZip = require("adm-zip");
    const zip = new AdmZip();
    for (const file of args.files) {
      const fullPath = path.resolve(args.cwd || process.cwd(), file);
      if (fs.statSync(fullPath).isDirectory()) {
        zip.addLocalFolder(fullPath, path.basename(file));
      } else {
        zip.addLocalFile(fullPath);
      }
    }
    zip.writeZip(args.outputPath);
    return { content: [{ type: "text", text: `Zip created: ${args.outputPath}` }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Zip create error: ${error.message}` }], isError: true };
  }
}

async function handleZipExtract(args) {
  try {
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(args.zipPath);
    zip.extractAllTo(args.outputDir, true);
    return { content: [{ type: "text", text: `Extracted to: ${args.outputDir}` }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Zip extract error: ${error.message}` }], isError: true };
  }
}

async function handleTarCreate(args) {
  try {
    const tar = require("tar");
    await tar.c({ file: args.outputPath, gzip: args.gzip !== false, cwd: args.cwd || process.cwd() }, args.files);
    return { content: [{ type: "text", text: `Tar created: ${args.outputPath}` }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Tar create error: ${error.message}` }], isError: true };
  }
}

async function handleTarExtract(args) {
  try {
    const tar = require("tar");
    await tar.x({ file: args.tarPath, cwd: args.outputDir });
    return { content: [{ type: "text", text: `Extracted to: ${args.outputDir}` }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Tar extract error: ${error.message}` }], isError: true };
  }
}

async function handlePdfExtract(args) {
  try {
    const pdf = require("pdf-parse");
    const data = fs.readFileSync(args.filePath);
    const parsed = await pdf(data);
    let text = parsed.text;
    if (args.pages && args.pages.length > 0) {
      // pdf-parse doesn't easily support page selection, return all
    }
    return { content: [{ type: "text", text: text }] };
  } catch (error) {
    return { content: [{ type: "text", text: `PDF extract error: ${error.message}` }], isError: true };
  }
}

async function handleImageInfo(args) {
  try {
    const sharp = require("sharp");
    const metadata = await sharp(args.filePath).metadata();
    return { content: [{ type: "text", text: JSON.stringify(metadata, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Image info error: ${error.message}` }], isError: true };
  }
}

async function handleBase64Encode(args) {
  try {
    let buffer;
    if (args.isFile) {
      buffer = fs.readFileSync(args.input);
    } else {
      buffer = Buffer.from(args.input, "utf-8");
    }
    const encoded = buffer.toString("base64");
    return { content: [{ type: "text", text: encoded }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Base64 encode error: ${error.message}` }], isError: true };
  }
}

async function handleBase64Decode(args) {
  try {
    const buffer = Buffer.from(args.input, "base64");
    if (args.outputFile) {
      fs.writeFileSync(args.outputFile, buffer);
      return { content: [{ type: "text", text: `Decoded to file: ${args.outputFile}` }] };
    }
    return { content: [{ type: "text", text: buffer.toString("utf-8") }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Base64 decode error: ${error.message}` }], isError: true };
  }
}

async function handleHashFile(args) {
  try {
    const algorithm = args.algorithm || "sha256";
    const buffer = fs.readFileSync(args.filePath);
    const hash = crypto.createHash(algorithm).update(buffer).digest("hex");
    return { content: [{ type: "text", text: hash }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Hash error: ${error.message}` }], isError: true };
  }
}

async function handleEnvGet(args) {
  try {
    const value = process.env[args.name];
    return { content: [{ type: "text", text: value || "" }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Env get error: ${error.message}` }], isError: true };
  }
}

async function handleEnvSet(args) {
  try {
    process.env[args.name] = args.value;
    return { content: [{ type: "text", text: `Set ${args.name}=${args.value}` }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Env set error: ${error.message}` }], isError: true };
  }
}

async function handleProcessList(args) {
  try {
    let cmd;
    if (process.platform === "win32") {
      cmd = `tasklist /FO CSV${args.filter ? ` /FI "IMAGENAME eq ${args.filter}*"` : ""}`;
    } else {
      cmd = `ps aux${args.filter ? ` | grep ${args.filter}` : ""}`;
    }
    const output = execSync(cmd, { encoding: "utf-8", maxBuffer: 1024 * 1024 * 10 });
    return { content: [{ type: "text", text: output }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Process list error: ${error.message}` }], isError: true };
  }
}

async function handlePortScan(args) {
  try {
    const host = args.host || "localhost";
    const ports = args.ports || [80, 443, 3000, 8080, 5432, 3306, 27017, 6379];
    const results = await Promise.all(
      ports.map((port) =>
        new Promise((resolve) => {
          const socket = new net.Socket();
          socket.setTimeout(1000);
          socket.on("connect", () => { socket.destroy(); resolve({ port, open: true }); });
          socket.on("timeout", () => { socket.destroy(); resolve({ port, open: false }); });
          socket.on("error", () => { resolve({ port, open: false }); });
          socket.connect(port, host);
        })
      )
    );
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Port scan error: ${error.message}` }], isError: true };
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "web_search":
      return handleWebSearch(args);
    case "file_read":
      return handleFileRead(args);
    case "file_write":
      return handleFileWrite(args);
    case "file_edit":
      return handleFileEdit(args);
    case "file_glob":
      return handleFileGlob(args);
    case "file_grep":
      return handleFileGrep(args);
    case "git_status":
      return handleGitCommand(args, "status");
    case "git_diff":
      return handleGitCommand(args, args.staged ? "diff --staged" : "diff");
    case "git_log":
      return handleGitCommand(args, `log --oneline -${args.limit || 10}`);
    case "git_commit":
      if (!args.files || args.files.length === 0) {
        return { content: [{ type: "text", text: "git_commit requires explicit files array" }], isError: true };
      }
      const { spawn } = require("child_process");
      const cwd = args.path || process.cwd();
      await new Promise((resolve, reject) => {
        const add = spawn("git", ["add", ...args.files], { cwd });
        add.on("close", (code) => code === 0 ? resolve() : reject(new Error("git add failed")));
        add.on("error", reject);
      });
      await new Promise((resolve, reject) => {
        const commit = spawn("git", ["commit", "-m", args.message, "--", ...args.files], { cwd });
        commit.on("close", (code) => code === 0 ? resolve() : reject(new Error("git commit failed")));
        commit.on("error", reject);
      });
      return { content: [{ type: "text", text: `Committed: ${args.files.join(", ")}` }] };
    case "azure_cli":
      return handleAzureCli(args);
    case "docker_run":
      return handleDocker(args);
    case "shell_exec":
      return handleShellExec(args);
    case "npm_install":
      return handleNpmInstall(args);
    case "npm_run":
      return handleNpmRun(args);
    case "python_exec":
      return handlePythonExec(args);
    case "http_request":
      return handleHttpRequest(args);
    case "json_query":
      return handleJsonQuery(args);
    case "yaml_parse":
      return handleYamlParse(args);
    case "toml_parse":
      return handleTomlParse(args);
    case "zip_create":
      return handleZipCreate(args);
    case "zip_extract":
      return handleZipExtract(args);
    case "tar_create":
      return handleTarCreate(args);
    case "tar_extract":
      return handleTarExtract(args);
    case "pdf_extract":
      return handlePdfExtract(args);
    case "image_info":
      return handleImageInfo(args);
    case "base64_encode":
      return handleBase64Encode(args);
    case "base64_decode":
      return handleBase64Decode(args);
    case "hash_file":
      return handleHashFile(args);
    case "env_get":
      return handleEnvGet(args);
    case "env_set":
      return handleEnvSet(args);
    case "process_list":
      return handleProcessList(args);
    case "port_scan":
      return handlePortScan(args);
    case "antigravity_skills_list":
      return handleAntigravitySkillsList(args);
    case "antigravity_skill_load":
      return handleAntigravitySkillLoad(args);
    case "antigravity_agents_list":
      return handleAntigravityAgentsList(args);
    case "antigravity_workflows_list":
      return handleAntigravityWorkflowsList(args);
    case "antigravity_rules_get":
      return handleAntigravityRulesGet(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function handleAntigravitySkillsList(args) {
  try {
    const skillsPath = "C:\\Users\\cedri\\.config\\opencode\\antigravity\\skills";
    const entries = fs.readdirSync(skillsPath, { withFileTypes: true });
    const skills = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const skillPath = path.join(skillsPath, e.name);
        const skillMd = path.join(skillPath, "SKILL.md");
        let description = "";
        if (fs.existsSync(skillMd)) {
          const content = fs.readFileSync(skillMd, "utf-8");
          const descMatch = content.match(/^description:\s*(.+)$/m);
          if (descMatch) description = descMatch[1].trim();
        }
        return { name: e.name, description };
      });
    // Compact and paged: the full list (~670 skills) was 166k characters,
    // more than an agent's tool output can hold.
    const words = String(args.category || "").toLowerCase().split(/\s+/).filter(Boolean);
    const matched = words.length ? skills.filter((s) => words.every((w) => `${s.name} ${s.description}`.toLowerCase().includes(w))) : skills;
    const limit = Math.max(1, Math.min(Number(args.limit) || 50, 300));
    const offset = Math.max(0, Number(args.offset) || 0);
    const page = matched.slice(offset, offset + limit);
    const lines = page.map((s) => `${s.name}: ${s.description.replace(/^"|"$/g, "").slice(0, 160)}`);
    const head = `${matched.length} skill(s)${words.length ? ` matching "${words.join(" ")}"` : ""}; showing ${page.length ? offset + 1 : 0}-${offset + page.length}.`;
    const tail = offset + page.length < matched.length ? `\nMore: call again with offset ${offset + page.length}.` : "";
    return { content: [{ type: "text", text: `${head}\n${lines.join("\n")}${tail}` }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Antigravity skills list error: ${error.message}` }], isError: true };
  }
}

async function handleAntigravitySkillLoad(args) {
  try {
    const skillPath = path.join("C:\\Users\\cedri\\.config\\opencode\\antigravity\\skills", args.skillName);
    if (!fs.existsSync(skillPath)) {
      return { content: [{ type: "text", text: `Skill not found: ${args.skillName}` }], isError: true };
    }
    const skillMd = path.join(skillPath, "SKILL.md");
    if (!fs.existsSync(skillMd)) {
      return { content: [{ type: "text", text: `SKILL.md not found in ${args.skillName}` }], isError: true };
    }
    const content = fs.readFileSync(skillMd, "utf-8");
    return { content: [{ type: "text", text: content }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Antigravity skill load error: ${error.message}` }], isError: true };
  }
}

async function handleAntigravityAgentsList(args) {
  try {
    const agentsPath = "C:\\Users\\cedri\\.config\\opencode\\antigravity\\agents";
    const entries = fs.readdirSync(agentsPath, { withFileTypes: true });
    const agents = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => {
        const agentPath = path.join(agentsPath, e.name);
        const content = fs.readFileSync(agentPath, "utf-8");
        const descMatch = content.match(/^description:\s*(.+)$/m);
        const name = e.name.replace(".md", "");
        return { name, description: descMatch ? descMatch[1].trim() : "" };
      });
    return { content: [{ type: "text", text: JSON.stringify(agents, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Antigravity agents list error: ${error.message}` }], isError: true };
  }
}

async function handleAntigravityWorkflowsList(args) {
  try {
    const workflowsPath = "C:\\Users\\cedri\\.config\\opencode\\antigravity\\global_workflows";
    const entries = fs.readdirSync(workflowsPath, { withFileTypes: true });
    const workflows = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => {
        const workflowPath = path.join(workflowsPath, e.name);
        const content = fs.readFileSync(workflowPath, "utf-8");
        const descMatch = content.match(/^description:\s*(.+)$/m);
        const desc = descMatch ? descMatch[1].trim() : "";
        return { name: e.name.replace(".md", ""), description: desc, file: e.name };
      });
    return { content: [{ type: "text", text: JSON.stringify(workflows, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Antigravity workflows list error: ${error.message}` }], isError: true };
  }
}

async function handleAntigravityRulesGet(args) {
  try {
    const rulesPath = "C:\\Users\\cedri\\.config\\opencode\\antigravity\\rules";
    if (args.ruleFile) {
      const ruleFile = path.join(rulesPath, args.ruleFile);
      if (!fs.existsSync(ruleFile)) {
        return { content: [{ type: "text", text: `Rule file not found: ${args.ruleFile}` }], isError: true };
      }
      const content = fs.readFileSync(ruleFile, "utf-8");
      return { content: [{ type: "text", text: content }] };
    }
    const entries = fs.readdirSync(rulesPath, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Antigravity rules get error: ${error.message}` }], isError: true };
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Skills MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
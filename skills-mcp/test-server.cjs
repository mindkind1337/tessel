const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

async function testServer() {
  console.log("Starting MCP server test...");
  let exitCode = 1;

  const transport = new StdioClientTransport({
    command: "node",
    args: ["server.cjs"],
    cwd: __dirname,
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    console.log("Connected to server");

    const tools = await client.listTools();
    console.log("Available tools:", tools.tools.map((t) => t.name).join(", "));

    // Test file_read
    const result = await client.callTool({
      name: "file_read",
      arguments: { filePath: path.join(__dirname, "package.json") },
    });
    console.log("file_read test:", result.content[0].text.substring(0, 100) + "...");
    if (!result.content[0].text.includes("skills-mcp-server")) throw new Error("file_read content mismatch");

    // Test file_glob
    const globResult = await client.callTool({
      name: "file_glob",
      arguments: { pattern: "*.cjs" },
    });
    console.log("file_glob test:", globResult.content[0].text);
    if (!globResult.content[0].text.includes("server.cjs")) throw new Error("file_glob content mismatch");

    // Test shell_exec
    const shellResult = await client.callTool({
      name: "shell_exec",
      arguments: { command: "echo hello" },
    });
    console.log("shell_exec test:", shellResult.content[0].text);
    if (!shellResult.content[0].text.includes("hello")) throw new Error("shell_exec content mismatch");

    // Test antigravity_agents_list (P2 fix)
    const agentsResult = await client.callTool({
      name: "antigravity_agents_list",
      arguments: {},
    });
    console.log("antigravity_agents_list test:", agentsResult.content[0].text.substring(0, 200) + "...");
    const agents = JSON.parse(agentsResult.content[0].text);
    if (!Array.isArray(agents) || agents.length === 0) throw new Error("antigravity_agents_list returned empty");
    if (!agents.some(a => a.name === "backend-specialist")) throw new Error("missing expected agent");

    // Test json_query .items[].name (P2 fix)
    const testJson = { items: [{ name: "A" }, { name: "B" }] };
    const testJsonPath = path.join(__dirname, "test-json-query.json");
    fs.writeFileSync(testJsonPath, JSON.stringify(testJson));
    try {
      const jsonResult = await client.callTool({
        name: "json_query",
        arguments: { filePath: testJsonPath, query: ".items[].name" },
      });
      console.log("json_query .items[].name test:", jsonResult.content[0].text);
      const jsonValue = JSON.parse(jsonResult.content[0].text);
      if (!Array.isArray(jsonValue) || jsonValue.length !== 2 || jsonValue[0] !== "A" || jsonValue[1] !== "B") {
        throw new Error("json_query .items[].name failed: " + JSON.stringify(jsonValue));
      }
    } finally {
      fs.unlinkSync(testJsonPath);
    }

    // Test git_commit P1 fix - isolated temp repo with unrelated staged file
    const gitTestDir = path.join(__dirname, "git-test-repo");
    try {
      if (fs.existsSync(gitTestDir)) fs.rmSync(gitTestDir, { recursive: true, force: true });
      fs.mkdirSync(gitTestDir);
      
      // Initialize git repo
      await runCmd("git", ["init"], gitTestDir);
      await runCmd("git", ["config", "user.email", "test@test.com"], gitTestDir);
      await runCmd("git", ["config", "user.name", "Test"], gitTestDir);
      
      // Create unrelated file and stage it
      fs.writeFileSync(path.join(gitTestDir, "unrelated.txt"), "unrelated");
      await runCmd("git", ["add", "unrelated.txt"], gitTestDir);
      
      // Create requested file
      fs.writeFileSync(path.join(gitTestDir, "requested.txt"), "requested");
      
      // Commit only requested.txt via MCP
      const commitResult = await client.callTool({
        name: "git_commit",
        arguments: { path: gitTestDir, message: "commit requested", files: ["requested.txt"] },
      });
      console.log("git_commit test:", commitResult.content[0].text);
      if (commitResult.isError) throw new Error("git_commit failed: " + commitResult.content[0].text);
      
      // Verify HEAD contains only requested.txt
      const logResult = await runCmd("git", ["log", "--oneline", "-1"], gitTestDir);
      if (!logResult.includes("commit requested")) throw new Error("commit not found in log");
      
      // Verify unrelated.txt is still staged (not committed)
      const statusResult = await runCmd("git", ["status", "--porcelain"], gitTestDir);
      if (!statusResult.includes("A  unrelated.txt")) throw new Error("unrelated.txt not staged: " + statusResult);
      
      console.log("git_commit P1 fix verified: only requested.txt committed, unrelated.txt remains staged");
    } finally {
      if (fs.existsSync(gitTestDir)) fs.rmSync(gitTestDir, { recursive: true, force: true });
    }

    console.log("All tests passed!");
    exitCode = 0;
  } catch (error) {
    console.error("Test failed:", error);
    exitCode = 1;
  } finally {
    try { await client.close(); } catch {}
    process.exit(exitCode);
  }
}

function runCmd(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd });
    let stdout = "", stderr = "";
    proc.stdout.on("data", d => stdout += d);
    proc.stderr.on("data", d => stderr += d);
    proc.on("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `exit ${code}`)));
    proc.on("error", reject);
  });
}

testServer();
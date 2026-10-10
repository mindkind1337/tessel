const { spawn } = require("child_process");

const server = spawn("node", ["server.cjs"], {
  cwd: __dirname,
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";

server.stdout.on("data", (data) => {
  buffer += data.toString();
  let lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (line.trim()) {
      try {
        const msg = JSON.parse(line);
        console.log("SERVER:", JSON.stringify(msg, null, 2));
      } catch (e) {
        console.log("SERVER (raw):", line);
      }
    }
  }
});

server.stderr.on("data", (data) => {
  console.log("STDERR:", data.toString());
});

function send(msg) {
  const json = JSON.stringify(msg);
  console.log("CLIENT:", json);
  server.stdin.write(json + "\n");
}

setTimeout(() => {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } });
}, 500);

setTimeout(() => {
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
}, 1000);

setTimeout(() => {
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "file_read", arguments: { filePath: __dirname + "/package.json" } } });
}, 1500);

setTimeout(() => {
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "shell_exec", arguments: { command: "echo hello" } } });
}, 2000);

setTimeout(() => {
  server.kill();
  process.exit(0);
}, 5000);
// The Vue app's client of tessel-host (the Rust daemon on an SSH host that
// serves file trees, git status, an editor and terminals over one SSH exec
// channel). This folder is TypeScript, strict (tsconfig.host.json); the
// protocol it speaks is crates/host-protocol/PROTOCOL.md of the tessel-host
// repository, and the recorded sessions in __tests__/fixtures are replayed
// against it.
export { Client, DEFAULT_OPTIONS } from './client'
export type { ClientOptions, ConnectionState, Resumable } from './client'
export { Link, Opening } from './link'
export type { Connector, Pipe, StreamHandler, StreamItem } from './link'
export { pipeFromDuplex, pipeFromStreams, pipePair } from './pipe'
export { Tree } from './tree'
export type { Entry, EntryKind, Listing, RootOpened, StaleReason, TreeChanged, TreeEvent } from './tree'
export { Git } from './git'
export type { GitBranch, GitChanged, GitEntry, GitEntryKind, GitEvent, GitOpened, GitState, UntrackedList } from './git'
export { archFromUname, archTarget, artifactFor, checkVersion, commands, matches, parseDigest, parseManifest, plan, sha256Hex } from './install'
export type { Arch, Artifact, Manifest, Plan } from './install'
export { labelOf, nameOf, pathKey, relPathOf, relPathText, samePath, startsWith, isRelPath } from './paths'
export type { RelPath } from './paths'
export { FrameError, FrameReader, HostError, LinkError, MAX_FRAME_BYTES, PROTOCOL_VERSION, SLOW_HOST, decodeFrame, encodeFrame, isConnectionLost } from './wire'
export type { Budgets, Capability, ClientFrame, HelloOk, HostFrame, HostInfo, Message, WireError } from './wire'

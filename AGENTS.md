# Rules for agents working in this repository

These apply to every agent that pushes to this repository, whichever tool it runs on.

## Keep the README current

Every push that adds, changes or removes something a user can see updates
`README.md` in the same push, without being asked:

- Write it in English, in the matching section of **Features**.
- Correct or remove any sentence the change makes false.
- A bug fix with nothing a user would read about needs no README line.
- Say in your report that the README was updated.

## Leave the release version alone

`version` in `package.json` belongs to releases. Do not change it for a normal
fix or feature: only change it when the user asks for a release.

Tessel's header shows a build number beside the version, like `1.17.2 b1692`,
which comes from git and goes up by itself with every commit. After each push,
give the user the build so they know which code is running:

```sh
git rev-list --count HEAD      # the number after the "b"
git rev-parse --short=7 HEAD   # the commit
```

Report it as `b1692 (8e8df0d)`.

# node

Toolchain for Node.js projects, forked from `dagger.io/js/node` to add
user-facing checks for Node's built-in test runner.

Upstream is import-only: `jest`, and the other JS modules, depend on it for
`base` and the install helpers, but it exposes no check of its own and does
not appear in `dagger module search`. This fork adds `projects`, `test` and
`testAll`.

## Discovery: why there is no marker file

Every other JS test module is found by a config file. `jest.config.*`,
`vitest.config.*`, `.mocharc.*`. node:test has none, and never will: it is
part of the standard library and is configured entirely by flags.

`node.config.json` does exist, and does have a `test` namespace. It is not a
usable marker:

- it is not read unless you pass `--experimental-default-config-file`
- both flags are still experimental, verified on Node 26
- it is almost never present, so its absence proves nothing

package.json is the only file, and it marks every npm package rather than a
node:test project. So the marker has to be the content of its test script:

```
"test": "node --test test/*.test.ts"
```

Matched with this pattern, in Rust regex as `Workspace.search` expects:

```
"test"\s*:\s*"[^"]*\bnode\b[^"]*\s--test\b
```

That is also the honest signal. Whatever `scripts.test` invokes is the
command CI has to run, whether or not a config file happens to sit beside it.

## Grep alone is not enough

Searching this pattern across a repository finds matches inside
`node_modules`. It did on the first project tried: a dependency's own
package.json matched.

So discovery is rooted, not grepped. `findRoots` gives the project
directories, and the search result is used only to filter them:

```dang
let hits = ws.search(pattern: testScriptPattern, globs: ["**/package.json"], filesOnly: true)
ws.findRoots(markers: ["package.json"], exclude: ignore) ... keep those whose package.json is in hits
```

## Running the tests

`test` runs the project's own test script, not a reconstructed command line.
The script is what the project means by "test", and rebuilding its flags here
would only drift from it.

```sh
dagger -m . call projects     # which projects were found
dagger -m . call test-all     # the check
dagger -m . call test --path sub
```

## Two upstream bugs found while forking

**The module cannot be called directly.** `dagger call` against unmodified
`dagger.io/js/node` fails:

```
Unknown argument "id" on field "Query.node"
```

`Query.node` collides with an existing schema field, so a module named `node`
has no reachable entry point. This is very likely why it is import-only:
`jest` aliases it to `nodejs` in its dependencies, which sidesteps the clash.
This fork is named `nodejs` for the same reason.

**A type name that differs in case fails silently.** With
`"name": "nodejs"` and `type NodeJs`, the module loads without error and
`dagger functions` reports "No functions found". `type Nodejs` works. A
mismatch should be an error, not an empty schema.

## Recommending the module

`recommend(ws)` returns the paths that suggest installing this module: every
package.json whose test script invokes the runner. It mirrors the shape the
engine's own module recommendations use, where each entry returns the
workspace paths that suggest it.

```sh
dagger -m . call recommend     # package.json
```

It has no special meaning to Dagger today. It is here so the detection logic
lives with the module it detects, rather than in a table inside the engine.
Most entries in that table are a glob over a config filename, which cannot
work here; `mochajs` already needs the same treatment, since a `mocha` key in
package.json is content rather than a filename.

`projects` is built on it, so the match is defined once.

Pruning happens in the function rather than in the query: `!` negation in
`globs` is not honoured by `Workspace.search`, and `skipIgnored` did not
exclude `node_modules` either.

# Ousel event contract (v3)

Ousel receives events over `POST /ingest`; it never launches or controls agents.
This contract is the boundary between the viewer and any integration.

## Existing fields (unchanged)

`actor` and `action` are required. `session`, `provider`, `target`, `parent`,
`summary`, `status`, `verdict`, `issues`, and `detail` keep their v2 meaning.
Unknown top-level keys still fold into `detail`.

## New optional fields

| Field     | Type                                                              | Meaning                                                                                                                                                                                     |
| --------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`  | `captured` \| `reported` \| `synthetic`                           | How Ousel learned this. Absent means `reported` for backward compatibility. `inferred` is never stored.                                                                                     |
| `project` | string (200)                                                      | Project identity. Absent means legacy/unassigned.                                                                                                                                           |
| `task`    | string (200)                                                      | Shared task identity within the project. Absent means legacy/unassigned.                                                                                                                    |
| `files`   | array (50) of `{ path, change? }`                                 | References to changed files. `path` required, 1000 chars. `change` is free-form, 40 chars (`added`, `modified`, `deleted`, …).                                                              |
| `checks`  | array (20) of `{ name, result, evidence, command?, durationMs? }` | Validation evidence. `name` and `result` required (200/40 chars). `evidence` is `captured` or `reported`; absent means `reported`. `command` 1000 chars, `durationMs` non-negative integer. |

Limits follow the existing validation style: over-long strings are truncated,
structural errors reject the event with a reason, and no credentials are stored.

## Meaning of `source`

- **captured** — produced by an integration that observed the host (for example a
  Claude Code hook seeing a tool result). It is not a claim by a model.
- **reported** — explicitly posted by an agent or by Maki through `/ingest`.
  Reports are useful and often the only available evidence, but they are claims.
- **synthetic** — demo or fixture data. Always labeled, never mixed silently.
- **inferred** — never stored. The viewer may derive "quiet / status unknown"
  from inactivity, and must label it as inferred. Silence never proves `blocked`.

## Evidence rules the viewer must express

- A reviewer verdict is a decision, not proof that tests ran.
- An agent saying "tests passed" is `reported`. A captured command result is
  `checks[].evidence = "captured"`.
- `status: "blocked"` means a participant explicitly reported a blocker.
- Approval with no captured checks must show that gap rather than imply validation.

## Integration shape

Automatic capture: a Claude Code hook reads the hook payload on stdin and POSTs
one event per meaningful lifecycle step with `source: "captured"`. It must exit
0 on every failure, use a short timeout, and never block the coding session.

Explicit reporting: any process may POST `source: "reported"` events. Handoffs,
review verdicts, and blockers that no integration can observe use this path.

## Compatibility

- `POST /ingest`, `GET /api/events` (SSE), and `GET /api/bootstrap` keep working.
- The local action token header accepts `x-ousel-token` and the legacy
  `x-agentops-token`.
- `GET /api/health` returns `{ ok, version, latestId, total }` for diagnostics.
- Existing AgentOps databases are migrated in place: new columns are added,
  old rows read as `source = "reported"` with empty `files`/`checks`.

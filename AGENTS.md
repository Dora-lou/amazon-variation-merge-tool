# Amazon Operations Workspace

Before analyzing Amazon operations work in this project, read the shared rules in
`business_context/operations_rules.yaml` and the schema in
`business_context/context_schema.json`.

The local runtime context is stored outside the repository at:

`%LOCALAPPDATA%\\AmazonOperationsWorkspace\\context\\`

When it exists, read `local_context.json` and the relevant confirmed records in
`decisions.jsonl`. Treat `confirmed`, `temporary`, and `needs_review` as distinct
states. Only confirmed rules and the current confirmed task Scope may be used for
a formal sales-plan conclusion.

Every product, inventory, and sales observation must remain scoped by:

`store_id + marketplace + ASIN/SKU/MSKU/FNSKU`

The same ASIN in different stores is a different business product. Never fill a
missing MSKU, FNSKU, inventory, sales value, or cost from another store, and never
convert missing data to zero. If the store is not confirmed, a formal sales plan
must be blocked.

Do not read, copy, print, or persist MCP tokens, cookies, HTTP headers, account
credentials, or other secrets. The Python Agent is the host-side read-only
collector; Codex analysis must preserve `--ignore-user-config`, `--ephemeral`,
`--sandbox read-only`, and `--ask-for-approval never`.

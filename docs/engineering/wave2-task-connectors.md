# Wave 2 task connector options

The supplied plan names GitHub, GitLab, Notion, and Trello as community tools. Which unmet workflow matters most remains unverified. This Step 7 study supports a later choice. New writes depend on the [Wave 1 GitHub write gate](wave1-write-proof.md).

## Current local behavior

Notion supports title search and page reads only. [The reader](../../src/integrations/notion-reader.ts) caps search at 100 pages, reads at 100 direct blocks, and extracted text at 100,000 characters. It reports partial coverage and excludes nested blocks, attachments, and linked pages. It pins `Notion-Version: 2026-03-11` and checks access around requests. [The catalog](../../src/integrations/catalog.ts) exposes no Notion writes or Trello connector.

[Disconnect](../../src/integrations/index.ts) erases local credentials and increments their version without revoking provider access. [Connector design](connector-design.md) requires Read content only. Provider revocation webhooks are absent. Source inspection establishes local behavior, not live account behavior.

## Official API options

Provider documentation checked on 2026-10-09. These operations are not implemented Asmo tools.

| Operation | Notion | Trello |
| --- | --- | --- |
| Deeper reads | Block children are paginated and require recursion for nested content. [Block children](https://developers.notion.com/reference/get-block-children) | Cards expose name, description, and status. Actions and checklists have separate reads. [Cards API](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) |
| Create a task | `POST /v1/pages` creates a page under a page or data source. Task properties must match the data source schema. Requires Insert content. [Create page](https://developers.notion.com/reference/post-page), [capabilities](https://developers.notion.com/reference/capabilities) | `POST /cards` requires `idList` and supports `name` and `desc`. OAuth 2.0 requires `write:board:trello`. [Create card](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/#api-cards-post) |
| Edit or update | Page updates change properties. Block edits use separate endpoints. Requires Update content. [Update page](https://developers.notion.com/reference/patch-page), [update block](https://developers.notion.com/reference/update-a-block) | `PUT /cards/{id}` supports name, description, list, and due-date changes. [Update card](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/#api-cards-id-put) |

Notion public OAuth lets users select pages. Content capabilities govern the allowed operations. Users can remove page access or disconnect in Notion settings. [Authorization](https://developers.notion.com/guides/get-started/authorization), [manage connections](https://www.notion.com/help/add-and-manage-connections-with-the-api).

Trello documents OAuth 2.0 consent, expiring tokens, refresh, and granular scopes. Asmo would need registration and a tested authorization flow. Provider token revocation is separate from local disconnect. [OAuth 2.0](https://developer.atlassian.com/cloud/trello/guides/rest-api/oauth-2-getting-started/), [confidential client](https://developer.atlassian.com/cloud/trello/guides/rest-api/oauth-2-confidential-client-usage/), [revoke token](https://support.atlassian.com/trello/docs/revoking-a-trello-token/).

## Unknown-write recovery

Notion documents writes that save but return 503. For page creation, `additional_data.committed_resource_id` identifies the saved page. Block append uses the parent ID plus `committed_child_ids`. Existing-object updates omit the resource ID because the caller already knows it. Inspect `retry_guidance` and read the object instead of repeating a saved write. [Write retry guidance](https://developers.notion.com/reference/request-limits#retry-a-write-that-returns-503).

This proves saved-write recovery, not a need for a generic `partial_confirmed` union. Current [reconciliation](../../src/core.ts) has `found`, `absent`, and `unknown`. A page-create proof must preserve the ID and verify the parent, reviewed properties, and content before returning `found`. Incomplete content remains unresolved. Extend shared outcomes only if an operation proof shows that existing outcomes cannot express required behavior. Losing the whole response also loses the ID and needs separate recovery proof.

The inspected Trello card reference does not document an idempotency key or a committed-resource recovery signal. Do not infer safe creation retries. A future lost-response proof needs a reviewed correlation marker and bounded lookup in the selected destination. No match alone does not prove absence. Revoked access must leave recovery unresolved, without a duplicate create.

## Conditional recommendation

If truncated Notion context blocks useful answers, first add bounded pagination and nested-block reads with explicit coverage limits. If the community needs Notion task capture, first prove creation in one selected data source with fixed reviewed properties. Defer arbitrary page editing.

If Trello task capture is the actual need, its first viable write is one reviewed card with `name` and `desc` in one selected list. Prove authorization, current list access, revocation, and lost-response recovery before exposing it. Defer card moves, checklists, and a connector framework. Route GitLab writes to a later study after the existing GitHub gate.

Effort remains unestimated. Notion authorization reuse may reduce work, but schema mapping and recovery are unproved. Trello needs registration, credentials, grants, and lifecycle handling. Estimate after a narrow operation proof and an actual community request. This study made no live API calls, account changes, or production changes.

# Privacy policy — Rossum SA extension

Last updated: 2026-08-19

This is a community project supported by enthusiasts and volunteers, not an
official Rossum product.

## What the extension stores on your device

Your feature toggles, per-tab navigation state (which Console app and collection
you had open), and the ids of annotations you recently opened in the Rossum UI.
All of it stays in your browser. None of it is transmitted anywhere.

While you use the Rossum Console or the DevTools panel, the extension calls the
Rossum API of the organisation you are signed in to, using your own session
token, to show you your own data. Nothing from those calls is transmitted anywhere else.

## Usage data — off unless you turn it on

Usage data reports **which of the extension's own features you use**, so unused
features get removed instead of maintained and useful ones get improved. It is off
by default and does nothing until you enable it in the extension popup. Turning it
off deletes both random identifiers described below, so a later re-enable cannot be
linked to earlier data.

When it is on, each usage event is one request to Google Analytics 4
containing exactly:

- the event name — one of the names listed below, and nothing else;
- the extension version (a short git commit hash);
- a random identifier, created the first time an event is sent after you enable
  usage data, and stored on your device;
- a random per-browser-session identifier.

The request is an ordinary HTTPS request, so Google receives your IP address at
the network layer as it would for any web request. Google's Measurement Protocol
does not include geolocation in the resulting data.

### Never sent

- any URL, hostname or organisation domain
- your name, e-mail address, username or API token
- any queue, workspace, hook, schema, rule, label, engine, collection, dataset,
  annotation or document identifier, name or content
- any query, aggregation pipeline, prompt or chat message
- for the onboarding training track: which mission or step you are on, the
  content or code of a completion receipt, or anything you paste into the
  trainer panel to check one

The request body is built from a fixed list of permitted fields
(`src/usage/event.js`), and any other field is rejected before sending —
there is no field in the payload that the data above could travel in.

### The complete list of event names

Every event this extension can ever send. A test in the repository fails if this
list and the code disagree.

**On Rossum pages**

| Event | Meaning |
| --- | --- |
| `sa_rossum_schema_ids` | the schema-ID overlay drew at least one label |
| `sa_rossum_resource_ids` | the resource-ID overlay drew at least one label on a page |
| `sa_rossum_expand_formulas` | a formula field was auto-expanded on a page |
| `sa_rossum_expand_reasoning` | a reasoning field's options were auto-expanded on a page |
| `sa_rossum_scroll_lock` | the sidebar scroll lock actually restored a scroll position Rossum had reset |
| `sa_rossum_tooltip_close` | you dismissed a validation tooltip with its × button |
| `sa_rossum_mdh_suggest_click` | you clicked "Open Dataset Management" on the legacy Master Data Hub banner |

The five overlay events above are reported **at most once per browser tab**, not
once per document — the extension deliberately does not count repeatedly.

**On NetSuite and Coupa pages**

| Event | Meaning |
| --- | --- |
| `sa_netsuite_field_names` | a NetSuite internal field name was shown on a page |
| `sa_coupa_field_names` | a Coupa API field name was shown on a page |

**In the extension popup**

| Event | Meaning |
| --- | --- |
| `sa_popup_open` | you opened the popup |
| `sa_popup_experimental_unlock` | you unlocked the extension's experimental features |
| `sa_popup_unlock_annotation` | you released an annotation another reviewer was holding |

**In the Console**

| Event | Meaning |
| --- | --- |
| `sa_console_open` | you opened the Console page |
| `sa_console_app_mdh` | Dataset Management became the active app |
| `sa_console_app_audit` | the Audit Log viewer became the active app |
| `sa_console_app_inspector` | the Inspector became the active app |
| `sa_console_app_galaxy` | Galaxy became the active app |
| `sa_console_app_fabry` | Mr. Fabry became the active app |
| `sa_console_app_academy` | the Academy became the active app |
| `sa_mdh_query_run` | the dataset query surface was used (at most once per Console session) |
| `sa_mdh_export` | a dataset export started |
| `sa_mdh_import` | a dataset import started |
| `sa_mdh_stages_view` | the aggregation Stages view was opened |
| `sa_mdh_agent_query` | you asked the AI query box for a pipeline |
| `sa_mdh_index_create` | an index was created |
| `sa_audit_search` | you changed the audit-log source or filters. Turning a page is **not** counted |
| `sa_audit_fabry_ask` | you asked Mr. Fabry a question about audit logs |
| `sa_inspector_report` | an annotation diagnosis report was built |
| `sa_inspector_followup` | you asked a follow-up question in a diagnosis report |
| `sa_inspector_revalidate` | you ran the opt-in live config-drift check |
| `sa_fabry_chat_send` | you sent a chat message to Mr. Fabry |
| `sa_fabry_deep_verify` | that message used deep verify |
| `sa_fabry_architect_check` | an Architect deliverable check ran |
| `sa_fabry_architect_implement` | an Architect implement run started |
| `sa_training_start` | the onboarding training track was started |
| `sa_training_mission_complete` | a training mission was completed. Which mission is **not** sent |
| `sa_training_receipt_issue` | a completion receipt was issued. The receipt, the code, the organisation and the user are **not** sent |
| `sa_training_receipt_verify` | a receipt was checked in the trainer panel. The pasted receipt is **not** sent |

**In the DevTools panel**

| Event | Meaning |
| --- | --- |
| `sa_devtools_panel_open` | the Rossum DevTools panel opened |
| `sa_devtools_save` | a resource edit was saved |
| `sa_devtools_request_bar` | you opened a path from the request bar |
| `sa_devtools_copy_curl` | you copied a curl command |
| `sa_devtools_preview` | a non-JSON resource preview was shown (once per resource) |

**In the side panel**

| Event | Meaning |
| --- | --- |
| `sa_sidepanel_open` | the side panel was opened (however you opened it) |

## Data retention

Event data is retained in Google Analytics for at most 14 months.

## Your choices

Enable or disable usage data at any time in the extension popup. Disabling deletes
the identifier. Uninstalling the extension removes everything stored on your
device.

## Limited Use

This project's use of data received from this extension complies with the
[Chrome Web Store Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

## Contact

Open an issue at
<https://github.com/rossumai/rossum-sa-extension/issues>.

// Seed content for a user's FIRST Architect deliverable — a self-describing demo
// so a new user immediately sees how it works (write a requirement in Markdown →
// Run → read-only check → verdict). The leading blockquote flags it as an example
// and is trivial to delete/replace. Generic Rossum content only (no customer data).
export const EXAMPLE_DELIVERABLE = `> 👋 **Example deliverable** — a quick demo of Architect. Edit it or replace it with your own, then **Run** to check it read-only against this organization. (Delete this line once you're set.)

# Invoices queue is set up for automation

The **Invoices** queue must exist and be configured for touchless processing:

- Bound to a dedicated extraction engine (not the generic one)
- \`document_id\` and \`vendor_vat\` fields present and required
- Score threshold ≤ 0.8 so confident fields auto-confirm

_Met when all three hold for the live queue._
`;

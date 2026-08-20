import { trackOnce } from '../usage/track.js';

const MARKER_CLASS = 'rossum-sa-extension-coupa-field-name';

// Generic s- classes to ignore (UI framework, not field identifiers)
const IGNORE_S_CLASSES = new Set([
  'header', 'data', 'hidden', 'sectionContent', 'expandableArrow', 'expandableSection',
  'coupaSimpleTooltip', 'readOnlyContent', 'label_readonly', 'mainContent', 'primaryNavBar',
  'popoverContentWrapper', 'popoverTrigger', 'tooltipWrapper', 'avatarElement',
  'searchBar', 'searchBarBtn', 'leftItems', 'leftItem', 'rightItems', 'rightItem',
  'menuLink', 'menu', 'bottom', 'toggleResults', 'comboBoxContainer', 'freeForm',
  'hiddenField', 'fieldHelperItem', 'fieldHelper', 'addCommentBtn', 'addCommentField',
  'commentList', 'numComments', 'headerIcon', 'tagList', 'addTagLink',
  'invoiceApp', 'FlashContainer', 'topSection', 'editableContainer',
  'invoiceLineGrid', 'invoiceEditLineGrid', 'invoiceLineTableRowRoot',
  'invoiceLineundefined', 'openFormLineWrapper', 'totalActionHolder',
  'invoiceLinesFields', 'invoiceLineCFA', 'headerCFA', 'invoiceLineTotal',
  'advSearch', 'dataTableId', 'pageContent', 'pageContentRight',
  'superScreenSwitchBtn', 'superScreenSwitch', 'superScreenFrameContent',
  'superScreenMenus', 'expandedFrame', 'collapsedFrame', 'relatedDocsIconBtn',
  'superScreenCollapsedContainer', 'coupaGlobalHeader',
  'muteAttachmentNotifications', 'attachmentFile', 'attachmentList',
  'tab-0', 'tab-1', 'tab-2', 'tab-3',
  'historyContainer', 'historyBody', 'history_content',
  'totalsTaxesSection', 'totalsTaxesContainer', 'lineTotalsSection',
  'lineNetTotal', 'totalAmounts', 'totalsTaxes', 'totalsContainer',
  'chargesSection', 'shippingCharges', 'handlingCharges', 'miscCharges',
  'shippingAmount', 'handlingAmount', 'miscAmount', 'amount',
  'reactSummaryView', 'invoiceSummary',
  'lineNumberDisplay', 'collapseSection',
  'secondaryLines', 'taxCodeSupport', 'lineToleranceFailureInfo',
  'coupaNumberBadge__chip',
  'billToShipTo', 'supplierInfoSection', 'generalSystemFields',
  'savingsOpportunity', 'coupaUserMenuPopover', 'coupaNotificationPopover',
  'coupaHelpPopover', 'coupaMenuPopup', 'coupaMenuPopupBody',
  'universalSearchContainer', 'magnifierIcon',
  'expandable-section', 'expandable-content',
  'invoicePaymentDetailsShow', 'paymentSection', 'paymentDetailsShow',
  'invoiceActionButtons', 'floatingActionBar', 'quickInfoBar', 'quickInfo',
  'approvalButtonsGroup',
  'orderLineItem', 'lineNumberDisplay',
  // PO-specific UI classes
  'SupplierShippableWidget', 'shippableApp', 'trackerList', 'emptyTrackerList',
  'groupCartContainer', 'groupCartShow',
]);

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
.${MARKER_CLASS} {
  color: red;
  font-size: 10px;
  opacity: .7;
  text-transform: lowercase;
}`;
  document.head?.appendChild(style);
}

function displayFieldName(node: Element, fieldName: string) {
  if (node.querySelector(`.${MARKER_CLASS}`)) return;
  const span = document.createElement('span');
  span.className = MARKER_CLASS;
  span.textContent = ' ' + fieldName;
  node.appendChild(span);
  trackOnce('sa_coupa_field_names');
}

function camelToSnake(str: string) {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// ── Strategy 1: JSON metadata (React pages like invoices) ──

function getFieldMapFromJson() {
  const script = document.getElementById('initial_full_react_data');
  if (!script) return null;

  try {
    const data = JSON.parse(script.textContent!);
    const map = new Map<string, string>();
    const meta = data?.metadata;
    if (!meta) return null;

    // Header fields
    if (meta.header_section) {
      for (const field of Object.values<any>(meta.header_section)) {
        if (field?.label && field?.name) {
          map.set(field.label, field.name);
        }
      }
    }

    // Line fields (from first line's metadata)
    const firstLine = meta.lines_section?.lines?.[0];
    if (firstLine) {
      for (const field of Object.values<any>(firstLine)) {
        if (field?.label && field?.name) {
          map.set(field.label, field.name);
        }
      }
    }

    // Summary tax line fields
    const taxLines = meta.summary_section?.tax_lines;
    if (Array.isArray(taxLines)) {
      for (const field of taxLines) {
        if (field?.label && field?.name) {
          map.set(field.label, field.name);
        }
      }
    }

    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

function annotateJsonLabels(fieldMap: Map<string, string>) {
  const labels = document.querySelectorAll(
    'dt.label_readonly, dt.group_label, dl.attribute dt, dl.form_element dt'
  );
  for (const dt of labels) {
    const labelText = dt.textContent!.trim();
    const apiName = fieldMap.get(labelText);
    if (apiName) {
      displayFieldName(dt, apiName);
    }
  }
}

// ── Strategy 2: DOM attribute extraction (Rails pages like POs) ──

function extractFieldNameFromId(formElement: Element): string | null {
  // Look for elements with id like order_header_*, order_line_NNNNN_*
  const children = formElement.querySelectorAll('[id]');
  for (const el of children) {
    const match = el.id.match(
      /^(?:order_header|order_line|requisition_header|contract)_(?:\d+_)?(.+)$/
    );
    if (match && match[1]) return match[1];
  }
  return null;
}

function extractFieldNameFromClasses(formElement: Element): string | null {
  // Check s- classes on the element itself and direct children
  const candidates = [formElement, ...formElement.children];
  for (const el of candidates) {
    if (!el.classList) continue;
    for (const cls of el.classList) {
      if (cls.startsWith('s-') && cls.length > 2) {
        const name = cls.substring(2);
        if (!IGNORE_S_CLASSES.has(name)) {
          return camelToSnake(name);
        }
      }
    }
  }

  // Semantic classes like orderLineQuantity, orderLinePrice
  for (const cls of formElement.classList) {
    const match = cls.match(/^orderLine(\w+)$/);
    if (match) return camelToSnake(match[1]);
  }

  return null;
}

function annotateRailsLabels() {
  const formElements = document.querySelectorAll('.form_element');
  for (const el of formElements) {
    const label =
      el.querySelector('span.group_label') ||
      el.querySelector('label.group_label');
    if (!label) continue;
    if (label.querySelector(`.${MARKER_CLASS}`)) continue;

    const fieldName =
      extractFieldNameFromId(el) || extractFieldNameFromClasses(el);
    if (fieldName) {
      displayFieldName(label, fieldName);
    }
  }
}

// ── Main ──

chrome.storage.local.get(['coupaFieldNamesEnabled']).then((result) => {
  if (result.coupaFieldNamesEnabled !== true) return;

  injectStyles();

  // Try JSON metadata first (React pages)
  const fieldMap = getFieldMapFromJson();
  if (fieldMap) {
    annotateJsonLabels(fieldMap);
  }

  // Always run Rails fallback (covers POs and any fields missed by JSON)
  annotateRailsLabels();
});

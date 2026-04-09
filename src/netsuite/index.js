function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
.rossum-sa-extension-netsuite-field-name {
  color: red;
  font-size: 10px;
  opacity: .7;
  text-transform: lowercase;
}`;
  document.head?.appendChild(style);
}

function displayFieldName(node, fieldId) {
  const div = document.createElement('div');
  div.className = 'rossum-sa-extension-netsuite-field-name';
  div.textContent = fieldId;
  node.appendChild(div);
}

chrome.storage.local.get(['netsuiteFieldNamesEnabled']).then((result) => {
  if (result.netsuiteFieldNamesEnabled !== true) return;

  injectStyles();

  const linksWithLabel = document.querySelectorAll("span[id$='_lbl'] a");
  for (const link of linksWithLabel) {
    const onClick = link.getAttribute('onclick');
    if (onClick == null || !onClick.includes('nlFieldHelp')) continue;

    const resultArray = onClick.match(/"(?<word>[^"]*)"/g) || onClick.match(/'(?<word>[^']*)'/g);
    if (resultArray && resultArray.length > 1) {
      const fieldId = resultArray[1].replace(/['"]/g, '');
      displayFieldName(link, fieldId);
    }
  }
});
